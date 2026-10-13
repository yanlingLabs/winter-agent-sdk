#define _GNU_SOURCE
/* Protected Linux supervisor launcher. Inputs/FDs are constructed by the root service,
 * never passed through from runtime requests. Shared primitives match the reviewed fixture. */
#include "linux-compartment.h"
#include <stdint.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <linux/mount.h>

static int descriptor(const char *text) {
    char *end;long number=strtol(text,&end,10);
    if(!*text || *end || number<3 || number>65535)_exit(64);
    int fd=(int)number;if(fcntl(fd,F_GETFD)<0)_exit(64);return fd;
}
static int number(const char *text,int minimum,int maximum) {
    char *end;long value=strtol(text,&end,10);
    if(!*text || *end || value<minimum || value>maximum)_exit(64);
    return (int)value;
}
static void pinned_file(int fd) {
    struct stat st;require(fstat(fd,&st),"artifact identity");
    if(!S_ISREG(st.st_mode) || st.st_uid!=0 || st.st_nlink!=1 || (st.st_mode&0222))_exit(64);
}
static void directory_fd(int fd) {
    struct stat st;require(fstat(fd,&st),"root identity");if(!S_ISDIR(st.st_mode))_exit(64);
}
/* Inherited descriptors retain paths in the parent's mount namespace. A legacy
 * MS_BIND of /proc/self/fd/N can therefore fail EINVAL after unshare. Clone the
 * exact admitted descriptor into a detached mount, then attach that object.
 * Detached clones retain source propagation, so privatize each before attachment;
 * the later recursive private operation on / cannot reach these detached trees. */
