"""Unprivileged review-receipt checks. No executable, root service or VM is launched."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
MODULE=Path(__file__).with_name('build.py');spec=importlib.util.spec_from_file_location('fresh_build',MODULE);build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.source=self.root/'source';self.source.mkdir();self.artifacts=self.root/'artifacts';self.artifacts.mkdir()
        self.sources=['native.c','runtime.ts','verify.py']
        for name in self.sources:(self.source/name).write_text('fixture source '+name)
        self.names=set(build.NATIVE)|{'runtimeEntry','providerWorker'}
        for name in self.names:(self.artifacts/name).write_bytes(b'fixture-not-executable-'+name.encode())
        self.receipt={'formatVersion':2,'sources':{name:build.digest(self.source/name) for name in self.sources},'artifacts':{name:build.digest(self.artifacts/name) for name in self.names}}
        (self.artifacts/'compile-receipt.json').write_text('{}');self.receipt['compileReceiptSha256']=build.digest(self.artifacts/'compile-receipt.json')
        self.compile_patch=patch.object(build,'validate_compile_receipt',return_value={});self.compile_patch.start()
        self.root_patch=patch.object(build,'ROOT',self.source);self.source_patch=patch.object(build,'SOURCES',self.sources);self.inventory_patch=patch.object(build,'source_inventory',return_value=self.sources);self.root_patch.start();self.source_patch.start();self.inventory_patch.start()
    def tearDown(self):self.compile_patch.stop();self.root_patch.stop();self.source_patch.stop();self.inventory_patch.stop();self.temp.cleanup()
    def test_exact_source_and_artifact_inventory_required(self):
        self.assertIs(build.validate_receipt(self.receipt,self.artifacts),self.receipt)
        for section,key in [('sources','runtime.ts'),('artifacts','runtimeEntry')]:
            copy=json.loads(json.dumps(self.receipt));copy[section].pop(key)
            with self.assertRaisesRegex(ValueError,'inventory'):build.validate_receipt(copy,self.artifacts)
    def test_modified_runtime_artifact_or_supervisor_source_refuses(self):
        (self.source/'runtime.ts').write_text('changed source')
        with self.assertRaisesRegex(ValueError,'source changed'):build.validate_receipt(self.receipt,self.artifacts)
        self.receipt['sources']['runtime.ts']=build.digest(self.source/'runtime.ts');(self.artifacts/'runtimeEntry').write_bytes(b'changed artifact')
        with self.assertRaisesRegex(ValueError,'artifact changed'):build.validate_receipt(self.receipt,self.artifacts)
    def test_source_escape_and_artifact_alias_refused(self):
        self.receipt['sources']['../outside']='not-a-digest'
        with self.assertRaisesRegex(ValueError,'source changed'):build.validate_receipt(self.receipt,self.artifacts)
        self.receipt['sources'].pop('../outside');target=self.artifacts/'runtimeEntry';target.rename(self.artifacts/'original');target.symlink_to('original')
        with self.assertRaisesRegex(ValueError,'artifact changed'):build.validate_receipt(self.receipt,self.artifacts)
if __name__=='__main__':unittest.main()
