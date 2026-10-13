"""Grammar and inert extracted checks only: never execute either native utility probe."""
import ast, errno, re, subprocess, unittest
from pathlib import Path

HERE=Path(__file__).resolve().parent
PAYLOADS=('utilities.sh','utilities-plan.sh')

def source(name):return (HERE/name).read_text()
def python_body(name):
    found=re.search(r"(?m)^python3 - <<'PY'\n(.*?)\nPY\n",source(name),re.S)
    if found is None:raise AssertionError('literal Python payload required')
    return ast.parse(found.group(1))

class FakeOS:
    O_WRONLY=1;O_NOFOLLOW=2
    def __init__(self,error,at=None):self.error=error;self.at=at;self.calls=[];self.closed=[]
    def next_error(self):return self.error if self.at is None or len(self.calls)==self.at else errno.EROFS
    def open(self,path,flags):
        self.calls.append(('open',path,flags))
        error=self.next_error()
        if error is None:return 101
        raise OSError(error,'inert')
    def chmod(self,path,mode):
        self.calls.append(('chmod',path,mode))
        error=self.next_error()
        if error is None:return None
        raise OSError(error,'inert')
    def close(self,fd):self.closed.append(fd)

class PayloadTests(unittest.TestCase):
    def test_sealed_payload_emits_separator_before_any_probe(self):
        for name in PAYLOADS:
            lines=source(name).splitlines()
            self.assertTrue(lines[1].startswith('phase_b_fail()'))
            self.assertEqual(lines[2],"printf '\\n' || phase_b_fail separator")
            # Only the failure function and separator: no utility/probe body.
            result=subprocess.run(['/bin/bash','-c','\n'.join(lines[1:3])],capture_output=True,timeout=2)
            self.assertEqual((result.returncode,result.stdout,result.stderr),(0,b'\n',b''))

    def test_optimized_python_refuses_before_imports_or_probe_io(self):
        for name in PAYLOADS:
            first=python_body(name).body[0]
            self.assertIsInstance(first,ast.If)
            tree=ast.fix_missing_locations(ast.Module(body=[first],type_ignores=[]))
            with self.assertRaises(SystemExit) as raised:exec(compile(tree,'inert-debug','exec',optimize=1),{})
            self.assertEqual(raised.exception.code,92)
            exec(compile(tree,'inert-debug','exec',optimize=0),{})

    def test_shell_grammar_without_body_execution(self):
        for name in PAYLOADS:
            result=subprocess.run(['/bin/bash','-n',str(HERE/name)],capture_output=True,timeout=2)
            self.assertEqual(result.returncode,0,result.stderr)
            python_body(name)  # parse only: no imports, fork, filesystem probes

    def test_exact_erofs_checks_do_not_accept_dac_or_missing_failures(self):
        for name in PAYLOADS:
            loop=next(node for node in python_body(name).body if isinstance(node,ast.For))
            code=compile(ast.fix_missing_locations(ast.Module(body=[loop],type_ignores=[])),'inert-erofs','exec')
            expected=2 if name=='utilities.sh' else 4
            for at in range(1,expected+1):
                for error in (errno.EROFS,errno.EPERM,errno.EACCES,errno.ENOENT,errno.EIO,None):
                    with self.subTest(name=name,error=error,at=at):
                        fake=FakeOS(error,at)
                        scope={'os':fake,'errno':errno,'canary':'/workspace/folders/readonly/dac-canary'}
                        if error==errno.EROFS:
                            exec(code,scope)
                            self.assertEqual(len(fake.calls),expected)
                            self.assertEqual([call[0] for call in fake.calls],['open','chmod']*(expected//2))
                            self.assertTrue(all(call[2]==3 for call in fake.calls if call[0]=='open'))
                            self.assertTrue(all(call[2]==0o600 for call in fake.calls if call[0]=='chmod'))
                        else:
                            with self.assertRaises(AssertionError):exec(code,scope)
                            if error is None:self.assertEqual(fake.closed,[101] if at%2 else [])

    def test_python_failure_stops_before_next_marker_even_in_conditional_function(self):
        failure="phase_b_fail() { printf 'phase-b-failed:%s\\n' \"$1\"; exit 91; }"
        check=next(line for line in source('utilities.sh').splitlines() if line.startswith('phase_code=$?;'))
        script=f'{failure}\nprobe() {{ false; {check}; printf forbidden-marker; }}\nif probe; then printf forbidden-pass; fi'
        result=subprocess.run(['/bin/bash','-c',script],capture_output=True,timeout=2)
        self.assertEqual(result.returncode,91)
        self.assertEqual(result.stdout,b'phase-b-failed:python\n')

    def test_wrong_git_commit_cannot_emit_marker(self):
        failure="phase_b_fail() { printf 'phase-b-failed:%s\\n' \"$1\"; exit 91; }"
        check=next(line for line in source('utilities.sh').splitlines() if line.startswith('test "$phase_commit"'))
        script=f'{failure}\nprobe() {{ phase_commit=wrong; {check}; printf forbidden-marker; }}\nif probe; then printf forbidden-pass; fi'
        result=subprocess.run(['/bin/bash','-c',script],capture_output=True,timeout=2)
        self.assertEqual(result.returncode,91)
        self.assertEqual(result.stdout,b'phase-b-failed:git\n')

    def test_scratch_name_rejects_nested_or_foreign_paths(self):
        for name,kind in (('utilities.sh','work'),('utilities-plan.sh','read')):
            guard=next(line for line in source(name).splitlines() if line.startswith('[[ "$phase_tmp"'))
            failure="phase_b_fail() { exit 91; }"
            for value,allowed in ((f'/dev/shm/winter-daily-home/{kind}.abc123',True),(f'/dev/shm/winter-daily-home/{kind}.abc123/escape',False),('/tmp/work.abc123',False),(f'/dev/shm/winter-daily-home/{kind}.abc12',False)):
                result=subprocess.run(['/bin/bash','-c',f'{failure}\nphase_tmp=$1\n{guard}','inert',value],capture_output=True,timeout=2)
                self.assertEqual(result.returncode,0 if allowed else 91)

    def test_plan_uses_readonly_utility_forms_and_marker_order(self):
        markers=['python','cat','temp','openssl','git']
        for name in PAYLOADS:
            text=source(name)
            positions=[text.index('sdk-daily-'+marker+'-ok') for marker in markers]
            self.assertEqual(positions,sorted(positions))
            self.assertGreater(text.index('sdk-daily-tools-end'),text.index('phase_b_fail cleanup'))
        plan=source('utilities-plan.sh')
        self.assertIn('mktemp -u /dev/shm/',plan)
        self.assertIn('openssl dgst -sha256 /workspace/folders/readonly/marker',plan)
        self.assertNotRegex(plan,r'git .*\b(?:init|add|commit)\b')
        self.assertNotIn('os.O_CREAT',plan)

if __name__=='__main__':unittest.main()
