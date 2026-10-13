#define _GNU_SOURCE
/* SOURCE PREREQUISITE ONLY: distinct Root-created one-shot reader role. This is
 * deliberately unwired: no runtime/profile/producer or existing launcher change.
 * Root must admit the complete immutable loader closure and reserve reader UID.
 * Source compilation is not Linux confinement or honest Bun compatibility proof. */
#include "linux-compartment.h"
#include <stdint.h>
#include <poll.h>
#include <signal.h>
#include <time.h>
#include <sys/resource.h>
#include <linux/mount.h>

#define READER_DEPENDENCIES 32
#define READER_WALL_MS 4000
#define READER_SHARED "/run/winter/shared-instructions"
#define READER_HOME "/run/winter/instruction-reader"

/* BEGIN PORTABLE CONTRACT -- pure parsing, no descriptor or native effects. */
struct reader_plan {
    int executable, receipt, uid, group, source, shared, dependencies;
    const char *view, *source_path, *cwd;
    int dependency_fds[READER_DEPENDENCIES];
    const char *dependency_paths[READER_DEPENDENCIES];
};
static int reader_number(const char *text, int minimum, int maximum, int *out) {
    unsigned int value=0;
    if(!text || !*text || (text[0]=='0' && text[1]))return 0;
    for(const unsigned char *p=(const unsigned char *)text;*p;p++) {
        if(*p<'0'||*p>'9'||value>(unsigned int)maximum/10)return 0;
        value=value*10+(*p-'0');if(value>(unsigned int)maximum)return 0;
    }
    if(value<(unsigned int)minimum)return 0;
    *out=(int)value;return 1;
}
static int reader_id(const char *text) {
    size_t length=text?strlen(text):0;
    if(!length||length>128||!((text[0]>='A'&&text[0]<='Z')||(text[0]>='a'&&text[0]<='z')||(text[0]>='0'&&text[0]<='9')))return 0;
    return strspn(text,"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")==length;
}
static int reader_path(const char *text, size_t maximum) {
    if(!text||text[0]!='/'||!text[1]||strlen(text)>maximum)return 0;
    const char *part=text+1;
    for(const unsigned char *p=(const unsigned char *)part;;p++) {
        if(!*p||*p=='/') {
            size_t length=(const char *)p-part;
            if(!length||(length==1&&part[0]=='.')||(length==2&&part[0]=='.'&&part[1]=='.'))return 0;
            if(!*p)return 1;
            part=(const char *)p+1;
        } else if(*p<33||*p>126)return 0;
    }
}
static int reader_source_path(const char *text) {
    const char *prefixes[]={"/workspace/folders/","/workspace/repos/"};
    if(!text)return 0;
    for(size_t i=0;i<2;i++)if(!strncmp(text,prefixes[i],strlen(prefixes[i])))return reader_id(text+strlen(prefixes[i]));
    return 0;
}
static int reader_dependency_path(const char *text) {
    if(!reader_path(text,1024))return 0;
    return !strncmp(text,"/lib/",5)||!strncmp(text,"/lib64/",7)||!strncmp(text,"/usr/lib/",9);
}
static int reader_parse(int argc, char **argv, struct reader_plan *plan) {
    memset(plan,0,sizeof *plan);
    if(argc<12||strcmp(argv[1],"instruction-reader-v1")||
       !reader_number(argv[2],3,65535,&plan->executable)||
       !reader_number(argv[4],3,65535,&plan->receipt)||
       !reader_number(argv[5],1000,65535,&plan->uid)||
       !reader_number(argv[6],1000,65535,&plan->group)||
       !reader_number(argv[7],3,65535,&plan->source)||
       !reader_number(argv[10],3,65535,&plan->shared)||
       !reader_number(argv[11],0,READER_DEPENDENCIES,&plan->dependencies)||
       argc!=12+2*plan->dependencies)return 0;
    const char *view_prefix="/run/winter/instruction-reader-views/";
    if(strncmp(argv[3],view_prefix,strlen(view_prefix))||!reader_id(argv[3]+strlen(view_prefix))||
       !reader_source_path(argv[8])||!reader_path(argv[9],4096))return 0;
    size_t root_length=strlen(argv[8]);
    if(strncmp(argv[9],argv[8],root_length)||(argv[9][root_length]&&argv[9][root_length]!='/'))return 0;
    plan->view=argv[3];plan->source_path=argv[8];plan->cwd=argv[9];
    int fds[4+READER_DEPENDENCIES]={plan->executable,plan->receipt,plan->source,plan->shared};
    for(int i=0;i<plan->dependencies;i++) {
        if(!reader_number(argv[12+2*i],3,65535,&plan->dependency_fds[i])||!reader_dependency_path(argv[13+2*i]))return 0;
        plan->dependency_paths[i]=argv[13+2*i];fds[4+i]=plan->dependency_fds[i];
        for(int j=0;j<i;j++) {
            const char *a=plan->dependency_paths[i],*b=plan->dependency_paths[j];
            size_t al=strlen(a),bl=strlen(b);
            if(!strcmp(a,b)||(!strncmp(a,b,bl)&&a[bl]=='/')||(!strncmp(a,b,al)&&b[al]=='/'))return 0;
        }
    }
    for(int i=0;i<4+plan->dependencies;i++)for(int j=0;j<i;j++)if(fds[i]==fds[j])return 0;
    return 1;
}
/* END PORTABLE CONTRACT */

