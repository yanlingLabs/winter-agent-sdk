"""Exercise the fixture's actual Bash oracle against ordinary synthetic files."""
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class PrivateProcOracleTests(unittest.TestCase):
    def test_visible_foreign_identity_or_missing_security_fields_fail(self):
        bash = shutil.which('bash')
        if not bash:
            self.skipTest('existing Bash unavailable')
        source = (HERE / 'client.ts').read_text()
        start = source.index('const privateProc=await guest.executeProcess!(`')
        command = source[start:].split('`', 2)[1].replace('${Number(uid)}', '10001')
        good = ('Uid:\t10001\t10001\t10001\t10001\n'
                'CapInh:\t0000000000000000\nCapPrm:\t0000000000000000\n'
                'CapEff:\t0000000000000000\nCapBnd:\t0000000000000000\n'
                'CapAmb:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\n')
        cases = {
            'valid': good,
            'foreign_uid': good.replace('10001', '20001'),
            'foreign_effective_uid': good.replace('10001\t10001\t10001\t10001', '10001\t0\t10001\t10001'),
            'missing_uid': good.split('\n', 1)[1],
            'missing_cap': good.replace('CapAmb:\t0000000000000000\n', ''),
            'nonzero_cap': good.replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000000001'),
            'no_nnp': good.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'),
            'no_filter': good.replace('Seccomp:\t2', 'Seccomp:\t0'),
        }
        with tempfile.TemporaryDirectory(prefix='winter-private-proc-oracle-') as temp:
            root = Path(temp)
            proc = root / 'proc'
            (proc / '1').mkdir(parents=True)
            (proc / '2').mkdir()
            (proc / 'self').symlink_to('2')
            (proc / '1/status').write_text(good)
            fixture = command.replace('/proc', shlex.quote(str(proc)))
            fixture = fixture.replace('/protected/runtime', shlex.quote(str(root / 'missing-runtime')))
            fixture = fixture.replace('/run', shlex.quote(str(root / 'missing-run')))
            for name, status in cases.items():
                with self.subTest(case=name):
                    (proc / '2/status').write_text(status)
                    result = subprocess.run([bash, '--noprofile', '--norc', '-c', fixture], capture_output=True, timeout=3,
                                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
                    if name == 'valid':
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stdout, b'private-proc-only')
                        self.assertEqual(result.stderr, b'')
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertNotIn(b'private-proc-only', result.stdout)
            (proc / '2/status').write_text(good)
            for name in ('missing-run', 'missing-runtime'):
                with self.subTest(exposed=name):
                    path = root / name
                    path.mkdir()
                    result = subprocess.run([bash, '--noprofile', '--norc', '-c', fixture], capture_output=True, timeout=3,
                                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn(b'private-proc-only', result.stdout)
                    path.rmdir()
            result = subprocess.run([bash, '--noprofile', '--norc', '-c', fixture], capture_output=True, timeout=3,
                                    env={'PATH': '/usr/bin:/bin', 'SECRET_SHOULD_NOT_TRAVEL': 'fixture-only'})
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'private-proc-only', result.stdout)


if __name__ == '__main__':
    unittest.main()
