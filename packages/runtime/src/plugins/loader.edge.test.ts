// Edge cases of a plugin manifest's custom component paths (`skills`/`commands`/`agents`/
// `outputStyles`/`workflows`), its `hooks` string entries, and the folder-shadowed notice -- pinned
// with exact warning text and exact result order. Layouts are materialised by
// loader.corpus-fixture.ts; `<tmp>` stands for the temp dir, the plugin root is `<tmp>/p`.
import { describe, expect, test } from "bun:test";
import { runLayout, type PluginLayout } from "./loader.corpus-fixture.ts";

type Result = {
  bundles: Array<Record<string, unknown> & { skills: Array<Record<string, unknown>>; commands: Array<Record<string, unknown>>; agents: Record<string, unknown> }>;
  rejected: unknown[];
  agentFileRejections: Array<Record<string, unknown>>;
  hookFileWarnings: string[];
  manifestPathWarnings: string[];
};
const run = (layout: PluginLayout): Result => runLayout(layout) as Result;

const SKILL = (d: string) => `---\ndescription: ${d}\n---\n\nBODY`;
const CMD = (d: string) => `---\ndescription: ${d}\n---\n\nDo $ARGUMENTS`;
const AGENT = (name: string, d = "d") => `---\nname: ${name}\ndescription: ${d}\n---\nYou are ${name}.`;
const HOOKS = (command: string, event = "PreToolUse") => JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command }] }] } });
const entry = (command: string) => [{ hooks: [{ type: "command", command }] }];

