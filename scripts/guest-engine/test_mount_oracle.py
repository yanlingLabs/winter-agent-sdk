"""Injected kernel records/disposable regular files only: no real proc, pidfd or mount effects."""
import importlib.util,json,os,tempfile,time,unittest
from pathlib import Path
from unittest.mock import MagicMock,patch
MODULE=Path(__file__).with_name('verify.py');spec=importlib.util.spec_from_file_location('mount_verify',MODULE);verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)

def parsed(wire):return verify.parse_mountinfo(wire.encode() if isinstance(wire,str) else wire)

def record(ident,point,access='rw',optional='',device='0:1'):
    return f'{ident} 1 {device} / {point} {access},nosuid,nodev,noexec{(" "+optional) if optional else ""} - tmpfs tmpfs rw\n'
def outer(extra=''):
    return parsed(record(1,'/')+record(2,'/unrelated')+extra)
def runtime(change=None):
    points=[f'/run/winter/conversations/{verify.LOGICAL}',f'/run/winter/conversations/{verify.LOGICAL}/.control',f'/workspace/.winter/conversations/{verify.LOGICAL}']
    text=record(1,'/','ro')
    for number,point in enumerate(points,2):text+=record(number,point,'ro' if number==3 else 'rw')
    if change:text=change(text)
    return parsed(text)