static void reader_fd(int fd) {
    int flags=fcntl(fd,F_GETFD);require(flags,"reader inherited descriptor");
    require(fcntl(fd,F_SETFD,flags|FD_CLOEXEC),"reader close-on-exec");
}
static void reader_file(int fd, int executable) {
    struct stat st;require(fstat(fd,&st),"reader immutable file");
    if(!S_ISREG(st.st_mode)||st.st_uid!=0||st.st_nlink!=1||(st.st_mode&0222)||
       (fcntl(fd,F_GETFL)&O_ACCMODE)!=O_RDONLY||(executable&&!(st.st_mode&0111)))_exit(64);
    reader_fd(fd);
}
static void reader_directory(int fd) {
    struct stat st;require(fstat(fd,&st),"reader selected directory");
    if(!S_ISDIR(st.st_mode))_exit(64);
    reader_fd(fd);
}
static void reader_pipes(void) {
    for(int fd=0;fd<3;fd++) {
        struct stat st;require(fstat(fd,&st),"reader explicit pipe");
        int flags=fcntl(fd,F_GETFL);require(flags,"reader pipe flags");
        if(!S_ISFIFO(st.st_mode)||(flags&O_ACCMODE)!=(fd==0?O_RDONLY:O_WRONLY))_exit(64);
        int descriptor_flags=fcntl(fd,F_GETFD);require(descriptor_flags,"reader pipe descriptor");
        require(fcntl(fd,F_SETFD,descriptor_flags&~FD_CLOEXEC),"reader surviving pipe");
    }
}
/* All view ancestors are Root-owned and nonwritable by other identities. The
 * caller must hold this directory empty and exclusive for the reader lifetime. */
