#define _GNU_SOURCE
/* SOURCE PREREQUISITE ONLY: distinct Root-created one-shot reader role. This is
 * deliberately unwired: no runtime/profile/producer or existing launcher change.
 * Root must admit the complete immutable loader closure and reserve reader UID.
 * Source compilation is not Linux confinement or honest Bun compatibility proof.
 *
 * Runtime-compatibility view: pinned WebKit opens /dev/urandom directly and glibc's
 * initial-thread pthread_getattr_np reads /proc/self/maps, so the sealed view gains
 * EXACTLY two things: a private, otherwise-empty tmpfs /dev holding one node made
 * here (character device 1:9, mode 0444; the host device file is never opened or
 * bound), and a fresh subset=pid procfs mounted by the PID namespace's own init.
 * This is a source-derived requirement; it diagnoses no run. Pre-exec invariants
 * below re-prove that view from inside it, fail closed. */
#include "linux-compartment.h"
#include <stdint.h>
#include <poll.h>
#include <signal.h>
#include <time.h>
#include <sys/resource.h>
#include <sys/sysmacros.h>
#include <linux/mount.h>

#define READER_DEPENDENCIES 32
#define READER_WALL_MS 4000
#define READER_SHARED "/run/winter/shared-instructions"
#define READER_HOME "/run/winter/instruction-reader"
#define READER_DEV "/dev"
#define READER_DEV_OPTIONS "mode=0755,size=4k,nr_inodes=4"
#define READER_ENTROPY READER_DEV "/urandom"
#define READER_PROC "/proc"
#define READER_PROC_OPTIONS "subset=pid,hidepid=invisible"

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
        } else if(*p<32||*p==127||*p=='\\')return 0;
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
    for(const unsigned char *p=(const unsigned char *)text;*p;p++)if(*p<33||*p>126)return 0;
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
    if(file) {
        /* Keep open's own errno: close(-1) would replace it with EBADF. */
        int fd=open(out,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0555);require(fd,"reader file mountpoint");close(fd);
    } else require(mkdir(out,0755),"reader directory mountpoint");
}

/* BEGIN PORTABLE VIEW CONTRACT -- pure name/text classifiers, no descriptor or native effects. */
struct reader_slice { const char *at; size_t length; };
struct reader_proc_names { int init, self, thread_self; };
struct reader_mounts { int root, source, shared, executable, tmp, device, proc, dependencies[READER_DEPENDENCIES]; };

/* Final /proc root of this namespace's subset=pid instance: PID 1 and the two
 * self links, each once, and nothing else. Any other name or number is refused. */
static int reader_proc_name(struct reader_proc_names *seen, const char *name) {
    if(!strcmp(name,".")||!strcmp(name,".."))return 1;
    if(!strcmp(name,"self"))return !seen->self++;
    if(!strcmp(name,"thread-self"))return !seen->thread_self++;
    if(!strcmp(name,"1"))return !seen->init++;
    return 0;
}
/* Reviewed exec inventory: exactly descriptors 0, 1 and 2. The enumerating
 * directory's own handle (listing) is the only other name that may appear. */
static int reader_descriptor_name(unsigned int *seen, int listing, const char *name) {
    int fd;
    if(!strcmp(name,".")||!strcmp(name,".."))return 1;
    if(!reader_number(name,0,65535,&fd))return 0;
    if(fd==listing)return 1;
    if(fd>2||(*seen&(1U<<fd)))return 0;
    *seen|=1U<<fd;return 1;
}
/* mountinfo fields are single-space separated; paths escape space/tab/newline/backslash. */
static int reader_next(const char **cursor, const char *end, struct reader_slice *out) {
    const char *p=*cursor;
    if(p>=end)return 0;
    out->at=p;while(p<end&&*p!=' ')p++;
    out->length=(size_t)(p-out->at);*cursor=p<end?p+1:p;return 1;
}
static int reader_same(struct reader_slice value, const char *text) {
    size_t length=strlen(text);
    return value.length==length&&!memcmp(value.at,text,length);
}
static int reader_below(struct reader_slice value, const char *root) {
    size_t length=strlen(root);
    return value.length>length+1&&!memcmp(value.at,root,length)&&value.at[length]=='/';
}
/* Pseudo and device filesystems that must never appear beneath a source or guidance
 * tree: the recursive clone could otherwise smuggle kernel interfaces into the view. */