describe("manifest component paths: per-entry checks and their exact warnings", () => {
  test("a non-string or empty entry is named with its JSON spelling and skipped; the key still shadows", () => {
    const r = run({ dirs: ["p/workflows"], manifest: { workflows: [42, "", null, { a: 1 }, ["x"], true] } });
    expect(r.manifestPathWarnings).toEqual([
      'plugin "p"\'s manifest "workflows" entry 42 is not a non-empty string -- ignoring it',
      'plugin "p"\'s manifest "workflows" entry "" is not a non-empty string -- ignoring it',
      'plugin "p"\'s manifest "workflows" entry null is not a non-empty string -- ignoring it',
      'plugin "p"\'s manifest "workflows" entry {"a":1} is not a non-empty string -- ignoring it',
      'plugin "p"\'s manifest "workflows" entry ["x"] is not a non-empty string -- ignoring it',
      'plugin "p"\'s manifest "workflows" entry true is not a non-empty string -- ignoring it',
      'plugin "p": the "workflows/" folder exists but is not auto-loaded because the manifest sets "workflows"',
    ]);
    expect(r.bundles[0]!["workflowsPath"]).toBeUndefined();
    expect(r.bundles[0]!["workflowsPaths"]).toBeUndefined();
  });

  test("a bare non-array, non-string value (null, a number, an object) is ONE entry, checked like any other", () => {
    expect(run({ manifest: { agents: null } }).manifestPathWarnings).toEqual(['plugin "p"\'s manifest "agents" entry null is not a non-empty string -- ignoring it']);
    expect(run({ manifest: { outputStyles: 7 } }).manifestPathWarnings).toEqual(['plugin "p"\'s manifest "output-styles" entry 7 is not a non-empty string -- ignoring it']);
    expect(run({ manifest: { skills: { x: "y" } } }).manifestPathWarnings).toEqual(['plugin "p"\'s manifest "skills" entry {"x":"y"} is not a non-empty string -- ignoring it']);
  });

  test("an empty array declares the key: nothing resolves, the default directory is still shadowed", () => {
    const r = run({ dirs: ["p/workflows", "p/output-styles"], files: { "p/agents/a.md": AGENT("a") }, manifest: { workflows: [], outputStyles: [], agents: [] } });
    const b = r.bundles[0]!;
    expect(b["workflowsPath"]).toBeUndefined();
    expect(b["workflowsPaths"]).toBeUndefined();
    expect(b["outputStylesPath"]).toBeUndefined();
    expect(b["outputStylesPaths"]).toBeUndefined();
    expect(b.agents).toEqual({});
    expect(r.manifestPathWarnings).toEqual([
      'plugin "p": the "agents/" folder exists but is not auto-loaded because the manifest sets "agents"',
      'plugin "p": the "output-styles/" folder exists but is not auto-loaded because the manifest sets "outputStyles"',
      'plugin "p": the "workflows/" folder exists but is not auto-loaded because the manifest sets "workflows"',
    ]);
  });

  test("checks run in order -- string, containment, existence, directory -- and the first failure is the one reported", () => {
    const r = run({
      files: { "p/afile.txt": "x" },
      manifest: { skills: ["../out", "/nowhere/at/all", "./missing", "./afile.txt", "a\\b", "..x"] },
    });
    expect(r.manifestPathWarnings).toEqual([
      'plugin "p"\'s manifest "skills" path "../out" escapes the plugin directory -- ignoring it',
      'plugin "p"\'s manifest "skills" path "/nowhere/at/all" escapes the plugin directory -- ignoring it',
      'plugin "p"\'s manifest "skills" path "./missing" was not found at <tmp>/p/missing -- ignoring it',
      'plugin "p"\'s manifest "skills" path "./afile.txt" is a file, not a directory (skills entries must be directories containing SKILL.md) -- ignoring it',
      'plugin "p"\'s manifest "skills" path "a\\b" escapes the plugin directory -- ignoring it',
      'plugin "p"\'s manifest "skills" path "..x" escapes the plugin directory -- ignoring it',
    ]);
  });

  test("the SKILL.md hint is matched on the entry's last segment, case-insensitively", () => {
    const r = run({ files: { "p/s/Skill.MD": SKILL("x"), "p/s/README.md": "x" }, manifest: { skills: ["./s/Skill.MD", "./s/README.md"] } });
    expect(r.manifestPathWarnings).toEqual([
      'plugin "p"\'s manifest "skills" path "./s/Skill.MD" is a file, not a directory (skills entries must be directories containing SKILL.md) -- point to its parent directory instead -- ignoring it',
      'plugin "p"\'s manifest "skills" path "./s/README.md" is a file, not a directory (skills entries must be directories containing SKILL.md) -- ignoring it',
    ]);
  });

  test("a bare file is a valid entry for workflows, output styles, agents and commands", () => {
    const r = run({
      files: { "p/w.js": "x", "p/st.md": "x", "p/one.md": AGENT("solo"), "p/c.md": CMD("c") },
      manifest: { workflows: "w.js", outputStyles: "./st.md", agents: "one.md", commands: "c.md" },
    });
    const b = r.bundles[0]!;
    expect(b["workflowsPaths"]).toEqual(["<tmp>/p/w.js"]);
    expect(b["outputStylesPaths"]).toEqual(["<tmp>/p/st.md"]);
    expect(Object.keys(b.agents)).toEqual(["solo"]);
    expect(b.commands.map((c) => c["name"])).toEqual(["c"]);
    expect(r.manifestPathWarnings).toEqual([]);
  });

  test("entries resolve against the plugin root and are normalised; `.` names the root itself", () => {
    const r = run({ dirs: ["p/a/b"], manifest: { workflows: [".", "a/./b/../b", "a//b/"] } });
    expect(r.bundles[0]!["workflowsPaths"]).toEqual(["<tmp>/p", "<tmp>/p/a/b", "<tmp>/p/a/b"]);
  });

  test("a symlink inside the plugin root that stays inside it is admitted, under its own (unresolved) path", () => {
    const r = run({ dirs: ["p/real"], links: { "p/alias": "p/real" }, manifest: { workflows: "./alias" } });
    expect(r.bundles[0]!["workflowsPaths"]).toEqual(["<tmp>/p/alias"]);
    expect(r.manifestPathWarnings).toEqual([]);
  });
});

