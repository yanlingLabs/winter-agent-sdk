#define _GNU_SOURCE
/* Test-only diagnostic. NOT production code and never shipped.
 * Runs inside the same compartment view verify.py builds for the file worker
 * (launched as its "worker"), and repeats the symlink-swap race against the
 * worker's exact openat2 flags/resolve mask from the same kind of root dirfd.
 * Every successful open is classified by fstat identity. Exit status is
 * non-zero if any out-of-root or unknown object is ever returned.
 * Arguments (after the launcher's own): probe /source race UID BUDGET_MS HOSTPARENT
 * where HOSTPARENT is "dev:ino" of the host fixture directory (not visible in the view). */
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include <inttypes.h>

enum { SEED, SOURCE_DIR, RACE_SYMLINK, SECRET, READONLY_DIR, VIEW_ROOT, HOST_PARENT, UNKNOWN, CLASSES };
static const char *names[CLASSES] = {"in-root:seed", "in-root:source-dir", "in-root:race-symlink",
    "OUT:readonly/secret", "OUT:readonly-dir", "OUT:view-root", "OUT:host-parent", "UNKNOWN"};
static unsigned long counts[CLASSES], errnos[256], other_errnos;
static struct stat known[CLASSES];
static int have[CLASSES];

static void load(int index, const char *path) {
    if (stat(path, &known[index])) { printf("{\"version\":1,\"ok\":false,\"code\":\"probe_setup\",\"errno\":%d}\n", errno); exit(2); }
    have[index] = 1;
}
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (double)t.tv_sec + (double)t.tv_nsec / 1e9; }

int main(int argc, char **argv) {
    if (argc < 7 || strcmp(argv[1], "probe")) return 64;
    uintmax_t host_dev = 0, host_ino = 0;
    if (sscanf(argv[6], "%ju:%ju", &host_dev, &host_ino) != 2) return 64;
    double budget = strtod(argv[5], NULL) / 1000.0;
    load(SEED, "/source/seed"); load(SOURCE_DIR, "/source");
    load(SECRET, "/readonly/secret"); load(READONLY_DIR, "/readonly"); load(VIEW_ROOT, "/");
    struct open_how root_how = { .flags = O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    int root = (int)syscall(SYS_openat2, AT_FDCWD, argv[2], &root_how, sizeof(root_how));
    if (root < 0) { printf("{\"version\":1,\"ok\":false,\"code\":\"root_unavailable\",\"errno\":%d}\n", errno); return 2; }
    struct open_how how = {
        .flags = O_RDONLY | O_CLOEXEC | O_NONBLOCK,
        .mode = 0,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS,
    };
    double start = now();
    unsigned long opens = 0;
    int bad = 0;
    while (opens < 200000 && now() - start < budget) {
        opens++;
        int fd = (int)syscall(SYS_openat2, root, argv[3], &how, sizeof(how));
        if (fd < 0) { if (errno < 256) errnos[errno]++; else other_errnos++; continue; }
        struct stat st;
        int cls = UNKNOWN;
        if (fstat(fd, &st) == 0) {
            if (S_ISLNK(st.st_mode)) cls = RACE_SYMLINK;
            else if ((uintmax_t)st.st_dev == host_dev && (uintmax_t)st.st_ino == host_ino) cls = HOST_PARENT;
            else for (int c = 0; c < CLASSES - 1; c++)
                if (have[c] && c != RACE_SYMLINK && c != HOST_PARENT && st.st_dev == known[c].st_dev && st.st_ino == known[c].st_ino) { cls = c; break; }
        }
        close(fd);
        counts[cls]++;
        if (cls >= SECRET) bad = 1;
    }
    printf("{\"version\":1,\"ok\":%s,\"opens\":%lu,\"seconds\":%.2f,\"objects\":{", bad ? "false" : "true", opens, now() - start);
    for (int c = 0, first = 1; c < CLASSES; c++) { printf("%s\"%s\":%lu", first ? "" : ",", names[c], counts[c]); first = 0; }
    printf("},\"errnos\":{");
    for (int e = 0, first = 1; e < 256; e++) if (errnos[e]) { printf("%s\"%d\":%lu", first ? "" : ",", e, errnos[e]); first = 0; }
    printf("}}\n");
    return bad ? 3 : 0;
}
