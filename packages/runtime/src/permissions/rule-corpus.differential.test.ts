// Zero changed decisions: every output of the rule grammar, the file-rule pipeline and the path
// predicates, recomputed from the current code, must equal the output recorded in
// `__fixtures__/rule-corpus.json` (see `rule-corpus.test-support.ts` for what is recorded and how).
//
// The corpus was recorded from the implementation that preceded the clean-room rewrite of these
// modules. A failure here means a decision changed: either a regression, or a deliberate behaviour
// change -- which must then re-record the corpus in the same commit and say so.
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
  RANDOM_COUNTS,
  randomFilePatterns,
  randomGroups,
  randomPaths,
  randomResolutionPairs,
  randomRuleStrings,
  type CorpusModules,
  type RecordedCorpus,
} from "./rule-corpus.test-support.ts";

const recorded = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "rule-corpus.json"), "utf8")) as RecordedCorpus;
const modules = { grammar, fileRules, paths, evaluator } as unknown as CorpusModules;

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
    const changed = Object.keys(recorded.full).filter((key) => canon(current.full[key]) !== canon(recorded.full[key]));
    for (const key of changed.slice(0, 5)) {
      expect({ key, now: current.full[key] }).toEqual({ key, now: recorded.full[key] });
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
      const changed = was.flatMap((d, i) => (now[i] === d ? [] : [{ index: i, input: inputs[i] }]));
      expect(changed.slice(0, 10)).toEqual([]);
    });
  }

  for (const section of ["rules", "patterns", "paths", "boundary"]) {
    test(`exhaustive enumeration, section ${section}: same count and same digest`, () => {
      expect(current.exhaustive[section]).toEqual(recorded.exhaustive[section]!);
    });
  }

  test("filesystem fixture (symlink chains, plugin-root fence, prefix canonicalisation): every answer unchanged", () => {
    const changed = Object.keys(recorded.fs).filter((key) => canon(current.fs[key]) !== canon(recorded.fs[key]));
    for (const key of changed.slice(0, 5)) {
      expect({ key, now: current.fs[key] }).toEqual({ key, now: recorded.fs[key] });
    }
    expect(changed).toEqual([]);
  });
});