static void reader_view(const char *view) {
    int fd=open("/",O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);require(fd,"reader view root");
    char copy[512];
    if(strlen(view)>=sizeof copy)_exit(64);
    strcpy(copy,view+1);
    char *save=NULL;
    for(char *part=strtok_r(copy,"/",&save);part;part=strtok_r(NULL,"/",&save)) {
        int next=openat(fd,part,O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);require(next,"reader view ancestor");
        close(fd);fd=next;struct stat st;require(fstat(fd,&st),"reader view ownership");
        if(st.st_uid!=0||(st.st_mode&0022)||(!*save&&(st.st_mode&0777)!=0700))_exit(64);
    }
    close(fd);
}
static int reader_clone(int fd, int executable) {
    int recursive=executable?0:AT_RECURSIVE; /* executable closure entries are exact files */
    int tree=(int)syscall(SYS_open_tree,fd,"",OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH|recursive);
    require(tree,"reader admitted clone");
    struct mount_attr attr={.attr_set=MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV|
        (executable?0:MOUNT_ATTR_NOEXEC),.propagation=MS_PRIVATE};
    require((int)syscall(SYS_mount_setattr,tree,"",AT_EMPTY_PATH|recursive,&attr,sizeof attr),"reader recursive mount flags");
    return tree;
}
static void reader_attach(int tree, const char *target) {
    require((int)syscall(SYS_move_mount,tree,"",AT_FDCWD,target,MOVE_MOUNT_F_EMPTY_PATH),"reader mount attach");close(tree);
}
static void reader_point(const char *root, const char *guest, char out[8192], int file) {
    if(!reader_path(guest,4096))_exit(64);
    path(out,8192,root,guest+1);
    char parents[8192];strcpy(parents,out);
    for(char *p=parents+strlen(root)+1;*p;p++)if(*p=='/') {
        *p=0;if(mkdir(parents,0755)&&errno!=EEXIST)require(-1,"reader skeleton ancestor");*p='/';
    }
    if(file)require(close(open(out,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0555)),"reader file mountpoint");
    else require(mkdir(out,0755),"reader directory mountpoint");
}

/* Separate filter: no sockets at all, no child processes. Bun threads may use
 * only the explicit pthread flags; clone3 ENOSYS allows libc's checked fallback.
 * Honest compiled Bun compatibility has NOT been exercised with this filter. */
static void reader_filter(void) {
    const unsigned int thread_required=CLONE_VM|CLONE_SIGHAND|CLONE_THREAD;
    const unsigned int thread_allowed=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|
        CLONE_SYSVSEM|CLONE_SETTLS|CLONE_PARENT_SETTID|CLONE_CHILD_SETTID|CLONE_CHILD_CLEARTID;
    struct sock_filter entries[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,ARCH,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,0x40000000,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
        DENY(mount),DENY(umount2),DENY(chroot),DENY(pivot_root),DENY(setns),DENY(unshare),
        DENY(open_tree),DENY(move_mount),DENY(mount_setattr),
        DENY(ptrace),DENY(process_vm_readv),DENY(process_vm_writev),
        DENY(socket),DENY(socketpair),DENY(connect),DENY(bind),DENY(listen),DENY(accept),DENY(accept4),
        DENY(sendto),DENY(sendmsg),DENY(sendmmsg),DENY(recvmsg),DENY(recvmmsg),
        DENY(open_by_handle_at),DENY(name_to_handle_at),DENY(bpf),DENY(perf_event_open),
        DENY(pidfd_open),DENY(pidfd_getfd),DENY(pidfd_send_signal),DENY(io_uring_setup),
#ifdef __NR_fork
        DENY(fork),
#endif
#ifdef __NR_vfork
        DENY(vfork),
#endif
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone,0,12),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])+4),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,0,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K,~thread_allowed),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,0,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K,thread_required),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,thread_required,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone3,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|ENOSYS),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program={.len=sizeof entries/sizeof entries[0],.filter=entries};
    require(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program),"reader seccomp");
}
static void reader_limit(int resource, rlim_t value) {
    struct rlimit limit={value,value};require(setrlimit(resource,&limit),"reader resource ceiling");
}
static int64_t reader_milliseconds(void) {
    struct timespec now;require(clock_gettime(CLOCK_MONOTONIC,&now),"reader monotonic deadline");
    return (int64_t)now.tv_sec*1000+now.tv_nsec/1000000;
}
static void reader_kill(int pidfd) {
    if(syscall(SYS_pidfd_send_signal,pidfd,SIGKILL,NULL,0)<0&&errno!=ESRCH)require(-1,"reader namespace kill");
}
/* Parent-only native lifecycle. Root still owns output draining and outstanding
 * debt; neither this receipt nor JSON alone establishes producer completion. */
