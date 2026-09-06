// Phase 6 Task 10: the CI workflow is a DELIVERABLE, so it gets a tripwire like every other one.
//
// Three of this phase's obligations live entirely in `.github/workflows/ci.yml`, and a YAML file has
// no compiler:
//
//   1. `provider:catalog -- --check` — the byte-identical-regeneration gate (WS-13 §13). Without it a
//      hand-edited `generated/catalog.json` ships and nothing notices until the next regeneration
//      silently reverts someone's edit.
//   2. `provider:sync -- --offline` — Lane X's no-network re-validation of the committed upstream
//      layer. The NETWORK forms are maintainer actions; a CI step that cloned an upstream release on
//      every push would make the gate depend on a third party's availability.
//   3. The opt-in LIVE provider gate is EXPLICITLY ABSENT. `scripts/verify-provider-live.ts` needs
//      real credentials and spends real money; "we simply never added it" and "we decided it must
//      never be added" look identical in a YAML file, and only one of them survives the next person
//      who notices an unused script.
//
// Absence is the one that genuinely needs a test: a step that should be there fails loudly the first
// time CI runs, while a step that should NOT be there fails only in a way that costs money.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CI_YML = readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
const ROOT_PACKAGE_JSON = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  scripts: Record<string, string>;
};

/** Only the `run:` command lines — a mention inside a `#` comment is documentation, never a gate. */
function ciRunCommands(): string[] {
  return CI_YML.split("\n")
    .map((line) => {
      const match = /^\s*-\s*run:\s*(.*)$/.exec(line);
      if (match === null) return undefined;
      // Strip a trailing `#` comment: this file's own steps carry long ones.
      return (match[1] ?? "").split("#")[0]?.trim();
    })
    .filter((cmd): cmd is string => cmd !== undefined && cmd.length > 0);
}

describe("Phase 6 Task 10: the CI gates", () => {
  test("`provider:sync` is a root package script pointing at Lane X's pipeline", () => {
    expect(ROOT_PACKAGE_JSON.scripts["provider:sync"]).toBe("bun run scripts/provider-source-sync.ts");
  });

  test("CI runs the catalog regeneration check and the OFFLINE source sync, and neither is only a comment", () => {
    const commands = ciRunCommands();
    expect(commands).toContain("bun run provider:catalog -- --check");
    expect(commands).toContain("bun run provider:sync -- --offline");
  });

  test("CI never runs the NETWORK form of the source sync (a per-push clone of a third party's release)", () => {
    const commands = ciRunCommands();
    for (const command of commands) {
      if (!command.includes("provider:sync") && !command.includes("provider-source-sync")) continue;
      expect(command).toContain("--offline");
    }
  });

  test("the opt-in LIVE provider gate is EXPLICITLY ABSENT from CI — no run step names it, anywhere", () => {
    const commands = ciRunCommands();
    for (const command of commands) {
      expect(command).not.toContain("verify-provider-live");
      expect(command).not.toContain("verify:provider:live");
    }
    // And the ABSENCE is documented in the file rather than left to be re-derived, so the next reader
    // knows it is a decision.
    expect(CI_YML).toContain("verify-provider-live.ts");
    expect(CI_YML).toContain("deliberately absent");
  });

  test("the live gate script exists — the absence above is a decision about a real script, not a stale reference", async () => {
    const url = new URL("./verify-provider-live.ts", import.meta.url);
    expect(readFileSync(fileURLToPath(url), "utf8").length).toBeGreaterThan(0);
  });
});