class MountOracleTests(unittest.TestCase):
    def test_bounded_parser_preserves_kernel_escapes_and_unknown_optional_fields(self):
        records=parsed(record(1,r'/tmp/fixture\040space',optional='future_tag:1'))
        self.assertEqual(records[1]['point'],'/tmp/fixture space');self.assertTrue(verify.mount_private(records[1]))
        for wire in [b'',b'x'*(verify.MOUNTINFO_BYTES+1),record(1,'/').encode()+record(1,'/other').encode(),record(1,r'/bad\999').encode(),record(1,'/').replace('rw,nosuid','rw,ro,nosuid').encode(),record(1,'/',optional='shared:bad').encode(),record(1,'/').encode().rstrip(b'\n')]:
            with self.subTest(wire=wire[:32]),self.assertRaises(verify.MountIsolationError):parsed(wire)
    def test_cover_and_descendants_are_exact_without_unrelated_mount_changes(self):
        baseline,count=verify.relevant_mounts(outer(),'/tmp/fixture');self.assertEqual(count,1)
        unrelated=parsed(record(1,'/')+record(2,'/unrelated','ro'))
        self.assertEqual(verify.relevant_mounts(unrelated,'/tmp/fixture')[0],baseline)
        changed=outer(record(3,'/tmp/fixture/provider.sock','ro'))
        self.assertNotEqual(verify.relevant_mounts(changed,'/tmp/fixture')[0],baseline)
        self.assertEqual(verify.relevant_mounts(changed,'/tmp/fixture')[1],2)
        nested=parsed(record(1,'/')+record(2,'/tmp'))
        self.assertEqual(verify.relevant_mounts(nested,'/tmp/fixture')[0],(nested[1]['exact'],nested[2]['exact']))
    def test_runtime_requires_all_three_exact_mounts_correct_access_and_private_groups(self):
        self.assertEqual(len(verify.runtime_mount_proof(runtime())),3)
        for tag in ('shared:4','master:5','propagate_from:6'):
            bad=runtime(lambda text:text.replace(' - tmpfs',f' {tag} - tmpfs',1))
            with self.assertRaisesRegex(verify.MountIsolationError,'runtime_propagation'):verify.runtime_mount_proof(bad)
        for change in [lambda text:text.replace('.control ro,','.control rw,'),lambda text:text.replace(f'{verify.LOGICAL} rw,',f'{verify.LOGICAL} ro,',1),lambda text:text.replace('nodev,','',1).replace('nodev,','',1)]:
            with self.assertRaisesRegex(verify.MountIsolationError,'runtime_mount_flags'):verify.runtime_mount_proof(runtime(change))
        with self.assertRaisesRegex(verify.MountIsolationError,'runtime_mounts_missing'):verify.runtime_mount_proof(outer())
    def fake_reader(self):
        reader=MagicMock();reader.outer.return_value=((1,101),outer());reader.runtime.return_value=((1,202),runtime());return reader
    def test_three_snapshots_emit_only_counts_and_proofs(self):
        reader=self.fake_reader();observed={}
        with patch.object(verify,'KernelMountReader',return_value=reader):
            oracle=verify.MountIsolationOracle('/tmp/fixture');oracle.before(observed);oracle.during(77,observed,time.monotonic()+1);oracle.after(observed)
        proof=observed['mountIsolation'];self.assertTrue(proof['liveOuterUnchanged']);self.assertTrue(proof['teardownOuterUnchanged']);self.assertTrue(proof['runtimeControlReadOnly'])
        self.assertNotIn('/tmp',json.dumps(observed));self.assertNotIn('mountinfo',json.dumps(observed));self.assertNotIn('202',json.dumps(observed));self.assertEqual(reader.runtime.call_args.args,(77,))
    def test_outer_namespace_and_relevant_mount_changes_refuse(self):
        for namespace,table in [((1,303),outer()),((1,101),outer(record(3,'/tmp/fixture/provider.sock','ro'))),((1,101),parsed(record(1,'/','ro')))]:
            reader=self.fake_reader();observed={}
            with patch.object(verify,'KernelMountReader',return_value=reader):
                oracle=verify.MountIsolationOracle('/tmp/fixture');oracle.before(observed);oracle.during(77,observed,time.monotonic()+1);reader.outer.return_value=(namespace,table)
                with self.assertRaises(verify.MountIsolationError):oracle.after(observed)
            self.assertNotIn('teardownOuterUnchanged',observed['mountIsolation'])
    def test_shared_outer_cover_passes_only_when_unchanged_and_runtime_is_private(self):
        reader=self.fake_reader();shared=record(1,'/',optional='shared:4');reader.outer.return_value=((1,101),parsed(shared));observed={}
        with patch.object(verify,'KernelMountReader',return_value=reader):
            oracle=verify.MountIsolationOracle('/tmp/fixture');oracle.before(observed);oracle.during(77,observed,time.monotonic()+1);oracle.after(observed)
        self.assertFalse(observed['mountIsolation']['baselineRelevantMountsPrivate']);self.assertTrue(observed['mountIsolation']['liveOuterUnchanged']);self.assertTrue(observed['mountIsolation']['teardownOuterUnchanged'])
        for phase in ('live','teardown'):
            reader=self.fake_reader();reader.outer.return_value=((1,101),parsed(shared));observed={}
            with patch.object(verify,'KernelMountReader',return_value=reader):
                oracle=verify.MountIsolationOracle('/tmp/fixture');oracle.before(observed)
                if phase=='teardown':oracle.during(77,observed,time.monotonic()+1)
                reader.outer.return_value=((1,101),parsed(shared+record(3,'/tmp/fixture/provider.sock','ro')))
                with self.assertRaisesRegex(verify.MountIsolationError,'outer_mounts_changed'):
                    if phase=='live':oracle.during(77,observed,time.monotonic()+1)
                    else:oracle.after(observed)
            self.assertNotIn(phase+'OuterUnchanged',observed['mountIsolation'])
    def test_live_wrong_flags_same_namespace_or_propagation_refuse_without_wait(self):
        cases=[((1,101),runtime()),((1,202),runtime(lambda text:text.replace('.control ro,','.control rw,'))),((1,202),runtime(lambda text:text.replace(' - tmpfs',' master:2 - tmpfs',1)))]
        for live in cases:
            reader=self.fake_reader();reader.runtime.return_value=live;observed={}
            with patch.object(verify,'KernelMountReader',return_value=reader),patch.object(verify.time,'sleep',side_effect=AssertionError('unexpected wait')):
                oracle=verify.MountIsolationOracle('/tmp/fixture');oracle.before(observed)
                with self.assertRaises(verify.MountIsolationError):oracle.during(77,observed,time.monotonic()+1)
            self.assertNotIn('runtimeNamespaceDistinct',observed['mountIsolation'])
    def test_construction_wait_uses_existing_deadline_and_no_dead_owner_retry(self):
        reader=self.fake_reader();reader.runtime.side_effect=[((1,202),outer()),((1,202),runtime()),((1,202),runtime())]
        with patch.object(verify,'KernelMountReader',return_value=reader):
            oracle=verify.MountIsolationOracle('/tmp/fixture');oracle.before({});observed={'mountIsolation':{}};oracle.during(77,observed,time.monotonic()+1)
        self.assertTrue(observed['mountIsolation']['runtimeNamespaceDistinct'])
        reader=self.fake_reader();reader.runtime.return_value=((1,202),outer())
        with patch.object(verify,'KernelMountReader',return_value=reader),patch.object(verify.time,'sleep',side_effect=AssertionError('deadline expanded')):
            oracle=verify.MountIsolationOracle('/tmp/fixture');oracle.before({})
            with self.assertRaisesRegex(verify.MountIsolationError,'oracle_deadline'):oracle.during(77,{'mountIsolation':{}},time.monotonic()-1)
        reader.runtime.side_effect=verify.MountIsolationError('runtime_dead')
        with patch.object(verify,'KernelMountReader',return_value=reader),patch.object(verify.time,'sleep',side_effect=AssertionError('dead owner retried')):
            oracle=verify.MountIsolationOracle('/tmp/fixture');oracle.before({})
            with self.assertRaisesRegex(verify.MountIsolationError,'runtime_dead'):oracle.during(77,{'mountIsolation':{}},time.monotonic()+1)
    def test_teardown_cannot_publish_proof_without_live_handoff_check_or_replay_it(self):
        reader=self.fake_reader();observed={}
        with patch.object(verify,'KernelMountReader',return_value=reader):
            oracle=verify.MountIsolationOracle('/tmp/fixture');oracle.before(observed)
            with self.assertRaisesRegex(verify.MountIsolationError,'oracle_phase'):oracle.after(observed)
            oracle.during(77,observed,time.monotonic()+1);oracle.after(observed)
            with self.assertRaisesRegex(verify.MountIsolationError,'oracle_phase'):oracle.after(observed)
            with self.assertRaisesRegex(verify.MountIsolationError,'oracle_phase'):oracle.before(observed)
    def test_kernel_pid_liveness_namespace_and_rebinding_checks(self):
        for pids,processes,code in [([42,43],[((1,202),runtime())],'runtime_pid_changed'),([42,42,43],[((1,202),runtime()),((1,202),runtime())],'runtime_pid_changed'),([42,42],[((1,202),runtime()),((1,303),runtime())],'runtime_namespace_changed'),([42,verify.MountIsolationError('runtime_dead')],[((1,202),runtime())],'runtime_dead')]:
            reader=verify.KernelMountReader.__new__(verify.KernelMountReader);reader.pidfd_pid=MagicMock(side_effect=pids);reader.process=MagicMock(side_effect=processes)
            with self.assertRaisesRegex(verify.MountIsolationError,code):reader.runtime(77)
            self.assertEqual(reader.process.call_args_list[0].args,(42,))
    def test_fdinfo_pid_is_kernel_only_and_dead_or_malformed_refuses(self):
        for wire,ready in [(b'Pid:\t42\nNSpid:\t42 1\n',False),(b'Pid:\t-1\n',False),(b'Pid:\t42\nPid:\t43\n',False),(b'"pid":42',False),(b'Pid:\t42\n',True)]:
            reader=verify.KernelMountReader.__new__(verify.KernelMountReader);reader.proc=10;reader.directory=MagicMock(return_value=11);reader.read=MagicMock(return_value=wire);poll=MagicMock();poll.poll.return_value=[(77,1)] if ready else []
            with patch.object(verify.select,'poll',return_value=poll),patch.object(verify.os,'close'):
                if wire.startswith(b'Pid:\t42\nNSpid') and not ready:self.assertEqual(reader.pidfd_pid(77),42)
                else:
                    with self.assertRaises(verify.MountIsolationError):reader.pidfd_pid(77)
            if ready:reader.read.assert_not_called()
    def test_descriptor_reader_refuses_symlink_fifo_hardlink_and_caps_before_read(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder=os.open(root,os.O_RDONLY|os.O_DIRECTORY);reader=verify.KernelMountReader.__new__(verify.KernelMountReader)
            try:
                for kind in ('valid','symlink','fifo','hardlink','oversize'):
                    path=root/'input'
                    if path.exists() or path.is_symlink():path.unlink()
                    if kind=='symlink':path.symlink_to('missing')
                    elif kind=='fifo':os.mkfifo(path,0o600)
                    else:path.write_bytes(b'x'*33 if kind=='oversize' else b'known')
                    if kind=='hardlink':os.link(path,root/'alias')
                    opened=[];original=os.open
                    def track(*args,**kwargs):
                        fd=original(*args,**kwargs);opened.append(fd);return fd
                    with patch.object(verify.os,'open',side_effect=track):
                        if kind=='valid':self.assertEqual(reader.read(folder,'input',32),b'known')
                        else:
                            with self.assertRaises((OSError,verify.MountIsolationError)):reader.read(folder,'input',32)
                    for fd in opened:
                        with self.assertRaises(OSError):os.fstat(fd)
            finally:os.close(folder)
    def test_proc_zero_size_stream_still_has_a_hard_read_cap(self):
        reader=verify.KernelMountReader.__new__(verify.KernelMountReader);info=MagicMock(st_mode=0o100444,st_nlink=1,st_size=0,st_dev=1,st_ino=2,st_uid=0)
        with patch.object(verify.os,'open',return_value=77),patch.object(verify.os,'fstat',return_value=info),patch.object(verify.os,'read',side_effect=[b'x'*33]),patch.object(verify.os,'close') as close:
            with self.assertRaisesRegex(verify.MountIsolationError,'mountinfo_limit'):reader.read(66,'mountinfo',32)
            close.assert_called_once_with(77)

if __name__=='__main__':unittest.main()