static int clone_descriptor(int fd,int readonly,int executable) {
    int tree=(int)syscall(SYS_open_tree,fd,"",OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH);
    require(tree,"clone admitted mount");
    struct mount_attr attributes={.attr_set=MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV|(readonly?MOUNT_ATTR_RDONLY:0)|(executable?0:MOUNT_ATTR_NOEXEC),.propagation=MS_PRIVATE};
    require((int)syscall(SYS_mount_setattr,tree,"",AT_EMPTY_PATH,&attributes,sizeof attributes),"admitted mount flags");
    return tree;
}
static void attach_descriptor(int tree,const char *target) {
    require((int)syscall(SYS_move_mount,tree,"",AT_FDCWD,target,MOVE_MOUNT_F_EMPTY_PATH),"attach admitted mount");
    close(tree);
}
static void point(const char *root,const char *guest,char *out,size_t size) {
    if(guest[0]!='/' || !guest[1] || strstr(guest,"..") || strlen(guest)>1024)_exit(64);
    path(out,size,root,guest+1);
    char parent[4096];strcpy(parent,out);
    for(char *p=parent+strlen(root)+1;*p;p++)if(*p=='/'){*p=0;if(mkdir(parent,0755)&&errno!=EEXIST)require(-1,"root skeleton");*p='/';}
    require(mkdir(out,0755),"root mountpoint");
}
int main(int argc,char **argv) {
    if(geteuid()!=0 || argc<15)_exit(64);
    int worker=descriptor(argv[1]),control=descriptor(argv[3]),environment=descriptor(argv[4]);
    struct stat view_identity;
    if(lstat(argv[2],&view_identity) || !S_ISDIR(view_identity.st_mode) || view_identity.st_uid!=0 || (view_identity.st_mode&0777)!=0700)_exit(64);
    int uid=number(argv[5],1000,65535),gid=number(argv[6],1000,65535),roots=number(argv[14],1,16);
    if(argc!=15+3*roots || (strcmp(argv[7],"auto")&&strcmp(argv[7],"plan")))_exit(64);
    int process=!strcmp(argv[8],"process");if(!process&&strcmp(argv[8],"file"))_exit(64);
    pinned_file(worker);directory_fd(environment);
    for(int i=0;i<roots;i++){directory_fd(descriptor(argv[15+3*i]));number(argv[17+3*i],0,1);}
    int supervisor_pidfd=(int)syscall(SYS_pidfd_open,getppid(),0);require(supervisor_pidfd,"supervisor pidfd");
    require(prctl(PR_SET_PDEATHSIG,SIGKILL),"supervisor owner death");struct pollfd supervisor={.fd=supervisor_pidfd,.events=POLLIN};
    if(poll(&supervisor,1,0)!=0)_exit(77);
    close(supervisor_pidfd);
    int parent_pidfd=(int)syscall(SYS_pidfd_open,getpid(),0);require(parent_pidfd,"parent pidfd");
    /* Clone while admitted descriptors still belong to the current mount namespace.
     * Detached mount objects can then cross into the child's private namespace. */
    int root_trees[16],environment_trees[4]={-1,-1,-1,-1};
    const char *environment_parts[]={"bin","lib","lib64","usr"};
    for(int i=0;i<roots;i++)root_trees[i]=clone_descriptor(descriptor(argv[15+3*i]),number(argv[17+3*i],0,1)||!strcmp(argv[7],"plan"),0);
    int worker_tree=clone_descriptor(worker,1,1);
    if(process)for(int i=0;i<4;i++){
        int part=openat(environment,environment_parts[i],O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
        if(part<0){if(errno==ENOENT)continue;require(-1,"environment identity");}
        environment_trees[i]=clone_descriptor(part,1,1);close(part);
    }
    require(unshare(CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUTS|CLONE_NEWNET|CLONE_NEWPID),"namespace admission");
    require(mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL),"private mounts");
    pid_t child=fork();require(child,"namespace init");
    if(child){
        close(parent_pidfd);int init_pidfd=(int)syscall(SYS_pidfd_open,child,0);require(init_pidfd,"init pidfd");
        char marker='I',ancillary[CMSG_SPACE(sizeof(int))]={0};struct iovec vector={&marker,1};
        struct msghdr message={0};message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=ancillary;message.msg_controllen=sizeof ancillary;
        struct cmsghdr *c=CMSG_FIRSTHDR(&message);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(c),&init_pidfd,sizeof init_pidfd);
        if(sendmsg(control,&message,MSG_NOSIGNAL)!=1){syscall(SYS_pidfd_send_signal,init_pidfd,SIGKILL,NULL,0);_exit(77);}
        close(init_pidfd);int status;
        while(waitpid(child,&status,0)<0)if(errno!=EINTR)_exit(77);
        /* Linux PID-namespace init exit completes namespace descendant teardown. This immutable
         * parent receipt follows actual waitpid, not a timeout, EOF or a successful kill(). */
        unsigned char receipt[5]={'R',0,0,0,0};uint32_t value=(uint32_t)status;memcpy(receipt+1,&value,4);
        if(send(control,receipt,sizeof receipt,MSG_NOSIGNAL)!=(ssize_t)sizeof receipt)_exit(77);
        return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
    }
    close(control);
    const char *root=argv[2];char target[4096];
    require(mount("tmpfs",root,"tmpfs",MS_NOSUID|MS_NODEV,"mode=0755,size=16m"),"tool view");
    for(int i=0;i<roots;i++){
        point(root,argv[16+3*i],target,sizeof target);
        attach_descriptor(root_trees[i],target);
    }
    if(process){
        for(int i=0;i<4;i++){
            if(environment_trees[i]<0)continue;
            path(target,sizeof target,root,environment_parts[i]);require(mkdir(target,0755),"environment mountpoint");attach_descriptor(environment_trees[i],target);
        }
        path(target,sizeof target,root,"tmp");require(mkdir(target,0755),"scratch mountpoint");
        require(mount("tmpfs",target,"tmpfs",MS_NOSUID|MS_NODEV|MS_NOEXEC,"mode=1777,size=8m"),"private scratch");
    }
    path(target,sizeof target,root,"file-worker");require(close(open(target,O_WRONLY|O_CREAT|O_EXCL,0555)),"helper point");attach_descriptor(worker_tree,target);
    require(mount(NULL,root,NULL,MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NODEV,NULL),"protected skeleton");
    require(chdir(root),"view cwd");require(chroot("."),"view root");require(chdir(argv[10]),"admitted source cwd");
    require(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0),"no new privileges");
    for(int cap=0;cap<=CAP_LAST_CAP;cap++)require(prctl(PR_CAPBSET_DROP,cap,0,0,0),"drop bounding capabilities");
    gid_t group=(gid_t)gid;require(setgroups(1,&group),"workspace group");
    require(setresgid(uid,uid,uid),"tool gid");require(setresuid(uid,uid,uid),"tool uid");
    require(prctl(PR_SET_PDEATHSIG,SIGKILL),"native owner death");struct pollfd parent={.fd=parent_pidfd,.events=POLLIN};
    if(poll(&parent,1,0)!=0)_exit(77);
    close(parent_pidfd);
    struct __user_cap_header_struct header={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};struct __user_cap_data_struct caps[2]={{0},{0}};require(syscall(SYS_capset,&header,caps),"clear capabilities");
    require(syscall(SYS_close_range,3U,~0U,0U),"close private inherited descriptors");install_filter(process);umask(0002);
    char *args[]={"/file-worker",argv[9],argv[10],argv[11],argv[5],argv[12],strcmp(argv[13],"-")?argv[13]:NULL,NULL};
    char *shell[]={"/file-worker",argv[10],argv[11],argv[5],argv[9],argv[12],NULL};char *env[]={"LANG=C","LC_ALL=C",NULL};
    execve(args[0],process?shell:args,env);require(-1,"immutable helper exec");return 77;
}
