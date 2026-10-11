# Linux file-worker validation

The worker is an unactivated implementation primitive. It uses `openat2` rooted
resolution, bounded data and ordinary workspace-group file creation. The
runtime's confined-guest entry remains blocked: a supervisor, authenticated
current policy, immutable artifact packaging and complete file-tool routing are
still required. The worker's prerequisite checks do not authenticate a sandbox
or replace those host/supervisor responsibilities.

On a disposable Linux CI machine, with an existing C compiler:

```sh
sudo -n python3 scripts/guest-files/verify.py
```

The explicit fixture launcher creates private mount/PID/network/IPC namespaces,
a minimal read-only chroot, source binds, non-root tool identities, zero
capabilities, no-new-privileges and a syscall filter. It runs only the freshly
compiled worker against a new temporary tree. Unsupported confinement fails the
job; it never falls back to unconfined execution. No VM, daemon, model provider,
credential store, real project or user's Winter home is used. This is not the
production supervisor and does not prove VZ/virtiofs behavior.

The runner verifies real byte results, two UIDs editing common group-writable
files, plan/read-only denials with unchanged bytes, in-root links, forbidden
escapes, non-regular files, payload bounds, root-identity refusal and concurrent
symlink replacement. The final JSON receipt is emitted only after every check.
The source-root boundary is intentionally explicit; cross-root symlink policy
and integration with the complete SDK file surface are separate work.
