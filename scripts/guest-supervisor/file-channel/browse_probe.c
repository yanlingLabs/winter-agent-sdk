#define _GNU_SOURCE
/* TEST ONLY (test_file_browse.py, Linux root in CI): exec'd by the tool launcher's browse mode IN PLACE OF the file worker, it reports the
 * compartment from inside: identity, groups, capabilities, no_new_privs, seccomp, the read-only root, the handle syscalls, clone, the umask
 * and the view's top level. argv is the worker's: OP ROOT RELATIVE UID MAXBYTES OFFSET ROOTDEV. Never part of an image. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <grp.h>
static int cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }
int main(int argc, char **argv) {
    if (argc != 8) return 64;
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 }; struct __user_cap_data_struct caps[2] = {{0}, {0}};
    if (syscall(SYS_capget, &header, caps)) return 65;
    unsigned long long bounding = 0;
    for (int cap = 0; cap <= CAP_LAST_CAP; cap++) if (prctl(PR_CAPBSET_READ, cap, 0, 0, 0) == 1) bounding |= 1ULL << cap;
    gid_t groups[16]; int count = getgroups(16, groups);
    struct statvfs vfs; int readonly = statvfs(argv[2], &vfs) == 0 && (vfs.f_flag & ST_RDONLY) ? 1 : 0;
    char target[8192]; snprintf(target, sizeof target, "%s/%s", argv[2], argv[3]);
    int fd = open(target, O_WRONLY | O_CLOEXEC); int write_open = fd < 0 ? errno : 0; if (fd >= 0) close(fd);
    struct { unsigned int bytes; int type; unsigned char data[128]; } handle = { .bytes = 128 }; int mount_id = 0;
    errno = 0; int to_handle = syscall(SYS_name_to_handle_at, AT_FDCWD, target, &handle, &mount_id, 0) < 0 ? errno : 0;
    errno = 0; int by_handle = syscall(SYS_open_by_handle_at, -1, &handle, O_RDONLY) < 0 ? errno : 0;
    errno = 0; long child = syscall(SYS_clone, SIGCHLD, 0, 0, 0, 0); if (child == 0) _exit(0);
    int cloned = child < 0 ? errno : 0;
    mode_t mask = umask(0);
    char *names[64]; int found = 0; DIR *top = opendir("/");
    if (top) { struct dirent *entry; while ((entry = readdir(top)) && found < 64) if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) names[found++] = strdup(entry->d_name); closedir(top); }
    qsort(names, (size_t)found, sizeof names[0], cmp);
    printf("{\"uid\":%u,\"euid\":%u,\"gid\":%u,\"groups\":[", getuid(), geteuid(), getgid());
    for (int i = 0; i < count; i++) printf("%s%u", i ? "," : "", groups[i]);
    printf("],\"capEffective\":%llu,\"capPermitted\":%llu,\"capInheritable\":%llu,\"boundingSet\":%llu,\"noNewPrivs\":%d,\"seccomp\":%d,\"rootMountReadOnly\":%d,\"writeOpen\":%d,"
        "\"nameToHandle\":%d,\"openByHandle\":%d,\"clone\":%d,\"umask\":%u,\"entries\":[",
        (unsigned long long)caps[0].effective | (unsigned long long)caps[1].effective << 32, (unsigned long long)caps[0].permitted | (unsigned long long)caps[1].permitted << 32,
        (unsigned long long)caps[0].inheritable | (unsigned long long)caps[1].inheritable << 32, bounding, prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0), prctl(PR_GET_SECCOMP, 0, 0, 0, 0),
        readonly, write_open, to_handle, by_handle, cloned, (unsigned)mask);
    for (int i = 0; i < found; i++) printf("%s\"%s\"", i ? "," : "", names[i]);
    puts("]}");
    return 0;
}
