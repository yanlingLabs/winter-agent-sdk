#define _GNU_SOURCE
/* TEST ONLY (test_file_browse.py, Linux root in CI): runs the file worker ALONE on the host tree in the browse identity, so the worker's own
 * walk (RESOLVE_NO_XDEV below the root, the root-device check) is observable without the launcher's non-recursive root clone in the way.
 * argv: WORKER UID GID OP ROOT RELATIVE MAXBYTES OFFSET ROOTDEV. Never part of an image. */
#include "linux-compartment.h"
int main(int argc, char **argv) {
    if (argc != 10 || geteuid() != 0) return 64;
    uid_t uid = (uid_t)strtoul(argv[2], NULL, 10); gid_t gid = (gid_t)strtoul(argv[3], NULL, 10);
    if (uid < 1000 || gid < 1000) return 64;
    for (int cap = 0; cap <= CAP_LAST_CAP; cap++) require(prctl(PR_CAPBSET_DROP, cap, 0, 0, 0), "drop bounding capabilities");
    require(setgroups(1, &gid), "workspace group");
    require(setresgid(uid, uid, uid), "browse gid"); require(setresuid(uid, uid, uid), "browse uid");
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 }; struct __user_cap_data_struct caps[2] = {{0}, {0}};
    require(syscall(SYS_capset, &header, caps), "clear capabilities");
    require(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no new privileges");
    int worker = open(argv[1], O_RDONLY | O_CLOEXEC); require(worker, "worker");
    install_filter(0);
    char *args[] = { "/file-worker", argv[4], argv[5], argv[6], argv[2], argv[7], argv[8], argv[9], NULL }; char *env[] = { "LANG=C", "LC_ALL=C", NULL };
    syscall(SYS_execveat, worker, "", args, env, AT_EMPTY_PATH); perror("exec worker"); return 77;
}
