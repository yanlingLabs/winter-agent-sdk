#define _GNU_SOURCE
/* Linux-only disposable validation launcher, NOT the production supervisor. */
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

static void require(int result, const char *label) {
    if (result < 0) { perror(label); _exit(77); }
}
static void path(char *out, size_t size, const char *root, const char *name) {
    if (snprintf(out, size, "%s/%s", root, name) >= (int)size) { errno=ENAMETOOLONG; require(-1,"fixture path"); }
}
static void bind(const char *source, const char *target, int ro, int executable) {
    require(mount(source,target,NULL,MS_BIND,NULL),"bind");
    require(mount(NULL,target,NULL,MS_REMOUNT|MS_BIND|MS_NOSUID|MS_NODEV|(ro?MS_RDONLY:0)|(executable?0:MS_NOEXEC),NULL),"bind flags");
}
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
static void install_filter(int process) {
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
int main(int argc,char **argv) {
    /* WORKER FIXTURE VIEW UID POLICY OP ROOT REL LIMIT; all are host fixture inputs. */
    if((argc!=10 && argc!=11) || geteuid()!=0 || (strcmp(argv[5],"auto")&&strcmp(argv[5],"plan")))return 64;
    char *end;unsigned long uid=strtoul(argv[4],&end,10);
    if(*end || (uid!=10001 && uid!=10002))return 64;
    const char expected_marker[]="winter-guest-file-fixture\n";
    char marker[4096],content[40]={0};path(marker,sizeof(marker),argv[2],".fixture");
    int marked=open(marker,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
    if(marked<0 || read(marked,content,sizeof(content)-1)!=(ssize_t)(sizeof(expected_marker)-1) || strcmp(content,expected_marker))return 64;
    close(marked);
    require(unshare(CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUTS|CLONE_NEWNET|CLONE_NEWPID),"unshare");
    require(mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL),"private mounts");
    pid_t child=fork();require(child,"fork");
    if(child){int status;while(waitpid(child,&status,0)<0)if(errno!=EINTR)return 77;return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);}
    require(mount("tmpfs",argv[3],"tmpfs",MS_NOSUID|MS_NODEV,"mode=0755,size=8m"),"tool view");
    char target[4096],source[4096];
    const char *roots[]={"source","readonly"};
    for(int index=0;index<2;index++){
        path(target,sizeof(target),argv[3],roots[index]);require(mkdir(target,0755),"mountpoint");
        path(source,sizeof(source),argv[2],roots[index]);bind(source,target,index==1||!strcmp(argv[5],"plan"),0);
    }
    int process=!strcmp(argv[6],"process");
    if(process){
        if(argc!=11)return 64;
        const char *runtime_roots[]={"bin","lib","lib64","usr"};
        for(int index=0;index<4;index++){
            path(source,sizeof(source),argv[2],"runtime");
            char runtime_source[4096];path(runtime_source,sizeof(runtime_source),source,runtime_roots[index]);
            struct stat st;if(stat(runtime_source,&st)){if(errno==ENOENT)continue;require(-1,"runtime stat");}
            path(target,sizeof(target),argv[3],runtime_roots[index]);require(mkdir(target,0755),"runtime mountpoint");bind(runtime_source,target,1,1);
        }
        path(target,sizeof(target),argv[3],"tmp");require(mkdir(target,0755),"scratch mountpoint");
        require(mount("tmpfs",target,"tmpfs",MS_NOSUID|MS_NODEV|MS_NOEXEC,"mode=1777,size=8m"),"scratch");
    }
    path(target,sizeof(target),argv[3],"file-worker");require(close(open(target,O_WRONLY|O_CREAT|O_EXCL,0555)),"worker point");
    bind(argv[1],target,1,1);
    require(mount(NULL,argv[3],NULL,MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NODEV,NULL),"readonly skeleton");
    require(chdir(argv[3]),"view cwd");require(chroot("."),"view root");require(chdir("/source"),"source cwd");
    require(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0),"no new privileges");
    for(int cap=0;cap<=CAP_LAST_CAP;cap++)require(prctl(PR_CAPBSET_DROP,cap,0,0,0),"drop bounding capability");
    gid_t group=10000;require(setgroups(1,&group),"workspace group");
    require(setresgid(uid,uid,uid),"tool gid");require(setresuid(uid,uid,uid),"tool uid");
    struct __user_cap_header_struct header={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};
    struct __user_cap_data_struct caps[2]={{0},{0}};require(syscall(SYS_capset,&header,caps),"clear caps");
    require(syscall(SYS_close_range,3U,~0U,0U),"close inherited descriptors");
    install_filter(process);umask(0002);
    char *args[]={"/file-worker",argv[6],argv[7],argv[8],argv[4],argv[9],argc==11?argv[10]:NULL,NULL};
    char *process_args[]={"/file-worker",argv[7],argv[8],argv[4],argv[9],argc==11?argv[10]:NULL,NULL};
    char *env[]={"LANG=C","LC_ALL=C",NULL};
    execve(args[0],process?process_args:args,env);require(-1,"execute file worker");return 77;
}
