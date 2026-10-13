"""Portable measured compile receipt tests. Synthetic ELF headers are never executed."""
import copy,hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
P=Path(__file__).with_name('provenance.py');spec=importlib.util.spec_from_file_location('provenance',P);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class CompileProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.output=self.root/'out';self.output.mkdir()
        for name in p.ROOT_FILES:(self.root/name).write_text('{}')
        for name in ('packages','scripts/guest-engine','node_modules/pkg'):(self.root/name).mkdir(parents=True,exist_ok=True)
        for name in ('runtime','provider'):(self.root/f'scripts/guest-engine/{name}.ts').write_text('entry '+name)
        (self.root/'node_modules/pkg/index.js').write_text('actual installed bytes')
        self.pin={'version':'1.3.14','target':'bun-linux-arm64','executableSha256':'a'*64}
        (self.root/'scripts/linux-runtime-base.json').write_text(json.dumps(self.pin))
        self.inputs=p.inventory(self.root);self.entries={};self.metas={};outputs={}
        for name,entry in [('runtimeEntry','runtime'),('providerWorker','provider')]:
            file=self.output/name;header=bytearray(20);header[:6]=b'\x7fELF\x02\x01';header[18:20]=(183).to_bytes(2,'little');file.write_bytes(header+b'synthetic-not-executable-'+name.encode());self.entries[name]=file
            relative=f'scripts/guest-engine/{entry}.ts';bundled={key:self.inputs[key] for key in (relative,'node_modules/pkg/index.js')}
            metadata={'inputs':{key:{'bytes':item['bytes']} for key,item in bundled.items()},'outputs':{}};meta=self.output/f'{name}.metafile.json';meta.write_text(p.canonical(metadata)+'\n');self.metas[name]=meta
            command=['<compiler>','build','--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv','--target=bun-linux-arm64','--compile-executable-path=linux-bun-base',f'--metafile={name}.metafile.json',f'../source/{relative}','--outfile',f'<output>/{name}']
            outputs[name]={'entry':relative,**p.sha(file),'bundledInputs':bundled,'metafileSha256':p.sha(meta)['sha256'],'command':command}
        self.receipt={'formatVersion':1,'kind':'winter-fresh-engine-compile','inputs':self.inputs,'inputInventorySha256':p.inventory_hash(self.inputs),'compiler':{'version':'1.3.14','sha256':'b'*64,'bytes':123,'platform':'darwin','architecture':'arm64'},'base':{'version':'1.3.14','target':'bun-linux-arm64','sha256':'a'*64},'recipe':{'flags':['--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv','--target=bun-linux-arm64','--compile-executable-path=linux-bun-base','--metafile=<entry>.metafile.json'],'cwd':'stage','source':'../source','environment':{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'}},'outputs':outputs,'linuxExecutionVerified':False,'vmExecutionVerified':False}
    def tearDown(self):self.temp.cleanup()
    def validate(self):return p.validate_compile(self.receipt,self.root,self.entries,self.pin,self.metas)
    def test_exact_measurement_accepts(self):self.assertIs(self.validate(),self.receipt)
    def test_stale_elf_cannot_be_relabeled_current(self):
        self.entries['runtimeEntry'].write_bytes(b'stale executable')
        with self.assertRaisesRegex(ValueError,'artifact mismatch'):self.validate()
    def test_source_change_after_compile_refuses(self):
        (self.root/'scripts/guest-engine/runtime.ts').write_text('new source after compile')
        with self.assertRaisesRegex(ValueError,'sources/dependencies changed'):self.validate()
    def test_installed_bytes_and_resolution_links_are_measured(self):
        (self.root/'node_modules/pkg/index.js').write_text('changed installed bytes')
        with self.assertRaisesRegex(ValueError,'sources/dependencies changed'):self.validate()
    def test_foreign_elf_with_updated_hash_still_refuses_machine(self):
        file=self.entries['runtimeEntry'];file.write_bytes(b'not-arm64-but-hash-updated');self.receipt['outputs']['runtimeEntry'].update(p.sha(file))
        with self.assertRaisesRegex(ValueError,'ARM64 ELF'):self.validate()
    def test_bundle_graph_and_recipe_must_match_measurement(self):
        self.receipt['outputs']['runtimeEntry']['bundledInputs'].pop('node_modules/pkg/index.js')
        with self.assertRaisesRegex(ValueError,'bundled inventory'):self.validate()
        self.receipt['outputs']['runtimeEntry']['command'].append('--minify')
        with self.assertRaisesRegex(ValueError,'recipe'):self.validate()
    def test_metafile_replacement_refuses(self):
        self.metas['runtimeEntry'].write_text('{}')
        with self.assertRaisesRegex(ValueError,'metafile changed'):self.validate()
    def test_input_and_receipt_limits_fail_before_bulk_reads(self):
        large=self.root/'node_modules/large';large.touch();os.truncate(large,p.MAX_FILE+1)
        with self.assertRaisesRegex(ValueError,'file limit'):p.inventory(self.root)
        with patch.object(p,'MAX_JSON',8):
            with self.assertRaisesRegex(ValueError,'receipt size'):p.json_read(self.metas['runtimeEntry'])
    def test_absolute_external_symlink_refuses(self):
        (self.root/'node_modules/alias').symlink_to('/tmp')
        with self.assertRaisesRegex(ValueError,'symlink escapes'):p.inventory(self.root)
    def test_native_builder_rejects_stale_pair_before_compiler_or_output_side_effect(self):
        location=Path(__file__).with_name('build.py');spec=importlib.util.spec_from_file_location('build_provenance_test',location);build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
        receipt=self.output/'compile-receipt.json';receipt.write_text(p.canonical(self.receipt)+'\n');self.entries['runtimeEntry'].write_bytes(b'stale pair')
        destination=self.root/'new-native-output'
        argv=['build.py','--output',str(destination),'--runtime-entry',str(self.entries['runtimeEntry']),'--provider-worker',str(self.entries['providerWorker']),'--compile-receipt',str(receipt)]
        with patch.object(build,'ROOT',self.root),patch.object(build.sys,'argv',argv),patch.object(build.sys,'platform','linux'),patch.object(build.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'artifact mismatch'):build.main()
            run.assert_not_called();self.assertFalse(destination.exists())
    def test_mutated_digest_does_not_establish_approval(self):
        self.receipt['linuxExecutionVerified']=True
        with self.assertRaisesRegex(ValueError,'execution claim'):self.validate()
if __name__=='__main__':unittest.main()