describe("the folder-shadowed notice and its suppression", () => {
  test("an entry INSIDE the default directory suppresses the notice; a sibling whose name merely starts the same does not", () => {
    const inside = run({ dirs: ["p/workflows/sub"], manifest: { workflows: "./workflows/sub" } });
    expect(inside.manifestPathWarnings).toEqual([]);
    const sibling = run({ dirs: ["p/workflows", "p/workflows-extra"], manifest: { workflows: "./workflows-extra" } });
    expect(sibling.manifestPathWarnings).toEqual(['plugin "p": the "workflows/" folder exists but is not auto-loaded because the manifest sets "workflows"']);
  });

  test("only entries that RESOLVED count toward suppression -- a missing self-reference does not suppress", () => {
    const r = run({ files: { "p/commands/x.md": CMD("x") }, manifest: { commands: ["./commands/gone"] } });
    expect(r.manifestPathWarnings).toEqual([
      'plugin "p"\'s manifest "commands" path "./commands/gone" was not found at <tmp>/p/commands/gone -- ignoring it',
      'plugin "p": the "commands/" folder exists but is not auto-loaded because the manifest sets "commands"',
    ]);
  });

  test("a symlink that points at the default directory under another name does not suppress (the check is on the resolved spelling)", () => {
    const r = run({ dirs: ["p/agents"], links: { "p/ag": "p/agents" }, manifest: { agents: "./ag" } });
    expect(r.manifestPathWarnings).toEqual(['plugin "p": the "agents/" folder exists but is not auto-loaded because the manifest sets "agents"']);
  });

  test("a default directory that is a FILE is not a folder to shadow", () => {
    const r = run({ files: { "p/workflows": "not a dir" }, dirs: ["p/w2"], manifest: { workflows: "./w2" } });
    expect(r.manifestPathWarnings).toEqual([]);
  });
});

describe("override scans: later entries win a name, the first position is kept", () => {
  test("skills: default first, overrides after; a repeated name keeps its first position with the LAST entry's content", () => {
    const r = run({
      files: {
        "p/skills/b/SKILL.md": SKILL("default-b"),
        "p/skills/a/SKILL.md": SKILL("default-a"),
        "p/x/c/SKILL.md": SKILL("x-c"),
        "p/x/a/SKILL.md": SKILL("x-a"),
        "p/y/a/SKILL.md": SKILL("y-a"),
      },
      manifest: { skills: ["./x", "./y"] },
    });
    expect(r.bundles[0]!.skills.map((s) => [s["name"], s["description"], s["path"]])).toEqual([
      ["a", "y-a", "<tmp>/p/y/a/SKILL.md"],
      ["b", "default-b", "<tmp>/p/skills/b/SKILL.md"],
      ["c", "x-c", "<tmp>/p/x/c/SKILL.md"],
    ]);
  });

  test("skills: naming the default directory again changes nothing (the same entries, once each)", () => {
    const r = run({ files: { "p/skills/a/SKILL.md": SKILL("a") }, manifest: { skills: ["./skills", "skills/"] } });
    expect(r.bundles[0]!.skills.map((s) => s["name"])).toEqual(["a"]);
    expect(r.manifestPathWarnings).toEqual([]);
  });

  test("skills: an override with no valid entry still loads the default directory (skills never shadow)", () => {
    const r = run({ files: { "p/skills/a/SKILL.md": SKILL("a") }, manifest: { skills: "../out" } });
    expect(r.bundles[0]!.skills.map((s) => s["name"])).toEqual(["a"]);
  });

  test("commands: directory entries scan `.md` files only, a single-file entry is taken whatever its extension, and the name drops only a trailing `.md`", () => {
    const r = run({
      files: { "p/d/z.md": CMD("dz"), "p/d/note.txt": "x", "p/d/m.md": CMD("dm"), "p/loose.txt": CMD("loose"), "p/UP.MD": CMD("up"), "p/again/m.md": CMD("again-m") },
      manifest: { commands: ["./d", "./loose.txt", "./UP.MD", "./again"] },
    });
    expect(r.bundles[0]!.commands.map((c) => [c["name"], c["description"], c["qualifiedName"]])).toEqual([
      ["m", "again-m", "p:m"],
      ["z", "dz", "p:z"],
      ["loose.txt", "loose", "p:loose.txt"],
      ["UP.MD", "up", "p:UP.MD"],
    ]);
  });

  test("agents: a later entry's agent of the same name replaces the earlier one in place; a bad file is a rejection, not a warning", () => {
    const r = run({
      files: { "p/a1/x.md": AGENT("x", "first"), "p/a1/y.md": AGENT("y"), "p/a2/x.md": AGENT("x", "second"), "p/bad.md": "---\ndescription: no name\n---\nbody" },
      manifest: { agents: ["./a1", "./a2", "./bad.md"] },
    });
    const agents = r.bundles[0]!.agents as Record<string, { description: string }>;
    expect(Object.keys(agents)).toEqual(["x", "y"]);
    expect(agents["x"]!.description).toBe("second");
    expect(r.agentFileRejections).toHaveLength(1);
    expect(r.agentFileRejections[0]!["filePath"]).toBe("<tmp>/p/bad.md");
    expect(r.manifestPathWarnings).toEqual([]);
  });
});

