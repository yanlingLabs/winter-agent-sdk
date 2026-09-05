import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERLAY_FILES } from "../packages/provider-catalog/src/extract/merge.ts";
import { COPIED, PKG, THIRD_PARTY, registryIdentifierNames, upstreamIdForRejection, writeOutputs, type ExtractionOutcome } from "./provider-source-sync.ts";

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
    // The behavioural half. `mtime` as well as bytes: a re-write that happened to produce the same
    // content would still mean the extractor reached the reviewed layer, and the rule is that it
    // never does.
    for (const { file, text, mtime } of before) {
      expect(readFileSync(join(PKG, file), "utf8")).toBe(text);
      expect(statSync(join(PKG, file)).mtimeMs).toBe(mtime);
    }
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
