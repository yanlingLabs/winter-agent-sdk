#define _GNU_SOURCE
/* SOURCE PREREQUISITE ONLY: capability probe for the instruction-reader view.
 * Unwired: no launcher, profile, producer or build list names this file. It is
 * exec'd by a separately admitted harness IN PLACE OF /instruction-reader, under
 * the identical sealed view, identity, limits, filter and pipe envelope. It makes
 * no claim about Bun, the reader or any recorded run. It only reports whether two
 * pinned-source dependencies are satisfiable in that view: WebKit's direct open of
 * the entropy device (WTF RandomDevice) and glibc's initial-thread stack lookup
 * through the process memory map (nptl pthread_getattr_np).
 *
 * Reference build: the packet builder compiles and links it DYNAMICALLY with its
 * NATIVE_FLAGS (-std=gnu11 -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2
 * -fstack-protector-strong -fPIE -pie, no -static), against the packet's pinned libc.
 * That is deliberate: pthread_getattr_np in that exact libc is the dependency under
 * test. The source gate additionally compiles it to objects with -std=c11 ... -c.
 *
 * STDOUT is exactly ONE line and nothing else; STDERR is never written. Exit
 * status is 0 once the whole line is written, 70 if it could not be written.
 *
 *   line  = "probe=reader-v2"
 *           " stack_rc="       N     ; initial-thread pthread_getattr_np return (0 = success, else errno)
 *           " stack_bounds="   B     ; reported stack base nonzero and size nonzero
 *           " stack_contains=" B     ; a local in the probe's current stack frame lies inside [base, base+size)
 *           " urandom_open="   N     ; errno of open of the entropy device (0 = opened)
 *           " urandom_read="   B     ; exactly 16 bytes read; the bytes are zeroed, never printed
 *           " getrandom="      N     ; errno of a non-blocking 16-byte getrandom (0 = exactly 16)
 *           " proc_list="      N     ; errno of listing the proc root (0 = listed)
 *           " proc_numeric="   N     ; count of all-digit entries (0 whenever proc_list != 0)
 *           " proc_root="      B     ; stat of proc PID 1 root equals stat of "/" (dev and inode)
 *           " canary_open="    N     ; errno of open of the fixed outside-canary path (0 = opened); see below
 *           LF
 *   N     = "0" / ( %x31-39 *DIGIT )   ; canonical unsigned decimal, at most 10 digits, no sign
 *   B     = "0" / "1"
 *
 * Keys appear exactly once, in exactly this order, separated by single spaces.
 * No address, mapping text, path, random byte, pid, name or argv value is ever
 * printed. A missing, shortened, reordered or additional field is a harness failure.
 *
 * Outside canary (the file half of B3). The harness creates a Root-owned mode 0444
 * regular file named "/winter-outside-canary" at the TOP of the launch root, which is
 * the launcher's "/" after the producer's chroot; it must NOT exist in the reader view.
 * The probe opens that fixed path O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC, closes the
 * descriptor at once on success and never reads it. canary_open=2 (ENOENT) means not
 * visible; canary_open=0 means visible (an escape); any other value is unknown. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define PROBE_ENTROPY "/dev/urandom"
#define PROBE_PROC "/proc"
#define PROBE_CANARY "/winter-outside-canary"
#define PROBE_GRND_NONBLOCK 1

/* BEGIN PORTABLE PROBE LINE -- pure formatting, no descriptor or native effects. */
struct probe_report {
    unsigned int stack_rc, stack_bounds, stack_contains, urandom_open, urandom_read,
                 getrandom_errno, proc_list, proc_numeric, proc_root, canary_open;
};
static int probe_line(char *out, size_t size, const struct probe_report *report) {
    int length=snprintf(out,size,"probe=reader-v2 stack_rc=%u stack_bounds=%u stack_contains=%u "
        "urandom_open=%u urandom_read=%u getrandom=%u proc_list=%u proc_numeric=%u proc_root=%u canary_open=%u\n",
        report->stack_rc,report->stack_bounds?1U:0U,report->stack_contains?1U:0U,
        report->urandom_open,report->urandom_read?1U:0U,report->getrandom_errno,
        report->proc_list,report->proc_numeric,report->proc_root?1U:0U,report->canary_open);
    return length>0&&(size_t)length<size?length:-1;
}
/* END PORTABLE PROBE LINE */

