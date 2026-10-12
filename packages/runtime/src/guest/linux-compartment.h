/* Shared Linux tool namespace/mount/filter primitives. Root-owned supervisor input only. */
#ifndef WINTER_LINUX_COMPARTMENT_H
#define WINTER_LINUX_COMPARTMENT_H
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static inline void require(int result, const char *label) {
    if (result < 0) { perror(label); _exit(77); }
}
static inline void path(char *out, size_t size, const char *root, const char *name) {
    if (snprintf(out, size, "%s/%s", root, name) >= (int)size) { errno=ENAMETOOLONG; require(-1,"fixture path"); }
}
static inline void guest_bind(const char *source, const char *target, int ro, int executable) {
    require(mount(source,target,NULL,MS_BIND,NULL),"bind");
    require(mount(NULL,target,NULL,MS_REMOUNT|MS_BIND|MS_NOSUID|MS_NODEV|(ro?MS_RDONLY:0)|(executable?0:MS_NOEXEC),NULL),"bind flags");
}
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
static inline void install_filter(int process) {
#if defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#else
#error unsupported Linux fixture architecture
#endif
    struct sock_filter entries[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,ARCH,1,0),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,0x40000000,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
        DENY(mount),DENY(umount2),DENY(chroot),DENY(pivot_root),DENY(setns),DENY(unshare),
        DENY(ptrace),DENY(process_vm_readv),DENY(process_vm_writev),DENY(socket),
        /* Ordinary fork/threads only for the shell slice; namespace creation remains denied. */
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone,0,4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K,process?(CLONE_NEWNS|CLONE_NEWCGROUP|CLONE_NEWUTS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET):~0U),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,0,process?1:0,0),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        DENY(open_by_handle_at),DENY(name_to_handle_at),DENY(bpf),DENY(perf_event_open),
#ifdef __NR_clone3
        DENY(clone3),
#endif
#ifdef __NR_io_uring_setup
        DENY(io_uring_setup),
#endif
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program={.len=sizeof(entries)/sizeof(entries[0]),.filter=entries};
    require(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program),"seccomp");
}

#endif
