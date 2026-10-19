#define _GNU_SOURCE
/* Linux file worker. MUST be launched in the caller's tool compartment, never as runtime/root. */
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <inttypes.h>
#include <stddef.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/vfs.h>

static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static int error_result(const char *code) {
    printf("{\"version\":1,\"ok\":false,\"code\":\"%s\",\"errno\":%d}\n", code, errno);
    return 1;
}
static int value(unsigned char c) {
    const char *p = strchr(alphabet, (char)c);
    return p && c ? (int)(p - alphabet) : -1;
}
static int decode(const unsigned char *text, size_t length, unsigned char *out, size_t *size, size_t limit) {
    if (length % 4) return -1;
    *size = 0;
    for (size_t i = 0; i < length; i += 4) {
        int a = value(text[i]), b = value(text[i+1]);
        int c = text[i+2] == '=' ? 0 : value(text[i+2]);
        int d = text[i+3] == '=' ? 0 : value(text[i+3]);
        size_t bytes = text[i+2] == '=' ? 1 : text[i+3] == '=' ? 2 : 3;
        if (a < 0 || b < 0 || c < 0 || d < 0 || (text[i+2] == '=' && text[i+3] != '=') || (bytes < 3 && i+4 != length) || (bytes == 1 && (b & 15)) || (bytes == 2 && (c & 3)) || *size+bytes > limit) return -1;
        out[(*size)++] = (unsigned char)((a << 2) | (b >> 4));
        if (bytes > 1) out[(*size)++] = (unsigned char)((b << 4) | (c >> 2));
        if (bytes > 2) out[(*size)++] = (unsigned char)((c << 6) | d);
    }
    return 0;
}
static void encode(const unsigned char *data, size_t length) {
    for (size_t i = 0; i < length; i += 3) {
        unsigned a = data[i], b = i+1 < length ? data[i+1] : 0, c = i+2 < length ? data[i+2] : 0;
        putchar(alphabet[a >> 2]); putchar(alphabet[((a & 3) << 4) | (b >> 4)]);
        putchar(i+1 < length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=');
        putchar(i+2 < length ? alphabet[c & 63] : '=');
    }
}
static void file_version(const struct stat *st, char *out, size_t size) {
    snprintf(out, size, "%ju:%ju:%jd:%jd:%09ld:%jd:%09ld", (uintmax_t)st->st_dev, (uintmax_t)st->st_ino, (intmax_t)st->st_size, (intmax_t)st->st_mtim.tv_sec, st->st_mtim.tv_nsec, (intmax_t)st->st_ctim.tv_sec, st->st_ctim.tv_nsec);
}
/* ---- Browse (the guest file channel's stat and ranged read; read only) -----------------------------------------------------
 * Launched only by the tool launcher's `browse` mode, as the per-workspace browse uid, in a read-only view of ONE admitted root,
 * with no capability. argv: stat|browse-read ROOT RELATIVE UID MAXBYTES OFFSET ROOTDEV. The worker reports the raw identity of the
 * file it read (dev, ino, size, mtime ns, ctime ns, mode, nlink, uid) before and after; the supervisor turns that into the channel's
 * generation token and every channel error code. It never prints a path. */
#define BROWSE_EXT4_MAGIC 0xEF53UL
#define BROWSE_MAX_BYTES (256UL * 1024UL)
#define BROWSE_MAX_OFFSET 9007199254740991ULL
/* BEGIN PORTABLE BROWSE CONTRACT -- pure argument and predicate logic, no descriptor or kernel effect. */
static int browse_decimal(const char *text, unsigned long long maximum, unsigned long long *out) {
    unsigned long long value = 0;
    if (!text || !*text || (text[0] == '0' && text[1])) return 0;
    for (const char *p = text; *p; p++) {
        if (*p < '0' || *p > '9') return 0;
        unsigned digit = (unsigned)(*p - '0');
        if (value > (maximum - digit) / 10) return 0;
        value = value * 10 + digit;
    }
    *out = value; return 1;
}
/* The open errno that means "no such file" to the channel; everything else is a refusal. */
static const char *browse_open_code(int error) { return error == ENOENT || error == ENOTDIR ? "path_missing" : error == ENOSYS ? "openat2_unavailable" : "path_denied"; }
/* The opened object must be one regular file, not a hard-link alias, on the root's own filesystem. */
static const char *browse_object_code(mode_t mode, nlink_t links, dev_t device, dev_t root_device) {
    if (!S_ISREG(mode)) return "not_regular";
    if (links != 1) return "linked";
    if (device != root_device) return "device_mismatch";
    return NULL;
}
/* Bytes a ranged read promises: min(maxBytes, size - offset). An offset past the end is the caller's error. */
static int browse_span(unsigned long long size, unsigned long long offset, unsigned long long max_bytes, unsigned long long *out) {
    if (offset > size) return 0;
    *out = size - offset < max_bytes ? size - offset : max_bytes; return 1;
}
/* END PORTABLE BROWSE CONTRACT */
static void browse_identity(const char *name, const struct stat *st) {
    printf("\"%s\":[%ju,%ju,%jd,%jd,%jd,%ju,%ju,%ju]", name, (uintmax_t)st->st_dev, (uintmax_t)st->st_ino, (intmax_t)st->st_size,
        (intmax_t)st->st_mtim.tv_sec * 1000000000 + st->st_mtim.tv_nsec, (intmax_t)st->st_ctim.tv_sec * 1000000000 + st->st_ctim.tv_nsec,
        (uintmax_t)st->st_mode, (uintmax_t)st->st_nlink, (uintmax_t)st->st_uid);
}
#if defined(__aarch64__)
#define BROWSE_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define BROWSE_ARCH AUDIT_ARCH_X86_64
#else
#error unsupported Linux browse architecture
#endif
#define BROWSE_DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
#define BROWSE_STDOUT_ONLY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##n,0,3), BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])), \
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,STDOUT_FILENO,1,0), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM), BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr))
/* A second filter, stacked on the launcher's shared one once the file is open: no further open, no exec, no write except the one
 * response line on stdout, and no syscall that changes a file or its metadata. Read, pread, fstat, close and exit stay allowed. */