static const char *const reader_pseudo[]={
    "proc","sysfs","devtmpfs","devpts","debugfs","tracefs","securityfs","cgroup","cgroup2","bpf","mqueue",
    "configfs","fusectl","pstore","efivarfs","binfmt_misc","hugetlbfs","autofs","selinuxfs","nsfs"
};
static int reader_pseudo_type(struct reader_slice type) {
    for(size_t i=0;i<sizeof reader_pseudo/sizeof reader_pseudo[0];i++)if(reader_same(type,reader_pseudo[i]))return 1;
    return 0;
}
/* Exact comma-separated option tokens; csv is a fixed comma list, "" matches vacuously. */
static int reader_options(struct reader_slice list, const char *csv, int present) {
    for(const char *item=csv;*item;) {
        size_t length=strcspn(item,",");
        int found=0;
        for(size_t at=0;at<=list.length&&!found;) {
            size_t stop=at;while(stop<list.length&&list.at[stop]!=',')stop++;
            found=stop-at==length&&!memcmp(list.at+at,item,length);at=stop+1;
        }
        if(found!=present)return 0;
        item+=length+(item[length]==','?1:0);
    }
    return 1;
}
static int reader_rule(struct reader_slice options, struct reader_slice type, struct reader_slice super,
                       const char *required, const char *forbidden, const char *fs, const char *super_required) {
    return reader_options(options,required,1)&&reader_options(options,forbidden,0)&&
           (!fs||reader_same(type,fs))&&(!super_required||reader_options(super,super_required,1));
}
static int reader_mount_line(const char *line, const char *end, const struct reader_plan *plan, struct reader_mounts *seen) {
    const struct reader_slice none={NULL,0};
    struct reader_slice head[6],token=none,type=none,device=none,super=none;
    const char *cursor=line;memset(head,0,sizeof head);
    for(int i=0;i<6;i++)if(!reader_next(&cursor,end,&head[i]))return 0;
    for(int i=0;;i++) {
        if(i==8||!reader_next(&cursor,end,&token))return 0;
        if(token.length==1&&token.at[0]=='-')break;
    }
    if(!reader_next(&cursor,end,&type)||!reader_next(&cursor,end,&device)||!reader_next(&cursor,end,&super)||
       reader_next(&cursor,end,&token))return 0;
    const struct reader_slice point=head[4],options=head[5];
    const char *sealed="ro,nosuid,nodev,noexec";
    if(reader_same(point,"/"))return !seen->root++&&reader_rule(options,type,super,sealed,"","tmpfs",NULL);
    if(reader_same(point,plan->source_path))return !seen->source++&&reader_rule(options,type,super,sealed,"",NULL,NULL);
    if(reader_below(point,plan->source_path))return !reader_pseudo_type(type)&&reader_rule(options,type,super,sealed,"",NULL,NULL);
    if(reader_same(point,READER_SHARED))return !seen->shared++&&reader_rule(options,type,super,sealed,"",NULL,NULL);
    if(reader_below(point,READER_SHARED))return !reader_pseudo_type(type)&&reader_rule(options,type,super,sealed,"",NULL,NULL);
    if(reader_same(point,"/instruction-reader"))return !seen->executable++&&reader_rule(options,type,super,"ro,nosuid,nodev","",NULL,NULL);
    for(int i=0;i<plan->dependencies;i++)
        if(reader_same(point,plan->dependency_paths[i]))return !seen->dependencies[i]++&&reader_rule(options,type,super,"ro,nosuid,nodev","",NULL,NULL);
    if(reader_same(point,"/tmp"))return !seen->tmp++&&reader_rule(options,type,super,"rw,nosuid,nodev,noexec","ro","tmpfs",NULL);
    /* The private device directory: its own tmpfs, read-only, nosuid, noexec, and the
     * only mount without nodev (the one node in it must stay usable). */
    if(reader_same(point,READER_DEV))return !seen->device++&&reader_rule(options,type,super,"ro,nosuid,noexec","nodev","tmpfs",NULL);
    if(reader_same(point,READER_PROC))return !seen->proc++&&reader_rule(options,type,super,sealed,"","proc",READER_PROC_OPTIONS);
    return 0;
}
/* The complete reachable mount list of the final view: nothing beyond the expected
 * table (recursive source/guidance clones may nest beneath their own mountpoints). */
static int reader_mountinfo_ok(const char *text, size_t length, const struct reader_plan *plan) {
    struct reader_mounts seen;memset(&seen,0,sizeof seen);
    const char *end=text+length;
    if(!length||text[length-1]!='\n')return 0;
    for(const char *line=text;line<end;) {
        const char *stop=memchr(line,'\n',(size_t)(end-line));
        if(!stop||stop==line||!reader_mount_line(line,stop,plan,&seen))return 0;
        line=stop+1;
    }
    for(int i=0;i<plan->dependencies;i++)if(seen.dependencies[i]!=1)return 0;
    return seen.root==1&&seen.source==1&&seen.shared==1&&seen.executable==1&&seen.tmp==1&&seen.device==1&&seen.proc==1;
}
/* END PORTABLE VIEW CONTRACT */

/* An invariant violation has no errno of its own: raise a fixed one so require()
 * audits it by its distinct label, exit 77 like every other setup failure. */
