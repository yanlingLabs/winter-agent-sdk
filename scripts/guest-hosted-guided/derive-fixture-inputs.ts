// @ts-nocheck -- a derivation tool, not a build input: its imports resolve inside two checkouts passed on the command line.
/** Derives `fixture-inputs.json` for the guided hosted run from REVIEWED UPSTREAM CODE, never from invented records.
 *
 *   bun scripts/guest-hosted-guided/derive-fixture-inputs.ts <winter checkout at the run-2 pin's winter head> <runtime-sdk entries dir> <out file>
 *
 * Winter Core's own classes (CoworkRepository, RuntimeSessionRecords, the guest supervisor and owner registry, the guided reader adapter)
 * create the records the host client's planner reads, exactly the way Core's guided-reader-adapter test fixture does; the result is dumped
 * as data. The host client's own `buildFixtureRecords` and Core's real guided handler then run over the dumped data (JSON round trip) and
 * the stub's marker lines are read from what Core actually produced for the old and for the edited guidance. Nothing here is a guess:
 * a missing or refused step throws and no file is written.
 *
 * Root-chosen names (the same constants session.py uses): workspace "workspace", incarnation "incarnation", lease 1, logical session
 * "guided-hosted", backend session id, source folder grant "source" (guest root /workspace/folders/source). Run-bound values the kernel
 * decides (the boot id) are written as a placeholder and replaced by session.py at open; the launch id is Core's random uuid, fixed to
 * a constant because nothing on the host path reads it. This tool is not run by CI and not by the workflow. */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [winter, entries, out] = process.argv.slice(2);
