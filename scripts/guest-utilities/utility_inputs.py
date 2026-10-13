"""Ordinary Linux build-only fixed utility inputs. readelf reads metadata; no input ELF runs."""
import os,sys
if __name__=='__main__' and os.geteuid()==0:raise SystemExit('ordinary utility origin builder required')
import argparse,hashlib,importlib.util,json,platform,re,subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('utility_capture',HERE/'closure.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
PACKAGES=('collections','encodings','importlib','json','multiprocessing','re','zipfile')
MODULES=('__future__','_collections_abc','_compression','_sitebuiltins','_weakrefset','abc','argparse','base64','bisect','calendar','codecs','contextlib','copy','copyreg','datetime','decimal','dis','enum','fnmatch','functools','genericpath','getopt','gettext','hashlib','heapq','hmac','inspect','io','keyword','linecache','locale','logging','numbers','operator','os','pathlib','pickle','platform','posixpath','queue','random','reprlib','runpy','secrets','selectors','shutil','signal','site','socket','stat','string','struct','subprocess','sysconfig','tempfile','textwrap','threading','token','tokenize','traceback','types','typing','warnings','weakref')
EXTENSIONS=('_multiprocessing','_posixshmem','_socket','_struct','array','binascii','math','select','_random','_sha2','_hashlib','_blake2','_pickle','_heapq','_bisect','_posixsubprocess','fcntl','mmap','_csv','_datetime','_opcode','zlib')


def stdlib_paths(base):
    """Enumerate the fixed Python 3.12 module/package selection without importing it."""
    base=Path(base);paths=[]
    for name in MODULES:
        path=base/(name+'.py')
        if path.is_file():paths.append(path)
        elif name=='logging' and (base/name/'__init__.py').is_file():
            paths.extend(sorted((base/name).glob('*.py')))
        else:raise ValueError('fixed Python module missing: '+name)
    for package in PACKAGES:
        if not (base/package/'__init__.py').is_file():raise ValueError('fixed Python package missing: '+package)
        paths.extend(path for path in sorted((base/package).rglob('*.py')) if not any(part in ('test','tests','__pycache__') for part in path.relative_to(base).parts))
    return paths


def prepare(output):
    if sys.platform!='linux' or platform.machine()!='aarch64' or os.geteuid()==0:raise ValueError('ordinary Linux ARM64 origin build only')
    output=Path(output);output.mkdir(mode=0o700);origin=output/'origin';origin.mkdir(mode=0o700);files={};commands=[];pending=[]
    reader=Path('/usr/bin/readelf').resolve();reader_identity=c.measured_path(reader)
    def add(guest,source,role):
        source=Path(source).resolve(strict=True);relative=source.as_posix()[1:]
        if guest in files:return
        fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC);target=origin/relative;target.parent.mkdir(parents=True,exist_ok=True);destination=None
        try:
            if target.exists():
                measured,header=c.measure(fd)
            else:
                destination=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);measured,header=c.measure(fd,destination);os.fsync(destination);os.fchmod(destination,0o444)
            if role!='stdlib' and (len(header)!=20 or header[:6]!=b'\x7fELF\x02\x01' or int.from_bytes(header[18:20],'little')!=183):raise ValueError('ARM64 input ELF required')
            files[guest]={'role':role,'source':relative,'executable':role=='executable' or role=='library' and guest in c.ELF_LOADERS,**measured}
            if role!='stdlib':pending.append((guest,target))
        finally:
            os.close(fd)
            if destination is not None:os.close(destination)
    for guest in sorted(c.EXECUTABLES):
        source='/usr/bin/python3.12' if guest=='/usr/bin/python3' else guest
        add(guest,source,'executable')
    for loader in sorted(c.ELF_LOADERS):add(loader,'/lib/ld-linux-aarch64.so.1','library')
    base=Path('/usr/lib/python3.12')
    for path in stdlib_paths(base):add(path.as_posix(),path,'stdlib')
    for extension in EXTENSIONS:
        found=list((base/'lib-dynload').glob(extension+'.*.so'))
        if len(found)>1:raise ValueError('ambiguous Python extension')
        for path in found:add(path.as_posix(),path,'extension')
    visited=set()
    while pending:
        guest,path=pending.pop()
        if guest in visited:continue
        visited.add(guest)
        result=subprocess.run([str(reader),'--wide','--dynamic','--program-headers',str(path)],capture_output=True,text=True,timeout=10,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
        if result.returncode or len(result.stdout)>65536 or len(result.stderr)>4096:raise ValueError('bounded readelf metadata required')
        commands.append({'input':guest,'flags':['--wide','--dynamic','--program-headers'],'stdoutSha256':c.digest(result.stdout.encode())})
        for name in re.findall(r'\(NEEDED\).*?\[([^\]]+)\]',result.stdout):
            if not re.fullmatch(r'[A-Za-z0-9_.+-]+\.so(?:\.[0-9.]+)?',name):raise ValueError('library basename')
            candidates=[Path('/usr/lib/aarch64-linux-gnu')/name,Path('/lib/aarch64-linux-gnu')/name]
            source=next((candidate for candidate in candidates if candidate.is_file()),None)
            if source is None:raise ValueError('fixed library dependency missing')
            add('/lib/aarch64-linux-gnu/'+name,source,'library')
    manifest=c.validate_manifest({'formatVersion':1,'kind':'winter-tool-utility-inputs','target':'linux-arm64-gnu','files':files})
    if c.measured_path(reader)!=reader_identity:raise ValueError('readelf changed')
    (output/'input-manifest.json').write_text(c.canonical(manifest)+'\n')
    (output/'origin-receipt.json').write_text(c.canonical({'kind':'winter-utility-origin','builder':{'version':platform.python_version(),**c.measured_path(Path(sys.executable).resolve(),128*1024*1024)},'readelf':reader_identity,'readelfCommands':commands,'manifestSha256':c.digest(c.canonical(manifest).encode()),'utilityExecution':False,'dependencyCompletenessVerified':False})+'\n')
    return manifest


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',required=True);args=parser.parse_args();prepare(args.out)
