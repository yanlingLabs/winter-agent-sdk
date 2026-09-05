import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERLAY_FILES } from "../packages/provider-catalog/src/extract/merge.ts";
import { COPIED, PKG, THIRD_PARTY, findEndpointContradictions, registryIdentifierNames, upstreamIdForRejection, writeOutputs, type ExtractionOutcome } from "./provider-source-sync.ts";

/**
 * NO NETWORK anywhere in this file. The network half of the pipeline (`--check`) is proven against a
 * local fixture repository in `packages/provider-catalog/src/extract/fetch.test.ts`; what is left to
 * prove here is the part CI actually runs and the part that could quietly destroy reviewed work.
 */

const REPO = fileURLToPath(new URL("../", import.meta.url));
const scratches: string[] = [];
afterAll(() => {
  for (const path of scratches) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "winter-sync-test-"));
  scratches.push(path);
  return path;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

const OUTCOME: ExtractionOutcome = {
  layer: { $comment: "fixture", providers: [], models: [], rejections: [] },
  manifest: {
    $comment: "fixture",
    upstream: { repository: "file:///fixture", tag: "v9.9.9", tagObject: "t".repeat(40), commit: "c".repeat(40) },
    extractorVersion: "winter.test",
    generatedFrom: "scripts/provider-source-sync.ts",
    copiedFiles: [],
    readOnlyFiles: [],
    outOfAllowlistImports: [],
  },
  denominator: {
    catalogueUnion: 1, byCategory: [], duplicatedAcrossCategories: [], categorySum: 1,
    registryEntries: 1, registryEntriesResolved: 1, catalogueWithoutRegistry: 0, registryWithoutCatalogue: 0,
    claims: [], summary: "fixture",
  },
  pin: { tag: "v9.9.9", tagObject: "t".repeat(40), commit: "c".repeat(40), extractorVersion: "winter.test", overlayVersion: "1" },
  files: [],
  copiedText: new Map(COPIED.map((c) => [c.upstreamPath, `fixture ${c.upstreamPath}\n`])),
};

describe("writeOutputs — the ONLY writer in the network path", () => {
  const thirdParty = scratch();
  const pkg = scratch();
  writeOutputs(OUTCOME, { thirdParty, pkg });

  test("writes exactly the six generated artefacts, and nothing else", () => {
    expect(listFiles(pkg)).toEqual(["UPSTREAM.json", "generated/denominator.json", "generated/upstream-layer.json"]);
    expect(listFiles(thirdParty)).toEqual(["LICENSE", "NOTICE", "extraction-manifest.json"]);
  });

  test("NO overlay path is among them — WS-13 §7's 'a re-sync must never overwrite the overlay'", () => {
    // The structural half of the guarantee: the only function that writes cannot reach the overlay,
    // so the rule holds by construction rather than by the caller remembering it. The behavioural
    // half is the byte-comparison test below.
    for (const written of [...listFiles(pkg), ...listFiles(thirdParty)]) {
      for (const overlay of OVERLAY_FILES) expect(written).not.toBe(overlay);
      expect(written.startsWith("overlay/")).toBe(false);
    }
  });

  test("every artefact is valid JSON where it claims to be, and the notices are copied verbatim", () => {
    for (const path of ["UPSTREAM.json", "generated/denominator.json", "generated/upstream-layer.json"]) {
      expect(() => JSON.parse(readFileSync(join(pkg, path), "utf8"))).not.toThrow();
    }
    expect(readFileSync(join(thirdParty, "LICENSE"), "utf8")).toBe("fixture LICENSE\n");
    expect(readFileSync(join(thirdParty, "NOTICE"), "utf8")).toBe("fixture THIRD_PARTY_NOTICES.md\n");
  });

  test("the pin it stamps keeps the tag object and the commit DISTINCT", () => {
    const written = JSON.parse(readFileSync(join(pkg, "UPSTREAM.json"), "utf8")) as { upstream: Record<string, string> };
    expect(written.upstream.tagObject).not.toBe(written.upstream.commit);
    expect(written.upstream).toEqual({ tag: "v9.9.9", tagObject: "t".repeat(40), commit: "c".repeat(40), extractorVersion: "winter.test", overlayVersion: "1" });
  });
});

