"""Deterministic Git DATA only, not a git invocation or native authority producer."""
import hashlib,zlib
MARKER=b'readonly utility marker\n'
CANARY=b'DAC-positive\n'
def object_bytes(kind,content):
    wire=kind.encode()+b' '+str(len(content)).encode()+b'\0'+content
    return hashlib.sha1(wire).hexdigest(),zlib.compress(wire)
def git_fixture():
    blob,blob_wire=object_bytes('blob',b'fixture-only')
    tree,tree_wire=object_bytes('tree',b'100644 fixture.txt\0'+bytes.fromhex(blob))
    commit,commit_wire=object_bytes('commit',(f'tree {tree}\nauthor Fixture <fixture@example.invalid> 946684800 +0000\ncommitter Fixture <fixture@example.invalid> 946684800 +0000\n\nfixture-tool-device-smoke\n').encode())
    files={'HEAD':b'ref: refs/heads/fixture-tool-smoke\n','refs/heads/fixture-tool-smoke':(commit+'\n').encode(),'config':b'[core]\n\trepositoryformatversion = 0\n\tbare = true\n'}
    for digest,wire in ((blob,blob_wire),(tree,tree_wire),(commit,commit_wire)):files['objects/'+digest[:2]+'/'+digest[2:]]=wire
    return commit,files
