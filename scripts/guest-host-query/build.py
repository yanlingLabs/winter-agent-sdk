#!/usr/bin/env python3
"""Build native fresh-engine fixture artifacts and record exact review inputs. Never launches.
Runtime/provider executables must already be compiled from reviewed fixture entry sources.
"""
import argparse,hashlib,importlib.util,json,os,shutil,subprocess,sys
from pathlib import Path
if __name__=='__main__' and os.geteuid()==0:raise SystemExit('native artifacts must be built unprivileged; privileged checkout entry refused before imports')
ROOT=Path(__file__).resolve().parents[2]
PROVENANCE_PATH=Path(__file__).with_name('provenance.py')
_spec=importlib.util.spec_from_file_location('fresh_provenance',PROVENANCE_PATH);provenance=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(provenance)
ENTRIES=('runtimeEntry','providerWorker','hostClient')
NATIVE={'toolLauncher':'linux-tool-compartment.c','runtimeLauncher':'linux-runtime-compartment.c','fileWorker':'file-worker.c','processWorker':'process-worker.c','ownerLibrary':'linux-session-owner.c'}
UTILITY_SOURCES=['scripts/guest-utilities/utility_inputs.py','scripts/guest-utilities/closure.py','scripts/guest-utilities/stdlib_graph.py','scripts/guest-utilities/smoke.sh','scripts/guest-utilities/descendant.py','scripts/guest-utilities/oracle.py','scripts/guest-host-query/utility-environment.py','scripts/guest-host-query/utility-data.py','scripts/guest-host-query/utilities.sh','scripts/guest-host-query/utilities-plan.sh']
SOURCES=[*UTILITY_SOURCES,'packages/runtime/src/guest/linux-supervisor.py','packages/runtime/src/guest/linux-compartment.h',*[f'packages/runtime/src/guest/{name}' for name in NATIVE.values()],'packages/runtime/src/guest/linux-session-admission.ts','scripts/guest-host-query/runtime.ts','scripts/guest-host-query/provider.ts','scripts/guest-host-query/host-client.ts','scripts/guest-host-query/cases.ts','scripts/guest-host-query/compile.ts','scripts/build-runtime.ts','scripts/linux-runtime-base.json','scripts/guest-host-query/verify.py','scripts/guest-host-query/build.py','scripts/guest-host-query/provenance.py','scripts/guest-host-query/stage.py','scripts/guest-engine/verify.py']
def digest(path):
    return provenance.sha(path,256*1024*1024)['sha256']
def source_inventory(extra=()):
    # Cover the actual SDK/provider/config dependency tree as well as new fixture
    # leaves. A changed embedded/engine/store consumer invalidates the receipt.
    tracked=[]
    for directory,folders,files in os.walk(ROOT/'packages',followlinks=False):
        folders[:]=[name for name in folders if name not in ('node_modules','.git','dist','out','__pycache__')]
        for name in files:
            path=Path(directory)/name
            if path.suffix in ('.ts','.json','.c','.h','.py'):tracked.append(str(path.relative_to(ROOT)))
    inventory=sorted(set([*SOURCES,*tracked,'package.json','pnpm-lock.yaml','tsconfig.base.json','bunfig.toml',*extra]))
    for relative in inventory:
        spelling=Path(relative);source=ROOT/spelling
        if spelling.is_absolute() or '..' in spelling.parts or source.is_symlink() or source.resolve()!=source:raise ValueError('source inventory must stay canonical inside checkout')
    return inventory
def capture_sources(extra=()):
    return {relative:provenance.sha(ROOT/relative)['sha256'] for relative in source_inventory(extra)}
def validate_receipt(receipt,directory):
    if not isinstance(receipt,dict) or receipt.get('formatVersion')!=3 or receipt.get('kind')!='winter-host-query-utilities' or not isinstance(receipt.get('sources'),dict) or not isinstance(receipt.get('artifacts'),dict):raise ValueError('review receipt shape')
    if not set(source_inventory())<=set(receipt['sources']) or set(receipt['artifacts'])!=set(NATIVE)|set(ENTRIES):raise ValueError('review receipt inventory')
    for relative,expected in receipt['sources'].items():
        path=Path(relative)
        if path.is_absolute() or '..' in path.parts or (ROOT/path).is_symlink() or digest(ROOT/path)!=expected:raise ValueError('reviewed source changed')
    for name,expected in receipt['artifacts'].items():
        path=Path(directory)/name
        if path.is_symlink() or not path.is_file() or digest(path)!=expected:raise ValueError('reviewed artifact changed')
    compile_path=Path(directory)/'compile-receipt.json'
    if digest(compile_path)!=receipt.get('compileReceiptSha256'):raise ValueError('compile receipt changed')
    validate_compile_receipt(provenance.json_read(compile_path),directory)
    parent=load_parent()
    with parent.capture(ROOT,directory,Path(directory)/'receipt.json',digest(Path(directory)/'receipt.json'),environment=Path(directory)/'environment'):pass
    return receipt

def validate_staged_receipt(directory,receipt_path):
    admission=getattr(sys,'_winter_host_query_stage_admission',None)
    if admission is None:raise ValueError('sealed bootstrap admission required')
    staged=Path(admission.directory)
    if ROOT!=staged/'source' or Path(directory)!=staged/'artifacts' or Path(receipt_path)!=staged/'artifacts/receipt.json':raise ValueError('closed sealed runner paths')
    parent=load_parent();native,environment=parent.open_admitted_environment()
    try:return native
    finally:os.close(environment)