static int reader_monitor(pid_t child, int control, int parent, int64_t deadline) {
    close(parent);
    int init=(int)syscall(SYS_pidfd_open,child,0);require(init,"reader namespace pidfd");
    /* Remap from copies, then close EVERY original and stdio in the monitor. */
    int control_copy=fcntl(control,F_DUPFD_CLOEXEC,64),init_copy=fcntl(init,F_DUPFD_CLOEXEC,64);
    require(control_copy,"reader monitor control copy");require(init_copy,"reader monitor init copy");
    require(dup2(control_copy,3),"reader monitor control");require(dup2(init_copy,4),"reader monitor init");
    require((int)syscall(SYS_close_range,5U,~0U,0U),"reader monitor originals");
    for(int fd=0;fd<3;fd++)close(fd);
    control=3;init=4;
    char marker='I',ancillary[CMSG_SPACE(sizeof(int))]={0};struct iovec vector={&marker,1};
    struct msghdr message={.msg_iov=&vector,.msg_iovlen=1,.msg_control=ancillary,.msg_controllen=sizeof ancillary};
    struct cmsghdr *c=CMSG_FIRSTHDR(&message);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;
    c->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(c),&init,sizeof init);
    int control_live=sendmsg(control,&message,MSG_NOSIGNAL)==1;
    if(!control_live)reader_kill(init);
    while(control_live) {
        int64_t left=deadline-reader_milliseconds();if(left<=0){reader_kill(init);break;}
        struct pollfd live[2]={{init,POLLIN,0},{control,POLLIN|POLLHUP|POLLERR,0}};
        int ready=poll(live,2,(int)left);if(ready<0){if(errno==EINTR)continue;reader_kill(init);break;}
        if(live[0].revents&POLLIN)break;
        /* Any Root control packet is cancellation; no new requests/config here. */
        if(!ready||live[1].revents){reader_kill(init);break;}
    }
    int status;while(waitpid(child,&status,0)<0)if(errno!=EINTR)_exit(77);
    /* PID namespace init's actual wait is the descendant teardown receipt. */
    unsigned char receipt[5]={'R',0,0,0,0};uint32_t value=(uint32_t)status;memcpy(receipt+1,&value,4);
    if(!control_live||send(control,receipt,sizeof receipt,MSG_NOSIGNAL)!=(ssize_t)sizeof receipt)_exit(77);
    close(init);close(control);return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
}

