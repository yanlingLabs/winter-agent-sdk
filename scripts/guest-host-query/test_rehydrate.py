"""Synthetic data only: no imported archived code, Root, helper, or service."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('portable_rehydrate', HERE / 'rehydrate.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def sha(wire):
    return hashlib.sha256(wire).hexdigest()


class RehydrateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # macOS /var is a symlink; callers must provide the actual canonical ancestor.
        self.root = Path(self.tmp.name).resolve()
        self.archive = self.root / 'source.tar.gz'
        self.receipt = self.root / 'compile-receipt.json'
        self.destination = self.root / 'new-source'
        self.payload = {name: ('inert:' + name).encode() for name in sorted(adapter.ROOT_FILES)}
        self.payload.update({'packages/first': b'not executable\n', 'packages/copy': b'not executable\n',
                             'packages/copy-again': b'not executable\n', 'scripts/fixture.txt': b'fixture',
                             'node_modules/leaf': b'dependency'})
        self.inputs = {name: {'kind': 'file', 'bytes': len(wire), 'sha256': sha(wire)} for name, wire in self.payload.items()}
        self.inputs['node_modules/link'] = {'kind': 'symlink', 'target': '../packages/first'}
        self.records = [(name, 'file', None) for name in self.payload if name not in ('packages/copy', 'packages/copy-again')]
        self.records += [('packages/copy', 'hardlink', 'packages/first'),
                         ('packages/copy-again', 'hardlink', 'packages/copy'),
                         ('node_modules/link', 'symlink', '../packages/first')]
        self.refresh()

    def tearDown(self):
        self.tmp.cleanup()

    def refresh(self, records=None):
        with tarfile.open(self.archive, 'w:gz', format=tarfile.PAX_FORMAT) as archive:
            for name, kind, target in (self.records if records is None else records):
                member = tarfile.TarInfo('source/' + name)
                member.mode = 0o755
                member.pax_headers = {'mtime': '1.25'}
                if kind == 'file':
                    wire = self.payload[name]
                    member.size = len(wire)
                    archive.addfile(member, io.BytesIO(wire))
                else:
                    member.type = tarfile.LNKTYPE if kind == 'hardlink' else tarfile.SYMTYPE if kind == 'symlink' else tarfile.FIFOTYPE
                    member.linkname = 'source/' + target if kind == 'hardlink' else target or ''
                    archive.addfile(member)
        self.compiled = {'formatVersion': 1, 'kind': 'winter-host-query-compile', 'inputs': self.inputs,
                         'inputInventorySha256': sha(adapter.canonical(self.inputs)), 'compiler': {}, 'base': {},
                         'recipe': {}, 'outputs': {name: {} for name in ('runtimeEntry', 'providerWorker', 'hostClient')},
                         'linuxExecutionVerified': False, 'vmExecutionVerified': False}
        self.receipt.write_bytes(adapter.canonical(self.compiled))
        self.archive_hash = sha(self.archive.read_bytes())
        self.receipt_hash = sha(self.receipt.read_bytes())

    def run_adapter(self, **kwargs):
        return adapter.rehydrate(self.archive, self.receipt, self.destination,
                                 kwargs.get('archive_hash', self.archive_hash), kwargs.get('receipt_hash', self.receipt_hash))

    def refusal_before_destination(self, **kwargs):
        with self.assertRaises((ValueError, OSError, EOFError, tarfile.TarError)):
            self.run_adapter(**kwargs)
        self.assertFalse(self.destination.exists())

    def test_valid_hardlinks_are_independent_single_link_files_and_symlink_is_last(self):
        seen = []
        original = adapter.Destination.symlink
        def observe(sink, name, target):
            self.assertTrue((self.destination / 'packages/copy-again').is_file())
            seen.append(name)
            return original(sink, name, target)
        with patch.object(adapter.Destination, 'symlink', observe):
            result = self.run_adapter()
        self.assertTrue(result['rehydrated'])
        self.assertFalse(result['executionAdmitted'])
        copies = [self.destination / name for name in ('packages/first', 'packages/copy', 'packages/copy-again')]
        self.assertEqual(len({p.stat().st_ino for p in copies}), 3)
        self.assertTrue(all(p.stat().st_nlink == 1 and p.stat().st_mode & 0o777 == 0o600 for p in copies))
        self.assertEqual(os.readlink(self.destination / 'node_modules/link'), '../packages/first')
        self.assertEqual(seen, ['node_modules/link'])
        self.assertEqual((self.destination / 'node_modules/link').read_bytes(), b'not executable\n')

    def test_wrong_hash_and_changed_bytes_refuse_before_destination(self):
        self.refusal_before_destination(archive_hash='0' * 64)
        self.refusal_before_destination(receipt_hash='0' * 64)
        self.refusal_before_destination(archive_hash='not-a-hash')
        self.payload['packages/first'] = b'changed bytes'
        self.refresh()
        self.refusal_before_destination()

    def test_missing_extra_duplicate_and_fifo_members_refuse(self):
        self.payload['packages/undeclared'] = b'undeclared'
        variants = [self.records[:-1], self.records + [self.records[0]],
                    self.records + [('packages/unknown', 'fifo', None)],
                    self.records + [('packages/undeclared', 'file', None)]]
        for records in variants:
            self.refresh(records)
            self.refusal_before_destination()
        self.inputs['packages/extra-expected'] = {'kind': 'file', 'bytes': 0, 'sha256': sha(b'')}
        self.refresh()
        self.refusal_before_destination()

    def test_hardlink_order_foreign_target_or_wrong_content_refuse(self):
        for records in ([self.records[-3], *self.records[:-3], *self.records[-2:]],
                        [*self.records[:-3], ('packages/copy', 'hardlink', '../escape'), *self.records[-2:]],
                        [*self.records[:-3], ('packages/copy', 'hardlink', 'scripts/fixture.txt'), *self.records[-2:]]):
            self.refresh(records)
            self.refusal_before_destination()

    def test_traversal_alias_ancestor_collision_and_link_graph_refuse(self):
        for target in ('../../escape', '/absolute', '../packages/missing', 'link'):
            self.inputs['node_modules/link']['target'] = target
            self.refresh([*self.records[:-1], ('node_modules/link', 'symlink', target)])
            self.refusal_before_destination()
        self.inputs['node_modules/link']['target'] = '../packages/first'
        self.inputs['node_modules/link/child'] = {'kind': 'file', 'bytes': 0, 'sha256': sha(b'')}
        self.refresh()
        self.refusal_before_destination()
        del self.inputs['node_modules/link/child']
        for name in ('../escape', 'packages/./first', '/absolute', 'packages//first'):
            self.refresh([*self.records, (name, 'fifo', None)])
            self.refusal_before_destination()

    def test_inventory_limit_shape_digest_and_old_two_entry_receipt_refuse(self):
        for change in ('digest', 'old', 'oversize', 'wrong-profile', 'bool-size'):
            self.refresh()
            if change == 'digest': self.compiled['inputInventorySha256'] = '0' * 64
            elif change == 'old': del self.compiled['outputs']['hostClient']
            elif change == 'wrong-profile': self.compiled['kind'] = 'winter-fresh-compile'
            else:
                self.compiled['inputs']['packages/first']['bytes'] = adapter.MAX_FILE + 1 if change == 'oversize' else True
                self.compiled['inputInventorySha256'] = sha(adapter.canonical(self.compiled['inputs']))
            self.receipt.write_bytes(adapter.canonical(self.compiled))
            self.receipt_hash = sha(self.receipt.read_bytes())
            self.refusal_before_destination()

    def test_fifo_input_refuses_with_subprocess_deadline_and_no_destination(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        for archive, receipt in ((fifo, self.receipt), (self.archive, fifo)):
            process = subprocess.run([sys.executable, '-I', '-S', '-B', str(HERE / 'rehydrate.py'),
                                      '--archive', str(archive), '--compile-receipt', str(receipt),
                                      '--destination', str(self.destination), '--archive-sha256', self.archive_hash,
                                      '--compile-sha256', self.receipt_hash], capture_output=True, timeout=3)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(json.loads(process.stdout)['class'], 'source_rehydration_refused')
            self.assertFalse(self.destination.exists())

    def test_input_symlink_hardlink_and_destination_reuse_refuse(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.archive.name)
        with self.assertRaises(OSError): adapter.open_input(alias)
        alias.unlink()
        os.link(self.archive, alias)
        self.refusal_before_destination()
        alias.unlink()
        self.destination.mkdir()
        (self.destination / 'retained').write_bytes(b'original')
        with self.assertRaises(FileExistsError): self.run_adapter()
        self.assertEqual((self.destination / 'retained').read_bytes(), b'original')

    def test_symlink_destination_ancestor_refuses(self):
        alias = self.root / 'parent-alias'
        alias.symlink_to(self.root, target_is_directory=True)
        self.destination = alias / 'new-source'
        self.refusal_before_destination()

    def test_partial_write_is_retained_without_success_or_permission_repair(self):
        original = adapter.write_all
        def fail(fd, data):
            original(fd, data[:1])
            raise OSError('injected write failure')
        with patch.object(adapter, 'write_all', fail):
            with self.assertRaises(OSError): self.run_adapter()
        self.assertTrue(self.destination.is_dir())
        self.assertEqual((self.destination / self.records[0][0]).read_bytes(), self.payload[self.records[0][0]][:1])
        self.assertFalse((self.destination / 'node_modules/link').exists())

    def test_final_nlink_extra_file_and_current_bytes_are_revalidated(self):
        original = adapter.Destination.verify
        for change in ('nlink', 'extra', 'bytes'):
            self.destination = self.root / ('new-' + change)
            def corrupt(sink, inputs, dirs):
                if change == 'nlink': os.link(self.destination / 'packages/first', self.root / 'outside-alias')
                elif change == 'extra': (self.destination / 'unknown').write_bytes(b'extra')
                else: (self.destination / 'packages/first').write_bytes(b'changed')
                return original(sink, inputs, dirs)
            with patch.object(adapter.Destination, 'verify', corrupt):
                with self.assertRaises(ValueError): self.run_adapter()
            self.assertTrue(self.destination.exists())

    def test_pax_and_uncompressed_limits_refuse_without_large_allocations(self):
        with patch.object(adapter, 'MAX_PAX', 2): self.refusal_before_destination()
        with patch.object(adapter, 'MAX_TAR', 512): self.refusal_before_destination()
        with patch.object(adapter, 'MAX_SOURCE', 1): self.refusal_before_destination()
        with self.assertRaises(ValueError): adapter.pax_fields(b'999999 path=outside\n')

    def test_root_refuses_before_input_open_and_refused_fd_is_closed(self):
        with patch.object(adapter.os, 'geteuid', return_value=0), patch.object(adapter, 'open_input') as opened:
            with self.assertRaises(ValueError): self.run_adapter()
            opened.assert_not_called()
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        original = adapter.os.close
        closed = []
        def close(fd):
            closed.append(fd)
            return original(fd)
        with patch.object(adapter.os, 'close', close):
            with self.assertRaises(ValueError): adapter.open_input(fifo)
        self.assertGreaterEqual(len(closed), 2)
        for fd in closed:
            with self.assertRaises(OSError): os.fstat(fd)


if __name__ == '__main__':
    unittest.main()
