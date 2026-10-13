# Apparent /dev/full protected-candidate change

The portable inline Phase B observation is a fixture topology error plus a
misleading SDK consent diagnostic, now corrected in source. It does not establish a parser bug or a pseudo-device
policy change. No Bash, Python, utility payload, native fixture or service was
executed for this investigation. The real SDK query parser/permission evaluator
ran with an injected provider and a synthetic executor.

Source references: `scripts/guest-host-query/cases.ts:75` at
`a19e4629` supplies the Phase A `procWriteCommand`; inert `utilities.sh` bytes
at `3aee7583fc8b60bce50bdd0c74398668253bc2c8` were appended for the initial
observation. Both complete command strings flatten successfully. With separate
temporary source cwd and protected runtime/store home, A and A+B each have zero
bypass callbacks. When cwd equals the protected home/store, A remains zero but
A+B has one callback. Its fixed reason is `Denied: protected path write requires
approval (WS-07 §6.7)` and its reported `blockedPath` is `/dev/full`.

The actual A+B candidates are `/dev/full`, `/proc/self/comm`, `/dev/null`,
`$phase_tmp/repo/fixture.txt`, `/dev/null`. Only the dynamic relative target is
protected in the colocated context: static resolution places it inside the
protected runtime/store home. The device itself remains unprotected by the
protected-path predicate. `protected.ts:382` and `protected.ts:389` intentionally
protect the entire resolved runtime/store home; the fixture must keep its source
cwd separate. The protection-positive colocated case must remain tested.

No heredoc, command substitution or regex is needed. The minimal inert string is:

```text
printf x > /dev/full; printf y > relative-target
```

It produces zero bypass callbacks with disjoint source/home and one with a
colocated home. `/dev/full` is the first candidate and unprotected in both;
`relative-target` is the matching protected candidate only in the latter.
At characterization freeze `664bf440`, `evaluator.ts:1835` reported
`candidatePaths[0]` rather than an actual matching candidate. Its reported path therefore cannot identify the cause of a compound
command's protected-write decision. The intended path semantics are already
stated by `evaluator.test.ts`'s "path that made isProtectedWrite fire" test.

The separate WS-07 §6.7 observation is limited to current code and portable bypass
behavior: direct writes to `/dev/null`, `/dev/full`, `/dev/zero`, `/dev/random`
and `/dev/urandom` each classify unprotected and produce zero bypass callbacks
in both fixture topologies. `shellWriteTargets` only explicitly exempts
`/dev/null`; that alone does not make the other devices protected. This is not
an upstream/device-policy ruling, a device whitelist change, or native filesystem
execution/admission evidence. Other mode, syscall and namespace rules remain
independent. No device exemption or protected-path policy edit is warranted here.

The raw initial source-only A/B observations are retained at
`out/dev-full-analysis/reproduction.log`; the durable self-contained regression is
`packages/sdk/src/dev-full-context.test.ts`. It has no dependency on the unmerged
Phase B commit, uses only fixed inert syntax, retains the real query parser and
synthetic executor, and preserves both disjoint-negative and colocated-positive
protection evidence. The initial `/dev/full` assertion was a known-wrong
characterization; the consent regression deliberately flips it to the actual
protected relative target. Parser/device/protection policy is unchanged.

This is a MED consent-integrity defect to fix before shipping, not merely a
logging concern: a prompt must identify the protected operation it asks the user
to approve. The source correction shares `realProtectedWriteCandidate` between
the REAL boolean check and consent path selection. It preserves the original
order: general protected paths at either symlink end, then shell-only control-plane
basenames at either end. The reported path is the lexical candidate when that
path matches; if only a resolved target matches, it names that target instead of
an innocent link. Existing and dangling chain targets use the existing resolver's
path provenance. This is not a promise that filesystem identity stays stable
until execution.

`checkSymlinkBothEnds` currently exposes only its two composed booleans, not its
local link/target/chain match fields. A private capturing matcher records the first
matching path during that same check, preserving all matcher invocations and
link → resolved target → chain order. It returns that path only when `denyIfEither`
is true. No public result-shape change or additional resolution walk is needed.

Only the exact REAL predicate gets that diagnostic selection. Custom boolean
SpecialChecks keep their existing first-candidate fallback, since they supply no
REAL path semantics. If a repeated filesystem check loses the REAL match, the
protected decision still stands and `blockedPath` is omitted rather than naming
an unrelated candidate. No permission decision or bypass floor changes.

The red consent regression failed against the original source (2 pass / 1 fail)
and passes with the correction. Additional evaluator coverage preserves
path-before-control-plane order, protects both symlink ends, retains custom seam
behavior, and demonstrates a lost-match recheck still denies without a false
path. These are portable source tests, not native/VM/device admission evidence.

Verification for the correction:

- `bun test ./packages/sdk/src/dev-full-context.test.ts ./packages/runtime/src/permissions/evaluator.test.ts`: 438 pass, 906 assertions.
- `bun test ./packages/runtime/src/permissions ./packages/sdk/src/query.test.ts ./packages/sdk/src/dev-full-context.test.ts ./packages/sdk/src/brand.test.ts ./packages/runtime/src/brand-gate.test.ts ./packages/runtime/src/brand-rebrand.test.ts`: 3279 pass, 1 existing platform skip, 6635 assertions.
- `bun run typecheck`: both configurations pass.
- `bun run build:packages`: 7 packages / 21 entries emitted.

Retained local logs are under `out/dev-full-analysis/`: `consent-red.log`,
`consent-green.log`, `permission-query-brand.log`, `consent-typecheck.log` and
`consent-build.log`. They are excluded from the source commit.

The target-only follow-up also tests existing multi-link chains, dangling `.git`
targets, dangling chains and dangling control-plane targets. Lexically protected
links pointing at an ordinary target still report the protected link path. The
lost-match regression remains unchanged: no stale or unrelated path is reported.

Target-only follow-up verification: evaluator plus portable query regression
438 pass / 918 assertions; the same permission/query/brand command above
3279 pass / 1 existing platform skip / 6647 assertions. Both typecheck
configurations and package emission pass. Follow-up evidence is retained locally
as `symlink-consent-green.log`, `symlink-permission-query-brand.log`,
`symlink-typecheck.log` and `symlink-build.log` under the same excluded log root.
