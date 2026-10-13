"""Bounded path-neutral compile inputs and receipts. Unsigned measurements need trusted build provenance."""
import hashlib,json,os,stat,sys
from pathlib import Path
ENTRIES={"runtimeEntry":"runtime.ts","providerWorker":"provider.ts","hostClient":"host-client.ts"}
MAX_FILE=16*1024*1024
MAX_TOTAL=256*1024*1024
MAX_ENTRIES=20000
MAX_JSON=16*1024*1024
ROOT_FILES=('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json','tsconfig.typecheck.json','tsconfig.sdk-fence.json','bunfig.toml')
EXCLUDED={'.git','__pycache__','.DS_Store'}
def sha(path,limit=MAX_FILE):
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK),'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>limit:raise ValueError('input file limit/type')
        result=hashlib.sha256();size=0
        while True:
            data=stream.read(min(65536,limit-size+1))
            if not data:break
            size+=len(data)
            if size>limit:raise ValueError('input file limit')
            result.update(data)
        after=os.fstat(stream.fileno())
        if (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or size!=info.st_size:raise ValueError('input changed during capture')
        return {'sha256':result.hexdigest(),'bytes':size}
def inventory(root):
    root=Path(root).resolve();result={};total=0
    def visit(path):
        nonlocal total
        relative=path.relative_to(root).as_posix()
        if len(relative)>4096 or '\0' in relative or len(result)>=MAX_ENTRIES:raise ValueError('input inventory limit')
        if path.is_symlink():
            target=os.readlink(path)
            if Path(target).is_absolute() or len(target)>4096 or not path.resolve().is_relative_to(root) or not path.exists():raise ValueError('input symlink escapes/cannot resolve')
            result[relative]={'kind':'symlink','target':target}
        elif path.is_dir():
            for child in sorted(path.iterdir()):
                if child.name not in EXCLUDED:visit(child)
        elif path.is_file():
            item=sha(path);total+=item['bytes']
            if total>MAX_TOTAL:raise ValueError('input aggregate limit')
            result[relative]={'kind':'file',**item}
        else:raise ValueError('input type')
    for name in ROOT_FILES:visit(root/name)
    for name in ('packages','scripts','node_modules'):visit(root/name)
    return dict(sorted(result.items()))
def json_read(path):
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK),'rb') as stream:
        if os.fstat(stream.fileno()).st_size>MAX_JSON:raise ValueError('receipt size limit')
        data=stream.read(MAX_JSON+1)
        if len(data)>MAX_JSON:raise ValueError('receipt size limit')
    return json.loads(data)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def inventory_hash(value):return hashlib.sha256(canonical(value).encode()).hexdigest()
def validate_compile(receipt,root,entries,base_pin,metafiles):
    if not isinstance(receipt,dict) or receipt.get('formatVersion')!=1 or receipt.get('kind')!='winter-host-query-compile':raise ValueError('compile receipt shape')
    inputs=receipt.get('inputs')
    if inputs!=inventory(root) or receipt.get('inputInventorySha256')!=inventory_hash(inputs):raise ValueError('compiled sources/dependencies changed')
    compiler=receipt.get('compiler',{})
    if set(compiler)!={'version','sha256','bytes','platform','architecture'} or compiler.get('version')!=base_pin['version'] or not isinstance(compiler.get('sha256'),str) or not all(c in '0123456789abcdef' for c in compiler['sha256']) or len(compiler['sha256'])!=64 or type(compiler.get('bytes')) is not int or not 1<=compiler['bytes']<=256*1024*1024:raise ValueError('compile compiler identity')
    if compiler.get('platform') not in ('darwin','linux') or compiler.get('architecture') not in ('arm64','x64'):raise ValueError('compile host identity')
    if receipt.get('base')!={'version':base_pin['version'],'target':base_pin['target'],'sha256':base_pin['executableSha256']}:raise ValueError('compile base pin')
    if receipt.get('recipe')!={'flags':['--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv',f"--target={base_pin['target']}",'--compile-executable-path=linux-bun-base','--metafile=<entry>.metafile.json'],'cwd':'stage','source':'../source','environment':{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'}}:raise ValueError('compile recipe')
    outputs=receipt.get('outputs')
    if not isinstance(outputs,dict) or set(outputs)!=set(entries):raise ValueError('compile output inventory')
    for name,path in entries.items():
        expected=outputs[name]
        if not isinstance(expected,dict) or set(expected)!={'entry','sha256','bytes','bundledInputs','metafileSha256','command'} or expected['entry']!=f"scripts/guest-host-query/{ENTRIES[name]}":raise ValueError('compile output shape')
        command=['<compiler>','build','--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv',f"--target={base_pin['target']}",'--compile-executable-path=linux-bun-base',f'--metafile={name}.metafile.json',f"../source/{expected['entry']}",'--outfile',f'<output>/{name}']
        if expected['command']!=command:raise ValueError('compile output recipe')
        actual=sha(path,256*1024*1024)
        if {key:expected[key] for key in ('sha256','bytes')}!=actual:raise ValueError('compiled artifact mismatch')
        with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK),'rb') as stream:header=stream.read(20)
        if len(header)!=20 or header[:6]!=b'\x7fELF\x02\x01' or int.from_bytes(header[18:20],'little')!=183:raise ValueError('compiled ARM64 ELF required')
        bundled=expected['bundledInputs']
        if not isinstance(bundled,dict) or not bundled or expected['entry'] not in bundled or len(bundled)>MAX_ENTRIES:raise ValueError('compile bundled input inventory')
        for relative,item in bundled.items():
            if inputs.get(relative)!=item or item.get('kind')!='file':raise ValueError('compile bundled dependency mismatch')
        meta_hash=expected['metafileSha256']
        metadata=json_read(metafiles[name])
        if sha(metafiles[name],MAX_JSON)['sha256']!=meta_hash or not isinstance(metadata,dict) or not isinstance(metadata.get('inputs'),dict):raise ValueError('compile metafile changed')
        # Bun emits the physical package paths; the retained normalized file binds the graph.
        measured={}
        for relative,item in metadata['inputs'].items():
            if relative not in inputs or inputs[relative].get('kind')!='file' or not isinstance(item,dict) or item.get('bytes')!=inputs[relative]['bytes']:raise ValueError('compile metafile input mismatch')
            measured[relative]=inputs[relative]
        if measured!=bundled:raise ValueError('compile metafile bundled inventory')
        if not isinstance(meta_hash,str) or len(meta_hash)!=64 or any(c not in '0123456789abcdef' for c in meta_hash):raise ValueError('compile metafile identity')
    if receipt.get('linuxExecutionVerified') is not False or receipt.get('vmExecutionVerified') is not False:raise ValueError('compile receipt execution claim')
    return receipt
if __name__=='__main__':
    if len(sys.argv)!=3 or sys.argv[1]!='inventory':raise SystemExit('fixed inventory arguments required')
    print(canonical(inventory(sys.argv[2])))