describe("the commands value's inline object-map form", () => {
  const INLINE = 'plugin "p"\'s manifest "commands" uses the inline {name: {source|content}} form, which Winter does not support yet -- no commands were loaded from it (the default commands/ directory is still shadowed, matching claude\'s own behaviour whenever the key is present)';

  test("an object whose FIRST value is an object carrying `source` or `content` is the inline form", () => {
    expect(run({ manifest: { commands: { a: { source: "./x.md" } } } }).manifestPathWarnings).toEqual([INLINE]);
    expect(run({ manifest: { commands: { a: { content: "hi", other: 1 } } } }).manifestPathWarnings).toEqual([INLINE]);
    expect(run({ manifest: { commands: { a: { source: null } } } }).manifestPathWarnings).toEqual([INLINE]);
  });

  test("only the first value decides: a later inline-shaped value after a plain first value is NOT the inline form", () => {
    const r = run({ manifest: { commands: { a: { other: 1 }, b: { source: "x" } } } });
    expect(r.manifestPathWarnings).toEqual(['plugin "p"\'s manifest "commands" entry {"a":{"other":1},"b":{"source":"x"}} is not a non-empty string -- ignoring it']);
  });

  test("an empty object, or a first value that is a string, array or null, is checked as an ordinary (invalid) entry", () => {
    expect(run({ manifest: { commands: {} } }).manifestPathWarnings).toEqual(['plugin "p"\'s manifest "commands" entry {} is not a non-empty string -- ignoring it']);
    expect(run({ manifest: { commands: { a: "./x.md" } } }).manifestPathWarnings).toEqual(['plugin "p"\'s manifest "commands" entry {"a":"./x.md"} is not a non-empty string -- ignoring it']);
    expect(run({ manifest: { commands: { a: ["source"] } } }).manifestPathWarnings).toEqual(['plugin "p"\'s manifest "commands" entry {"a":["source"]} is not a non-empty string -- ignoring it']);
    expect(run({ manifest: { commands: { a: null } } }).manifestPathWarnings).toEqual(['plugin "p"\'s manifest "commands" entry {"a":null} is not a non-empty string -- ignoring it']);
  });

  test("the inline form shadows the default directory: the inline notice comes first, then the folder notice", () => {
    const r = run({ files: { "p/commands/x.md": CMD("x") }, manifest: { commands: { a: { content: "hi" } } } });
    expect(r.bundles[0]!.commands).toEqual([]);
    expect(r.manifestPathWarnings).toEqual([INLINE, 'plugin "p": the "commands/" folder exists but is not auto-loaded because the manifest sets "commands"']);
  });
});