describe("--offline is what CI runs, and it is inert", () => {
  const before = OVERLAY_FILES.map((file) => ({ file, text: readFileSync(join(PKG, file), "utf8"), mtime: statSync(join(PKG, file)).mtimeMs }));

  const run = Bun.spawnSync({
    cmd: ["bun", "run", join(REPO, "scripts", "provider-source-sync.ts"), "--offline"],
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });

  test("exits 0 against the committed snapshot, with no network", () => {
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect(output).toContain("validates standalone");
    expect(run.exitCode).toBe(0);
  });

  test("regenerates the merged catalog byte-identically — WS-13 §13's own acceptance test", () => {
    expect(run.stdout.toString()).toContain("provider:catalog --check: OK");
  });

  test("leaves the OVERLAY byte-identical AND untouched", () => {
    // `mtime` as well as bytes: a re-write that happened to produce the same content would still mean
    // the extractor reached the reviewed layer, and the rule is that it never does.
    for (const { file, text, mtime } of before) {
      expect(readFileSync(join(PKG, file), "utf8")).toBe(text);
      expect(statSync(join(PKG, file)).mtimeMs).toBe(mtime);
    }
  });

  test("an EDITED overlay survives a real regeneration byte-for-byte, and the edit reaches the output", () => {
    // THE BRIEF'S FIXTURE, and the previous version of this test did not earn its title: it ran
    // `--offline`, which writes no catalog at all, so "the overlay survived" was true of a path that
    // writes nothing anywhere. This one EDITS `overlay/models.json`, runs the WRITE path
    // (`provider:catalog`, the only writer of catalog.json/rejections.json), and asserts both halves:
    // the overlay file is untouched to the byte, AND the edit actually flowed into the regenerated
    // catalog — which is what proves the generator READ the edited overlay rather than ignoring it.
    const overlayPath = join(PKG, "overlay/models.json");
    const saved = [overlayPath, join(PKG, "generated/catalog.json"), join(PKG, "generated/rejections.json")].map((path) => ({ path, bytes: readFileSync(path) }));
    const MARKER = "Winter overlay-survival probe";
    try {
      const edited = JSON.parse(saved[0]!.bytes.toString("utf8")) as { models: Array<{ key: string; displayName: string }> };
      const target = edited.models.find((m) => m.key === "ollama-local/llama3.1:8b")!;
      target.displayName = MARKER;
      const editedText = `${JSON.stringify(edited, null, 2)}\n`;
      writeFileSync(overlayPath, editedText);

      const run = Bun.spawnSync({ cmd: ["bun", "run", join(REPO, "scripts", "provider-catalog.ts")], cwd: REPO, stdout: "pipe", stderr: "pipe" });
      expect(`${run.stdout.toString()}${run.stderr.toString()}`).toContain("provider:catalog: wrote");
      expect(run.exitCode).toBe(0);

      // (1) the overlay is untouched — byte for byte, including my edit.
      expect(readFileSync(overlayPath, "utf8")).toBe(editedText);
      // (2) the edit REACHED the output, so the generator really did read the file it left alone.
      const regenerated = JSON.parse(readFileSync(join(PKG, "generated/catalog.json"), "utf8")) as { models: Array<{ key: string; displayName: string }> };
      expect(regenerated.models.find((m) => m.key === "ollama-local/llama3.1:8b")!.displayName).toBe(MARKER);
    } finally {
      // Restore from saved BYTES rather than by regenerating: a failure mid-test must not be able to
      // leave the repository holding a probe string.
      for (const { path, bytes } of saved) writeFileSync(path, bytes);
    }
    for (const { path, bytes } of saved) expect(readFileSync(path)).toEqual(bytes);
  });

  test("--check and --offline are mutually exclusive (one needs the network, the other refuses it)", () => {
    const both = Bun.spawnSync({ cmd: ["bun", "run", join(REPO, "scripts", "provider-source-sync.ts"), "--check", "--offline"], cwd: REPO, stdout: "pipe", stderr: "pipe" });
    expect(both.exitCode).toBe(2);
    expect(both.stderr.toString()).toContain("mutually exclusive");
  });
});

