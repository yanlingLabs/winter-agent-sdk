# Synthetic workflow refresh correction candidate — 2026-10-12

The independent re-review accepted the original canonical-provenance P1 fix at
`9092a4e`, then found two synthetic refresh defects: a replacement workflow
retained the denied source's declared name, and parse-only refresh bypassed the
normal 524,288-byte source cap. The preserved report is
[the provenance re-review](2026-10-12-host-context-read-provenance-independent-review.md).
Its name/size reproducers remain unchanged historical bug-confirming evidence.

The correction reuses workflow discovery for refresh. Discovery associates each
source origin with a private frozen refresh recipe capturing the original
workspace/trust/source gates, brand and plugin namespace/root inputs. Derived
synthetic metadata retains that origin identity. On revocation, the index uses
the recipe to rerun `listWorkflowsForListing`, retaining its normal file/tier
collision rules and the guarded regular-file/512 KiB admission checks. Trusted
programmatic synthetic callers without a discovery recipe use the same exported
bounded file discovery helper. No serialized metadata, environment or model
option supplies a refresh recipe or exemption.

Synthetic metadata, primary lookup keys, project aliases, body keys and generated
Workflow invocation names rebuild together from authorized declarations. Old
names/aliases stop resolving. A current benign replacement remains usable under
its new name. Ordinary skill precedence is preserved: a synthetic body is stored
only when its own metadata was admitted, so an ordinary skill that owns the name
keeps its ordinary body. Oversized replacements contribute no synthetic entry;
replacing them with an admissible source permits recovery rather than permanent
suppression.

The command resolver checks the current skill identity/description/alias surface
before using cached enumeration. Thus a denied alias retargeted after enumeration
under the same protection revision exposes the correct new command name, without
requiring another host policy update.

`packages/runtime/src/sandbox/workflow-retarget.test.ts` converts the two review
findings into absence/coherence expectations and adds collision/qualification
controls:

- changed declared name: no old name in listing/body/lookup/project alias;
  the current generated Workflow invocation resolves;
- oversized replacement: both normal discovery and synthetic refresh refuse;
  an admissible replacement then recovers;
- collisions: normal later-file winner matches resolver source, regular skill
  precedence retains its body, and same-revision command enumeration refreshes;
- plugin qualification and excluded project/user tiers retain their original
  discovery gates during refresh.

Final validation: targeted workflow/source/skill/discovery plus brand gate
**116 passed / 368 expectations across five files**; command/production/live
source compatibility **268 passed / 682 expectations across five files**.
Both SDK TypeScript configurations passed after the final source changes. The only brand-gate change updates its existing skills/store allowlist
location from line 46 to 45 after an import removal, with identical rationale.
Root's committed comparison-runner fix at `bb426b2d` is untouched.

This changes source refresh and cached guidance only. No execution wrapper,
approved escape, outer native floor, sandbox-disabling flag, own-MCP exception,
release/pin or workload-parity matrix changes occurred. Context version one
remains a candidate awaiting final independent re-review and Core acceptance;
it does not imply transcript scrubbing, running-child drain or same-user
confidentiality. Fixtures use disposable synthetic files and homes, without
live Winter, Keychain or VM operations.