describe("manifest `hooks` string entries", () => {
  test("empty strings and non-string, non-object elements are skipped silently", () => {
    const r = run({ manifest: { hooks: ["", 5, null, true, ["nested"]] } });
    expect(r.bundles[0]!["hooks"]).toBeUndefined();
    expect(r.manifestPathWarnings).toEqual([]);
    expect(r.hookFileWarnings).toEqual([]);
  });

  test("exact warnings: escape, not found (a directory counts as not found), and in that check order", () => {
    const r = run({ dirs: ["p/hdir"], files: { "out/h.json": HOOKS("x") }, manifest: { hooks: ["../out/h.json", "./nope.json", "./hdir", "/etc/hosts", "x\\y.json"] } });
    expect(r.manifestPathWarnings).toEqual([
      'plugin "p"\'s manifest "hooks" entry "../out/h.json" escapes the plugin directory -- ignoring it',
      'plugin "p"\'s manifest "hooks" entry "./nope.json" was not found at <tmp>/p/nope.json -- ignoring it',
      'plugin "p"\'s manifest "hooks" entry "./hdir" was not found at <tmp>/p/hdir -- ignoring it',
      'plugin "p"\'s manifest "hooks" entry "/etc/hosts" escapes the plugin directory -- ignoring it',
      'plugin "p"\'s manifest "hooks" entry "x\\y.json" escapes the plugin directory -- ignoring it',
    ]);
  });

  test("the standard hooks/hooks.json named under any spelling, or through an in-root symlink, is skipped silently", () => {
    const r = run({
      files: { "p/hooks/hooks.json": HOOKS("std") },
      links: { "p/alias.json": "p/hooks/hooks.json" },
      manifest: { hooks: ["hooks/hooks.json", "./hooks//hooks.json", "./alias.json", "hooks/../hooks/hooks.json"] },
    });
    expect(r.bundles[0]!["hooks"]).toEqual({ PreToolUse: entry("std") });
    expect(r.manifestPathWarnings).toEqual([]);
  });

  test("a symlink to another in-root file is the SAME file as that file: the second spelling is a duplicate naming the real path", () => {
    const r = run({ files: { "p/h.json": HOOKS("h") }, links: { "p/l.json": "p/h.json" }, manifest: { hooks: ["./l.json", "./h.json"] } });
    expect(r.bundles[0]!["hooks"]).toEqual({ PreToolUse: entry("h") });
    expect(r.manifestPathWarnings).toEqual(['plugin "p"\'s manifest "hooks" entry "./h.json" duplicates another entry (both resolve to <tmp>/p/h.json) -- loaded once']);
  });

  test("a file that failed to parse still counts as seen: a second spelling of it is a duplicate", () => {
    const r = run({ files: { "p/bad.json": "{nope" }, manifest: { hooks: ["bad.json", "./bad.json"] } });
    expect(r.bundles[0]!["hooks"]).toBeUndefined();
    expect(r.hookFileWarnings).toEqual([]);
    expect(r.manifestPathWarnings).toEqual(['plugin "p"\'s manifest "hooks" entry "./bad.json" duplicates another entry (both resolve to <tmp>/p/bad.json) -- loaded once']);
  });

  test("a referenced file that is a JSON object without `hooks` warns on the hook-file channel naming the entry; a non-object or non-JSON file is silent", () => {
    const r = run({ files: { "p/flat.json": JSON.stringify({ PreToolUse: [] }), "p/arr.json": "[1]", "p/str.json": '"s"', "p/junk.json": "nope" }, manifest: { hooks: ["flat.json", "arr.json", "str.json", "junk.json"] } });
    expect(r.hookFileWarnings).toEqual(['plugin "p"\'s manifest "hooks" entry "flat.json" has no "hooks" key -- check that the file follows the required schema ({"hooks": {<Event>: [...]}})']);
    expect(r.manifestPathWarnings).toEqual([]);
  });

  test("merge order: hooks.json, then the manifest's objects in order, then the string entries in order", () => {
    const r = run({
      files: { "p/hooks/hooks.json": HOOKS("std"), "p/s1.json": HOOKS("s1"), "p/s2.json": HOOKS("s2") },
      manifest: { hooks: ["s2.json", { PreToolUse: entry("o1") }, "s1.json", { PreToolUse: entry("o2") }] },
    });
    expect(r.bundles[0]!["hooks"]).toEqual({ PreToolUse: [...entry("std"), ...entry("o1"), ...entry("o2"), ...entry("s2"), ...entry("s1")] });
  });

  test("a single string value (not in an array) is one entry", () => {
    const r = run({ files: { "p/one.json": HOOKS("one", "Stop") }, manifest: { hooks: "one.json" } });
    expect(r.bundles[0]!["hooks"]).toEqual({ Stop: entry("one") });
  });

  test("warning order across both channels: string-entry read problems come before the malformed-value notices of what they contributed", () => {
    const r = run({
      files: { "p/hooks/hooks.json": HOOKS("std"), "p/flat.json": JSON.stringify({ X: [] }), "p/mal.json": JSON.stringify({ hooks: { PreToolUse: "oops" } }) },
      manifest: { hooks: ["mal.json", "flat.json", "../escape.json"] },
    });
    expect(r.hookFileWarnings).toEqual([
      'plugin "p"\'s manifest "hooks" entry "flat.json" has no "hooks" key -- check that the file follows the required schema ({"hooks": {<Event>: [...]}})',
      'plugin "p": a malformed "PreToolUse" hooks value was dropped in favour of an earlier valid array for the same event',
    ]);
    expect(r.manifestPathWarnings).toEqual(['plugin "p"\'s manifest "hooks" entry "../escape.json" escapes the plugin directory -- ignoring it']);
  });
});

