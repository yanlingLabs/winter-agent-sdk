// AWS credential material for the Bedrock adapter. Lane N (Task 9, R6-10 / R6-16).
//
// THIS MODULE RESOLVES NOTHING ITSELF. Every byte comes out of Task 2's FROZEN stores
// (`credentials/{env,file,types}.ts`) through the `CredentialStore` on `ProviderContext`; what lives
// here is the narrow question those stores cannot answer, which is whether what came back is
// material Bedrock can actually sign with. `process.env` is never read, `~/.aws/credentials` is
// never opened, and no chain is re-implemented — the file store's own `aws-default-chain` arm is the
// chain (env triple, then the shared-credentials file, and NO third link: R6-16 excludes IMDS and
// STS this phase, deliberately, because an IMDS link turns a credential lookup into a request to
// `169.254.169.254` that hangs off-EC2 and silently succeeds on it).
//
// THE THREE REFS THAT WORK, and the one that looks like it should:
//
//   `{ kind: "aws-default-chain" }`            the env triple, then the shared-credentials file.
//   `{ kind: "file", format: "aws-shared-credentials", profile? }`   a named profile, no fallback to
//                                              [default] if it is absent (the file store's own rule:
//                                              signing with the wrong account silently is worse than
//                                              reporting that nothing was found).
//   `{ kind: "keychain" | "inline" }`          whatever the host's store returns, IF it is `aws`
//                                              material — a host that keeps an access key pair in the
//                                              Keychain is a supported shape.
//
//   `{ kind: "env", name }` IS NOT ONE OF THEM, and the refusal below says so in as many words. The
//   frozen env store reads ONE NAMED VARIABLE and returns `{ kind: "api-key" }`; SigV4 needs a key
//   ID *and* a secret *and* optionally a session token, which is three variables. Winter's brief
//   named `{ kind: "env" }` for "the standard triple", but the store that would have to serve it
//   cannot express one — so the triple is reached through `aws-default-chain`'s first link, which is
//   exactly those three variables, and an `env` ref gets a typed error naming the ref that works
//   rather than a confusing 403 from AWS.

import type { CredentialMaterial, CredentialRef, ProviderContext } from "../../types.ts";
import { redactMaterial, redactRef } from "../../credentials/types.ts";
import { ProviderRequestError } from "../../http.ts";
import type { AwsSigningCredentials } from "./sigv4.ts";

/**
 * The marker that distinguishes "no credential is configured or present" from "a credential was
 * rejected".
 *
 * Both are `code: "auth"` — they are the same taxonomy branch — but they are DIFFERENT ANSWERS to
 * `validateCredential`, and telling a user their key is invalid when they never configured one sends
 * them to debug the wrong thing entirely. It rides `providerCode` because that field is exactly "a
 * finer, machine-readable code beneath the coarse taxonomy", and it is Winter-namespaced so it can
 * never collide with a code AWS returns.
 */
export const WINTER_CREDENTIAL_MISSING = "WinterCredentialMissing";

/** A credential refusal, typed as `auth` so it lands on the same taxonomy branch as a rejected key. NEVER retryable: no amount of backoff produces a credential. */
function credentialRefusal(message: string, missing = false): ProviderRequestError {
  return new ProviderRequestError({ code: "auth", message, retryable: false, ...(missing ? { providerCode: WINTER_CREDENTIAL_MISSING } : {}) });
}

/**
 * Resolves the context's credential ref into AWS signing material.
 *
 * EVERY FAILURE MESSAGE IS BUILT FROM A LOCATOR, never from a value: `redactRef` renders the ref
 * (which is addressing information and is what makes the message actionable) and `redactMaterial`
 * renders a wrong-kind material as `***(kind)`. A credential error message is one of the most
 * reliably-logged strings in any system.
 */
