// A recorded input -> output corpus for the `# Environment` renderers: 800 generated environment
// inputs (shell values with and without `zsh`/`bash`, blank and padded shells, empty and absent model /
// display-name / cutoff fields, nested additional directories, newlines and non-ASCII text) with what
// `shellName`, `renderEnvironmentSection`, `renderStaticEnvironmentSection` and
// `renderEnvironmentContextValue` returned when the corpus was recorded.
import { expect, test } from "bun:test";
import { renderEnvironmentContextValue, renderEnvironmentSection, renderStaticEnvironmentSection, shellName, type EnvironmentInput } from "./dynamic-sections.ts";
import corpus from "./__corpus__/environment-section.json";

test("the recorded corpus renders exactly as recorded", () => {
  const rows = corpus as Array<{ input: EnvironmentInput; expected: { shell: string; section: string; staticSection: string; contextValue: string } }>;
  expect(rows.length).toBe(800);
  const mismatches = rows.filter(({ input, expected }) => {
    const got = { shell: shellName(input.shell), section: renderEnvironmentSection(input), staticSection: renderStaticEnvironmentSection(input), contextValue: renderEnvironmentContextValue(input) };
    return JSON.stringify(got) !== JSON.stringify(expected);
  });
  expect(mismatches).toEqual([]);
});
