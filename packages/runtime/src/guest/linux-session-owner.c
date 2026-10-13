#define _GNU_SOURCE
/* Native fresh-runtime bootstrap. No public path/config/proof arguments and no tenancy release.
 * The immutable root service sends evidence over an inherited AF_UNIX socket. */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define LIMIT 65536
#define TOKENS 4096
struct token { int start,end,next,count; char type; };
struct parser { const char *s; int pos,n,used; struct token t[TOKENS]; };
/* Bounded structural JSON parser. Core evidence strings may not contain escapes;
 * configuration/provider strings can, but are never used as native authority. */
static void space(struct parser *p){while(p->pos<p->n&&strchr(" \t\r\n",p->s[p->pos]))p->pos++;}
static int parse(struct parser *p,int depth){
    space(p);if(depth>32||p->pos>=p->n||p->used==TOKENS)return -1;
    int i=p->used++;struct token *t=&p->t[i];t->start=p->pos;t->type=p->s[p->pos++];
    if(t->type=='{'||t->type=='['){
        char end=t->type=='{'?'}':']';space(p);
        if(p->pos<p->n&&p->s[p->pos]==end)p->pos++;
        else for(;;){
            if(t->type=='{'){space(p);if(p->pos>=p->n||p->s[p->pos]!='"'||parse(p,depth+1)<0)return -1;space(p);if(p->pos>=p->n||p->s[p->pos++]!=':')return -1;}
            if(parse(p,depth+1)<0)return -1;
            t->count++;space(p);if(p->pos>=p->n)return -1;
            if(p->s[p->pos]==end){p->pos++;break;}
            if(p->s[p->pos++]!=',')return -1;
        }
    }else if(t->type=='"'){
        for(;;){if(p->pos>=p->n)return -1;unsigned char c=p->s[p->pos++];if(c=='"')break;if(c<32)return -1;
            if(c=='\\'){if(p->pos>=p->n)return -1;c=p->s[p->pos++];if(c=='u'){for(int j=0;j<4;j++)if(p->pos>=p->n||!strchr("0123456789abcdefABCDEF",p->s[p->pos++]))return -1;}else if(!strchr("\"\\/bfnrt",c))return -1;}
        }
    }else{
        while(p->pos<p->n&&!strchr(" \t\r\n,]}",p->s[p->pos]))p->pos++;
        int len=p->pos-t->start;const char *s=p->s+t->start;
        if(!((len==4&&!memcmp(s,"true",4))||(len==5&&!memcmp(s,"false",5))||(len==4&&!memcmp(s,"null",4)))){
            int j=0;if(j<len&&s[j]=='-')j++;if(j==len)return -1;
            if(s[j]=='0')j++;else{if(s[j]<'1'||s[j]>'9')return -1;while(j<len&&s[j]>='0'&&s[j]<='9')j++;}
            if(j<len&&s[j]=='.'){j++;int first=j;while(j<len&&s[j]>='0'&&s[j]<='9')j++;if(first==j)return -1;}
            if(j<len&&(s[j]=='e'||s[j]=='E')){j++;if(j<len&&(s[j]=='+'||s[j]=='-'))j++;int first=j;while(j<len&&s[j]>='0'&&s[j]<='9')j++;if(first==j)return -1;}
            if(j!=len)return -1;
        }
    }
    t->end=p->pos;t->next=p->used;return i;
}
static int eq(struct parser *p,int i,const char *s){return i>=0&&p->t[i].type=='"'&&p->t[i].end-p->t[i].start==(int)strlen(s)+2&&!memcmp(p->s+p->t[i].start+1,s,strlen(s));}
static int field(struct parser *p,int object,const char *name){
    if(object<0||p->t[object].type!='{')return -1;
    int found=-1;
    for(int i=object+1;i<p->t[object].next;){int value=i+1;if(eq(p,i,name)){if(found>=0)return -1;found=value;}i=p->t[value].next;}
    return found;
}
static int string(struct parser *p,int i,char *out,size_t n){
    if(i<0||p->t[i].type!='"')return -1;
    size_t length=(size_t)(p->t[i].end-p->t[i].start-2);if(length>=n)return -1;
    memcpy(out,p->s+p->t[i].start+1,length);out[length]=0;return strchr(out,'\\')?-1:0;
}
static long integer(struct parser *p,int i){if(i<0)return -1;char buf[32],*end;int len=p->t[i].end-p->t[i].start;if(len<=0||len>=32)return -1;memcpy(buf,p->s+p->t[i].start,(size_t)len);buf[len]=0;errno=0;long n=strtol(buf,&end,10);return errno||*end?-1:n;}
static int identifier(const char *s){size_t n=strlen(s);if(n<1||n>128||!strchr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",*s))return 0;return strspn(s,"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")==n;}
static int live(int fd){struct pollfd p={fd,POLLIN,0};return poll(&p,1,0)==0;}
static int pidfd_pid(int fd){char path[64],line[256];snprintf(path,sizeof path,"/proc/self/fdinfo/%d",fd);FILE *f=fopen(path,"re");if(!f)return -1;int pid=-1;while(fgets(line,sizeof line,f))if(sscanf(line,"Pid:\t%d",&pid)==1)break;fclose(f);return pid;}
static int pidfd_type(int fd){char path[64],target[128];snprintf(path,sizeof path,"/proc/self/fd/%d",fd);ssize_t n=readlink(path,target,sizeof target-1);if(n<0)return 0;target[n]=0;return !strcmp(target,"anon_inode:[pidfd]");}
static int immutable(int fd){struct stat s;return !fstat(fd,&s)&&S_ISREG(s.st_mode)&&s.st_uid==0&&s.st_nlink==1&&!(s.st_mode&0222)&&(fcntl(fd,F_GETFL)&O_ACCMODE)==O_RDONLY;}
static int identity(int a,int b){struct stat x,y;return !fstat(a,&x)&&!fstat(b,&y)&&x.st_dev==y.st_dev&&x.st_ino==y.st_ino;}
static int boot(char out[64]){FILE *f=fopen("/proc/sys/kernel/random/boot_id","re");if(!f)return -1;int ok=fgets(out,64,f)!=NULL;fclose(f);if(!ok)return -1;out[strcspn(out,"\r\n")]=0;return strlen(out)==36?0:-1;}
struct owner { int fd[4],socket; uid_t uid; char record[LIMIT+1],store[512],boot[64],identity[256]; uint64_t serial; struct owner *next; };
static struct owner *owners;static uint64_t serial;static const char *error="none";
static struct owner *get(uint64_t h){for(struct owner *o=owners;o;o=o->next)if(o->serial==h)return o;error="owner_closed";return NULL;}
const char *winter_owner_error(void){return error;}
int winter_owner_check(uint64_t h){
    struct owner *o=get(h);if(!o)return -1;
    char resolved[4096],current[64];struct stat s;
    int pathfd=open(o->store,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);int exe=open("/proc/self/exe",O_RDONLY|O_CLOEXEC);
    int ok=getuid()==o->uid&&geteuid()==o->uid&&getpid()==1&&live(o->fd[0])&&live(o->fd[1])&&pidfd_pid(o->fd[0])==getpid()&&pathfd>=0&&exe>=0&&identity(pathfd,o->fd[2])&&identity(exe,o->fd[3])&&immutable(o->fd[3])&&!fstat(o->fd[2],&s)&&S_ISDIR(s.st_mode)&&s.st_uid==o->uid&&(s.st_mode&0777)==0700&&realpath(o->store,resolved)&&!strcmp(resolved,o->store)&&!boot(current)&&!strcmp(current,o->boot);
    if(pathfd>=0)close(pathfd);
    if(exe>=0)close(exe);
    if(!ok){error="owner_lost";return -1;}return 0;
}
uint64_t winter_owner_open(int socketfd){
    error="bootstrap_invalid";if(socketfd<3||getuid()<1000||getuid()!=geteuid()||getpid()!=1)return 0;
    struct sockaddr_un_placeholder { unsigned short family; char bytes[108]; } address;socklen_t size=sizeof address;
    struct ucred peer;socklen_t credentials=sizeof peer;int type;socklen_t typesize=sizeof type;
    if(getpeername(socketfd,(struct sockaddr *)&address,&size)||address.family!=AF_UNIX||getsockopt(socketfd,SOL_SOCKET,SO_TYPE,&type,&typesize)||type!=SOCK_SEQPACKET||getsockopt(socketfd,SOL_SOCKET,SO_PEERCRED,&peer,&credentials)||credentials!=sizeof peer||peer.uid!=0)return 0;
    struct pollfd ready={socketfd,POLLIN,0};if(poll(&ready,1,3000)!=1)return 0;
    struct owner *o=calloc(1,sizeof *o);if(!o){error="allocation_failed";return 0;}o->socket=-1;for(int i=0;i<4;i++)o->fd[i]=-1;
    char ancillary[CMSG_SPACE(sizeof(int)*16)]={0};struct iovec vector={o->record,LIMIT};struct msghdr message={0};message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=ancillary;message.msg_controllen=sizeof ancillary;
    ssize_t count=recvmsg(socketfd,&message,MSG_CMSG_CLOEXEC);int fds[16],used=0,envelopes=0;
    for(struct cmsghdr *c=CMSG_FIRSTHDR(&message);c;c=CMSG_NXTHDR(&message,c)){
        if(c->cmsg_level==SOL_SOCKET&&c->cmsg_type==SCM_RIGHTS){envelopes++;size_t bytes=c->cmsg_len-CMSG_LEN(0);for(size_t j=0;j+sizeof(int)<=bytes;j+=sizeof(int)){int fd;memcpy(&fd,(char *)CMSG_DATA(c)+j,sizeof fd);if(used<16)fds[used++]=fd;else close(fd);}}
        else envelopes+=100;
    }
    if(count<1||message.msg_flags&~MSG_CMSG_CLOEXEC||used!=4||envelopes!=1){for(int i=0;i<used;i++)close(fds[i]);free(o);return 0;}
    for(int i=0;i<4;i++){o->fd[i]=fds[i];}
    o->record[count]=0;
    struct parser p={.s=o->record,.n=(int)count};if(parse(&p,0)!=0)goto fail;space(&p);if(p.pos!=p.n||p.t[0].type!='{')goto fail;
    int fresh=field(&p,0,"freshOnly"),scope=field(&p,0,"scope");char logical[129],id[129],expected[512];
    if(integer(&p,field(&p,0,"protocolVersion"))!=1||fresh<0||p.t[fresh].end-p.t[fresh].start!=4||memcmp(p.s+p.t[fresh].start,"true",4)||integer(&p,field(&p,0,"runtimeUid"))!=(long)getuid()||string(&p,field(&p,0,"logicalSessionId"),logical,sizeof logical)||!identifier(logical))goto fail;
    for(int i=0;i<3;i++){const char *keys[]={"workspaceId","sessionId","incarnationId"};if(string(&p,field(&p,scope,keys[i]),id,sizeof id)||!identifier(id))goto fail;}
    if(integer(&p,field(&p,scope,"leaseEpoch"))<1||string(&p,field(&p,scope,"storeHome"),o->store,sizeof o->store)||string(&p,field(&p,scope,"currentBootId"),o->boot,sizeof o->boot))goto fail;
    snprintf(expected,sizeof expected,"/workspace/.winter/conversations/%s",logical);if(strcmp(expected,o->store))goto fail;
    for(int i=0;i<4;i++)if(!(fcntl(o->fd[i],F_GETFD)&FD_CLOEXEC))goto fail;
    if(!pidfd_type(o->fd[0])||!pidfd_type(o->fd[1])||!immutable(o->fd[3])||(fcntl(o->fd[2],F_GETFL)&O_ACCMODE)!=O_RDONLY)goto fail;
    o->uid=getuid();o->serial=++serial;if(!o->serial)o->serial=++serial;o->next=owners;owners=o;
    if(winter_owner_check(o->serial)){owners=o->next;goto fail;}
    o->socket=socketfd;fcntl(socketfd,F_SETFD,FD_CLOEXEC);error="none";return o->serial;
fail:
    for(int i=0;i<4;i++){if(o->fd[i]>=0)close(o->fd[i]);}
    free(o);return 0;
}
const char *winter_owner_record(uint64_t h){struct owner *o=get(h);return o&&!winter_owner_check(h)?o->record:NULL;}
const char *winter_owner_process_identity(uint64_t h,int pid){
    struct owner *o=get(h);if(!o||pid!=getpid()||winter_owner_check(h))return NULL;
    FILE *f=fopen("/proc/self/stat","re");char data[4096];if(!f)return NULL;int ok=fgets(data,sizeof data,f)!=NULL;fclose(f);if(!ok)return NULL;
    char *end=strrchr(data,')');if(!end||end[1]!=' ')return NULL;char *save=NULL,*part=strtok_r(end+2," ",&save);int fieldnumber=3;unsigned long long ticks=0;
    while(part){if(fieldnumber==22){char *tail;errno=0;ticks=strtoull(part,&tail,10);if(errno||*tail)return NULL;break;}fieldnumber++;part=strtok_r(NULL," ",&save);}
    if(fieldnumber!=22)return NULL;
    snprintf(o->identity,sizeof o->identity,"{\"bootId\":\"%s\",\"startTicks\":\"%llu\"}",o->boot,ticks);return o->identity;
}
void winter_owner_close(uint64_t h){struct owner **link=&owners;while(*link&&(*link)->serial!=h)link=&(*link)->next;if(!*link)return;struct owner *o=*link;*link=o->next;for(int i=0;i<4;i++)close(o->fd[i]);if(o->socket>=0)close(o->socket);memset(o,0,sizeof *o);free(o);}
/* Fixture provider worker admission: only the root harness passes the service's
 * actual outer-namespace init pidfd. No guest packet can select its own PID/UID. */
int winter_provider_receive_owner(int channel){
    struct ucred peer;socklen_t size=sizeof peer;int type;socklen_t typesize=sizeof type;struct sockaddr address;socklen_t addresssize=sizeof address;
    if(channel<3||getpeername(channel,&address,&addresssize)||address.sa_family!=AF_UNIX||getsockopt(channel,SOL_SOCKET,SO_TYPE,&type,&typesize)||type!=SOCK_SEQPACKET||getsockopt(channel,SOL_SOCKET,SO_PEERCRED,&peer,&size)||size!=sizeof peer||peer.uid!=0)return -1;
    struct pollfd ready={channel,POLLIN,0};if(poll(&ready,1,3000)!=1)return -1;
    char marker[2],ancillary[CMSG_SPACE(sizeof(int)*16)]={0};struct iovec vector={marker,sizeof marker};struct msghdr message={0};message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=ancillary;message.msg_controllen=sizeof ancillary;
    ssize_t count=recvmsg(channel,&message,MSG_CMSG_CLOEXEC);int fds[16],used=0,envelopes=0;
    for(struct cmsghdr *c=CMSG_FIRSTHDR(&message);c;c=CMSG_NXTHDR(&message,c)){
        if(c->cmsg_level==SOL_SOCKET&&c->cmsg_type==SCM_RIGHTS){envelopes++;size_t bytes=c->cmsg_len-CMSG_LEN(0);for(size_t j=0;j+sizeof(int)<=bytes;j+=sizeof(int)){int fd;memcpy(&fd,(char *)CMSG_DATA(c)+j,sizeof fd);if(used<16)fds[used++]=fd;else close(fd);}}
        else envelopes+=100;
    }
    if(count==1&&marker[0]=='I'&&!(message.msg_flags&~MSG_CMSG_CLOEXEC)&&used==1&&envelopes==1&&(fcntl(fds[0],F_GETFD)&FD_CLOEXEC)&&pidfd_type(fds[0])&&pidfd_pid(fds[0])>0&&live(fds[0]))return fds[0];
    for(int i=0;i<used;i++)close(fds[i]);
    return -1;
}
int winter_provider_peer_check(int client,int init_pidfd,int expected_uid){
    if(client<0||init_pidfd<3||expected_uid<1000||expected_uid>65535||!pidfd_type(init_pidfd)||!live(init_pidfd))return -1;
    struct ucred peer;socklen_t size=sizeof peer;struct sockaddr address;socklen_t addresssize=sizeof address;int type;socklen_t typesize=sizeof type;
    if(getpeername(client,&address,&addresssize)||address.sa_family!=AF_UNIX||getsockopt(client,SOL_SOCKET,SO_TYPE,&type,&typesize)||type!=SOCK_STREAM||getsockopt(client,SOL_SOCKET,SO_PEERCRED,&peer,&size)||size!=sizeof peer||peer.uid!=(uid_t)expected_uid||peer.pid<=0||pidfd_pid(init_pidfd)!=peer.pid)return -1;
    return live(init_pidfd)?0:-1;
}
/* Bun does not listen on inherited descriptors. This bounded fixture transport
 * keeps the immutable listener instead of reopening a caller-selected path. */
#include <time.h>
#include <arpa/inet.h>
#define PROVIDER_REQUEST_LIMIT (2U*1024U*1024U+4096U)
#define PROVIDER_RESPONSE_LIMIT (256U*1024U+4096U)
struct provider_client { int active,fd,owner,uid; };
static struct provider_client provider_clients[8];
static char provider_frame[PROVIDER_REQUEST_LIMIT+1];
static int64_t monotonic_ms(void){struct timespec now;if(clock_gettime(CLOCK_MONOTONIC,&now))return -1;return (int64_t)now.tv_sec*1000+now.tv_nsec/1000000;}
static int ready_before(int fd,short event,int64_t deadline){
    for(;;){int64_t now=monotonic_ms();if(now<0||now>=deadline)return -1;struct pollfd p={fd,event,0};int result=poll(&p,1,(int)(deadline-now));if(result<0&&errno==EINTR)continue;if(result!=1||!(p.revents&event))return -1;return 0;}
}
static int provider_owned(int fd,int owner,int uid){for(int i=0;i<8;i++)if(provider_clients[i].active&&provider_clients[i].fd==fd&&provider_clients[i].owner==owner&&provider_clients[i].uid==uid)return winter_provider_peer_check(fd,owner,uid);return -1;}
int winter_provider_owner_live(int owner){return owner>=3&&pidfd_type(owner)&&pidfd_pid(owner)>0&&live(owner);}
int winter_provider_accept(int listener,int owner,int uid){
    int type,accepting;socklen_t size=sizeof type;struct sockaddr address;socklen_t addresssize=sizeof address;struct stat identity;
    if(listener<3||uid<1000||uid>65535||!winter_provider_owner_live(owner)||fstat(listener,&identity)||!S_ISSOCK(identity.st_mode)||identity.st_uid!=0||getsockname(listener,&address,&addresssize)||address.sa_family!=AF_UNIX||getsockopt(listener,SOL_SOCKET,SO_TYPE,&type,&size)||type!=SOCK_STREAM)return -1;
    size=sizeof accepting;if(getsockopt(listener,SOL_SOCKET,SO_ACCEPTCONN,&accepting,&size)||accepting!=1)return -1;
    int slot=-1;for(int i=0;i<8;i++)if(!provider_clients[i].active){slot=i;break;}if(slot<0)return -1;
    int flags=fcntl(listener,F_GETFL);if(flags<0||fcntl(listener,F_SETFL,flags|O_NONBLOCK)<0)return -1;
    int64_t now=monotonic_ms();if(now<0||ready_before(listener,POLLIN,now+250))return -1;
    int client=accept4(listener,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK);if(client<0)return -1;
    if(winter_provider_peer_check(client,owner,uid)){close(client);return -1;}
    provider_clients[slot]=(struct provider_client){1,client,owner,uid};return client;
}
static int exact_read(int fd,void *buffer,size_t length,int64_t deadline){
    size_t at=0;while(at<length){if(ready_before(fd,POLLIN,deadline))return -1;ssize_t count=recv(fd,(char *)buffer+at,length-at,0);if(count<0&&(errno==EINTR||errno==EAGAIN))continue;if(count<=0)return -1;at+=(size_t)count;}int64_t finish=monotonic_ms();return finish>=0&&finish<deadline?0:-1;
}
const char *winter_provider_read_frame(int client,int owner,int uid){
    if(provider_owned(client,owner,uid))return NULL;
    int64_t now=monotonic_ms();if(now<0)return NULL;int64_t deadline=now+3000;uint32_t wire;
    if(exact_read(client,&wire,sizeof wire,deadline))return NULL;
    uint32_t length=ntohl(wire);if(length<1||length>PROVIDER_REQUEST_LIMIT||exact_read(client,provider_frame,length,deadline)||memchr(provider_frame,0,length)||provider_owned(client,owner,uid))return NULL;
    /* One request per accepted connection. Pipelining/trailing bytes are refused,
     * not treated as a second request or replay opportunity. */
    char trailing;ssize_t pending=recv(client,&trailing,1,MSG_PEEK|MSG_DONTWAIT);if(pending>0)return NULL;
    provider_frame[length]=0;return provider_frame;
}
static int exact_write(int fd,const void *buffer,size_t length,int64_t deadline){
    size_t at=0;while(at<length){if(ready_before(fd,POLLOUT,deadline))return -1;ssize_t count=send(fd,(const char *)buffer+at,length-at,MSG_NOSIGNAL);if(count<0&&(errno==EINTR||errno==EAGAIN))continue;if(count<=0)return -1;at+=(size_t)count;}int64_t finish=monotonic_ms();return finish>=0&&finish<deadline?0:-1;
}
int winter_provider_write_frame(int client,int owner,int uid,const char *json){
    if(!json||provider_owned(client,owner,uid))return -1;
    size_t length=strnlen(json,PROVIDER_RESPONSE_LIMIT+1);if(length<1||length>PROVIDER_RESPONSE_LIMIT)return -1;
    int64_t now=monotonic_ms();if(now<0)return -1;int64_t deadline=now+3000;uint32_t wire=htonl((uint32_t)length);
    if(exact_write(client,&wire,sizeof wire,deadline)||exact_write(client,json,length,deadline)||provider_owned(client,owner,uid))return -1;
    return 0;
}
void winter_provider_close_client(int client){for(int i=0;i<8;i++)if(provider_clients[i].active&&provider_clients[i].fd==client){provider_clients[i].active=0;close(client);return;}}
