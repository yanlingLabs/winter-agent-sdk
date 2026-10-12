#define _GNU_SOURCE
/* Dynamic glibc regression, executed only inside the disposable tool compartment. */
#include <errno.h>
#include <pthread.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
static void *thread_main(void *arg) { return arg; }
int main(void) {
#ifdef SYS_clone3
    errno=0;
    if(syscall(SYS_clone3,NULL,0)!=-1 || errno!=ENOSYS)return 1;
#endif
    pthread_t thread;void *result=NULL;int token=7;
    if(pthread_create(&thread,NULL,thread_main,&token) || pthread_join(thread,&result) || result!=&token)return 2;
    pid_t child;char *args[]={"/bin/bash","-c","exit 0",NULL};
    if(posix_spawn(&child,args[0],NULL,NULL,args,environ))return 3;
    int status;if(waitpid(child,&status,0)!=child || !WIFEXITED(status) || WEXITSTATUS(status))return 4;
    int pair[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,pair))return 5;
    char byte=0;if(write(pair[0],"x",1)!=1 || read(pair[1],&byte,1)!=1 || byte!='x')return 6;
    close(pair[0]);close(pair[1]);
    int local=socket(AF_UNIX,SOCK_STREAM,0);if(local<0)return 7;close(local);
    errno=0;int network=socket(AF_INET,SOCK_STREAM,0);if(network!=-1 || errno!=EPERM)return 8;
    errno=0;network=socket(AF_INET6,SOCK_STREAM,0);if(network!=-1 || errno!=EPERM)return 9;
    puts("glibc-thread-spawn-local-ipc-ok");return 0;
}
