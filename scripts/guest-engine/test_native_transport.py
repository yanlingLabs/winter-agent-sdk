"""Execute actual C transport framing/deadlines with real local Unix socketpairs.
Kernel pidfd/root-peer authority is explicitly stubbed here; positive admission requires Linux CI.
"""
import shutil,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
class NativeTransportTests(unittest.TestCase):
    def test_real_c_framing_limits_close_and_absolute_deadline(self):
        compiler=shutil.which('cc')
        if not compiler:self.skipTest('existing local C compiler unavailable')
        source=(ROOT/'packages/runtime/src/guest/linux-session-owner.c').read_text();tail=source[source.index('/* Bun does not listen on inherited descriptors.'):]
        prelude=r'''
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <signal.h>
#include <unistd.h>
/* Authority doubles: these do not prove Linux pidfd/peer admission. */
static int authority_alive=1;
static int pidfd_type(int fd){return fd==91;}
static int pidfd_pid(int fd){return fd==91?123:-1;}
static int live(int fd){return fd==91&&authority_alive;}
int winter_provider_peer_check(int client,int owner,int uid){struct stat s;return owner==91&&uid==20001&&authority_alive&&!fstat(client,&s)&&S_ISSOCK(s.st_mode)?0:-1;}
#ifdef __APPLE__
#ifndef SOCK_CLOEXEC
#define SOCK_CLOEXEC 0x80000
#define SOCK_NONBLOCK 0x800
#endif
static int fixture_accept4(int listener,struct sockaddr *address,socklen_t *size,int flags){int fd=accept(listener,address,size);if(fd>=0){if(flags&SOCK_CLOEXEC)fcntl(fd,F_SETFD,FD_CLOEXEC);if(flags&SOCK_NONBLOCK)fcntl(fd,F_SETFL,O_NONBLOCK);}return fd;}
#define accept4 fixture_accept4
#endif
'''
        harness=r'''
static void pair(int fds[2]){assert(!socketpair(AF_UNIX,SOCK_STREAM,0,fds));assert(fcntl(fds[1],F_SETFL,O_NONBLOCK)>=0);provider_clients[0]=(struct provider_client){1,fds[1],91,20001};}
static void endpair(int fds[2]){winter_provider_close_client(fds[1]);assert(fcntl(fds[1],F_GETFD)==-1);close(fds[0]);}
static void request(int fd,const char *body,size_t length,const char *extra){uint32_t header=htonl((uint32_t)length);assert(write(fd,&header,4)==4);if(length)assert(write(fd,body,length)==(ssize_t)length);if(extra)assert(write(fd,extra,strlen(extra))==(ssize_t)strlen(extra));}
int main(void){
    int fds[2];pair(fds);request(fds[0],"{\"ok\":true}",11,NULL);const char *value=winter_provider_read_frame(fds[1],91,20001);assert(value&&!strcmp(value,"{\"ok\":true}"));assert(!winter_provider_write_frame(fds[1],91,20001,"{\"done\":true}"));uint32_t header;assert(read(fds[0],&header,4)==4&&ntohl(header)==13);char body[16]={0};assert(read(fds[0],body,13)==13&&!strcmp(body,"{\"done\":true}"));endpair(fds);
    pair(fds);uint32_t large=htonl(PROVIDER_REQUEST_LIMIT+1);assert(write(fds[0],&large,4)==4);assert(!winter_provider_read_frame(fds[1],91,20001));endpair(fds);
    pair(fds);request(fds[0],"{}",2,"trailing");assert(!winter_provider_read_frame(fds[1],91,20001));endpair(fds);
    pair(fds);char nul[]={123,34,97,34,58,34,0,34,125};request(fds[0],nul,sizeof nul,NULL);assert(!winter_provider_read_frame(fds[1],91,20001));endpair(fds);
    pair(fds);authority_alive=0;assert(!winter_provider_read_frame(fds[1],91,20001));assert(winter_provider_write_frame(fds[1],91,20001,"{}")==-1);assert(!winter_provider_owner_live(91));authority_alive=1;endpair(fds);
    pair(fds);char *oversize=malloc(PROVIDER_RESPONSE_LIMIT+2);assert(oversize);memset(oversize,'x',PROVIDER_RESPONSE_LIMIT+1);oversize[PROVIDER_RESPONSE_LIMIT+1]=0;assert(winter_provider_write_frame(fds[1],91,20001,oversize)==-1);free(oversize);endpair(fds);
    pair(fds);pid_t child=fork();assert(child>=0);if(!child){close(fds[1]);uint32_t wire=htonl(11);char bytes[15];memcpy(bytes,&wire,4);memcpy(bytes+4,"{\"ok\":true}",11);for(int i=0;i<15;i++){if(write(fds[0],bytes+i,1)!=1)_exit(0);usleep(300000);}_exit(0);}
    int64_t start=monotonic_ms();assert(!winter_provider_read_frame(fds[1],91,20001));int64_t elapsed=monotonic_ms()-start;assert(elapsed>=2800&&elapsed<4000);kill(child,SIGTERM);int status;assert(waitpid(child,&status,0)==child);endpair(fds);
    assert(winter_provider_accept(-1,91,20001)==-1);assert(!winter_provider_owner_live(-1));return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix='winter-native-frame-') as directory:
            root=Path(directory);code=root/'transport.c';binary=root/'transport';code.write_text(prelude+tail+harness)
            result=subprocess.run([compiler,'-std=c11','-O2','-Wall','-Wextra','-Werror',str(code),'-o',str(binary)],capture_output=True,text=True,timeout=30);self.assertEqual(result.returncode,0,result.stderr)
            result=subprocess.run([str(binary)],capture_output=True,text=True,timeout=10);self.assertEqual(result.returncode,0,result.stderr)
if __name__=='__main__':unittest.main()