int main(int argc, char **argv) {
    struct reader_plan plan;if(getuid()!=0||geteuid()!=0||!reader_parse(argc,argv,&plan))_exit(64);
    int64_t deadline=reader_milliseconds()+READER_WALL_MS;
    reader_pipes();reader_view(plan.view);reader_file(plan.executable,1);
    reader_directory(plan.source);reader_directory(plan.shared);reader_fd(plan.receipt);
    struct stat source,shared;require(fstat(plan.source,&source),"reader source identity");
    require(fstat(plan.shared,&shared),"reader shared identity");
    if(source.st_dev==shared.st_dev&&source.st_ino==shared.st_ino)_exit(64);
    int socket_type;socklen_t type_length=sizeof socket_type;
    require(getsockopt(plan.receipt,SOL_SOCKET,SO_TYPE,&socket_type,&type_length),"reader receipt type");
    struct ucred peer;socklen_t peer_length=sizeof peer;
    require(getsockopt(plan.receipt,SOL_SOCKET,SO_PEERCRED,&peer,&peer_length),"reader Root peer");
    if(socket_type!=SOCK_SEQPACKET||peer_length!=sizeof peer||peer.uid!=0||peer.pid!=getppid())_exit(64);
    for(int i=0;i<plan.dependencies;i++)reader_file(plan.dependency_fds[i],0);
    int service=(int)syscall(SYS_pidfd_open,getppid(),0);require(service,"reader service pidfd");
    require(prctl(PR_SET_PDEATHSIG,SIGKILL),"reader service death");struct pollfd owner={service,POLLIN,0};
    if(poll(&owner,1,0)!=0)_exit(77);
    close(service);
    int parent=(int)syscall(SYS_pidfd_open,getpid(),0);require(parent,"reader parent pidfd");
    int source_tree=reader_clone(plan.source,0),shared_tree=reader_clone(plan.shared,0),executable_tree=reader_clone(plan.executable,1);
    int dependencies[READER_DEPENDENCIES];
    for(int i=0;i<plan.dependencies;i++)dependencies[i]=reader_clone(plan.dependency_fds[i],1);
    require(unshare(CLONE_NEWNS|CLONE_NEWPID|CLONE_NEWIPC|CLONE_NEWUTS|CLONE_NEWNET),"reader namespaces");
    require(mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL),"reader private propagation");
    pid_t child=fork();require(child,"reader namespace init");
    if(child)return reader_monitor(child,plan.receipt,parent,deadline);
    close(plan.receipt);
    /* Arm before privileged child setup, then re-arm after the UID transition
     * which clears PDEATHSIG. The held pidfd closes the pre-arm death race. */
    require(prctl(PR_SET_PDEATHSIG,SIGKILL),"reader setup monitor death");
    struct pollfd setup_alive={parent,POLLIN,0};if(poll(&setup_alive,1,0)!=0)_exit(77);
    char target[8192];
    require(mount("tmpfs",plan.view,"tmpfs",MS_NOSUID|MS_NODEV|MS_NOEXEC,"mode=0755,size=16m"),"reader skeleton");
    reader_point(plan.view,plan.source_path,target,0);reader_attach(source_tree,target);
    reader_point(plan.view,READER_SHARED,target,0);reader_attach(shared_tree,target);
    reader_point(plan.view,"/instruction-reader",target,1);reader_attach(executable_tree,target);
    for(int i=0;i<plan.dependencies;i++) {
        reader_point(plan.view,plan.dependency_paths[i],target,1);reader_attach(dependencies[i],target);
    }
    reader_point(plan.view,READER_HOME,target,0);
    reader_point(plan.view,"/tmp",target,0);
    require(mount("tmpfs",target,"tmpfs",MS_NOSUID|MS_NODEV|MS_NOEXEC,"mode=1777,size=8m"),"reader private temporary files");
    require(mount(NULL,plan.view,NULL,MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NODEV|MS_NOEXEC,NULL),"reader readonly skeleton");
    require(chdir(plan.view),"reader view cwd");require(chroot("."),"reader root");require(chdir(READER_HOME),"reader empty readonly cwd");
    reader_limit(RLIMIT_CPU,3);reader_limit(RLIMIT_NOFILE,64);reader_limit(RLIMIT_NPROC,32);
    reader_limit(RLIMIT_CORE,0);reader_limit(RLIMIT_FSIZE,0);
    /* NO RLIMIT_AS: compiled Bun reserves substantial virtual address space.
     * Physical RSS/cgroup accounting and honest compatibility remain unproven. */
    require(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0),"reader no new privileges");
    for(int cap=0;cap<=CAP_LAST_CAP;cap++)require(prctl(PR_CAPBSET_DROP,cap,0,0,0),"reader bounding capabilities");
    gid_t group=(gid_t)plan.group;require(setgroups(1,&group),"reader selected workspace group");
    require(setresgid(plan.uid,plan.uid,plan.uid),"reader independent primary gid");
    require(setresuid(plan.uid,plan.uid,plan.uid),"reader independent uid");
    require(prctl(PR_SET_PDEATHSIG,SIGKILL),"reader monitor death");struct pollfd alive={parent,POLLIN,0};
    if(poll(&alive,1,0)!=0)_exit(77);
    struct __user_cap_header_struct header={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};
    struct __user_cap_data_struct caps[2]={{0},{0}};require((int)syscall(SYS_capset,&header,caps),"reader zero capabilities");
    /* Original source/shared/closure FDs name the parent mount: close, don't just
     * rely on CLOEXEC. There is no bootstrap, owner library, socket or root fd. */
    require((int)syscall(SYS_close_range,3U,~0U,0U),"reader explicit pipe-only envelope");
    reader_filter();umask(0077);
    char *args[]={"/instruction-reader","--instruction-reader-v1",NULL};
    char *environment[]={"LANG=C","LC_ALL=C","TZ=UTC","HOME=" READER_HOME,"TMPDIR=/tmp","PATH=/usr/bin:/bin",NULL};
    execve(args[0],args,environment);require(-1,"reader immutable exec");return 77;
}