if (!winter || !entries || !out) throw new Error("usage: derive-fixture-inputs.ts <winter> <entries dir> <out>");
async function main(): Promise<void> {
const load = (path: string) => import(join(winter, "packages/core", path));

const LOGICAL = "guided-hosted", BACKEND = "01234567-89ab-4cde-8fab-0123456789a0", MODEL = "openai/gpt-5.6";
const BOOT_PLACEHOLDER = "00000000-0000-4000-8000-000000000000", LAUNCH_ID = "00000000-0000-4000-8000-000000000001", READER_REGISTRATION = "00000000-0000-4000-8000-000000000002";
const CLOCK = "2026-10-19T00:00:00.000Z";
const GUIDANCE = {
  old: "Guided hosted run guidance, first version.\nThe shared guidance marker is ALPHA.\n",
  edited: "Guided hosted run guidance, second version.\nThe shared guidance marker is BRAVO.\n",
};
const PROMPTS = ["Answer with the first scripted reply.", "Answer with the second scripted reply."];
const RESPONSES = ["first deterministic answer", "second deterministic answer"];

const { CoworkRepository } = await load("src/cowork/repository.ts");
const { CoworkAuthority } = await load("src/cowork/authority.ts");
const { CoworkGuestRuntimeSupervisor } = await load("src/cowork/guest-runtime.ts");
const { CoworkGuestContextOwners, captureCoworkGuestOwner, COWORK_GUEST_OWNER_READER_LIMITS } = await load("src/cowork/guest-context-owner.ts");
const { COWORK_SHARED_INSTRUCTION_VIEW } = await load("src/cowork/current-context-resolver.ts");
const { coworkGuestSourceRoot } = await load("src/cowork/guest-paths.ts");
const { createCoworkGuidedRuntimeContextHandler } = await load("src/cowork/guided-reader-adapter.ts");
const { openRuntimeStateDb } = await load("src/runtime-state/db.ts");
const { RuntimeSessionRecords } = await load("src/runtime-state/records.ts");
const { authorityFixtureSessions } = await import(join(winter, "packages/core/test/cowork/committed-sessions.ts"));
const host = await import(join(entries, "host-client-core.ts"));

const caps = { toolClasses: ["read", "write", "execute"], hostServices: [], connectors: [], network: "none" };
const home = mkdtempSync(join(tmpdir(), "winter-guided-fixture-inputs-"));
const db = openRuntimeStateDb(home);
try {
  let mint = 0;
  const records = new CoworkRepository(db, () => CLOCK, (prefix: string) => prefix === "home" ? "home-fixture" : prefix === "workspace" ? "workspace" : `${prefix}_${++mint}`);
  const workspaceId = records.create({ principalId: "fixture", requestId: "create" }, {
    ownership: "project", title: "guided hosted run", ceiling: caps, defaultPolicy: "ask",
    sources: [{ kind: "folder", label: "source", access: "read-write", detail: { grantRef: "source", rootIdentity: "guided-hosted-root-identity" } }],
  }).workspaceId;
  if (workspaceId !== "workspace") throw new Error("workspace id");
  const source = records.sources(workspaceId)[0], root = coworkGuestSourceRoot(source);
  if (root !== "/workspace/folders/source") throw new Error("source root");
  const epoch = records.beginIncarnation(workspaceId, "incarnation", 1);
  if (epoch.leaseEpoch !== 1) throw new Error("lease epoch");
  records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  const sessions = new RuntimeSessionRecords(db, () => CLOCK);
  records.bindConversation({ principalId: "fixture", requestId: `bind-${LOGICAL}`, expectedRevision: records.get(workspaceId).configRevision }, workspaceId,
    { sessionId: LOGICAL, sourceId: source.sourceId, relativeCwd: "." }, authorityFixtureSessions(LOGICAL));
  sessions.create({ winterSessionId: LOGICAL, runtimeKind: "winter-agent", backendSessionId: BACKEND, providerId: "openai", modelRef: MODEL,
    backendRoot: "/private/protected/backend", transcriptProjectKey: "private-key", memoryProjectKey: "private-key", tempProjectKey: "private-key",
    transcriptHealth: "clean", compatibilityLevel: "full-filesystem", conformanceCorpusVersion: "fixture", versionProvenance: "legacy-unknown", capabilities: [],
    selection: { runtimeKind: "winter-agent", providerId: "openai", modelRef: MODEL, family: "openai", authFamily: "api-key", sdkVersion: "fixture", reason: "guided hosted run", decidedAt: CLOCK } });
  sessions.transition(LOGICAL, "ready"); sessions.bumpGeneration(LOGICAL, { runtimeKind: "winter-agent", backendSessionId: BACKEND }); sessions.transition(LOGICAL, "running");

  const grants = { folder: (ref: string) => ref === "source" ? { rootIdentity: source.detail.rootIdentity, writable: true, revoked: false } : undefined,
    repository: () => undefined };
  const authority = new CoworkAuthority(records, grants);
  const supervisor = new CoworkGuestRuntimeSupervisor({ records, authority, identity: () => ({ backendSessionId: BACKEND, model: "winter-test/echo", resume: false }), bootId: () => BOOT_PLACEHOLDER,
    runtimeCapability: { protocolVersion: 1, capabilities: ["confined-guest-posture-v1"], supportsConfinedGuestExecution: true }, port: { open() { throw new Error("the fixture port is never opened"); } } });
  const deps = { records, bootId: () => BOOT_PLACEHOLDER };
  const BINDING = "guided-hosted-binding";
  const evidence = { evidence: (capture: any) => ({ profile: "host-query-guided-v1", registrationId: READER_REGISTRATION, launchId: capture.launchId, bindingId: BINDING,
    kernel: { pidfs: true, peerPidfd: true }, owner: { workspaceId: capture.workspaceId, logicalSessionId: capture.sessionId, backendSessionId: capture.backendSessionId,
      incarnationId: capture.incarnationId, leaseEpoch: capture.leaseEpoch, bootId: capture.bootId, generation: capture.backendGeneration } }) };
  const registry = new CoworkGuestContextOwners({ ...deps, evidence });
  const plan = { registrationId: READER_REGISTRATION, views: { sourceRoot: root, sourceCwd: root, sharedRoot: COWORK_SHARED_INSTRUCTION_VIEW, sharedPath: `${COWORK_SHARED_INSTRUCTION_VIEW}/WINTER.md` }, limits: { ...COWORK_GUEST_OWNER_READER_LIMITS } };
  const capture = captureCoworkGuestOwner(deps, supervisor.prepareQuery(LOGICAL).launch, plan);
  const owner = registry.prepare(capture); owner.bindCorrelation({ version: 1, bindingId: BINDING }); owner.attachLifetime({ held: () => true });
  const registration = owner.registrationPort(capture.trustedQuerySessionId);
  if (!registration) throw new Error("registration");

  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const row = db.db.query("SELECT * FROM runtime_sessions WHERE winter_session_id = ?").get(LOGICAL);
  const fixture = {
    registration: plain(registration), capture: { ...plain(capture), launchId: LAUNCH_ID }, runtimeRow: plain(row), workspace: plain(records.get(workspaceId)),
    binding: plain(records.binding(LOGICAL)), policy: plain(records.policy(workspaceId)), sources: plain(records.sources(workspaceId)),
    grants: { folder: { source: grants.folder("source") }, repository: {} }, bootId: BOOT_PLACEHOLDER,
  };

  // ---- run Core's real guided handler over the DUMPED data, through the host client's own record builder.
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const sharedPath = `${COWORK_SHARED_INSTRUCTION_VIEW}/WINTER.md`;
  async function context(text: string) {
    const built = host.buildFixtureRecords(plain(fixture));
    const block = { requestedPath: sharedPath, admittedPath: sharedPath, text, textSha256: sha(text), tier: "workspace" };
    const rendered = `# ${block.requestedPath}\n\n${block.text}`;
    const snapshot = { blocks: [block], digest: sha(rendered), droppedImports: [], files: [{ path: sharedPath, tier: "workspace", sha256: block.textSha256, imported: false }],
      provenance: [{ ...block, depth: 0 }], skippedLinks: [], text: rendered, tiers: "admitted-only" };
    const frame = { version: 1, readId: "00000000-0000-4000-8000-0000000000aa", owner: { logicalSessionId: LOGICAL, backendSessionId: BACKEND, incarnationId: "incarnation", leaseEpoch: 1, bootId: BOOT_PLACEHOLDER, generation: 1 },
      views: { ...fixture.capture.views }, limits: { ...fixture.capture.limits }, snapshot };
    const handler = createCoworkGuidedRuntimeContextHandler({ records: built.records, grants: built.grants, currentBootId: built.currentBootId, registration: built.registration, capture: fixture.capture,
      frames: { readFrame: async () => `${JSON.stringify(frame)}\n` } });
    const signal = new AbortController().signal;
    return await handler({ bindingId: BINDING, sessionId: BACKEND, cwd: root, purpose: "generation", attempt: 1 }, { signal, trustedQuerySessionId: BACKEND });
  }
  const before = await context(GUIDANCE.old), after = await context(GUIDANCE.edited);
  const lines = (text: string) => text.split(/\r?\n/);
  if (process.env.DERIVE_SHOW === "1") console.error(JSON.stringify({ facts: before.facts, instructions: before.instructions, edited: after.instructions }, null, 1));
  // System markers: lines of the host FACTS (the engine renders them under "# Current workspace context" in `system`, required-context.ts).
  // User markers: lines of the INSTRUCTIONS (rendered under "# claudeMd" in message 0). Both are read from Core's real output.
  const facts = lines(before.facts), instructions = lines(before.instructions), editedInstructions = lines(after.instructions);
  if (before.facts !== after.facts) throw new Error("facts changed with the guidance");
  const pick = (all: string[], test: RegExp, what: string) => { const found = all.filter(line => test.test(line)); if (found.length !== 1) throw new Error(`marker ${what}: ${found.length}`); return found[0]; };
  const systemMarkers = [pick(facts, /^Cowork current host context/, "host fact"), pick(facts, /^Source .* admitted at \/workspace\/folders\/source; read-write\.$/, "source root"),
    pick(facts, /^Completion default: /, "publication obligation")];
  if (!(facts.indexOf(systemMarkers[0]) < facts.indexOf(systemMarkers[1]) && facts.indexOf(systemMarkers[1]) < facts.indexOf(systemMarkers[2]))) throw new Error("system marker order");
  const userMarkers = (all: string[], version: string, word: string) => [pick(all, new RegExp(`^Guided hosted run guidance, ${version} version\\.$`), `${version} version line`), pick(all, new RegExp(`marker is ${word}\\.$`), `${word} marker`)];
  const oldUser = userMarkers(instructions, "first", "ALPHA"), newUser = userMarkers(editedInstructions, "second", "BRAVO");
  if (oldUser.some(line => editedInstructions.includes(line)) || newUser.some(line => instructions.includes(line))) throw new Error("guidance markers overlap");
  const steps = [
    { system: systemMarkers, user: oldUser, absentSystem: [], absentUser: newUser, response: RESPONSES[0] },
    { system: systemMarkers, user: newUser, absentSystem: [], absentUser: oldUser, response: RESPONSES[1] },
  ];
  const result = { version: 1, prompts: PROMPTS, guidance: GUIDANCE, steps, hostFixture: fixture };
  writeFileSync(out, `${JSON.stringify(result)}\n`);
  console.log(JSON.stringify({ facts: before.facts, instructionsOld: before.instructions, instructionsEdited: after.instructions }, null, 1));
} finally {
  try { db.close(); } catch { /* closed */ }
  rmSync(home, { recursive: true, force: true });
}
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
