import utilities from "./utilities.sh" with { type: "text" };
import planUtilities from "./utilities-plan.sh" with { type: "text" };
/** Closed disposable fixture cases. No model-supplied policy, shell, path or native admission. */
export const CASES = ["ask-allow", "ask-deny", "plan", "bypass"] as const;
export type Case = typeof CASES[number];
export function fixtureCase(value: unknown): Case {
  if (!(CASES as readonly unknown[]).includes(value)) throw new Error("fixture case unavailable");
  return value as Case;
}
export type ProbePaths = { store: string; home: string; control: string; credential: string; canaryStore: string; stage: string };
/** Closed disposable Root oracle data. This never confers native admission or a grant. */
export function fixtureProbePaths(value: unknown): ProbePaths {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture probe paths unavailable");
  const record = value as Record<string, unknown>, keys = ["store", "home", "control", "credential", "canaryStore", "stage"];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort()) || keys.some(key => typeof record[key] !== "string" || (record[key] as string).length > 256)) throw new Error("fixture probe paths unavailable");
  const match = /^\/tmp\/winter-host-query-run-[A-Za-z0-9_]{1,64}\/store$/.exec(record.store as string);
  if (!match) throw new Error("fixture probe paths unavailable");
  const root = (record.store as string).slice(0, -6);
  for (const [key, suffix] of Object.entries({ home: "home", control: "control", credential: "host-only-credential", canaryStore: "protected-canary-store" })) if (record[key] !== `${root}/${suffix}`) throw new Error("fixture probe paths unavailable");
  if (!/^\/tmp\/winter-host-query-reviewed-[A-Za-z0-9_]{1,64}$/.test(record.stage as string)) throw new Error("fixture probe paths unavailable");
  return Object.fromEntries(keys.map(key => [key, record[key]])) as ProbePaths;
}
/** Every mandatory shell check is explicit; errexit never supplies the oracle. */
const check = (condition: string, label: string) => `${condition} || phase_fail ${label}`;
const failure = 'phase_fail() { printf "phase-a-check-failed:%s\\n" "$1"; exit 90; }';
/** Existing Bash/cat only. Kernel checks are for the admitted private tool view. */
export function boundaryCommand(kind: Case, inputPaths: ProbePaths): string {
  const paths = fixtureProbePaths(inputPaths);
  const status = [
    'phase_seen=0; phase_caps=0',
    'while IFS=$\' \\t\' read -r phase_field phase_a phase_b phase_c phase_d phase_rest || test -n \"$phase_field\"; do case "$phase_field" in',
    'Uid:|Gid:) ' + check('test "$phase_a:$phase_b:$phase_c:$phase_d" = 10001:10001:10001:10001 && test -z "$phase_rest"', 'identity') + '; phase_seen=$((phase_seen+1));;',
    'PPid:) if test "$phase_id" = 1; then ' + check('test "$phase_a" = 0', 'init_parent') + '; else ' + check('test "$phase_a" = 1', 'shell_parent') + '; fi; phase_seen=$((phase_seen+1));;',
    'Groups:) ' + check('test "$phase_a" = 10000 && test -z "$phase_b$phase_c$phase_d$phase_rest"', 'groups') + '; phase_seen=$((phase_seen+1));;',
    'CapInh:|CapPrm:|CapEff:|CapBnd:|CapAmb:) ' + check('[[ "$phase_a" =~ ^0+$ ]]', 'capability') + '; phase_caps=$((phase_caps+1));;',
    'NoNewPrivs:) ' + check('test "$phase_a" = 1', 'no_new_privileges') + '; phase_seen=$((phase_seen+1));;',
    'Seccomp:) ' + check('test "$phase_a" = 2', 'seccomp') + '; phase_seen=$((phase_seen+1));;',
    'esac; done < "$phase_proc/status" || phase_fail status_read; ' + check('test "$phase_seen" = 6 && test "$phase_caps" = 5', 'status_fields'),
  ].join('\n');
  const probe = [
    failure,
    check('test "$UID" = 10001', 'uid'),
    ...['/workspace/.winter/conversations','/run/winter/conversations','/outside-source','/host-only-credential','/winter-runtime','/run/winter','/workspace/.winter'].map(path => check(`test ! -e ${path}`, 'private_path')),
    check('test -L store-probe && test ! -e store-probe && test -L credential-probe && test ! -e credential-probe', 'canary_links'),
    'for envkey in OPENAI_API_KEY ANTHROPIC_API_KEY WINTER_TEST_KEYCHAIN_SECRET; do ' + check('test -z "${!envkey-}"', 'credential_environment') + '; done',
    check('test ! -t 0 && test ! -t 1 && test ! -t 2', 'tty'),
    'shopt -s dotglob nullglob; phase_dev_count=0; for phase_device in /dev/*; do case "$phase_device" in',
    '/dev/null|/dev/zero|/dev/full|/dev/random|/dev/urandom) ' + check('test -c "$phase_device"', 'device_type') + ';;',
    '/dev/fd|/dev/stdin|/dev/stdout|/dev/stderr) ' + check('test -L "$phase_device"', 'device_link') + ';;',
    '/dev/shm) ' + check('test -d "$phase_device" && test -k "$phase_device" && test -w "$phase_device"', 'shm_directory') + ';;',
    '*) phase_fail device_inventory;; esac; phase_dev_count=$((phase_dev_count+1)); done; ' + check('test "$phase_dev_count" = 10', 'device_inventory') + '; shopt -u dotglob nullglob',
    check('test /dev/fd -ef /proc/self/fd && test /dev/stdin -ef /proc/self/fd/0 && test /dev/stdout -ef /proc/self/fd/1 && test /dev/stderr -ef /proc/self/fd/2', 'device_targets'),
    'phase_pid=$BASHPID; ' + check('test "$phase_pid" -ge 2 && test "$phase_pid" -le 1024', 'private_pid'),
    'shopt -s nullglob; phase_pid_count=0; for phase_proc in /proc/[0-9]*; do phase_id=${phase_proc##*/}; if test ! -e "$phase_proc"; then continue; fi; ' + check('[[ "$phase_id" = 1 || "$phase_id" = "$phase_pid" ]]', 'process_set') + '; phase_pid_count=$((phase_pid_count+1));\n' + status + '\ndone; ' + check('test "$phase_pid_count" = 2', 'process_set') + '; shopt -u nullglob',
    check('test -r /proc/1/fd && test -x /proc/1/fd', 'worker_fd_access'),
    'shopt -s nullglob; phase_worker_fds=0; for phase_fd in /proc/1/fd/*; do phase_number=${phase_fd##*/}; case "$phase_number" in 0|1|2|3|5) :;; *) phase_fail worker_fd_inventory;; esac; ' + check('test -p "$phase_fd" && test ! -S "$phase_fd" && test ! -f "$phase_fd" && test ! -d "$phase_fd" && test ! -c "$phase_fd"', 'worker_fd_type') + '; phase_worker_fds=$((phase_worker_fds+1)); done; ' + check('test "$phase_worker_fds" = 5', 'worker_fd_inventory') + '; shopt -u nullglob',
    check('test /proc/self/fd/1 -ef /proc/1/fd/3 && test /proc/self/fd/2 -ef /proc/1/fd/5', 'capture_binding'),
    check('test -r /proc/"$phase_pid"/fd && test -x /proc/"$phase_pid"/fd', 'self_fd_access'),
    'shopt -s nullglob; phase_self_fds=0; phase_gone_fds=0; for phase_fd in /proc/"$phase_pid"/fd/*; do phase_number=${phase_fd##*/}; case "$phase_number" in',
    '0) ' + check('test -c "$phase_fd" && test "$phase_fd" -ef /dev/null', 'stdin_type') + '; phase_self_fds=$((phase_self_fds+1));;',
    '1|2) ' + check('test -p "$phase_fd" && test ! -S "$phase_fd"', 'stdio_type') + '; phase_self_fds=$((phase_self_fds+1));;',
    '*) ' + check('test ! -e "$phase_fd" && test ! -L "$phase_fd"', 'extra_fd') + '; phase_gone_fds=$((phase_gone_fds+1)); ' + check('test "$phase_gone_fds" -le 1', 'extra_fd') + ';;',
    'esac; done; ' + check('test "$phase_self_fds" = 3', 'stdio_inventory') + '; shopt -u nullglob',
    'phase_proc_mount=0; phase_shm_mount=0; phase_source_mount=0; phase_device_mounts=0; phase_env_mounts=0; phase_rodata_mounts=0; phase_mounts=0; while IFS=" " read -r phase_mid phase_parent phase_dev phase_root phase_point phase_options phase_tail || test -n "$phase_mid"; do phase_mounts=$((phase_mounts+1)); ' + check('test "$phase_mounts" -le 128', 'mount_limit') + '; case " $phase_tail" in *" shared:"*|*" master:"*|*" propagate_from:"*) phase_fail mount_propagation;; esac; for phase_protected in ' + Object.values(paths).flatMap(path => [path, path.slice(4)]).map(path => "'" + path + "'").join(' ') + '; do case "$phase_root" in *"$phase_protected"*) phase_fail protected_mount_root;; esac; done; case "$phase_point" in',
    '/proc) for phase_flag in ro nosuid nodev noexec; do ' + check('[[ ",$phase_options," = *",$phase_flag,"* ]]', 'proc_flags') + '; done; ' + check('[[ "$phase_tail" = *"- proc proc "* ]]', 'proc_type') + '; phase_proc_mount=$((phase_proc_mount+1));;',
    '/dev/shm) for phase_flag in rw nosuid nodev noexec; do ' + check('[[ ",$phase_options," = *",$phase_flag,"* ]]', 'shm_flags') + '; done; ' + check('[[ "$phase_tail" = *"- tmpfs tmpfs "* && ",$phase_tail," = *",size=8192k,"* ]]', 'shm_size') + '; phase_shm_mount=$((phase_shm_mount+1));;',
    '/workspace/folders/source) for phase_flag in ' + (kind === 'plan' ? 'ro' : 'rw') + ' nosuid nodev noexec; do ' + check('[[ ",$phase_options," = *",$phase_flag,"* ]]', 'source_flags') + '; done; phase_source_mount=$((phase_source_mount+1));;',
    '/bin|/lib|/usr) for phase_flag in ro nosuid nodev; do ' + check('[[ ",$phase_options," = *",$phase_flag,"* ]]', 'environment_flags') + '; done; phase_env_mounts=$((phase_env_mounts+1));;',
    '/workspace/folders/readonly) for phase_flag in ro nosuid nodev noexec; do ' + check('[[ ",$phase_options," = *",$phase_flag,"* ]]', 'readonly_data_flags') + '; done; phase_rodata_mounts=$((phase_rodata_mounts+1));;',
    '/dev/null|/dev/zero|/dev/full|/dev/random|/dev/urandom) for phase_flag in ro nosuid noexec; do ' + check('[[ ",$phase_options," = *",$phase_flag,"* ]]', 'device_flags') + '; done; ' + check('[[ ",$phase_options," != *",nodev,"* ]]', 'device_nodev') + '; phase_device_mounts=$((phase_device_mounts+1));;',
    'esac; done < /proc/self/mountinfo || phase_fail mount_read; ' + check('test "$phase_proc_mount:$phase_shm_mount:$phase_source_mount:$phase_device_mounts:$phase_env_mounts:$phase_rodata_mounts" = 1:1:1:5:3:1', 'mount_inventory') + ';',
    'printf "host-query-view-v2-counts:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s\\n" "$phase_pid_count" "$phase_worker_fds" "$phase_self_fds" "$phase_dev_count" "$phase_proc_mount" "$phase_shm_mount" "$phase_source_mount" "$phase_device_mounts" "$phase_env_mounts" "$phase_rodata_mounts"',
    'printf host-query-boundary-ok',
  ].join('\n');
  if (kind !== 'plan') return probe;
  return 'if printf forbidden > plan-denied-write; then exit 35; fi; test ! -e plan-denied-write || exit 35\n' + probe;
}
/** Separate fixed write probe: no protected store/runhome paths in its command. */
export const procWriteCommand = () => [
  failure,
  'phase_byte=""; if IFS= read -r -t 1 phase_byte; then phase_fail stdin_eof; else phase_status=$?; ' + check('test "$phase_status" = 1 && test -z "$phase_byte"', 'stdin_eof') + '; fi',
  'phase_byte=""; if IFS= read -r -d "" -n 1 phase_byte < /dev/null; then phase_fail null_eof; else phase_status=$?; ' + check('test "$phase_status" = 1 && test -z "$phase_byte"', 'null_eof') + '; fi',
  'phase_byte=""; ' + check('IFS= read -r -d "" -n 1 phase_byte < /dev/zero && test -z "$phase_byte"', 'zero_read'),
  'if printf x > /dev/full; then phase_fail full_write; fi',
  'for phase_random in /dev/random /dev/urandom; do phase_byte=""; ' + check('IFS= read -r -d "" -n 1 -t 2 phase_byte < "$phase_random"', 'entropy_read') + '; done',
  '{ ' + check('read -r phase_a phase_b phase_c phase_d phase_e phase_f phase_g phase_h phase_extra && test "$phase_a:$phase_b:$phase_c:$phase_d:$phase_e:$phase_f:$phase_g:$phase_h" = Num:RefCount:Protocol:Flags:Type:St:Inode:Path && test -z "$phase_extra"', 'unix_header') + '; if IFS= read -r phase_extra; then phase_fail unix_socket; else phase_status=$?; ' + check('test "$phase_status" = 1 && test -z "$phase_extra"', 'unix_eof') + '; fi; } < /proc/self/net/unix || phase_fail unix_read',
  'if printf forbidden > /proc/self/comm; then phase_fail proc_write; fi',
  'printf host-query-proc-device-ok',
].join('\n');
export const DAILY_STDOUT = "host-query-proc-device-ok\nsdk-daily-python-ok\nsdk-daily-cat-ok\nsdk-daily-temp-ok\nsdk-daily-openssl-ok\nsdk-daily-git-ok\nsdk-daily-tools-end";
export const PROC_WRITE_RESULT = DAILY_STDOUT + "\n[stderr]\n/bin/bash: line 5: printf: write error: No space left on device\n/bin/bash: line 8: /proc/self/comm: Read-only file system\n\n[Exit code: 0; cwd changes apply to this command only]";
export const VIEW_RESULT = "host-query-view-v2-counts:2:5:3:10:1:1:1:5:3:1\nhost-query-boundary-ok\n[Exit code: 0; cwd changes apply to this command only]";
export const PLAN_BOUNDARY_RESULT = "host-query-view-v2-counts:2:5:3:10:1:1:1:5:3:1\nhost-query-boundary-ok\n[stderr]\n/bin/bash: line 1: plan-denied-write: Read-only file system\n\n[Exit code: 0; cwd changes apply to this command only]";
export function toolScript(kind: Case, paths: ProbePaths) {
  const script: { name: string; input: Record<string, unknown> }[] = [
    { name: "Read", input: { file_path: "seed" } },
    { name: "Write", input: { file_path: "approved-write", content: "approved\n" } },
    { name: "Bash", input: { command: boundaryCommand(kind, paths), timeout: 5000 } },
    { name: "Bash", input: { command: procWriteCommand() + "\n" + (kind === "plan" ? planUtilities : utilities), timeout: 5000 } },
  ];
  if (kind === "bypass") script.push(
    { name: "Read", input: { file_path: "store-probe" } },
    { name: "Write", input: { file_path: "/outside-source", content: "must-not-write" } },
    { name: "Read", input: { file_path: "credential-probe" } },
  );
  return script;
}
export const terminalText = (kind: Case) => `host-query-${kind}-complete`;