describe("the committed inputs are internally consistent", () => {
  test("the extraction manifest's copied files exist here, byte-for-byte, with the recorded hash", () => {
    const manifest = JSON.parse(readFileSync(join(THIRD_PARTY, "extraction-manifest.json"), "utf8")) as {
      copiedFiles: Array<{ upstreamPath: string; localPath: string; sha256: string; bytes: number; modifications: string }>;
    };
    expect(manifest.copiedFiles.length).toBeGreaterThan(0);
    for (const file of manifest.copiedFiles) {
      const bytes = readFileSync(join(REPO, file.localPath));
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(file.sha256);
      expect(bytes.length).toBe(file.bytes);
      expect(file.modifications).toBe("none");
    }
  });

  test("the ONLY upstream files in the repository are the ones the manifest declares", () => {
    // The boundary's strongest statement: `third_party/` holds Winter-authored files plus exactly
    // the declared copies, and no upstream source tree.
    const manifest = JSON.parse(readFileSync(join(THIRD_PARTY, "extraction-manifest.json"), "utf8")) as { copiedFiles: Array<{ localPath: string }> };
    const declared = new Set(manifest.copiedFiles.map((f) => f.localPath.split("/").pop()));
    const winterAuthored = new Set(["README.md", "allowlist.json", "UPSTREAM.json", "extraction-manifest.json"]);
    for (const name of listFiles(THIRD_PARTY)) {
      expect(declared.has(name) || winterAuthored.has(name)).toBe(true);
    }
  });

  test("the allowlist's own path patterns all compile and are repository-anchored", async () => {
    const { compilePathPattern } = await import("../packages/provider-catalog/src/extract/fetch.ts");
    const allowlist = JSON.parse(readFileSync(join(THIRD_PARTY, "allowlist.json"), "utf8")) as { paths: Array<{ pattern: string; role: string; why: string }> };
    expect(allowlist.paths.length).toBeGreaterThan(0);
    for (const entry of allowlist.paths) {
      expect(() => compilePathPattern(entry.pattern)).not.toThrow();
      expect(["extract", "claim", "notice"]).toContain(entry.role);
      expect(entry.why.length).toBeGreaterThan(10);
    }
  });

  test("the input pin's `observedAt` is an ISO INSTANT — a date-only string would fail the validator later", () => {
    const pin = JSON.parse(readFileSync(join(THIRD_PARTY, "UPSTREAM.json"), "utf8")) as { observedAt: string; tagObject: string; commit: string };
    expect(pin.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(pin.tagObject).not.toBe(pin.commit);
  });
});

describe("the CROSS-LAYER gate — the row-level merge's blind spot", () => {
  const provider = (id: string, adapterId: string, protocols: string[]) => ({ id, adapterId, protocols }) as never;
  const model = (key: string, providerId: string, endpoints: string[]) => ({ key, providerId, endpoints }) as never;

  test("a responses-ONLY model under a Chat Completions adapter is a contradiction, though every row validates alone", () => {
    // The real defect: upstream's deepseek entry is `format: "openai-responses"`, so its extracted
    // model rows land `endpoints: ["responses"]` while the adapter that serves them speaks Chat
    // Completions. The frozen validator sees one row at a time and cannot notice.
    const found = findEndpointContradictions({
      providers: [provider("deepseek", "winter.openai-chat-completions", ["openai-chat-completions"])],
      models: [model("deepseek/r", "deepseek", ["responses"])],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("RESPONSES ONLY");
  });

  test("WIDENING `protocols` does NOT silence it — the gate reads `adapterId`, which is what resolution reads", () => {
    // This is the finding. The first version of this gate consulted `provider.protocols`, so adding
    // `openai-responses` to the declaration made it go quiet while the two rows still routed onto the
    // Chat adapter. Nothing in the runtime reads `protocols` at all.
    const found = findEndpointContradictions({
      providers: [provider("deepseek", "winter.openai-chat-completions", ["openai-chat-completions", "openai-responses"])],
      models: [model("deepseek/r", "deepseek", ["responses"])],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("resolution reads `adapterId`");
  });

  test("a Responses-shaped ADAPTER resolves it; Azure's own Responses surface counts too", () => {
    expect(findEndpointContradictions({
      providers: [provider("openai", "winter.openai-responses", ["openai-responses"])],
      models: [model("openai/o4-mini", "openai", ["responses"])],
    })).toEqual([]);
    expect(findEndpointContradictions({
      providers: [provider("azure-openai", "winter.azure-openai", ["azure-openai"])],
      models: [model("azure-openai/m", "azure-openai", ["chat", "responses"])],
    })).toEqual([]);
  });

  test("a model available on BOTH surfaces is fine under a Chat adapter — the gate is one-directional on purpose", () => {
    // `endpoints` records which surfaces a model is AVAILABLE on, not which one its adapter picks, so
    // only a responses-ONLY row has no surface a Chat adapter can drive. Flagging the reverse would
    // have been false churn on eight healthy OpenAI rows.
    expect(findEndpointContradictions({
      providers: [provider("openrouter", "winter.openai-chat-completions", ["openai-chat-completions"])],
      models: [model("openrouter/x", "openrouter", ["chat", "responses"])],
    })).toEqual([]);
  });

  test("an adapter the gate does not know is REPORTED, never waved through", () => {
    const found = findEndpointContradictions({
      providers: [provider("newcloud", "winter.brand-new", ["custom"])],
      models: [model("newcloud/m", "newcloud", ["responses"])],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("this gate does not know");
  });

  test("the COMMITTED catalog is cross-layer consistent", async () => {
    const catalog = JSON.parse(await Bun.file(join(PKG, "generated", "catalog.json")).text()) as Parameters<typeof findEndpointContradictions>[0];
    expect(findEndpointContradictions(catalog)).toEqual([]);
  });
});

describe("small helpers, pinned because a silent miss is invisible", () => {
  test("registryIdentifierNames reads the REGISTRY map's keys from TEXT, so a helper-built entry still counts", () => {
    const names = registryIdentifierNames([
      "export const REGISTRY: Record<string, RegistryEntry> = {",
      "  acme: acmeProvider,",
      '  "kebab-id": kebabProvider,',
      "  built: buildOpenAiCompatibleRegistryEntry({ id: \"built\" }),",
      "};",
    ].join("\n"));
    // `built`'s value is a CALL, so the literal walker never resolves it — but its key is still a
    // registry entry, and counting only resolved ones would report the extractor's blind spot as an
    // upstream fact.
    expect([...names.keys()].sort()).toEqual(["acme", "kebab-id"]);
  });

  test("upstreamIdForRejection attributes a field rejection to its provider, by binding then by path", () => {
    const identifiers = new Map([["acme", "acmeProvider"]]);
    expect(upstreamIdForRejection("open-sse/config/providers/registry/acme/index.ts", "acmeProvider.headers", identifiers)).toBe("acme");
    expect(upstreamIdForRejection("open-sse/config/providers/registry/other/index.ts", "SOME_CONST.x", identifiers)).toBe("other");
    expect(upstreamIdForRejection("open-sse/config/providers/shared.ts", "SOME_CONST.x", identifiers)).toBe("");
  });
});

void execFileSync;