export async function resolveAwsCredentials(ctx: ProviderContext): Promise<AwsSigningCredentials> {
  const ref: CredentialRef = ctx.authRef;

  if (ref.kind === "none") {
    throw credentialRefusal(
      "Bedrock requires AWS credentials and this session's provider is configured with no credential reference; set `provider.authRef` to `{ kind: \"aws-default-chain\" }`, a `{ kind: \"file\", format: \"aws-shared-credentials\" }` ref, or a Keychain ref holding AWS material",
      true,
    );
  }

  if (ref.kind === "env") {
    // Refused BEFORE the store is asked, so the message can name the real fix. Asking first would
    // yield `{ kind: "api-key" }` and fall into the wrong-kind branch below, whose message is about
    // material rather than about the ref that would have worked.
    throw credentialRefusal(
      `Bedrock cannot use ${redactRef(ref)}: SigV4 needs an access key id, a secret and an optional session token, and an \`env\` reference names a single variable holding one opaque value. Use \`{ kind: "aws-default-chain" }\`, whose first link reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN`,
    );
  }

  if (ref.kind === "file" && ref.format !== "aws-shared-credentials") {
    throw credentialRefusal(`Bedrock cannot use ${redactRef(ref)}: the only file format that carries AWS signing material is "aws-shared-credentials"`);
  }

  let material: CredentialMaterial | null;
  try {
    material = await ctx.credentials.get(ref);
  } catch (err) {
    // A store's own typed failure (unsupported kind, malformed file, IO) already carries a redacted,
    // locator-only message; it is re-wrapped rather than replaced so the taxonomy is `auth` while the
    // diagnosis survives.
    throw credentialRefusal(`Bedrock could not resolve ${redactRef(ref)}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (material === null) {
    throw credentialRefusal(
      `Bedrock found no credential at ${redactRef(ref)}${ref.kind === "aws-default-chain" ? " — neither the AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY environment pair nor a shared credentials file provided one (this phase does not use IMDS or STS)" : ""}`,
      true,
    );
  }

  if (material.kind !== "aws") {
    throw credentialRefusal(`Bedrock needs AWS signing material, but ${redactRef(ref)} resolved to ${redactMaterial(material)}`);
  }

  // Structurally present but empty is the same failure as absent, and it is worth checking here: an
  // empty secret produces a perfectly well-formed signature that AWS rejects with a message about
  // the signature rather than about the credential.
  if (material.accessKeyId.length === 0 || material.secretAccessKey.length === 0) {
    throw credentialRefusal(`the AWS credential at ${redactRef(ref)} is incomplete: both an access key id and a secret access key are required`);
  }

  return {
    accessKeyId: material.accessKeyId,
    secretAccessKey: material.secretAccessKey,
    ...(material.sessionToken !== undefined && material.sessionToken.length > 0 ? { sessionToken: material.sessionToken } : {}),
  };
}

/**
 * The region this connection signs for.
 *
 * A HARD REQUIREMENT with no default, and that is a security property rather than pedantry: the
 * region is part of the credential SCOPE, so a wrong one is not a routing mistake but a signature
 * that will not verify — and a silent `us-east-1` default would send a European operator's requests,
 * and their data, to a jurisdiction they never chose. R6-16 puts the region in the connection
 * profile; absent, the session refuses to start rather than guessing.
 */
export function requireRegion(ctx: ProviderContext): string {
  const region = ctx.connection.region;
  if (region === undefined || region.trim().length === 0) {
    throw new ProviderRequestError({
      code: "capability",
      message: `the Bedrock connection for provider "${ctx.connection.providerId}" declares no region; set \`provider.connection.region\` (Winter never defaults an AWS region — it is part of the credential scope and of where the request is served)`,
      retryable: false,
    });
  }
  // Bounded and charset-checked because it is interpolated into a HOSTNAME and into the credential
  // scope. An unvalidated value here is a request to an attacker-named host.
  if (!/^[a-z0-9-]{1,32}$/.test(region)) {
    throw new ProviderRequestError({
      code: "capability",
      message: `the Bedrock connection declares region "${region}", which is not a well-formed AWS region name`,
      retryable: false,
    });
  }
  return region;
}
