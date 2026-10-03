// Zero changed decisions: every output of the rule grammar, the file-rule pipeline and the path
// predicates, recomputed from the current code, must equal the output recorded in
// `__fixtures__/rule-corpus.json` (see `rule-corpus.test-support.ts` for what is recorded and how).
//
// The corpus was recorded from the implementation that preceded the clean-room rewrite of these
// modules. A failure here means a decision changed: either a regression, or a deliberate behaviour
// change -- which must then re-record the corpus in the same commit and say so.
//
// It was recorded on macOS, and a few answers depend on the host rather than the code: which system
// symlinks exist (`canonicalizeTrustedSymlinkPath`, see `TRUSTED_SYMLINK_REAL_DIRECTORIES`), whether
// the volume folds case, and what the host's own root directory holds. On macOS every recorded answer
// is asserted. Elsewhere, a path at or below a trusted real directory is checked with the recording
// host's `trustedAlias` in place of this host's (`pathOutputAsOnRecordingHost`), so all its other
// answers are still compared; and the filesystem keys `hostDependentFsKeys` names (case folding, the
// host's root) are left out. Everything else is asserted unchanged.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as evaluator from "./evaluator.ts";
import * as fileRules from "./file-rules.ts";
import * as grammar from "./grammar.ts";
import * as paths from "./paths.ts";
import {
  canon,
  computeCorpus,
  corpusSize,
  CURATED_FILE_PATTERNS,
  CURATED_PATHS,
  CURATED_RULE_STRINGS,
  digest,
  hostDependentFsKeys,
  pathOutputAsOnRecordingHost,
  RANDOM_COUNTS,
  randomFilePatterns,
  randomGroups,
  randomPaths,
  randomResolutionPairs,
  randomRuleStrings,
  reachesTrustedSymlinkDirectory,
  trustedAliasOnRecordingHost,
  type CorpusModules,
  type RecordedCorpus,
} from "./rule-corpus.test-support.ts";

const recorded = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "rule-corpus.json"), "utf8")) as RecordedCorpus;
const modules = { grammar, fileRules, paths, evaluator } as unknown as CorpusModules;

/** The host the corpus was recorded on; elsewhere the host-dependent answers are left out (see the header). */
const RECORDING_HOST = process.platform === "darwin";

function noteSkipped(what: string, count: number): void {
  if (count > 0) console.log(`rule corpus: ${count} ${what} depend on the host and are not asserted on ${process.platform}`);
}

/** A curated output as compared on this host: off macOS, a path's host-dependent `trustedAlias` is the recording host's. */
function comparable(key: string, output: unknown): unknown {
  if (RECORDING_HOST || !key.startsWith("path:") || !reachesTrustedSymlinkDirectory(key.slice("path:".length))) return output;
  return pathOutputAsOnRecordingHost(modules, key.slice("path:".length), false);
}

let current: RecordedCorpus;
beforeAll(() => {
  current = computeCorpus(modules, recorded.inputs);
}, 120_000);

/** The inputs behind each random section, regenerated so a mismatch can name the input. */
function randomInputsOf(section: string): unknown[] {
  switch (section) {
    case "harvestedRules":
    case "harvestedPatterns":
    case "harvestedPaths":
    case "harvestedSandbox":
      return recorded.inputs.harvested;
    case "rules":
      return randomRuleStrings(RANDOM_COUNTS.rules);
    case "patterns":
      return randomFilePatterns(RANDOM_COUNTS.patterns);
    case "groups":
      return randomGroups(RANDOM_COUNTS.groups, [...CURATED_FILE_PATTERNS, ...randomFilePatterns(RANDOM_COUNTS.patterns).slice(0, 400)]);
    case "paths":
      return randomPaths(RANDOM_COUNTS.paths);
    case "globs":
      return randomFilePatterns(RANDOM_COUNTS.globs, 6);
    case "resolutionPairs":
      return randomResolutionPairs(RANDOM_COUNTS.resolutionPairs);
    default:
      return [];
  }
}