describe("warning order across components", () => {
  test("hooks, agents, commands, output styles, workflows, then skills -- each component's entry warnings before its folder notice", () => {
    const r = run({
      dirs: ["p/agents", "p/commands", "p/output-styles", "p/workflows"],
      manifest: { skills: "./s-missing", workflows: "./w-missing", outputStyles: "./o-missing", commands: "./c-missing", agents: "./a-missing", hooks: "./h-missing.json" },
    });
    expect(r.manifestPathWarnings).toEqual([
      'plugin "p"\'s manifest "hooks" entry "./h-missing.json" was not found at <tmp>/p/h-missing.json -- ignoring it',
      'plugin "p"\'s manifest "agents" path "./a-missing" was not found at <tmp>/p/a-missing -- ignoring it',
      'plugin "p": the "agents/" folder exists but is not auto-loaded because the manifest sets "agents"',
      'plugin "p"\'s manifest "commands" path "./c-missing" was not found at <tmp>/p/c-missing -- ignoring it',
      'plugin "p": the "commands/" folder exists but is not auto-loaded because the manifest sets "commands"',
      'plugin "p"\'s manifest "output-styles" path "./o-missing" was not found at <tmp>/p/o-missing -- ignoring it',
      'plugin "p": the "output-styles/" folder exists but is not auto-loaded because the manifest sets "outputStyles"',
      'plugin "p"\'s manifest "workflows" path "./w-missing" was not found at <tmp>/p/w-missing -- ignoring it',
      'plugin "p": the "workflows/" folder exists but is not auto-loaded because the manifest sets "workflows"',
      'plugin "p"\'s manifest "skills" path "./s-missing" was not found at <tmp>/p/s-missing -- ignoring it',
    ]);
  });
});
