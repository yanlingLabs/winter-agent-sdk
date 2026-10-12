# Private guest provider proxy

`createGuestProviderClient` accepts only a trusted immutable-bootstrap channel,
copied scope and host-selected public model metadata. No credential, endpoint or
authentication-header field exists on the binding. Its length-prefixed private
exchange carries normalized provider requests/events, including opaque state and
thinking signatures; it must not be connected to model-readable NDJSON or logs.
The native integration must authenticate the channel's actual boot/task/UID.
This JavaScript constructor is not proof of native admission.

The sealed binding can be passed only through internal SessionProviderOptions.
The actual SessionProvider buildProvider route uses `guestProviderFor` and the
existing adapterAsProvider fold/domain stamping/history renderer. A mismatched
SDK backend session or model refuses. Guest credential/keychain/tool-secret
stores remain unavailable; the proxy has no direct HTTP/discovery/local fallback.
Ordinary sessions with no binding keep their existing provider path.

Each invocation has an independent UUID, sequence, abort state and event stream;
eight may run concurrently on a binding. Capacity refusal is a typed retryable
rate-limit error and does not close the binding. There is no automatic turn replay.
The port must multiplex exchanges without mixing invocation frames and should
honor each exchange's AbortSignal without closing unrelated exchanges.

One exchange is bounded at six seconds. The host MUST answer a pending `next`
within that deadline even when the provider has no event yet; Core polls at five
seconds and retains the same outstanding adapter `next`. Pending responses never
resend the turn. A user abort or early consumer return sends one bounded,
best-effort `cancel` for that invocation and preserves the binding for later work.
The host fences cancel-before-begin races and retains capacity until the exact
pending adapter operation and finalizer settle. A cancel acknowledgment is not
proof of native/adapter cleanup. Late canceled responses are ignored.

Binding/framing/sequence violations, transport failure during normal work, and
session close still fence the whole binding. Cancellation delivery failures alone
do not. Errors are fixed/redacted; guest credential/HTTP fallback remains absent.
The host independently owns lingering cleanup obligations.

The initial seven focused SDK tests verified real fold/native state/tool triples, sealed model/
backend matching, framing/sequence failure without retries, and cancellation with
late-response fencing, pending polls without request replay, actual exchange
deadline enforcement and oversized/malformed response refusal. Companion Core tests exercise actual shipped Responses
and Anthropic adapters plus sidecar/tool-result continuation over fixture Worker
bytes. That Worker is not a production sandbox, and scripted tool results are not
Linux tool execution. Global confined startup remains refused. No SDK release,
consumer pin, environment authorization flag or broad fallback was introduced.

Initial slice validation (before the invocation lifecycle correction): 166 proxy/posture/bridge/session-provider/credential regressions
pass (513 assertions), and both SDK typecheck projects pass. Companion Core
validation passes 13 tests (109 assertions), including actual partial Responses
output that fails without another upstream request or leaked fixture credential.

The lifecycle correction adds interleaved parallel generations, invocation-only
abort plus later turns, early consumer return, and retryable host capacity tests.
Host tests separately cover cancel-before-begin and exactly-once capacity release
across multiple retained pending operations. These are protocol/adapter tests,
not proof of the production native channel or subagent model delegation.