static int browse_seal(void) {
    struct sock_filter entries[] = {
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,BROWSE_ARCH,1,0),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,0x40000000,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
        BROWSE_STDOUT_ONLY(write), BROWSE_STDOUT_ONLY(writev),
        BROWSE_DENY(execve), BROWSE_DENY(execveat), BROWSE_DENY(openat), BROWSE_DENY(openat2), BROWSE_DENY(pwrite64), BROWSE_DENY(pwritev), BROWSE_DENY(pwritev2),
        BROWSE_DENY(truncate), BROWSE_DENY(ftruncate), BROWSE_DENY(fallocate), BROWSE_DENY(renameat2), BROWSE_DENY(unlinkat),
        BROWSE_DENY(mkdirat), BROWSE_DENY(mknodat), BROWSE_DENY(linkat), BROWSE_DENY(symlinkat), BROWSE_DENY(fchmod), BROWSE_DENY(fchmodat),
        BROWSE_DENY(fchown), BROWSE_DENY(fchownat), BROWSE_DENY(setxattr), BROWSE_DENY(lsetxattr), BROWSE_DENY(fsetxattr), BROWSE_DENY(removexattr),
        BROWSE_DENY(lremovexattr), BROWSE_DENY(fremovexattr), BROWSE_DENY(utimensat), BROWSE_DENY(sendfile), BROWSE_DENY(copy_file_range),
        BROWSE_DENY(splice), BROWSE_DENY(tee), BROWSE_DENY(vmsplice), BROWSE_DENY(socket), BROWSE_DENY(socketpair), BROWSE_DENY(connect),
        BROWSE_DENY(open_by_handle_at), BROWSE_DENY(name_to_handle_at),
#ifdef __NR_fchmodat2
        BROWSE_DENY(fchmodat2),
#endif
#ifdef __NR_renameat
        BROWSE_DENY(renameat),
#endif
#if defined(__x86_64__)
        BROWSE_DENY(open), BROWSE_DENY(creat), BROWSE_DENY(rename), BROWSE_DENY(unlink), BROWSE_DENY(mkdir), BROWSE_DENY(rmdir), BROWSE_DENY(link),
        BROWSE_DENY(symlink), BROWSE_DENY(chmod), BROWSE_DENY(chown), BROWSE_DENY(lchown), BROWSE_DENY(mknod), BROWSE_DENY(utimes), BROWSE_DENY(utime),
        BROWSE_DENY(futimesat),
#endif
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program = { .len = sizeof(entries) / sizeof(entries[0]), .filter = entries };
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}
#ifdef WINTER_BROWSE_SEAL_PROBE
/* TEST BUILDS ONLY (the image compiles this file without the define): after the seal, try each thing it must stop and report errno. */
static int browse_seal_probe(int file) {
    char *none[] = { NULL };
    int results[7];
    errno = 0; results[0] = execve("/", none, none) < 0 ? errno : 0;
    errno = 0; results[1] = openat(AT_FDCWD, "/", O_RDONLY | O_CLOEXEC) < 0 ? errno : 0;
    errno = 0; results[2] = write(STDERR_FILENO, "x", 1) < 0 ? errno : 0;
    errno = 0; results[3] = pwrite(file, "x", 1, 0) < 0 ? errno : 0;
    errno = 0; results[4] = ftruncate(file, 0) < 0 ? errno : 0;
    errno = 0; results[5] = fchmod(file, 0600) < 0 ? errno : 0;
    errno = 0; results[6] = (int)syscall(SYS_name_to_handle_at, AT_FDCWD, ".", NULL, NULL, 0) < 0 ? errno : 0;
    printf("{\"version\":1,\"ok\":true,\"probe\":[%d,%d,%d,%d,%d,%d,%d]}\n", results[0], results[1], results[2], results[3], results[4], results[5], results[6]);
    return 0;
}
#endif
static int browse_main(char **argv) {
    unsigned long long max_bytes, offset, root_device;
    int reading = !strcmp(argv[1], "browse-read");
    if (!browse_decimal(argv[5], BROWSE_MAX_BYTES, &max_bytes) || max_bytes < 1 || !browse_decimal(argv[6], BROWSE_MAX_OFFSET, &offset) || (!reading && offset)
        || !browse_decimal(argv[7], ~0ULL, &root_device) || argv[2][0] != '/' || !argv[3][0] || argv[3][0] == '/') { errno = EINVAL; return error_result("invalid_request"); }
    if (syscall(SYS_close_range, 3U, ~0U, 0U)) return error_result("fd_cleanup_unavailable");
    /* 1. The root, without RESOLVE_NO_XDEV: the root is itself a mount point in the view. */
    struct open_how browse_root_how = { .flags = O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    int root = (int)syscall(SYS_openat2, AT_FDCWD, argv[2], &browse_root_how, sizeof(browse_root_how));
    if (root < 0) return error_result("root_unavailable");
    /* 2. The root-device check: an ext4 root on the admitted descriptor's device. A share root (a host-share mount point) fails here. */
    struct statfs fs; struct stat root_st;
    if (fstatfs(root, &fs) || fstat(root, &root_st)) { close(root); return error_result("root_unavailable"); }
    if ((unsigned long)fs.f_type != BROWSE_EXT4_MAGIC || (unsigned long long)root_st.st_dev != root_device) { close(root); errno = EXDEV; return error_result("root_not_data"); }
    /* 3. Kernel-enforced walk: no symlink in any component, no escape, no magic link, no mount crossing below the root. */
    struct open_how browse_how = { .flags = O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_NOCTTY | O_CLOEXEC,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV };
    int file = (int)syscall(SYS_openat2, root, argv[3], &browse_how, sizeof(browse_how));
    int saved = errno; close(root); errno = saved;
    if (file < 0) return error_result(browse_open_code(errno));
    /* 4. One regular file, one link, the root's device. */
    struct stat before, after;
    if (fstat(file, &before)) { saved = errno; close(file); errno = saved; return error_result("stat_failed"); }
    const char *refused = browse_object_code(before.st_mode, before.st_nlink, before.st_dev, root_st.st_dev);
    if (refused) { close(file); errno = EPERM; return error_result(refused); }
    if (browse_seal()) { saved = errno; close(file); errno = saved; return error_result("seal_unavailable"); }
#ifdef WINTER_BROWSE_SEAL_PROBE
    return browse_seal_probe(file);
#endif
    if (!reading) {
        close(file);
        printf("{\"version\":1,\"ok\":true,"); browse_identity("before", &before); puts("}");
        return 0;
    }
    unsigned long long want;
    if (before.st_size < 0 || !browse_span((unsigned long long)before.st_size, offset, max_bytes, &want)) { close(file); errno = EINVAL; return error_result("offset_beyond"); }
    unsigned char *data = malloc(want ? want : 1);
    if (!data) { close(file); return error_result("resource_unavailable"); }
    size_t got = 0;
    while (got < want) {
        ssize_t count = pread(file, data + got, want - got, (off_t)(offset + got));
        if (count < 0) { if (errno == EINTR) continue; saved = errno; close(file); free(data); errno = saved; return error_result("read_failed"); }
        if (!count) break;
        got += (size_t)count;
    }
    /* 6. The identity again, on the same descriptor: the supervisor compares it with the first. */
    if (fstat(file, &after)) { saved = errno; close(file); free(data); errno = saved; return error_result("stat_failed"); }
    close(file);
    printf("{\"version\":1,\"ok\":true,"); browse_identity("before", &before); putchar(','); browse_identity("after", &after);
    printf(",\"bytes\":%zu,\"dataBase64\":\"", got); encode(data, got); puts("\"}");
    free(data); return 0;
}

int main(int argc, char **argv) {
    int conditional = argc == 7 && !strcmp(argv[1], "write-check");
    int browse = argc == 8 && (!strcmp(argv[1], "stat") || !strcmp(argv[1], "browse-read"));
    if ((!conditional && !browse && argc != 6) || (strcmp(argv[1], "read") && strcmp(argv[1], "write") && !conditional && !browse)) { errno = EINVAL; return error_result("invalid_request"); }
    char *end;
    unsigned long expected_uid = strtoul(argv[4], &end, 10);
    if (*end || expected_uid == 0 || expected_uid > 65535 || getuid() != expected_uid || geteuid() != expected_uid || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 || prctl(PR_GET_SECCOMP) != 2) { errno = EPERM; return error_result("compartment_required"); }
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct caps[2] = {{0}, {0}};
    if (syscall(SYS_capget, &header, caps) || caps[0].effective || caps[1].effective || caps[0].permitted || caps[1].permitted || caps[0].inheritable || caps[1].inheritable) { errno = EPERM; return error_result("compartment_required"); }
    for (int cap = 0; cap <= CAP_LAST_CAP; cap++) {
        if (prctl(PR_CAPBSET_READ, cap, 0, 0, 0) != 0 || prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, cap, 0, 0) != 0) { errno = EPERM; return error_result("compartment_required"); }
    }
    if (browse) return browse_main(argv);
    unsigned long limit = strtoul(argv[5], &end, 10);
    if (*end || limit < 1 || limit > 16 * 1024 * 1024 || argv[2][0] != '/' || !argv[3][0] || argv[3][0] == '/') { errno = EINVAL; return error_result("invalid_request"); }
    /* No inherited control/store/socket descriptors, even if a launcher accidentally passed them. */
    if (syscall(SYS_close_range, 3U, ~0U, 0U)) return error_result("fd_cleanup_unavailable");
    struct open_how root_how = { .flags = O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    int root = (int)syscall(SYS_openat2, AT_FDCWD, argv[2], &root_how, sizeof(root_how));
    if (root < 0) return error_result("root_unavailable");
    unsigned char *data = malloc(limit + 1);
    if (!data) { close(root); return error_result("resource_unavailable"); }
    size_t bytes = 0;
    int writing = strcmp(argv[1], "read") != 0;
    int creating = conditional && !strcmp(argv[6], "absent");
    if (writing) {
        size_t encoded_limit = ((limit + 2) / 3) * 4;
        unsigned char *input = malloc(encoded_limit + 1);
        if (!input) { free(data); close(root); return error_result("resource_unavailable"); }
        size_t length = 0;
        for (;;) {
            ssize_t count = read(STDIN_FILENO, input+length, encoded_limit+1-length);
            if (count < 0) { if (errno == EINTR) continue; free(input); free(data); close(root); return error_result("input_failed"); }
            if (!count) break;
            length += (size_t)count;
            if (length > encoded_limit) { errno = EFBIG; free(input); free(data); close(root); return error_result("payload_limit"); }
        }
        if (decode(input, length, data, &bytes, limit)) { errno = EINVAL; free(input); free(data); close(root); return error_result("invalid_payload"); }
        free(input);
    }
    struct open_how how = {
        .flags = (writing ? O_WRONLY | (conditional ? (creating ? O_CREAT | O_EXCL : 0) : O_CREAT) : O_RDONLY) | O_CLOEXEC | O_NONBLOCK,
        /* Respect the compartment's normal umask and setgid workspace group. */
        .mode = writing && (!conditional || creating) ? 0666 : 0,
        /* In-root relative links and admitted nested binds are normal workspace semantics.
         * Absolute/out-of-root links and proc-style magic links remain denied by the kernel. */
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS,
    };
    int file = (int)syscall(SYS_openat2, root, argv[3], &how, sizeof(how));
    close(root);
    if (file < 0) { free(data); return error_result(errno == ENOSYS ? "openat2_unavailable" : "path_denied"); }
    struct stat st;
    if (fstat(file, &st)) {
        int saved_errno = errno;
        close(file); free(data); errno = saved_errno;
        return error_result("stat_failed");
    }
    if (!S_ISREG(st.st_mode)) { close(file); free(data); errno = EINVAL; return error_result("regular_file_required"); }
    char before_version[256], after_version[256];
    file_version(&st, before_version, sizeof(before_version));
    if (conditional && !creating && strcmp(argv[6], before_version)) { errno = EAGAIN; close(file); free(data); return error_result("file_changed"); }
    if (writing) {
        /* Validate the opened object before making the first destructive change. */
        if (ftruncate(file, 0)) { close(file); free(data); return error_result("write_failed"); }
        size_t written = 0;
        while (written < bytes) {
            ssize_t count = write(file, data+written, bytes-written);
            if (count < 0) { if (errno == EINTR) continue; close(file); free(data); return error_result("write_failed"); }
            if (!count) { errno = EIO; close(file); free(data); return error_result("write_failed"); }
            written += (size_t)count;
        }
        if (fsync(file)) { close(file); free(data); return error_result("flush_failed"); }
        if (fstat(file, &st)) { close(file); free(data); return error_result("write_failed"); }
        file_version(&st, after_version, sizeof(after_version));
        printf("{\"version\":1,\"ok\":true,\"bytes\":%zu,\"fileVersion\":\"%s\",\"mtimeMs\":%.6f}\n", bytes, after_version, (double)st.st_mtim.tv_sec * 1000.0 + (double)st.st_mtim.tv_nsec / 1000000.0);
    } else {
        for (;;) {
            ssize_t count = read(file, data+bytes, limit+1-bytes);
            if (count < 0) { if (errno == EINTR) continue; close(file); free(data); return error_result("read_failed"); }
            if (!count) break;
            bytes += (size_t)count;
            if (bytes > limit) { errno = EFBIG; close(file); free(data); return error_result("payload_limit"); }
        }
        if (fstat(file, &st)) { close(file); free(data); return error_result("read_failed"); }
        file_version(&st, after_version, sizeof(after_version));
        if (strcmp(before_version, after_version)) { errno = EAGAIN; close(file); free(data); return error_result("file_changed"); }
        printf("{\"version\":1,\"ok\":true,\"bytes\":%zu,\"fileVersion\":\"%s\",\"mtimeMs\":%.6f,\"dataBase64\":\"", bytes, after_version, (double)st.st_mtim.tv_sec * 1000.0 + (double)st.st_mtim.tv_nsec / 1000000.0); encode(data, bytes); puts("\"}");
    }
    close(file); free(data); return 0;
}
