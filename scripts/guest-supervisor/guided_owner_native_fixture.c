/* TARGET ONLY: separately admitted disposable Linux Root fixture, never a VM.
 * The parent is the actual Root socket creator. The child is actual UID20001 /
 * PID1 in private namespaces with a fixture-only chroot, store and procfs.
 * Include the production C unchanged: there are no authority/syscall doubles.
 * The ordinary Python source suite never compiles or launches this fixture.
 */
#define _GNU_SOURCE
#include <assert.h>
#include <grp.h>
#include <sched.h>
#include <signal.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include "../../packages/runtime/src/guest/linux-session-owner.c"

#define RUNTIME_UID 20001
static void must(int result,const char *operation){if(result<0){perror(operation);exit(90);}}
static void path(char out[4096],const char *root,const char *relative){int n=snprintf(out,4096,"%s%s",root,relative);assert(n>0&&n<4096);}
static void prepare(const char *root){
    must(chmod(root,0755),"fixture chroot traversal mode");
    const char *directories[]={"/proc","/workspace","/workspace/.winter","/workspace/.winter/conversations","/workspace/.winter/conversations/logical"};
    for(size_t i=0;i<sizeof directories/sizeof *directories;i++){char p[4096];path(p,root,directories[i]);must(mkdir(p,0755),"fixture mkdir");}
    char store[4096];path(store,root,directories[4]);must(chown(store,RUNTIME_UID,RUNTIME_UID),"fixture chown");must(chmod(store,0700),"fixture mode");
}
static void byte(int fd,char value){assert(send(fd,&value,1,MSG_NOSIGNAL)==1);}
static char receive_byte(int fd){char value;assert(recv(fd,&value,1,0)==1);return value;}
static int send_record(int channel,int *fds,int count,int guided,int registration){
    char current[64],record[4096];assert(!boot(current));
    int length=snprintf(record,sizeof record,
        "{\"protocolVersion\":1,\"freshOnly\":true,\"runtimeUid\":20001,\"logicalSessionId\":\"logical\","
        "\"profile\":\"%s\"%s,\"scope\":{\"workspaceId\":\"workspace\",\"sessionId\":\"session\",\"incarnationId\":\"incarnation\","
        "\"leaseEpoch\":1,\"storeHome\":\"/workspace/.winter/conversations/logical\",\"currentBootId\":\"%s\"}}",
        guided?"host-query-guided-v1":"host-query-v1",registration?",\"readerRegistration\":{}":"",current);
    assert(length>0&&length<(int)sizeof record);
    char ancillary[CMSG_SPACE(sizeof(int)*5)]={0};struct iovec data={record,(size_t)length};struct msghdr message={0};
    message.msg_iov=&data;message.msg_iovlen=1;message.msg_control=ancillary;message.msg_controllen=CMSG_SPACE(sizeof(int)*(size_t)count);
    struct cmsghdr *rights=CMSG_FIRSTHDR(&message);rights->cmsg_level=SOL_SOCKET;rights->cmsg_type=SCM_RIGHTS;rights->cmsg_len=CMSG_LEN(sizeof(int)*(size_t)count);memcpy(CMSG_DATA(rights),fds,sizeof(int)*(size_t)count);
    return sendmsg(channel,&message,MSG_NOSIGNAL)==length;
}
static void child(int bootstrap,int control,int *inherited,int inherited_count,const char *root,const char *name,int expected){
    for(int i=0;i<inherited_count;i++)if(inherited[i]>=0&&inherited[i]!=bootstrap&&inherited[i]!=control)close(inherited[i]);
    must(unshare(CLONE_NEWNS),"fixture child mount namespace");must(mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL),"fixture child private propagation");
    char proc[4096];path(proc,root,"/proc");must(mount("proc",proc,"proc",MS_NOSUID|MS_NODEV|MS_NOEXEC,NULL),"fixture proc mount");
    must(chdir(root),"fixture chdir");must(chroot(root),"fixture chroot");must(chdir("/"),"fixture root chdir");must(setgroups(0,NULL),"fixture setgroups");must(setgid(RUNTIME_UID),"fixture setgid");must(setuid(RUNTIME_UID),"fixture setuid");
    assert(getpid()==1&&getuid()==RUNTIME_UID);byte(control,'R');
    uint64_t owner=winter_owner_open(bootstrap);assert((owner!=0)==expected);
    if(!expected){assert(!strcmp(winter_owner_error(),"bootstrap_invalid"));byte(control,'F');close(bootstrap);close(control);_exit(0);}
    assert(!winter_owner_check(owner));byte(control,'O');assert(receive_byte(control)=='C');
    if(!strcmp(name,"bootstrap-close"))assert(!winter_owner_check(owner));
    else if(!strcmp(name,"half-close")){assert(winter_owner_check(owner)==-1);assert(!strcmp(winter_owner_error(),"owner_lost"));}
    else if(!strcmp(name,"reader-shutdown")||!strcmp(name,"claim-twice")){
        int duplicate=winter_owner_claim_reader(owner);assert(duplicate>=3);assert(fcntl(duplicate,F_GETFD)&FD_CLOEXEC);assert(winter_owner_claim_reader(owner)==-1);
        if(!strcmp(name,"reader-shutdown")){
            winter_owner_reader_shutdown(owner);assert(winter_owner_check(owner)==-1);assert(!strcmp(winter_owner_error(),"owner_lost"));assert(fcntl(duplicate,F_GETFD)>=0);winter_owner_reader_shutdown(owner);
        }else assert(!winter_owner_check(owner));
        /* C shutdown/close must never numerically close the caller-owned dup,
         * even if the caller closes it and its number is reused by a new file. */
        close(duplicate);int replacement=open("/workspace",O_RDONLY|O_DIRECTORY|O_CLOEXEC);assert(replacement>=0);
        if(replacement!=duplicate){assert(dup2(replacement,duplicate)==duplicate);close(replacement);}
        winter_owner_close(owner);assert(fcntl(duplicate,F_GETFD)>=0);close(duplicate);owner=0;
    }
    if(owner)winter_owner_close(owner);
    close(control);_exit(0);
}
static void run(const char *name,const char *root,int count,int guided,int registration,int expected){
    int bootstrap[2],reader[2],control[2];must(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,bootstrap),"fixture bootstrap");must(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,reader),"fixture reader");must(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,control),"fixture control");
    int service=(int)syscall(SYS_pidfd_open,getpid(),0);must(service,"fixture service pidfd");
    char storepath[4096];path(storepath,root,"/workspace/.winter/conversations/logical");int store=open(storepath,O_RDONLY|O_DIRECTORY|O_CLOEXEC),exe=open("/proc/self/exe",O_RDONLY|O_CLOEXEC);must(store,"fixture store");must(exe,"fixture executable");
    char otherpath[4096];path(otherpath,root,"/not-socket");int other=open(otherpath,O_RDONLY|O_CREAT|O_CLOEXEC,0600);must(other,"fixture non-socket");
    must(unshare(CLONE_NEWPID),"fixture fresh PID namespace");
    pid_t pid=fork();must(pid,"fixture fork");
    if(pid==0){int inherited[]={bootstrap[0],bootstrap[1],reader[0],reader[1],control[0],control[1],service,store,exe,other};child(bootstrap[1],control[1],inherited,10,root,name,expected);}
    close(control[1]);int runtime=(int)syscall(SYS_pidfd_open,pid,0);must(runtime,"fixture runtime pidfd");assert(receive_byte(control[0])=='R');
    int descriptors[]={runtime,service,store,exe,reader[1]};
    if(!strncmp(name,"alias",5)&&name[5]>='0'&&name[5]<='3')descriptors[4]=descriptors[name[5]-'0'];
    if(!strcmp(name,"alias-bootstrap"))descriptors[4]=bootstrap[1];
    if(!strcmp(name,"non-socket"))descriptors[4]=other;
    assert(send_record(bootstrap[0],descriptors,count,guided,registration));close(bootstrap[1]);close(reader[1]);
    assert(receive_byte(control[0])==(expected?'O':'F'));
    if(expected){if(!strcmp(name,"bootstrap-close")){close(bootstrap[0]);bootstrap[0]=-1;}if(!strcmp(name,"half-close"))must(shutdown(reader[0],SHUT_WR),"fixture stream half-close");byte(control[0],'C');}
    int status;assert(waitpid(pid,&status,0)==pid);assert(WIFEXITED(status)&&WEXITSTATUS(status)==0);
    close(runtime);close(service);close(store);close(exe);close(other);if(bootstrap[0]>=0)close(bootstrap[0]);close(reader[0]);close(control[0]);
}
int main(int argc,char **argv){
    assert(argc==3&&geteuid()==0);prepare(argv[2]);
    /* This process owns the private namespace: no mount or credential changes
     * reach its caller. /workspace and /proc exist only in the fixture chroot. */
    must(unshare(CLONE_NEWNS),"fixture private mount namespace");must(mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL),"fixture private propagation");
    if(!strcmp(argv[1],"crossed")){
        for(int count=4;count<=5;count++)for(int guided=0;guided<=1;guided++)for(int registration=0;registration<=1;registration++)
            run(argv[1],argv[2],count,guided,registration,(guided&&registration&&count==5)||(!guided&&!registration&&count==4));
    }else{
        int rejected=!strncmp(argv[1],"alias",5)||!strcmp(argv[1],"non-socket")||!strcmp(argv[1],"pidfs-absent");
        assert(rejected||!strcmp(argv[1],"claim-twice")||!strcmp(argv[1],"reader-shutdown")||!strcmp(argv[1],"bootstrap-close")||!strcmp(argv[1],"half-close"));
        run(argv[1],argv[2],5,1,1,!rejected);
    }
    printf("%s: actual kernel case passed\n",argv[1]);return 0;
}
