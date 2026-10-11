#define _GNU_SOURCE
/* Linux-only tool compartment PID 1. NOT a VM launcher or protected runtime supervisor. */
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/openat2.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int denial(const char *code) {
    printf("{\"version\":1,\"ok\":false,\"code\":\"%s\",\"errno\":%d}\n",code,errno);return 1;
}
static long long now_ms(void) {
    struct timespec ts;if(clock_gettime(CLOCK_MONOTONIC,&ts))_exit(78);
    return (long long)ts.tv_sec*1000+ts.tv_nsec/1000000;
}
static void encode(const unsigned char *data,size_t length) {
    const char *alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for(size_t i=0;i<length;i+=3){
        unsigned a=data[i],b=i+1<length?data[i+1]:0,c=i+2<length?data[i+2]:0;
        putchar(alphabet[a>>2]);putchar(alphabet[((a&3)<<4)|(b>>4)]);
        putchar(i+1<length?alphabet[((b&15)<<2)|(c>>6)]:'=');putchar(i+2<length?alphabet[c&63]:'=');
    }
}
static int compartment(unsigned long uid) {
    if(getpid()!=1 || getuid()!=uid || geteuid()!=uid || prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0)!=1 || prctl(PR_GET_SECCOMP)!=2)return 0;
    struct __user_cap_header_struct header={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};
    struct __user_cap_data_struct caps[2]={{0},{0}};
    if(syscall(SYS_capget,&header,caps) || caps[0].effective || caps[1].effective || caps[0].permitted || caps[1].permitted || caps[0].inheritable || caps[1].inheritable)return 0;
    for(int cap=0;cap<=CAP_LAST_CAP;cap++)if(prctl(PR_CAPBSET_READ,cap,0,0,0)!=0 || prctl(PR_CAP_AMBIENT,PR_CAP_AMBIENT_IS_SET,cap,0,0)!=0)return 0;
    return 1;
}
int main(int argc,char **argv) {
    /* ROOT REL_CWD UID TIMEOUT_MS OUTPUT_LIMIT; command is bounded UTF-8 stdin. */
    if(argc!=6){errno=EINVAL;return denial("invalid_request");}
    char *end;unsigned long uid=strtoul(argv[3],&end,10);
    if(*end || uid<1 || uid>65535 || !compartment(uid)){errno=EPERM;return denial("compartment_required");}
    unsigned long timeout=strtoul(argv[4],&end,10);
    if(*end || timeout<1 || timeout>600000){errno=EINVAL;return denial("invalid_request");}
    unsigned long limit=strtoul(argv[5],&end,10);
    if(*end || limit<1 || limit>16*1024*1024 || argv[1][0]!='/' || !argv[2][0] || argv[2][0]=='/'){errno=EINVAL;return denial("invalid_request");}
    if(syscall(SYS_close_range,3U,~0U,0U))return denial("fd_cleanup_unavailable");
    struct open_how root_how={.flags=O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC,.resolve=RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS};
    int root=(int)syscall(SYS_openat2,AT_FDCWD,argv[1],&root_how,sizeof(root_how));
    if(root<0)return denial("root_unavailable");
    struct open_how cwd_how={.flags=O_PATH|O_DIRECTORY|O_CLOEXEC,.resolve=RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS};
    int cwd=(int)syscall(SYS_openat2,root,argv[2],&cwd_how,sizeof(cwd_how));close(root);
    if(cwd<0)return denial("cwd_denied");
    if(fchdir(cwd)){close(cwd);return denial("cwd_denied");}close(cwd);
    char command[65537];size_t length=0;
    while(length<sizeof(command)){
        ssize_t count=read(0,command+length,sizeof(command)-length);
        if(count<0){if(errno==EINTR)continue;return denial("invalid_payload");}
        if(!count)break;
        length+=(size_t)count;
    }
    if(!length || length>=sizeof(command)){errno=EFBIG;return denial("payload_limit");}
    if(memchr(command,0,length)){errno=EINVAL;return denial("invalid_payload");}command[length]=0;
    unsigned char *output[2]={malloc(limit),malloc(limit)};
    if(!output[0] || !output[1]){free(output[0]);free(output[1]);errno=ENOMEM;return denial("resource_unavailable");}
    int pipes[2][2];
    if(pipe2(pipes[0],O_CLOEXEC) || pipe2(pipes[1],O_CLOEXEC))return denial("pipe_failed");
    struct rlimit processes={128,128},files={128,128},core={0,0};
    if(setrlimit(RLIMIT_NPROC,&processes) || setrlimit(RLIMIT_NOFILE,&files) || setrlimit(RLIMIT_CORE,&core))return denial("resource_unavailable");
    pid_t child=fork();
    if(child<0)return denial("fork_failed");
    if(child==0){
        if(dup2(pipes[0][1],1)<0 || dup2(pipes[1][1],2)<0 || syscall(SYS_close_range,3U,~0U,0U))_exit(126);
        char *args[]={"/bin/bash","--noprofile","--norc","-c",command,NULL};
        char *env[]={"PATH=/usr/bin:/bin","HOME=/tmp","TMPDIR=/tmp","LANG=C","LC_ALL=C",NULL};
        execve(args[0],args,env);_exit(126);
    }
    close(pipes[0][1]);close(pipes[1][1]);
    struct pollfd streams[2]={{.fd=pipes[0][0],.events=POLLIN},{.fd=pipes[1][0],.events=POLLIN}};
    for(int i=0;i<2;i++)if(fcntl(streams[i].fd,F_SETFL,O_NONBLOCK)<0){kill(-1,SIGKILL);_exit(78);}
    size_t sizes[2]={0,0},total=0;int status=0,finished=0,killed=0,alive=2;
    const char *termination="exit";long long deadline=now_ms()+timeout;
    while(!finished || alive){
        if(!finished){pid_t waited=waitpid(child,&status,WNOHANG);if(waited==child)finished=1;else if(waited<0 && errno!=EINTR){kill(-1,SIGKILL);_exit(78);}}
        if(!killed && (finished || now_ms()>=deadline)){
            if(!finished)termination="timeout";
            /* PID namespace owns ALL descendants; process groups cannot contain setsid escapees.
             * kill(-1) excludes this PID 1. Kernel namespace destruction is the abort fallback. */
            if(kill(-1,SIGKILL) && errno!=ESRCH)_exit(78);
            killed=1;
        }
        int ready=poll(streams,2,10);
        if(ready<0 && errno!=EINTR){kill(-1,SIGKILL);_exit(78);}
        for(int i=0;i<2;i++)if(streams[i].fd>=0 && streams[i].revents){
            unsigned char buffer[4096];ssize_t count=read(streams[i].fd,buffer,sizeof(buffer));
            if(count>0){
                size_t keep=(size_t)count;if(keep>limit-total)keep=limit-total;
                memcpy(output[i]+sizes[i],buffer,keep);sizes[i]+=keep;total+=keep;
                if(keep<(size_t)count){
                    if(!strcmp(termination,"exit"))termination="output_limit";
                    if(!killed){if(kill(-1,SIGKILL) && errno!=ESRCH)_exit(78);killed=1;}
                }
            }else if(count==0 || (count<0 && errno!=EINTR && errno!=EAGAIN)){close(streams[i].fd);streams[i].fd=-1;alive--;}
        }
    }
    /* Reap every adopted descendant before admitting a confirmed receipt. */
    while(waitpid(-1,NULL,0)>=0 || errno==EINTR){}
    int exit_code=WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
    printf("{\"version\":1,\"ok\":true,\"exitCode\":%d,\"termination\":\"%s\",\"stdoutBase64\":\"",exit_code,termination);
    encode(output[0],sizes[0]);printf("\",\"stderrBase64\":\"");encode(output[1],sizes[1]);puts("\"}");
    free(output[0]);free(output[1]);return 0;
}
