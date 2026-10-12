# Source origin correction: independent re-review

2026-10-12. **The original pending-read and cached-body/description leaks are fixed at `9092a4e352bc2ebac73dfa677693867e2c11d6d2`; hold broad coverage acceptance for a narrow synthetic-workflow refresh correction.** Fresh replacement workflow metadata is mixed with the old source-declared identity, and its refresh bypasses the normal source-size cap. Core acceptance should remain 0 pending that correction and the designated review. This report does not supersede the preserved original `32b9b753` report or its historical leak-confirming reproducers.

I inspected the actual `32b9b753..9092a4e` diff and `2026-10-12-host-context-read-provenance-fix.md`. No context implementation changed during this review. Root's concurrent edits to `packages/runtime/src/brand-gate.test.ts` and `scripts/research/code-policy-compatibility.ts` were observed and left untouched; they are outside this source verdict. I made only this report and two review reproducers. No VM, native rebuild, accepted workload-parity repeat, live home, Keychain, release, push or commit occurred.

**Original P1 disposition: corrected.** `packages/runtime/src/sandbox/source-read.ts:14–31` captures and freezes the requested spelling, resolved target/chain and canonical path before I/O; the readers use that captured canonical path and recheck every original path against current restrictions. In particular, `readSourceText:89–94` cannot deliver A's pending bytes by checking only a newly retargeted alias to B. The private WeakMap holds that original origin, and inheritance preserves it through plugin skill/command contribution mapping, skill discovery/index metadata, workflow listing/synthetic construction and agent definitions.

Conditional rules reload an allowed replacement when the original origin is denied (`context/rules.ts:274–280`); plugin agents do the same at `subagents/definitions.ts:451–463`. Ordinary skill refresh updates description/author from a guarded bounded read and rebinds provenance (`skills/store.ts:266–270`). The command resolver inherits source metadata and obtains current skill metadata when listing rather than returning its old description. These changes close the exact reproduced stale-rule, plugin-agent, ordinary-skill and async-read paths without permanently suppressing fresh benign replacements. The multiple-owner denial and subsequent policy-relaxation controls pass.

**Remaining finding 1: source-declared workflow identity is retained after its origin is denied.** At `skills/store.ts:258–262`, synthetic refresh parses B's new metadata, but builds its new prompt with `name: meta.name` from A. It also keeps A's key in `entries`, `byName`, aliases and `syntheticBodies`. Unlike ordinary SKILL.md identity—which `skills/frontmatter.ts:87–98,120–124` derives from its directory and deliberately ignores frontmatter `name:`—a workflow's name is parsed from the script. Retaining that field is retaining source-derived bytes from the denied origin.

A deterministic disposable reproduction loads an alias to A declaring `source-secret-name`, installs private denyRead for A's directory, and retargets the alias to B declaring `safe-name`. Without any earlier invocation, the refreshed listing and newly generated body still emit `source-secret-name`. The actual workflow resolver rejects that generated old name while resolving `safe-name`. The observed result is:

```json
{"cachedName":"source-secret-name","bodyContainsProtectedName":true,"oldNameResolves":false,"newNameResolves":true}
```

This is both an incomplete stale-content fix and broken generated guidance. It is not a demand to scrub a historical transcript or previously advertised namespace. Rebuild the current synthetic workflow identity/body coherently from the authorized replacement, including lookup/collision/alias state, or use another explicitly valid identity-preserving mechanism that cannot emit the denied declaration and actually resolves the intended current workflow. Preserve user/project/plugin qualification and trust/source gating. Do not merely hide the source forever: fresh allowed B must remain usable.

**Remaining finding 2: synthetic refresh does not preserve workflow admission bounds.** The same branch directly calls `readSourceTextWithOrigin` and `parseWorkflowMeta`, bypassing `workflows/store.ts:234–246`, where normal discovery requires a regular file no larger than `WORKFLOW_SCRIPT_MAX_BYTES` (524,288 bytes). A replacement just larger than that cap is correctly absent from fresh listing and name resolution, yet the cached synthetic refresh still materializes/parses it and returns generated guidance. The observed result is:

```json
{"freshListingCount":0,"cachedBodyExists":true,"oldNameResolves":false}
```

This was tested with approximately 512 KiB of synthetic text, not a pressure workload. Preserve the existing cap in the refresh path. Prefer a shared guarded, bounded workflow-source refresh helper so original discovery, name resolution and synthetic refresh do not drift on identity, admission or parsing. This is a focused follow-up in the same refresh branch, not a request for a broader transport/security redesign.

**Independent verification.** All of the following positive regressions passed on the reviewed source:

- `bun test packages/runtime/src/sandbox/source-read.test.ts packages/runtime/src/sandbox/source-read-retarget.test.ts`: **12 passed / 70 expectations**.
- `bun test ./packages/runtime/src/sandbox/source-read-async-retarget.isolated.ts`, alone: **1 passed / 2 expectations**, including refusal of held real A bytes and a successful fresh read of B.
- The preserved actual native-child/embedded-Worker startup plus control-exception probes: **3 passed / 16 expectations**.

The two new review-only reproducers each passed one assertion confirming the remaining defects; their passing status is bug evidence, not acceptance. They are preserved as `docs/research/host-context-read-independent-fixtures/workflow-name-retarget.repro.ts` and `workflow-size-retarget.repro.ts`. Run explicitly from SDK root:

```sh
bun test ./docs/research/host-context-read-independent-fixtures/workflow-name-retarget.repro.ts ./docs/research/host-context-read-independent-fixtures/workflow-size-retarget.repro.ts
```

An exploratory ordinary-skill declared-name hypothesis was disproved: that parser ignores the declared name and retains the directory identity, so it is not a finding. No larger compatibility suite, typecheck or compiled-runtime gate was independently repeated; the author's recorded 556/1,208 compatibility and typecheck results remain separately attributed.

No new issue was found in the unchanged native restriction-install timing, async SDK callback seam, own global MCP exception, live private-policy union, or approved native escape behavior. Separate disk encryption remains deferred for v1. The result is scoped SDK source review; it does not activate Core, release/pin the SDK, prove a running-child drain, scrub prior histories/model state, or claim same-user confidentiality.
