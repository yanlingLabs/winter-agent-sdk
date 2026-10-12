# Host source-reader coverage candidate — 2026-10-12

This candidate closes the SDK source-reader inventory that kept protected
Chat/Dispatch activation refused. It also guards native Code startup: host
sandbox read restrictions apply before source settings or prompt content load.
The source advertisement is a candidate implementation claim for independent
review, not approval to activate Core, release or pin the SDK.

Independent review of `32b9b753` found a canonical-provenance blocker. The
[follow-up correction](2026-10-12-host-context-read-provenance-fix.md) binds pending
bytes and reusable metadata to their exact pre-I/O origin and adds retarget
regressions; source coverage remains pending re-review.

The preceding Code workload parity report remains frozen at `d7d4688b`. No
command wrapper, escape posture, tool sandbox flags, or native floor enrollment
changed in this slice, and its workload matrix was not repeated. Separate disk
encryption remains deferred for version one. These path checks are defense in
depth for plaintext protected roots, not same-user confidentiality.

## Shared boundary and inventory

`sandbox/source-read.ts` supplies synchronous file, directory, stat and bounded
skill-open checks, plus an asynchronous text reader. Every read uses current
private host policy and any captured native source restrictions. Content and
listings are checked before and after I/O; asynchronous content is discarded
if a host update denies its path while I/O is pending. Symlink chains, canonical
aliases, macOS case aliases and glob rules use the existing shared host path
matcher. No generic exception, environment flag, model field or RuntimeConfig
exemption can bypass a source read.

| Consumer | Guarded operation |
|---|---|
| context injection / WINTER.md / memory | whole and capped source reads; delegated instruction/memory loading |
| context imports | recursive imported file stat/read |
| context rules | recursive directories, rule content, cached conditional-rule eligibility |
| output styles | project/user/plugin style discovery and content |
| runtime settings | SDK-owned async reader receives the runtime guarded callback |
| MCP config | project files; own global control reader described below |
| skill loader/index | directory discovery, bounded metadata prefix, full invocation; cached listings filter current paths |
| agent definitions | project/user content; cached plugin definitions carry private object-identity provenance |
| plugin loader/manifest/installed | manifests, skill/command/agent components, hooks/MCP files, installed/marketplace source ledgers |
| command resolver | discovery/meta/body reads; policy-generation cache invalidation and current-path eligibility |
| workflow sources | discovery/name resolution, direct tool scriptPath and nested runtime scriptPath |

SDK settings resolution still lives in the Node-compatible SDK package. Its
separate reader callback is trusted JavaScript supplied by the runtime seam,
not a serialized settings property. Standalone SDK settings/plugin-management
APIs retain their ordinary control-plane behavior; they are not embedded prompt
loaders and do not acquire host-policy authority from ambient environment.

## Native startup and live lifecycle

`buildProductionWiring` installs a copied union of the host-provided native
sandbox denyRead paths before it calls settings resolution. Resolved settings
can add narrowing restrictions before subsequent loaders run. Owners stay
installed through wiring disposal, union across concurrent owners, and are
removed on startup failure/terminal disposal. A settings source cannot remove
a bootstrap deny or a private live host policy. The existing native config
channel supplies narrowing sandbox paths; it does not mint a private host
capability or any exemption.

Embedded Workers continue receiving host-owned snapshots through the private
`updateHostCodeProtection` lifecycle channel and exact revision acknowledgement.
Source reads consult the new snapshot immediately; the engine invalidates its
cached instruction/user context when the protection generation changes.
A two-turn real engine regression observes previously allowed fixture import
bytes in request one, updates trusted policy, and observes no protected bytes
in request two while allowed guidance remains. This proves live reassembly,
not retroactive scrubbing of transcripts, exact fork snapshots, already-sent
requests or model state. Already running native children retain their original
profile; no child drain or retirement guarantee is added.

The exported ABI remains `HOST_CODE_PROTECTION_CONTRACT_VERSION = 1` and
`host-code-path-protection-v1`. Its frozen coverage now advertises
`contextReadChecksVersion: 1` with an explicit `sourceReaderFamilies` inventory.
Core must still require independent source review and appropriate lifecycle
acknowledgements before lifting its activation refusal. Capability discovery
alone is neither acknowledgement nor accepted production coverage.

## Fixed trusted control read and durable stores

The global MCP loader consumes the fixed own `.winter.json` (brand equivalent)
from the runtime's already established discovery/run-home. Production passes
that home; source content does not select it. Its private helper permits only
the exact own control-file native sandbox denial, because the tool sandbox
should deny that file while runtime startup needs its MCP fields. When this
exception is needed, the leaf must be a regular non-symlink file and its
canonical identity must stay inside the captured canonical home. All live host
protected roots, canonical aliases and broader native deny ancestry still apply.
A denied Cowork directory containing an own-looking `.winter.json` remains
unreadable. General imports/Read never inherit this exception. Without an
own-control exception, ordinary standalone global MCP symlinks keep their
existing behavior through the normal guarded reader.

Runtime-owned SDK durable transcripts/leases, authority recovery, permission
journals/approvals/caches, MCP credential stores, task outputs and checkpoint
stores keep their existing fixed-operation/durable-authority readers. This
slice does not indiscriminately apply source discovery denials to those stores,
and does not claim to replace their authority or alias validation. In the
listed context/source subsystems the sole remaining general raw file reader is
`workflows/journal.ts`: it reads the runtime-owned run journal for continuation,
not a model-selected workflow script. Direct/nested script sources are guarded.
The other intentional raw reader is the narrow own-MCP control helper above.

## Verification

All attack fixtures use fresh disposable directories and synthetic content;
no live app/home, Keychain or VM operations are involved. The tests cover:

- hostile native repo WINTER.md import through an in-repo symlink to a denied
  plaintext Cowork image, plus allowed project/user/imported guidance;
- denied settings symlinks during actual production startup, before environment
  or style values can be applied;
- protected file/directory aliases through context/rules/styles/skill metadata
  and invocation, agent definitions, plugin components/manifests/ledgers,
  commands and workflow discovery;
- policy updates during pending asynchronous I/O, after skill/plugin discovery,
  and between provider requests;
- legitimate own global MCP loading under exact control-file denial, ordinary
  source import/alias refusal, symlink-leaf refusal and broader Cowork refusal;
- existing standalone loaders and workflow/production/context behavior.

The reproducible attack suite is
`packages/runtime/src/sandbox/source-read.test.ts`: 10 passed, 52 expectations.
The final source/live-path/edge/corpus batch passed 161 tests with 394
expectations across 12 files. The existing loader/production/assembler/workflow
regression batch passed 796 tests with 1,851 expectations across 17 files.
Both `tsconfig.typecheck.json` and `tsconfig.sdk-fence.json` passed after final
source/tests/marker changes. No full-suite or native Swift/Xcode/browser workload
repeat was performed in this slice.

Path checks intentionally retain arbitrary same-user hardlink and post-check
race residuals. There is no persistent outer Code floor, no sandbox-disabling
flag injection, no encrypted-image claim and no claim of complete Cowork
production integration from this SDK source change.
