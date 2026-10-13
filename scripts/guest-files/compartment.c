#define _GNU_SOURCE
/* Linux-only disposable validation launcher, NOT the production supervisor. */
#include "../../packages/runtime/src/guest/linux-compartment.h"
#include <linux/mount.h>
#include <sys/sysmacros.h>

/* The shared process worker requires an identity-checked EOF stdin device.
 * Keep the older file fixture's view narrow: only this process-only node,
 * with no procfs, descriptor links or whole-host device-directory bind. */
static int null_mount(void) {
    int fd=open("/dev/null",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);require(fd,"fixture null device");
    struct stat info;require(fstat(fd,&info),"fixture null identity");
    if(!S_ISCHR(info.st_mode)||major(info.st_rdev)!=1||minor(info.st_rdev)!=3||(fcntl(fd,F_GETFL)&O_ACCMODE)!=O_RDONLY)_exit(64);
    int tree=(int)syscall(SYS_open_tree,fd,"",OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH);require(tree,"fixture null clone");
    struct mount_attr attributes={.attr_set=MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NOEXEC,.attr_clr=MOUNT_ATTR_NODEV,.propagation=MS_PRIVATE};
    require((int)syscall(SYS_mount_setattr,tree,"",AT_EMPTY_PATH,&attributes,sizeof attributes),"fixture null flags");
    close(fd);return tree;
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
    int process=!strcmp(argv[6],"process"),null_tree=-1;
    if(process){if(argc!=11)return 64;null_tree=null_mount();}
    require(unshare(CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUTS|CLONE_NEWNET|CLONE_NEWPID),"unshare");
    require(mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL),"private mounts");
    pid_t child=fork();require(child,"fork");
    if(child){int status;while(waitpid(child,&status,0)<0)if(errno!=EINTR)return 77;return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);}
    require(mount("tmpfs",argv[3],"tmpfs",MS_NOSUID|MS_NODEV,"mode=0755,size=8m"),"tool view");
    char target[4096],source[4096];
    const char *roots[]={"source","readonly"};
    for(int index=0;index<2;index++){
        path(target,sizeof(target),argv[3],roots[index]);require(mkdir(target,0755),"mountpoint");
        path(source,sizeof(source),argv[2],roots[index]);guest_bind(source,target,index==1||!strcmp(argv[5],"plan"),0);
    }
    if(process){
        const char *runtime_roots[]={"bin","lib","lib64","usr"};
        for(int index=0;index<4;index++){
            path(source,sizeof(source),argv[2],"runtime");
            char runtime_source[4096];path(runtime_source,sizeof(runtime_source),source,runtime_roots[index]);
            struct stat st;if(stat(runtime_source,&st)){if(errno==ENOENT)continue;require(-1,"runtime stat");}
            path(target,sizeof(target),argv[3],runtime_roots[index]);require(mkdir(target,0755),"runtime mountpoint");guest_bind(runtime_source,target,1,1);
        }
        path(target,sizeof(target),argv[3],"tmp");require(mkdir(target,0755),"scratch mountpoint");
        require(mount("tmpfs",target,"tmpfs",MS_NOSUID|MS_NODEV|MS_NOEXEC,"mode=1777,size=8m"),"scratch");
        path(target,sizeof(target),argv[3],"dev");require(mkdir(target,0755),"device mountpoint");
        path(target,sizeof(target),argv[3],"dev/null");require(close(open(target,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0666)),"null mountpoint");
        require((int)syscall(SYS_move_mount,null_tree,"",AT_FDCWD,target,MOVE_MOUNT_F_EMPTY_PATH),"attach fixture null");
        close(null_tree);
    }
    path(target,sizeof(target),argv[3],"file-worker");require(close(open(target,O_WRONLY|O_CREAT|O_EXCL,0555)),"worker point");
    guest_bind(argv[1],target,1,1);
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
