#define _GNU_SOURCE
/* Immutable root-service-only launcher for a fresh actual SDK executable. This
 * uses a different Unix-capable runtime filter; the tool filter remains separate. */
#include "linux-compartment.h"
#include <stdint.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <linux/mount.h>
static int number(const char *text,int minimum,int maximum){char *end;long n=strtol(text,&end,10);if(!*text||*end||n<minimum||n>maximum)_exit(64);return (int)n;}
static int descriptor(const char *text){int fd=number(text,3,65535);if(fcntl(fd,F_GETFD)<0)_exit(64);return fd;}
static void pinned_file(int fd){struct stat s;require(fstat(fd,&s),"artifact identity");if(!S_ISREG(s.st_mode)||s.st_uid!=0||s.st_nlink!=1||(s.st_mode&0222)||(fcntl(fd,F_GETFL)&O_ACCMODE)!=O_RDONLY)_exit(64);}
static void directory(int fd,int uid,int mode){struct stat s;require(fstat(fd,&s),"directory identity");if(!S_ISDIR(s.st_mode)||(uid>=0&&s.st_uid!=(uid_t)uid)||(mode>=0&&(s.st_mode&0777)!=(mode_t)mode))_exit(64);}
static int clone_mount(int fd,int ro,int executable){int tree=(int)syscall(SYS_open_tree,fd,"",OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH);require(tree,"clone runtime mount");struct mount_attr attr={.attr_set=MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV|(ro?MOUNT_ATTR_RDONLY:0)|(executable?0:MOUNT_ATTR_NOEXEC)};require((int)syscall(SYS_mount_setattr,tree,"",AT_EMPTY_PATH,&attr,sizeof attr),"runtime mount flags");return tree;}
static void attach(int tree,const char *target){require((int)syscall(SYS_move_mount,tree,"",AT_FDCWD,target,MOVE_MOUNT_F_EMPTY_PATH),"attach runtime mount");close(tree);}
static void point(const char *root,const char *guest,char out[4096],int file){
    if(*guest!='/'||!guest[1]||strstr(guest,"..")||strstr(guest,"//")||strlen(guest)>1024)_exit(64);
    path(out,4096,root,guest+1);char parent[4096];strcpy(parent,out);
    for(char *p=parent+strlen(root)+1;*p;p++)if(*p=='/'){*p=0;if(mkdir(parent,0755)&&errno!=EEXIST)require(-1,"runtime skeleton");*p='/';}
    if(file)require(close(open(out,O_WRONLY|O_CREAT|O_EXCL,0555)),"runtime artifact mountpoint");else require(mkdir(out,0755),"runtime directory mountpoint");
}
static int id(const char *s){return *s&&strlen(s)<=128&&strspn(s,"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")==strlen(s)&&*s!='.'&&*s!='-';}
static void runtime_filter(void){
    struct sock_filter entries[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,ARCH,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,0x40000000,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
        DENY(mount),DENY(umount2),DENY(chroot),DENY(pivot_root),DENY(setns),DENY(unshare),
#ifdef __NR_open_tree
        DENY(open_tree),DENY(move_mount),DENY(mount_setattr),
#endif
        DENY(ptrace),DENY(process_vm_readv),DENY(process_vm_writev),DENY(open_by_handle_at),DENY(name_to_handle_at),DENY(bpf),DENY(perf_event_open),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_socket,0,4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AF_UNIX,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_socketpair,0,4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AF_UNIX,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone,0,4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K,CLONE_NEWNS|CLONE_NEWCGROUP|CLONE_NEWUTS|CLONE_NEWIPC|CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,0,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#ifdef __NR_clone3
        /* libc/Bun can fall back to flag-inspected clone for threads. */
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_clone3,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|ENOSYS),
#endif
#ifdef __NR_io_uring_setup
        DENY(io_uring_setup),
#endif
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    };struct sock_fprog program={sizeof entries/sizeof entries[0],entries};require(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program),"runtime seccomp");
}
/* argv fixed by root: executable, view, receiptSocket, environment, runtimeUid,
 * workspaceGid, bootstrapSocket, ownerLibrary, store, runhome, controlDirectory,
 * logicalSessionId, policy, roots then triples (sourceFD, guestPath, readOnly). */
