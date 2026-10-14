# Internal parent context/reader protocol — source prerequisite

`packages/runtime/src/guest/guided-parent-bridge.ts` is an unwired, injected protocol
component. No query, engine, production wiring, Linux admission or profile gate
imports it. Existing confined-context refusal remains unconditional. This is not
an authority factory: `assertOwnerHeld` is a trusted synchronous dependency in
source tests; matching identifiers, response shapes and a successful assertion do
not create a native admission or grant a source path.

The fixed parent scope contains the existing runtime-context binding, backend SDK
session ID and cwd. Child/foreign/cwd mismatches refuse before context or reader
IO. A real RpcBridge owns runtime_context and permission requests separately; the
reader request has its own instruction_reader subtype and identical envelope/
read ID. Its payload contains ONLY version1, bindingId, contextRequestId and
readId. Root scope/views/configuration cannot enter through that DTO.

One read is allowed per pending parent context. A successful context needs valid
correlated, bounded reader JSON, confirmed drain and accepted reader response
output. Owner liveness is rechecked after every await and before response output.
The opaque inner frame still needs the future native adapter's RuntimeSDK owner/
view/snapshot validation; this layer checks correlation and JSON transport only.

Bounds are explicit: at most16 pending contexts and16 reader debts, one read per
context, reader frame1MiB, absolute wait default15s/max30s. Aborted/expired/closed
contexts cannot output a late reader result. Cancellation is idempotent, preserves
its first reason and asks the operation to stop once. Unknown/malformed results
cancel the context/read; failed drain retains uncertain debt. A fulfilled trusted
drain discharges debt even after the context closes. Bridge closure is NOT proof
of native process termination, service close, FD cleanup or store-lock release.
The future operation must report drain only from its independently checked native
lifetime evidence; EOF or returned frame alone is insufficient.

Portable tests use the real RpcBridge and controlled injected reader operations.
Existing actual engine tests retain zero provider/admission/input/output access
for unavailable/unsupported confined context. No parallel provider path is added.
No process/helper/Root/VM launch, profile activation, consumer pin or B admission
reuse follows. Actual reader capabilities, native ownership, protected views,
parent-only production integration and generation-bound replay remain unimplemented.

Trusted `readerPort.start` must synchronously return a fully registered operation
before effects, or throw with no effects. The future native adapter owns that
registration and all launch/capture debt; this bridge cannot infer cleanup from a
failed start or fabricate a native handle. An invalid returned operation breaches
that trusted dependency contract and fails the context closed.
