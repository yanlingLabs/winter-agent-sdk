#!/usr/bin/env python3
"""Build native fresh-engine fixture artifacts and record exact review inputs. Never launches.
Runtime/provider executables must already be compiled from reviewed fixture entry sources.
"""
import argparse,hashlib,json,os,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
NATIVE={'toolLauncher':'linux-tool-compartment.c','runtimeLauncher':'linux-runtime-compartment.c','fileWorker':'file-worker.c','processWorker':'process-worker.c','ownerLibrary':'linux-session-owner.c'}
SOURCES=['packages/runtime/src/guest/linux-supervisor.py','packages/runtime/src/guest/linux-compartment.h',*[f'packages/runtime/src/guest/{name}' for name in NATIVE.values()],'packages/runtime/src/guest/linux-session-admission.ts','scripts/guest-engine/runtime.ts','scripts/guest-engine/provider.ts','scripts/guest-engine/compile.ts','scripts/build-runtime.ts','scripts/linux-runtime-base.json','scripts/guest-engine/verify.py','scripts/guest-engine/build.py']
def digest(path):
    hash=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(65536),b''):hash.update(block)
    return hash.hexdigest()
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
    return {relative:digest(ROOT/relative) for relative in source_inventory(extra)}
def validate_receipt(receipt,directory):
    if not isinstance(receipt,dict) or receipt.get('formatVersion')!=1 or not isinstance(receipt.get('sources'),dict) or not isinstance(receipt.get('artifacts'),dict):raise ValueError('review receipt shape')
    if not set(source_inventory())<=set(receipt['sources']) or set(receipt['artifacts'])!=set(NATIVE)|{'runtimeEntry','providerWorker'}:raise ValueError('review receipt inventory')
    for relative,expected in receipt['sources'].items():
        path=Path(relative)
        if path.is_absolute() or '..' in path.parts or (ROOT/path).is_symlink() or digest(ROOT/path)!=expected:raise ValueError('reviewed source changed')
    for name,expected in receipt['artifacts'].items():
        path=Path(directory)/name
        if path.is_symlink() or not path.is_file() or digest(path)!=expected:raise ValueError('reviewed artifact changed')
    return receipt

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--runtime-entry',type=Path,required=True);parser.add_argument('--provider-worker',type=Path,required=True);parser.add_argument('--provider-source',action='append',default=[]);parser.add_argument('--cc',default='cc');args=parser.parse_args()
    if sys.platform!='linux':raise SystemExit('Native Linux build only; local cross-compilation does not establish fixture execution')
    if args.output.exists():raise SystemExit('Use a new isolated artifact directory')
    source_hashes=capture_sources(args.provider_source);args.output.mkdir(mode=0o700,parents=True);commands=[]
    for name,source in NATIVE.items():
        flags=['-shared','-fPIC'] if name=='ownerLibrary' else ['-static']
        command=[args.cc,'-std=c11','-O2','-Wall','-Wextra','-Werror',*flags,str(ROOT/'packages/runtime/src/guest'/source),'-o',str(args.output/name)]
        result=subprocess.run(command,capture_output=True,timeout=60)
        if result.returncode:raise SystemExit(f'native build failed: {name}: '+result.stderr[-2000:].decode(errors='replace'))
        commands.append(command)
    for name,source in [('runtimeEntry',args.runtime_entry),('providerWorker',args.provider_worker)]:
        if source.is_symlink() or not source.is_file():raise SystemExit('Compiled fixture executable required')
        shutil.copyfile(source,args.output/name)
    for name in [*NATIVE,'runtimeEntry','providerWorker']:(args.output/name).chmod(0o555)
    if capture_sources(args.provider_source)!=source_hashes:raise SystemExit('Sources changed during artifact build')
    receipt={'formatVersion':1,'sources':source_hashes,'artifacts':{name:digest(args.output/name) for name in [*NATIVE,'runtimeEntry','providerWorker']},'nativeBuildCommands':commands,'linuxExecutionVerified':False,'vmExecutionVerified':False}
    (args.output/'receipt.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n');(args.output/'receipt.json').chmod(0o444)
    print(json.dumps({'receipt':str(args.output/'receipt.json'),'nativeArtifactsBuilt':True,'linuxExecutionVerified':False,'vmExecutionVerified':False}))
if __name__=='__main__':main()
