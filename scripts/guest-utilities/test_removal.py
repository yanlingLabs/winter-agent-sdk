"""Portable working-fixture removal tests. No root/service/mount/native executes."""
import ast,errno,importlib.util,json,os,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('utility_removal',HERE/'verify.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
DIRECTORY=Path('/tmp/winter-utility-run-removal-test')
BASE=b'1 0 0:1 / / rw - tmpfs tmpfs rw\n'


def proof():
    return {'serviceReaped':True,'serviceExitCode':0,'serviceCleanupConfirmed':True,'nativeCleanupConfirmed':True,'fixtureFdsClosedConfirmed':True,'wholeFixtureRemovalConfirmed':False}


class WorkingFixtureRemovalTests(unittest.TestCase):
    def test_exact_success_finally_closes_control_fd_and_refuses_unclosed_process_pipes(self):
        source=ast.parse((HERE/'verify.py').read_bytes());execute=next(node for node in source.body if isinstance(node,ast.FunctionDef) and node.name=='execute')
        final=next(node.finalbody for node in execute.body if isinstance(node,ast.Try) and node.finalbody)
        logic=compile(ast.Module(body=final[:3],type_ignores=[]),'exact-fixture-fd-close','exec')
        def run(closed=True,close_error=None):
            events=[];observations={'fixtureFdsClosedConfirmed':False}
            pipe=SimpleNamespace(closed=closed);process=SimpleNamespace(stdin=None,stdout=pipe,stderr=pipe)
            def close(fd):
                self.assertEqual(fd,42);events.append('close-control-fd')
                if close_error:raise close_error
            try:exec(logic,{'complete':True,'fd':42,'os':SimpleNamespace(close=close),'observations':observations,'clients':[process],'server':process})
            except BaseException as error:return observations,events,error
            return observations,events,None
        observations,events,error=run();self.assertIsNone(error);self.assertEqual(events,['close-control-fd']);self.assertTrue(observations['fixtureFdsClosedConfirmed'])
        observations,events,error=run(False);self.assertIsInstance(error,ValueError);self.assertFalse(observations['fixtureFdsClosedConfirmed'])
        observations,events,error=run(close_error=OSError('close failed'));self.assertIsInstance(error,OSError);self.assertFalse(observations['fixtureFdsClosedConfirmed'])

    def remove(self,wire=BASE,observations=None,result=None,remove_error=None,still_present=False):
        observations=proof() if observations is None else observations
        result={'passed':True,'nativeCleanupConfirmed':True,'outerMountObservation':{'unchanged':True}} if result is None else result
        events=[]
        def rmtree(path):
            self.assertEqual(path,DIRECTORY);events.append('rmtree')
            if remove_error:raise remove_error
        def lstat(path):
            self.assertEqual(path,DIRECTORY);events.append('lstat')
            if still_present:return SimpleNamespace()
            raise FileNotFoundError(path)
        def mountinfo():events.append('mountinfo');return wire
        with patch.object(v.shutil,'rmtree',rmtree),patch.object(v.os,'lstat',lstat),patch.object(v,'outer_mountinfo',mountinfo):
            v.remove_working_fixture(DIRECTORY,result,observations)
        return events,result,observations

    def test_plain_removal_then_missing_lstat_then_mount_check_precede_success(self):
        sibling=BASE+b'2 1 0:2 / /tmp/winter-utility-run-removal-test-other/sub ro - tmpfs tmpfs ro\n'
        events,result,observations=self.remove(sibling)
        self.assertEqual(events,['rmtree','lstat','mountinfo'])
        self.assertTrue(result['wholeFixtureRemovalConfirmed']);self.assertFalse(result['sealedInputStageRemovalConfirmed'])
        self.assertFalse(observations['fixtureRetained']);self.assertEqual(observations['phase'],'complete')

    def test_cleanup_conjunction_is_required_before_any_delete(self):
        for key in ('passed','nativeCleanupConfirmed'):
            result={'passed':True,'nativeCleanupConfirmed':True,'outerMountObservation':{'unchanged':True},key:False}
            with self.subTest(resultKey=key),patch.object(v.shutil,'rmtree') as remove:
                with self.assertRaises(ValueError):v.remove_working_fixture(DIRECTORY,result,proof())
                remove.assert_not_called()
        for key in ('serviceReaped','serviceCleanupConfirmed','nativeCleanupConfirmed','fixtureFdsClosedConfirmed'):
            with self.subTest(key=key),patch.object(v.shutil,'rmtree') as remove:
                with self.assertRaises(ValueError):v.remove_working_fixture(DIRECTORY,{'passed':True,'nativeCleanupConfirmed':True,'outerMountObservation':{'unchanged':True}},{**proof(),key:False})
                remove.assert_not_called()
        for result,observations in (({'passed':True,'nativeCleanupConfirmed':True,'outerMountObservation':{'unchanged':False}},proof()),({'passed':True,'nativeCleanupConfirmed':True,'outerMountObservation':{'unchanged':True}},{**proof(),'serviceExitCode':1}),({'passed':True,'nativeCleanupConfirmed':True,'outerMountObservation':{'unchanged':True}},{**proof(),'serviceExitCode':False})):
            with patch.object(v.shutil,'rmtree') as remove:
                with self.assertRaises(ValueError):v.remove_working_fixture(DIRECTORY,result,observations)
                remove.assert_not_called()
        with patch.object(v.shutil,'rmtree') as remove:
            with self.assertRaises(ValueError):v.remove_working_fixture(Path('/tmp/winter-utility-reviewed-input'),{},proof())
            remove.assert_not_called()

    def test_erofs_is_propagated_without_retry_or_mount_recovery(self):
        error=OSError(errno.EROFS,'synthetic read-only failure');observations=proof()
        with patch.object(v.shutil,'rmtree',side_effect=error) as remove,patch.object(v.os,'lstat') as check,patch.object(v,'outer_mountinfo') as mounts:
            with self.assertRaises(OSError) as caught:v.remove_working_fixture(DIRECTORY,{'passed':True,'nativeCleanupConfirmed':True,'outerMountObservation':{'unchanged':True}},observations)
        self.assertIs(caught.exception,error);remove.assert_called_once_with(DIRECTORY);check.assert_not_called();mounts.assert_not_called()
        self.assertTrue(observations['nativeCleanupConfirmed']);self.assertFalse(observations['wholeFixtureRemovalConfirmed'])
        self.assertEqual(observations['phase'],'fixture-removal')

    def test_present_directory_residue_and_unreadable_or_malformed_mountinfo_refuse(self):
        with self.assertRaisesRegex(ValueError,'still present'):self.remove(still_present=True)
        for wire in (BASE+b'2 1 0:2 / '+os.fsencode(DIRECTORY)+b' ro - tmpfs tmpfs ro\n',BASE+b'2 1 0:2 / '+os.fsencode(DIRECTORY)+b'/space\\040name ro - tmpfs tmpfs ro\n',b'',b'malformed\n',b'x'*(1024*1024+1)):
            observations=proof()
            with self.subTest(wire=wire[:100]),self.assertRaises(ValueError):self.remove(wire,observations)
            self.assertFalse(observations['wholeFixtureRemovalConfirmed']);self.assertTrue(observations['nativeCleanupConfirmed'])
        with patch.object(v.shutil,'rmtree'),patch.object(v.os,'lstat',side_effect=FileNotFoundError),patch.object(v,'outer_mountinfo',side_effect=OSError('reader failure')):
            with self.assertRaises(OSError):v.remove_working_fixture(DIRECTORY,{'passed':True,'nativeCleanupConfirmed':True,'outerMountObservation':{'unchanged':True}},proof())

    def main(self,remove_error=None,mount_error=None,execute_error=None):
        events=[];writes=[];prints=[];removed=[False]
        def write(path,wire,mode):
            writes.append((path,json.loads(wire),mode));events.append('diagnostic-write')
            if removed[0]:raise FileNotFoundError(path)
        parent=SimpleNamespace(verify_staged=lambda *args:None,canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')),write_file=write)
        modules={'stage':parent,'closure':SimpleNamespace(validate_capture=lambda *args,**kwargs:None),'oracle':object()}
        admission=SimpleNamespace(directory='/sealed-immutable-input',receipt_sha='receipt',parent_sha='parent',receipt={'utilityCapture':{}})
        def execute(directory,parent,oracle,observations):
            events.append('execute-confirmed');observations.update(proof())
            if execute_error:raise execute_error
            return {'passed':True,'nativeCleanupConfirmed':True,'outerMountObservation':{'unchanged':True}}
        def remove(directory):
            self.assertEqual(directory,DIRECTORY);events.append('rmtree')
            if remove_error:raise remove_error
            removed[0]=True
        def lstat(directory):
            self.assertEqual(directory,DIRECTORY);events.append('lstat')
            if removed[0]:raise FileNotFoundError(directory)
            return SimpleNamespace()
        def mounts():
            events.append('mountinfo')
            if mount_error:raise mount_error
            return BASE
        def printed(value,**kwargs):prints.append((json.loads(value),kwargs));events.append('print')
        with patch.object(v,'ADMISSION',admission),patch.object(v,'checked_module',lambda name:modules[name]),patch.object(v.tempfile,'mkdtemp',lambda **kwargs:str(DIRECTORY)),patch.object(v,'execute',execute),patch.object(v.shutil,'rmtree',remove),patch.object(v.os,'lstat',lstat),patch.object(v,'outer_mountinfo',mounts),patch('builtins.print',printed):
            try:v.main()
            except BaseException as error:return events,writes,prints,error
        return events,writes,prints,None

    def test_main_prints_success_only_after_complete_removal_and_never_writes_a_premature_pass(self):
        events,writes,prints,error=self.main()
        self.assertIsNone(error);self.assertEqual(events,['execute-confirmed','rmtree','lstat','mountinfo','print'])
        self.assertEqual(writes,[]);self.assertEqual(len(prints),1);result=prints[0][0]
        self.assertTrue(result['passed']);self.assertTrue(result['wholeFixtureRemovalConfirmed']);self.assertFalse(result['sealedInputStageRemovalConfirmed'])

    def test_main_removal_failure_retains_tree_and_native_evidence_without_success(self):
        failure=OSError(errno.EROFS,'private source path');events,writes,prints,error=self.main(remove_error=failure)
        self.assertIs(error,failure);self.assertEqual(sum(item=='rmtree' for item in events),1)
        self.assertEqual(writes[0][0],DIRECTORY/'failure.json');record=writes[0][1]
        self.assertFalse(record['passed']);self.assertTrue(record['fixtureRetained']);self.assertTrue(record['nativeCleanupConfirmed']);self.assertFalse(record['wholeFixtureRemovalConfirmed'])
        self.assertFalse(any(record.get('passed') is True for record,_ in prints))
        self.assertNotIn('private source path',json.dumps(record))

    def test_mount_read_failure_after_deletion_retains_exclusive_bounded_external_diagnostic(self):
        failure=OSError('mount reader failed');events,writes,prints,error=self.main(mount_error=failure)
        self.assertIs(error,failure);retention=prints[-1][0]
        self.assertEqual(retention['retentionScope'],'diagnostic-file');path=Path('/tmp')/retention['retentionId']
        try:
            info=path.lstat();self.assertEqual(info.st_mode&0o777,0o600);wire=path.read_bytes();self.assertLessEqual(len(wire),32768)
            record=json.loads(wire);self.assertTrue(record['nativeCleanupConfirmed']);self.assertFalse(record['fixtureRetained']);self.assertFalse(record['wholeFixtureRemovalConfirmed']);self.assertFalse(record['passed'])
        finally:path.unlink()
        self.assertFalse(any(record.get('passed') is True for record,_ in prints))

    def test_failed_execution_never_attempts_removal_and_overflow_retains_new_cleanup_flags(self):
        failure=ValueError('prior failure');events,writes,prints,error=self.main(execute_error=failure)
        self.assertIs(error,failure);self.assertNotIn('rmtree',events)
        record,wire=v.diagnostic_wire(failure,{**proof(),'clients':['x'*40000],'phase':'fixture-removal-checks'},lambda value:json.dumps(value,separators=(',',':')))
        self.assertTrue(record['diagnosticTruncated']);self.assertTrue(record['nativeCleanupConfirmed']);self.assertFalse(record['wholeFixtureRemovalConfirmed']);self.assertFalse(record['passed']);self.assertLessEqual(len(wire),32768)


if __name__=='__main__':unittest.main()
