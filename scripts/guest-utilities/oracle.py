"""Exact utility receipt oracle; stdout is fixed markers, never utility/random bytes.
Portable validation is not native execution or general tool availability evidence.
"""
import hashlib, json

EXPECTED_STDOUT = 'tool-device-stdin-fds-ok\ntool-device-inventory-ok\ntool-device-boundaries-ok\ntool-entropy-multiprocessing-ok\ntool-device-smoke-ok\n'


def validate_result(result):
    if type(result) is not dict or set(result) != {'stdout', 'stderr', 'exitCode', 'termination'} or type(result['exitCode']) is not int or result['exitCode'] != 0 or result['termination'] != 'exit' or result['stdout'] != EXPECTED_STDOUT or result['stderr'] != '':
        raise ValueError('exact successful utility process result required')
    wire = json.dumps(result, sort_keys=True, separators=(',', ':')).encode()
    return {'kind': 'winter-tool-utility-result', 'resultSha256': hashlib.sha256(wire).hexdigest(), 'stdoutSha256': hashlib.sha256(EXPECTED_STDOUT.encode()).hexdigest(), 'stdoutBytes': len(EXPECTED_STDOUT.encode()), 'generalToolAvailabilityEnabled': False, 'vmExecutionVerified': False}