/* main runs on the process's INITIAL thread, which is the case glibc resolves by
 * reading the process memory map; a created pthread takes a different branch. */
static void probe_stack(struct probe_report *report) {
    pthread_attr_t attributes;
    volatile char marker=0;
    int rc=pthread_getattr_np(pthread_self(),&attributes);
    report->stack_rc=(unsigned int)rc;
    if(rc)return;
    void *base=NULL;size_t size=0;
    if(!pthread_attr_getstack(&attributes,&base,&size)) {
        uintptr_t low=(uintptr_t)base,here=(uintptr_t)&marker;
        report->stack_bounds=base&&size?1U:0U;
        report->stack_contains=report->stack_bounds&&here>=low&&here-low<size?1U:0U;
    }
    pthread_attr_destroy(&attributes);
}
static void probe_entropy(struct probe_report *report) {
    unsigned char bytes[16];
    int fd=open(PROBE_ENTROPY,O_RDONLY|O_CLOEXEC);
    if(fd<0){report->urandom_open=(unsigned int)errno;}
    else {
        size_t have=0;
        while(have<sizeof bytes) {
            ssize_t count=read(fd,bytes+have,sizeof bytes-have);
            if(count<0&&errno==EINTR)continue;
            if(count<=0)break;
            have+=(size_t)count;
        }
        report->urandom_read=have==sizeof bytes?1U:0U;
        explicit_bzero(bytes,sizeof bytes);
        close(fd);
    }
    long count=syscall(SYS_getrandom,bytes,sizeof bytes,(long)PROBE_GRND_NONBLOCK);
    report->getrandom_errno=count==(long)sizeof bytes?0U:count<0?(unsigned int)errno:(unsigned int)EIO;
    explicit_bzero(bytes,sizeof bytes);
}
/* The identity fact does not depend on the listing, so it is measured first. */
static void probe_proc(struct probe_report *report) {
    struct stat proc_root,root;
    report->proc_root=!stat(PROBE_PROC "/1/root",&proc_root)&&!stat("/",&root)&&
        proc_root.st_dev==root.st_dev&&proc_root.st_ino==root.st_ino?1U:0U;
    DIR *directory=opendir(PROBE_PROC);
    if(!directory){report->proc_list=(unsigned int)errno;return;}
    unsigned int numeric=0;
    errno=0;
    for(struct dirent *entry=readdir(directory);entry;entry=readdir(directory)) {
        size_t digits=strspn(entry->d_name,"0123456789");
        if(digits&&!entry->d_name[digits])numeric++;
    }
    int failed=errno;
    closedir(directory);
    if(failed)report->proc_list=(unsigned int)failed;
    else report->proc_numeric=numeric;
}
/* Opened, never read: visibility is the whole question. The descriptor is closed at once. */
static void probe_canary(struct probe_report *report) {
    int fd=open(PROBE_CANARY,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
    if(fd<0){report->canary_open=(unsigned int)errno;return;}
    close(fd);
}
int main(void) {
    struct probe_report report;memset(&report,0,sizeof report);
    probe_stack(&report);probe_entropy(&report);probe_proc(&report);probe_canary(&report);
    char line[512];int length=probe_line(line,sizeof line,&report);
    if(length<0)return 70;
    for(int written=0;written<length;) {
        ssize_t count=write(1,line+written,(size_t)(length-written));
        if(count<0&&errno==EINTR)continue;
        if(count<=0)return 70;
        written+=(int)count;
    }
    return 0;
}