describe("the rule corpus recorded before the clean-room rewrite", () => {
  test("covers what it claims to (a guard against a corpus that silently shrank)", () => {
    const size = corpusSize(recorded);
    expect(size.full).toBe(CURATED_RULE_STRINGS.length + 2 * CURATED_FILE_PATTERNS.length + CURATED_PATHS.length);
    expect(size.random).toBeGreaterThan(40_000);
    expect(size.exhaustive).toBeGreaterThan(1_000_000);
    expect(size.fs).toBeGreaterThan(200);
    expect(recorded.inputs.harvested.length).toBeGreaterThan(5_000);
  });

  test("curated inputs: every recorded output is unchanged", () => {
    const changed = Object.keys(recorded.full).filter((key) => canon(comparable(key, current.full[key])) !== canon(recorded.full[key]));
    for (const key of changed.slice(0, 5)) {
      expect({ key, now: comparable(key, current.full[key]) }).toEqual({ key, now: recorded.full[key] });
    }
    expect(changed).toEqual([]);
    expect(Object.keys(current.full).sort()).toEqual(Object.keys(recorded.full).sort());
  });

  for (const section of Object.keys(RANDOM_COUNTS).concat(["harvestedRules", "harvestedPatterns", "harvestedPaths", "harvestedSandbox"])) {
    test(`random and harvested inputs, section ${section}: every recorded digest is unchanged`, () => {
      const was = recorded.random[section]!;
      const now = current.random[section]!;
      expect(now.length).toBe(was.length);
      const inputs = randomInputsOf(section);
      // The path sections' digests include `trustedAlias`; off macOS such a row is recomputed with the
      // recording host's alias in place of this host's.
      const recompute = (i: number): boolean => !RECORDING_HOST && (section === "paths" || section === "harvestedPaths") && reachesTrustedSymlinkDirectory(inputs[i] as string);
      const nowHere = (i: number): string => (recompute(i) ? digest(canon(pathOutputAsOnRecordingHost(modules, inputs[i] as string, false))) : now[i]!);
      const changed = was.flatMap((d, i) => (nowHere(i) === d ? [] : [{ index: i, input: inputs[i] }]));
      expect(changed.slice(0, 10)).toEqual([]);
    });
  }

  for (const section of ["rules", "patterns", "paths", "boundary"]) {
    test(`exhaustive enumeration, section ${section}: same count and same digest`, () => {
      expect(current.exhaustive[section]).toEqual(recorded.exhaustive[section]!);
    });
  }

  test.skipIf(!RECORDING_HOST)("on the recording host, its trustedAlias stand-in agrees with the implementation for every path input", () => {
    const inputs = [...CURATED_PATHS, ...randomPaths(RANDOM_COUNTS.paths), ...recorded.inputs.harvested].filter(reachesTrustedSymlinkDirectory);
    expect(inputs.length).toBeGreaterThan(400);
    const disagreeing = inputs.filter((p) => trustedAliasOnRecordingHost(p) !== fileRules.canonicalizeTrustedSymlinkPath(p));
    expect(disagreeing).toEqual([]);
  });

  test("filesystem fixture (symlink chains, plugin-root fence, prefix canonicalisation): every answer unchanged", () => {
    const hostDependent = RECORDING_HOST ? new Map<string, string>() : hostDependentFsKeys(Object.keys(recorded.fs));
    noteSkipped("filesystem answers (case folding, the host's root)", hostDependent.size);
    const changed = Object.keys(recorded.fs).filter((key) => !hostDependent.has(key) && canon(current.fs[key]) !== canon(recorded.fs[key]));
    for (const key of changed.slice(0, 5)) {
      expect({ key, now: current.fs[key] }).toEqual({ key, now: recorded.fs[key] });
    }
    expect(changed).toEqual([]);
  });
});