static void reader_expect(int holds, int error, const char *label) {
    if(!holds){errno=error;require(-1,label);}
}
/* Kernel identity of the one device node: character device 1:9, mode exactly 0444.
 * O_PATH: the node is examined, never opened as a device. */
static void reader_entropy_identity(const char *target, const char *label) {
    int fd=open(target,O_PATH|O_NOFOLLOW|O_CLOEXEC);require(fd,label);
    struct stat info;require(fstat(fd,&info),label);close(fd);
    reader_expect(S_ISCHR(info.st_mode)&&major(info.st_rdev)==1&&minor(info.st_rdev)==9&&(info.st_mode&07777)==0444,ENODEV,label);
}
/* WebKit opens /dev/urandom directly. Give the view a PRIVATE node instead of binding
 * the host's: a tiny tmpfs with device nodes allowed (nosuid, noexec; nr_inodes bounds
 * it), one mknod while still root, then the whole mount read-only. The host device
 * file is never opened, so no host inode (pool writes, notifications) is reachable. */
static void reader_entropy_node(const char *view, char target[8192]) {
    reader_point(view,READER_DEV,target,0);
    require(mount("tmpfs",target,"tmpfs",MS_NOSUID|MS_NOEXEC,READER_DEV_OPTIONS),"reader private device directory");
    const char *guest=READER_ENTROPY;char node[8192];path(node,sizeof node,view,guest+1);
    require(mknod(node,S_IFCHR|0444,makedev(1,9)),"reader entropy node");
    reader_entropy_identity(node,"reader created entropy identity");
    require(mount(NULL,target,NULL,MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NOEXEC,NULL),"reader readonly device directory");
}
#define READER_DIRENT_RECLEN 16
#define READER_DIRENT_NAME 19
/* 0: every entry accepted; 1: refused; -1: errno. Raw getdents64 records, no allocation. */
static int reader_walk(const char *directory, int (*visit)(void *state, int listing, const char *name), void *state) {
    int fd=open(directory,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return -1;
    union { char bytes[8192]; uint64_t alignment; } buffer;
    int result=0;
    while(!result) {
        long count=syscall(SYS_getdents64,fd,buffer.bytes,sizeof buffer.bytes);
        if(count<0){result=-1;break;}
        if(!count)break;
        for(long at=0;at<count&&!result;) {
            uint16_t length;memcpy(&length,buffer.bytes+at+READER_DIRENT_RECLEN,sizeof length);
            if(length<READER_DIRENT_NAME+2||length>count-at||!memchr(buffer.bytes+at+READER_DIRENT_NAME,0,(size_t)(length-READER_DIRENT_NAME))) {
                errno=EBADMSG;result=-1;break;
            }
            if(!visit(state,fd,buffer.bytes+at+READER_DIRENT_NAME))result=1;
            at+=length;
        }
    }
    int saved=errno;close(fd);errno=saved;return result;
}
static int reader_proc_accept(void *state, int listing, const char *name) {
    (void)listing;return reader_proc_name((struct reader_proc_names *)state,name);
}
static int reader_descriptor_accept(void *state, int listing, const char *name) {
    return reader_descriptor_name((unsigned int *)state,listing,name);
}
/* B1: the only numeric /proc entry is PID 1. */
static void reader_proc_inventory(void) {
    struct reader_proc_names seen={0,0,0};
    int walked=reader_walk(READER_PROC,reader_proc_accept,&seen);
    require(walked,"reader proc root inventory");
    reader_expect(!walked&&seen.init==1,ECHILD,"reader proc root inventory");
}
/* B2: this process is the namespace init of the PID namespace whose procfs this is, and
 * /proc/1 root and cwd are identical to this process's own root and cwd. */
static void reader_proc_identity(void) {
    reader_expect(getpid()==1,ECHILD,"reader init process id");
    struct stat view,proc_view;
    require(stat("/",&view),"reader proc root identity");
    require(stat(READER_PROC "/1/root",&proc_view),"reader proc root identity");
    reader_expect(view.st_dev==proc_view.st_dev&&view.st_ino==proc_view.st_ino,EXDEV,"reader proc root identity");
    require(stat(".",&view),"reader proc cwd identity");
    require(stat(READER_PROC "/1/cwd",&proc_view),"reader proc cwd identity");
    reader_expect(view.st_dev==proc_view.st_dev&&view.st_ino==proc_view.st_ino,EXDEV,"reader proc cwd identity");
}
/* B4: the reachable mount list is exactly the expected table. */
static void reader_mount_inventory(const struct reader_plan *plan) {
    static char text[1<<18];
    int fd=open(READER_PROC "/self/mountinfo",O_RDONLY|O_CLOEXEC);require(fd,"reader mount inventory");
    size_t length=0;
    for(;;) {
        ssize_t count=read(fd,text+length,sizeof text-length);
        if(count<0&&errno==EINTR)continue;
        require((int)count,"reader mount inventory");
        if(!count)break;
        length+=(size_t)count;
        reader_expect(length<sizeof text,EFBIG,"reader mount inventory");
    }
    close(fd);
    reader_expect(reader_mountinfo_ok(text,length,plan),EBUSY,"reader mount inventory");
}
/* B5: the exec descriptor table is exactly 0/1/2, still the verified pipe kinds. */
static void reader_descriptor_inventory(void) {
    unsigned int seen=0;
    int walked=reader_walk(READER_PROC "/self/fd",reader_descriptor_accept,&seen);
    require(walked,"reader descriptor inventory");
    reader_expect(!walked&&seen==7U,EBADF,"reader descriptor inventory");
    for(int fd=0;fd<3;fd++) {
        struct stat st;require(fstat(fd,&st),"reader descriptor kind");
        int flags=fcntl(fd,F_GETFL),descriptor_flags=fcntl(fd,F_GETFD);
        require(flags,"reader descriptor kind");require(descriptor_flags,"reader descriptor kind");
        reader_expect(S_ISFIFO(st.st_mode)&&(flags&O_ACCMODE)==(fd==0?O_RDONLY:O_WRONLY)&&!(descriptor_flags&FD_CLOEXEC),EBADF,"reader descriptor kind");
    }
}
/* Run as the reader identity, under the final filter, after the last irreversible
 * step. B3 (an outside canary must stay invisible) needs the harness, not this file. */
static void reader_verify_view(const struct reader_plan *plan) {
    reader_proc_inventory();
    reader_proc_identity();
    reader_entropy_identity(READER_ENTROPY,"reader final entropy identity");
    reader_mount_inventory(plan);
    reader_descriptor_inventory();
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

/* Bind the peer check and death signal to ONE original Root parent. Re-reading
 * getppid for pidfd_open could otherwise bind a new parent after reparenting.
 * SO_PEERCRED PID translation is valid here only BEFORE unshare/fork. */
static int reader_service_owner(int receipt) {
    pid_t original_parent=getppid();
    int socket_type;socklen_t type_length=sizeof socket_type;
    require(getsockopt(receipt,SOL_SOCKET,SO_TYPE,&socket_type,&type_length),"reader receipt type");
    struct ucred peer;socklen_t peer_length=sizeof peer;
    require(getsockopt(receipt,SOL_SOCKET,SO_PEERCRED,&peer,&peer_length),"reader Root peer");
    if(socket_type!=SOCK_SEQPACKET||peer_length!=sizeof peer||peer.uid!=0||peer.pid!=original_parent)_exit(64);
    int service=(int)syscall(SYS_pidfd_open,original_parent,0);require(service,"reader service pidfd");
    require(prctl(PR_SET_PDEATHSIG,SIGKILL),"reader service death");
    struct pollfd owner={service,POLLIN,0};
    if(getppid()!=original_parent||poll(&owner,1,0)!=0)_exit(77);
    return service;
}

int main(int argc, char **argv) {
    struct reader_plan plan;if(getuid()!=0||geteuid()!=0||!reader_parse(argc,argv,&plan))_exit(64);
    int64_t deadline=reader_milliseconds()+READER_WALL_MS;
    reader_pipes();reader_view(plan.view);reader_file(plan.executable,1);
    reader_directory(plan.source);reader_directory(plan.shared);reader_fd(plan.receipt);
    struct stat source,shared;require(fstat(plan.source,&source),"reader source identity");
    require(fstat(plan.shared,&shared),"reader shared identity");
    if(source.st_dev==shared.st_dev&&source.st_ino==shared.st_ino)_exit(64);
    int service=reader_service_owner(plan.receipt);
    for(int i=0;i<plan.dependencies;i++)reader_file(plan.dependency_fds[i],0);
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
    /* Every directory and mountpoint below is made with fixed modes; do not inherit Root's umask. */
    umask(022);
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
    reader_entropy_node(plan.view,target);
    /* Mounted here, by the namespace's own init, so the instance is THIS PID namespace's. */
    reader_point(plan.view,READER_PROC,target,0);
    require(mount("proc",target,"proc",MS_RDONLY|MS_NOSUID|MS_NODEV|MS_NOEXEC,READER_PROC_OPTIONS),"reader private proc");
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
    reader_verify_view(&plan);
    char *args[]={"/instruction-reader","--instruction-reader-v1",NULL};
    char *environment[]={"LANG=C","LC_ALL=C","TZ=UTC","HOME=" READER_HOME,"TMPDIR=/tmp","PATH=/usr/bin:/bin",NULL};
    execve(args[0],args,environment);require(-1,"reader immutable exec");return 77;
}
