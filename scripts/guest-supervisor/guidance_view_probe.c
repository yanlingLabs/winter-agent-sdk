/* Linux-only observer for test_guided_guidance_view.py. The test launches the PATCHED tool
 * launcher (built from the DATA patch in a scratch copy) with this program as the immutable
 * helper, so it runs INSIDE the finished tool view, after chroot, as the unprivileged tool uid.
 * It only reads, probes and prints `key value` lines. It opens no socket and uses no network. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/wait.h>
#include <unistd.h>

#define ALIAS "/workspace/.winter/WINTER.md"
#define VIEW "/run/winter/shared-instructions"

static int cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }
static void list(const char *key, const char *path) {
    DIR *d = opendir(path);
    if (!d) { printf("%s errno=%d\n", key, errno); return; }
    char *names[256]; int n = 0; struct dirent *e;
    while ((e = readdir(d)) && n < 256) if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) names[n++] = strdup(e->d_name);
    closedir(d);
    qsort(names, n, sizeof names[0], cmp);
    printf("%s ", key);
    for (int i = 0; i < n; i++) printf("%s%s", i ? "," : "", names[i]);
    printf("\n");
}
static void attempt(const char *key, const char *path, int flags) {
    int fd = open(path, flags | O_CLOEXEC, 0666);
    if (fd < 0) printf("%s errno=%d\n", key, errno); else { printf("%s opened\n", key); close(fd); }
}
static void flags(const char *key, const char *path) {
    struct statvfs v;
    if (statvfs(path, &v)) printf("%s errno=%d\n", key, errno); else printf("%s %lu\n", key, (unsigned long)v.f_flag);
}
int main(void) {
    int leaked = 0;
    for (int fd = 3; fd < 1024; fd++) if (fcntl(fd, F_GETFD) != -1) leaked++;
    printf("leaked_fds %d\n", leaked);
    char text[256]; int fd = open(ALIAS, O_RDONLY | O_CLOEXEC);
    if (fd < 0) printf("alias_read errno=%d\n", errno);
    else { ssize_t n = read(fd, text, sizeof text - 1); text[n > 0 ? n : 0] = 0; close(fd); printf("alias_read ok %s\n", text); }
    fd = open(VIEW "/WINTER.md", O_RDONLY | O_CLOEXEC);
    if (fd < 0) printf("view_read errno=%d\n", errno);
    else { ssize_t n = read(fd, text, sizeof text - 1); text[n > 0 ? n : 0] = 0; close(fd); printf("view_read ok %s\n", text); }
    attempt("alias_write", ALIAS, O_WRONLY);
    attempt("view_file_write", VIEW "/WINTER.md", O_WRONLY | O_TRUNC);
    attempt("view_create", VIEW "/created-by-tool", O_WRONLY | O_CREAT | O_EXCL);
    printf("view_unlink %s\n", unlink(VIEW "/WINTER.md") ? (errno == EROFS ? "EROFS" : "other") : "removed");
    flags("alias_flags", ALIAS);
    flags("view_flags", VIEW);
    list("ls_root_run", "/run");
    list("ls_run_winter", "/run/winter");
    list("ls_workspace_winter", "/workspace/.winter");
    list("ls_view", VIEW);
    list("ls_nested", VIEW "/nested");
    attempt("dotdot_file", VIEW "/../WINTER.md", O_RDONLY);
    attempt("dotdot_etc", VIEW "/../../../../../../../etc/hostname", O_RDONLY);
    attempt("symlink_out", VIEW "/escape-link", O_RDONLY);
    attempt("hardlink_probe", VIEW "/hard-link", O_RDONLY);
    pid_t child = fork();
    if (child == 0) { execl(VIEW "/exe", "exe", (char *)NULL); _exit(errno & 255); }
    int status = 0; waitpid(child, &status, 0);
    printf("exec_view %d\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1);
    FILE *info = fopen("/proc/self/mountinfo", "re");
    char line[1024];
    while (info && fgets(line, sizeof line, info)) {
        if (strstr(line, "shared-instructions") || strstr(line, "WINTER.md") || strstr(line, "/workspace/.winter")) printf("mount %s", line);
    }
    if (info) fclose(info);
    fflush(stdout);
    return 0;
}
