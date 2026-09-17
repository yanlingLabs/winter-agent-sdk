// SDK 0.0.16 Lane C: the `# Environment` section, in claude 0.3.250's `env_info_simple` shape (the
// captured request's section, with Winter's product line in place of claude's).
import { describe, expect, test } from "bun:test";
import { renderEnvironmentContextValue, renderEnvironmentSection, renderStaticEnvironmentSection, shellName, WINTER_PRODUCT_LINE } from "./dynamic-sections.ts";

const base = { cwd: "/work/proj", isGitRepo: true, platform: "darwin", shell: "/bin/zsh", osVersion: "Darwin 25.6.0" };

describe("context/dynamic-sections.ts -- # Environment", () => {
  test("the captured shape: heading, lead-in (with its trailing space), bullets, model line, product line; no date", () => {
    expect(renderEnvironmentSection({ ...base, model: "claude-haiku-4-5", modelDisplayName: "Haiku 4.5" })).toBe(
      [
        "# Environment",
        "You have been invoked in the following environment: ",
        " - Primary working directory: /work/proj",
        " - Is a git repository: true",
        " - Platform: darwin",
        " - Shell: zsh",
        " - OS Version: Darwin 25.6.0",
        " - You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4-5.",
        ` - ${WINTER_PRODUCT_LINE}`,
      ].join("\n"),
    );
  });

  test("no display name: the bare-id model line; no model: no model line", () => {
    expect(renderEnvironmentSection({ ...base, model: "winter-test/echo" })).toContain(" - You are powered by the model winter-test/echo.\n");
    expect(renderEnvironmentSection(base)).not.toContain("powered by");
  });

  test("additional working directories nest as `  - ` items; a cutoff adds its line", () => {
    const out = renderEnvironmentSection({ ...base, isGitRepo: false, additionalDirectories: ["/a", "/b"], model: "m", knowledgeCutoff: "January 2026" });
    expect(out).toContain(" - Is a git repository: false\n - Additional working directories:\n  - /a\n  - /b\n - Platform: darwin");
    expect(out).toContain(" - Assistant knowledge cutoff is January 2026.");
  });

  test("the shell is reduced the way claude reduces it", () => {
    expect(shellName("/opt/homebrew/bin/zsh")).toBe("zsh");
    expect(shellName("/bin/bash")).toBe("bash");
    expect(shellName("/usr/bin/fish")).toBe("/usr/bin/fish");
    expect(shellName("")).toBe("unknown");
  });

  test("excludeDynamicSections halves: static keeps model + product, the context value keeps the machine facts without the heading", () => {
    expect(renderStaticEnvironmentSection({ model: "m" })).toBe(`# Environment\n - You are powered by the model m.\n - ${WINTER_PRODUCT_LINE}`);
    expect(renderEnvironmentContextValue(base)).toBe(
      "You have been invoked in the following environment: \n - Primary working directory: /work/proj\n - Is a git repository: true\n - Platform: darwin\n - Shell: zsh\n - OS Version: Darwin 25.6.0",
    );
  });
});
