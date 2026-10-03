// Edge cases of the `# Environment` section's shell reduction and bullet rendering.
import { describe, expect, test } from "bun:test";
import { renderEnvironmentContextValue, renderEnvironmentSection, renderStaticEnvironmentSection, shellName, WINTER_PRODUCT_LINE } from "./dynamic-sections.ts";

const base = { cwd: "/w", isGitRepo: true, platform: "linux", shell: "/bin/sh", osVersion: "Linux 6.1" };

describe("shellName", () => {
  test("an empty or whitespace-only value is `unknown`", () => {
    expect(shellName("")).toBe("unknown");
    expect(shellName("   ")).toBe("unknown");
    expect(shellName("\t\n")).toBe("unknown");
  });

  test("`zsh` anywhere in the value wins, and is checked before `bash`", () => {
    expect(shellName("/bin/zsh")).toBe("zsh");
    expect(shellName("/opt/bash/bin/zsh")).toBe("zsh");
    expect(shellName("/bin/bash-zsh")).toBe("zsh");
    expect(shellName("zsh")).toBe("zsh");
    expect(shellName("  /bin/zsh  ")).toBe("zsh");
  });

  test("`bash` anywhere in the value (without `zsh`) gives `bash`", () => {
    expect(shellName("/usr/local/bin/bash")).toBe("bash");
    expect(shellName("rbash")).toBe("bash");
  });

  test("the match is case-sensitive", () => {
    expect(shellName("/bin/ZSH")).toBe("/bin/ZSH");
    expect(shellName("BASH")).toBe("BASH");
  });

  test("anything else is returned raw, NOT trimmed", () => {
    expect(shellName("/usr/bin/fish")).toBe("/usr/bin/fish");
    expect(shellName("  /usr/bin/fish  ")).toBe("  /usr/bin/fish  ");
    expect(shellName("z s h")).toBe("z s h");
  });
});

describe("bullet rendering", () => {
  test("every top-level fact is ` - <fact>`; an array fact's members are `  - <item>`, empty strings included", () => {
    const out = renderEnvironmentSection({ ...base, additionalDirectories: ["/a", "", "/c d"] });
    expect(out).toContain(" - Additional working directories:\n  - /a\n  - \n  - /c d\n - Platform: linux");
  });

  test("an empty additional-directories list adds no line at all", () => {
    expect(renderEnvironmentSection({ ...base, additionalDirectories: [] })).not.toContain("Additional working directories");
  });

  test("an empty model id gives no model line; an empty display name falls back to the bare-id line", () => {
    expect(renderEnvironmentSection({ ...base, model: "" })).not.toContain("powered by");
    expect(renderEnvironmentSection({ ...base, model: "m1", modelDisplayName: "" })).toContain(" - You are powered by the model m1.\n");
  });

  test("a cutoff without a model still adds its own line", () => {
    expect(renderEnvironmentSection({ ...base, knowledgeCutoff: "May 2025" })).toContain(` - Assistant knowledge cutoff is May 2025.\n - ${WINTER_PRODUCT_LINE}`);
    expect(renderEnvironmentSection({ ...base, knowledgeCutoff: "" })).not.toContain("cutoff");
  });

  test("the static half with no model is the heading plus the product line", () => {
    expect(renderStaticEnvironmentSection({})).toBe(`# Environment\n - ${WINTER_PRODUCT_LINE}`);
  });

  test("the context value keeps the lead-in's trailing space and has no heading", () => {
    expect(renderEnvironmentContextValue({ ...base, isGitRepo: false })).toBe(
      "You have been invoked in the following environment: \n - Primary working directory: /w\n - Is a git repository: false\n - Platform: linux\n - Shell: /bin/sh\n - OS Version: Linux 6.1",
    );
  });

  test("values are inserted as-is: a newline inside a fact is not re-indented", () => {
    expect(renderEnvironmentContextValue({ ...base, cwd: "/a\nb" })).toContain(" - Primary working directory: /a\nb\n - Is a git repository: true");
  });
});