def load_parent():
    spec=importlib.util.spec_from_file_location('host_query_utility_parent',Path(__file__).with_name('stage.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def validate_compile_receipt(receipt,directory,entries=None):
    directory=Path(directory)
    entries=entries or {name:directory/name for name in ENTRIES}
    pin=provenance.json_read(ROOT/'scripts/linux-runtime-base.json')
    return provenance.validate_compile(receipt,ROOT,entries,pin,{name:directory/f'{name}.metafile.json' for name in entries})

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--runtime-entry',type=Path,required=True);parser.add_argument('--provider-worker',type=Path,required=True);parser.add_argument('--host-client',type=Path,required=True);parser.add_argument('--compile-receipt',type=Path,required=True);parser.add_argument('--utility-capture',type=Path,required=True);parser.add_argument('--utility-origin',type=Path,required=True);parser.add_argument('--provider-source',action='append',default=[]);parser.add_argument('--cc',default='cc');args=parser.parse_args()
    if sys.platform!='linux':raise SystemExit('Native Linux build only; local cross-compilation does not establish fixture execution')
    if args.output.exists():raise SystemExit('Use a new isolated artifact directory')
    compile_receipt=provenance.json_read(args.compile_receipt)
    validate_compile_receipt(compile_receipt,args.compile_receipt.parent,{'runtimeEntry':args.runtime_entry,'providerWorker':args.provider_worker,'hostClient':args.host_client})
    cc=shutil.which(args.cc)
    if not cc:raise SystemExit('Existing native compiler required')
    cc=Path(cc).resolve();compiler_identity=provenance.sha(cc,256*1024*1024)
    version=subprocess.run([str(cc),'--version'],capture_output=True,timeout=10)
    if version.returncode or len(version.stdout)>8192 or len(version.stderr)>8192:raise SystemExit('Native compiler version unavailable')
    # Compiler output is trusted build metadata; no checkout paths enter the retained commands.
    version_line=version.stdout.decode(errors='replace').splitlines()[0]
    if '/' in version_line:raise SystemExit('Native compiler version must be path-neutral')
    source_hashes=capture_sources(args.provider_source);args.output.mkdir(mode=0o700,parents=True);commands=[]
    for name,source in NATIVE.items():
        flags=['-shared','-fPIC'] if name=='ownerLibrary' else ['-static']
        command=[str(cc),'-std=c11','-O2','-Wall','-Wextra','-Werror',*flags,str(ROOT/'packages/runtime/src/guest'/source),'-o',str(args.output/name)]
        result=subprocess.run(command,capture_output=True,timeout=60,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'})
        if result.returncode:raise SystemExit(f'native build failed: {name}: '+result.stderr[-2000:].decode(errors='replace'))
        commands.append(['<native-compiler>',*command[1:-3],f'packages/runtime/src/guest/{source}','-o',f'<artifacts>/{name}'])
    for name,source in [('runtimeEntry',args.runtime_entry),('providerWorker',args.provider_worker),('hostClient',args.host_client)]:
        if source.is_symlink() or not source.is_file():raise SystemExit('Compiled fixture executable required')
        shutil.copyfile(source,args.output/name)
    for name in [*NATIVE,*ENTRIES]:(args.output/name).chmod(0o555)
    for name in ['compile-receipt.json',*[f'{name}.metafile.json' for name in ENTRIES]]:
        shutil.copyfile(args.compile_receipt if name=='compile-receipt.json' else args.compile_receipt.parent/name,args.output/name);(args.output/name).chmod(0o444)
    validate_compile_receipt(provenance.json_read(args.output/'compile-receipt.json'),args.output)
    if provenance.sha(cc,256*1024*1024)!=compiler_identity:raise SystemExit('Native compiler changed during build')
    if capture_sources(args.provider_source)!=source_hashes:raise SystemExit('Sources changed during artifact build')
    parent=load_parent()
    capture=provenance.json_read(args.utility_capture/'utility-receipt.json');origin=provenance.json_read(args.utility_origin)
    spec=importlib.util.spec_from_file_location('utility_capture_validation',ROOT/'scripts/guest-utilities/closure.py');closure=importlib.util.module_from_spec(spec);spec.loader.exec_module(closure);closure.validate_capture(capture,args.utility_capture/'environment')
    shutil.copytree(args.utility_capture/'environment',args.output/'environment',symlinks=False)
    for source,name in ((args.utility_capture/'utility-receipt.json','utility-receipt.json'),(args.utility_origin,'utility-origin-receipt.json')):shutil.copyfile(source,args.output/name);(args.output/name).chmod(0o444)
    dependencies={}
    for name in ('runtimeEntry','ownerLibrary'):
        fd=os.open(args.output/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:dependencies[name]=parent.elf_dependencies(fd)
        finally:os.close(fd)
    receipt={'formatVersion':3,'kind':'winter-host-query-utilities','utilityCapture':capture,'utilityOrigin':origin,'environment':capture['outputs'],'utilityCaptureSha256':digest(args.output/'utility-receipt.json'),'utilityOriginSha256':digest(args.output/'utility-origin-receipt.json'),'elfDependencies':dependencies,'compileReceiptSha256':digest(args.output/'compile-receipt.json'),'sources':source_hashes,'artifacts':{name:digest(args.output/name) for name in [*NATIVE,*ENTRIES]},'nativeBuildCommands':commands,'nativeCompiler':{**compiler_identity,'version':version_line},'nativeBuildEnvironment':{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'},'linuxExecutionVerified':False,'vmExecutionVerified':False}
    (args.output/'receipt.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n');(args.output/'receipt.json').chmod(0o444)
    with parent.capture(ROOT,args.output,args.output/'receipt.json',digest(args.output/'receipt.json'),environment=args.output/'environment'):pass
    print(json.dumps({'receiptFile':'receipt.json','nativeArtifactsBuilt':True,'linuxExecutionVerified':False,'vmExecutionVerified':False}))
if __name__=='__main__':main()