int main(int argc,char **argv){
    if(geteuid()!=0||argc<15)_exit(64);
    int executable=descriptor(argv[1]),control=descriptor(argv[3]),environment=descriptor(argv[4]),uid=number(argv[5],1000,65535),gid=number(argv[6],1000,65535),bootstrap=descriptor(argv[7]),owner=descriptor(argv[8]),store=descriptor(argv[9]),home=descriptor(argv[10]),sockets=descriptor(argv[11]),roots=number(argv[14],1,16);
    if(argc!=15+3*roots||!id(argv[12])||(strcmp(argv[13],"auto")&&strcmp(argv[13],"plan")))_exit(64);
    struct stat view;if(lstat(argv[2],&view)||!S_ISDIR(view.st_mode)||view.st_uid!=0||(view.st_mode&0777)!=0700)_exit(64);
    pinned_file(executable);pinned_file(owner);directory(environment,0,-1);directory(store,uid,0700);directory(home,uid,0700);directory(sockets,0,0750);
    int service=(int)syscall(SYS_pidfd_open,getppid(),0);require(service,"runtime service pidfd");require(prctl(PR_SET_PDEATHSIG,SIGKILL),"runtime service death");struct pollfd service_live={service,POLLIN,0};if(poll(&service_live,1,0)!=0)_exit(77);close(service);
    int parent=(int)syscall(SYS_pidfd_open,getpid(),0);require(parent,"runtime parent pidfd");
    int trees[16],envtrees[4]={-1,-1,-1,-1};const char *parts[]={"bin","lib","lib64","usr"};
    for(int i=0;i<roots;i++){directory(descriptor(argv[15+3*i]),-1,-1);trees[i]=clone_mount(descriptor(argv[15+3*i]),number(argv[17+3*i],0,1)||!strcmp(argv[13],"plan"),0);}
    int exetree=clone_mount(executable,1,1),ownertree=clone_mount(owner,1,1),storetree=clone_mount(store,0,0),hometree=clone_mount(home,0,0),sockettree=clone_mount(sockets,1,0);
    for(int i=0;i<4;i++){int fd=openat(environment,parts[i],O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(fd<0){if(errno==ENOENT)continue;require(-1,"runtime environment");}envtrees[i]=clone_mount(fd,1,1);close(fd);}
    require(unshare(CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUTS|CLONE_NEWNET|CLONE_NEWPID),"runtime namespaces");require(mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL),"runtime private mounts");pid_t child=fork();require(child,"runtime namespace init");
    if(child){
        close(parent);close(bootstrap);int init=(int)syscall(SYS_pidfd_open,child,0);require(init,"runtime init pidfd");
        char marker='I',ancillary[CMSG_SPACE(sizeof(int))]={0};struct iovec vector={&marker,1};struct msghdr message={0};message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=ancillary;message.msg_controllen=sizeof ancillary;struct cmsghdr *c=CMSG_FIRSTHDR(&message);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(c),&init,sizeof init);
        if(sendmsg(control,&message,MSG_NOSIGNAL)!=1){syscall(SYS_pidfd_send_signal,init,SIGKILL,NULL,0);_exit(77);}close(init);int status;while(waitpid(child,&status,0)<0)if(errno!=EINTR)_exit(77);
        unsigned char receipt[5]={'R',0,0,0,0};uint32_t value=(uint32_t)status;memcpy(receipt+1,&value,4);if(send(control,receipt,5,MSG_NOSIGNAL)!=5)_exit(77);return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
    }
    close(control);const char *root=argv[2];char target[4096],guest[512];require(mount("tmpfs",root,"tmpfs",MS_NOSUID|MS_NODEV,"mode=0755,size=16m"),"runtime view");
    for(int i=0;i<roots;i++){point(root,argv[16+3*i],target,0);attach(trees[i],target);}
    for(int i=0;i<4;i++)if(envtrees[i]>=0){snprintf(guest,sizeof guest,"/%s",parts[i]);point(root,guest,target,0);attach(envtrees[i],target);}
    point(root,"/winter-runtime",target,1);attach(exetree,target);point(root,"/winter-owner.so",target,1);attach(ownertree,target);
    snprintf(guest,sizeof guest,"/workspace/.winter/conversations/%s",argv[12]);point(root,guest,target,0);attach(storetree,target);
    snprintf(guest,sizeof guest,"/run/winter/conversations/%s",argv[12]);point(root,guest,target,0);attach(hometree,target);
    snprintf(guest,sizeof guest,"/run/winter/conversations/%s/.control",argv[12]);point(root,guest,target,0);attach(sockettree,target);
    point(root,"/proc",target,0);require(mount("proc",target,"proc",MS_NOSUID|MS_NODEV|MS_NOEXEC,NULL),"runtime private proc");
    point(root,"/tmp",target,0);require(mount("tmpfs",target,"tmpfs",MS_NOSUID|MS_NODEV|MS_NOEXEC,"mode=1777,size=16m"),"runtime temporary files");
    point(root,"/dev",target,0);strcat(target,"/null");require(close(open(target,O_WRONLY|O_CREAT|O_EXCL,0666)),"runtime null device");require(mount("/dev/null",target,NULL,MS_BIND,NULL),"runtime null mount");
    require(mount(NULL,root,NULL,MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NODEV,NULL),"runtime readonly skeleton");require(chdir(root),"runtime view cwd");require(chroot("."),"runtime root");require(chdir(argv[16]),"runtime admitted cwd");
    /* The parent monitor may itself occupy fd3/fd4. Preserve it before either
     * fixed remap; close_range still disposes of the monitor before SDK exec. */
    int parentcopy=fcntl(parent,F_DUPFD_CLOEXEC,64);require(parentcopy,"runtime parent copy");
    /* Preserve fixed bootstrap/library descriptors without an alias collision. */
    int bootcopy=fcntl(bootstrap,F_DUPFD_CLOEXEC,64),ownercopy=fcntl(owner,F_DUPFD_CLOEXEC,64);require(bootcopy,"bootstrap copy");require(ownercopy,"owner copy");require(dup2(bootcopy,3),"bootstrap fd3");require(dup2(ownercopy,4),"owner fd4");
    require(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0),"runtime no new privileges");for(int cap=0;cap<=CAP_LAST_CAP;cap++)require(prctl(PR_CAPBSET_DROP,cap,0,0,0),"runtime bounding capabilities");gid_t group=(gid_t)gid;require(setgroups(1,&group),"runtime workspace group");require(setresgid(uid,uid,uid),"runtime gid");require(setresuid(uid,uid,uid),"runtime uid");require(prctl(PR_SET_PDEATHSIG,SIGKILL),"runtime owner death");struct pollfd alive={parentcopy,POLLIN,0};if(poll(&alive,1,0)!=0)_exit(77);
    struct __user_cap_header_struct header={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};struct __user_cap_data_struct caps[2]={{0},{0}};require(syscall(SYS_capset,&header,caps),"runtime zero capabilities");require(syscall(SYS_close_range,5U,~0U,0U),"runtime close inherited descriptors");runtime_filter();umask(0077);
    char homeenv[512];snprintf(homeenv,sizeof homeenv,"HOME=/run/winter/conversations/%s",argv[12]);char *env[]={"LANG=C","LC_ALL=C",homeenv,"PATH=/usr/bin:/bin","TMPDIR=/tmp",NULL};char *args[]={"/winter-runtime","--native-bootstrap-fd","3","--native-owner-fd","4",NULL};execve(args[0],args,env);require(-1,"immutable SDK exec");return 77;
}
