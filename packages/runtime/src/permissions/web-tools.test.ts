// The web tools' permission behaviour, asserted through the REAL evaluator with REAL call shapes.
//
// Every WebFetch call in this file is `{url, prompt}` and every WebSearch call is `{query, ...}` --
// exactly what the model sends. Nothing here hand-builds a `domain` field: that is how a matcher that
// was dead in production once stayed green. Nothing calls a grammar function directly either; the
// grammar has its own unit file, and what THIS file pins is the decision a session actually gets.
import { describe, expect, test } from "bun:test";
import type { PermissionMode, PermissionRequestPayload, PermissionResult, PermissionRuleValue, RuleSource } from "@yanlinglabs/winter-agent-sdk";
import {
  evaluate,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  PREAPPROVED_HOST_REASON,
  REAL_SPECIAL_CHECKS,
  UNFETCHABLE_URL_REASON,
  type AutoEngine,
  type EvaluationContext,
  type HookStage,
  type PermissionCall,
  type PromptDecision,
  type PromptStage,
  type PromptStageMeta,
} from "./evaluator.ts";
import type { PolicyState } from "./policy-state.ts";
import { createBridgePromptStage } from "./prompt-stage.ts";
import { emptyRuleSet, sourceRule, type SourcedRuleEntry } from "./ruleset.ts";
import type { RpcBridge } from "../rpc/bridge.ts";

// --- helpers -----------------------------------------------------------------------------------------

function rule(raw: string, behavior: "allow" | "deny" | "ask", source: RuleSource = "user"): SourcedRuleEntry {
  const m = /^([^\s(]+)\((.*)\)$/s.exec(raw.trim());
  const value: PermissionRuleValue = m ? { toolName: m[1]!, ruleContent: m[2]! } : { toolName: raw.trim() };
  return sourceRule(value, behavior, source);
}

function policy(mode: PermissionMode, entries: SourcedRuleEntry[]): PolicyState {
  return { mode, version: 7, rules: { ...emptyRuleSet(), entries } };
}

interface Harness {
  ctx: EvaluationContext;
  prompts: Array<{ call: PermissionCall; meta: PromptStageMeta }>;
  classified: PermissionCall[];
}

function harness(opts: {
  mode?: PermissionMode;
  rules?: SourcedRuleEntry[];
  /** What the prompt stage answers. Omitted = NO handler at all (a session that cannot prompt). */
  answer?: PromptDecision;
  privateAddressPolicy?: string;
  trustedWorkspace?: boolean;
  hookStage?: HookStage;
  sessionBypassEnabled?: boolean;
}): Harness {
  const prompts: Harness["prompts"] = [];
  const classified: PermissionCall[] = [];
  const promptStage: PromptStage =
    opts.answer === undefined
      ? NO_OPINION_PROMPT_STAGE
      : {
          async prompt(call, _ctx, meta) {
            prompts.push({ call, meta });
            return opts.answer!;
          },
        };
  // A classifier that would ALLOW anything it is shown -- so a test that expects a prompt or a denial
  // under `auto` proves the classifier was never the one deciding.
  const autoEngine: AutoEngine = {
    async classify(call) {
      classified.push(call);
      return { verdict: "allow" };
    },
  };
  return {
    prompts,
    classified,
    ctx: {
      policy: policy(opts.mode ?? "default", opts.rules ?? []),
      cwd: "/work",
      sessionRoot: "/work",
      home: "/synthetic/home/tester",
      trustedWorkspace: opts.trustedWorkspace ?? true,
      hookStage: opts.hookStage ?? NO_OPINION_HOOK_STAGE,
      promptStage,
      autoEngine,
      specialChecks: REAL_SPECIAL_CHECKS,
      ...(opts.sessionBypassEnabled !== undefined ? { sessionBypassEnabled: opts.sessionBypassEnabled } : {}),
      ...(opts.privateAddressPolicy !== undefined ? { webFetchPrivateAddressPolicy: opts.privateAddressPolicy } : {}),
    },
  };
}

const fetchCall = (url: unknown): PermissionCall => ({ toolName: "WebFetch", input: { url, prompt: "What does this page say?" }, toolUseId: "toolu_fetch" });
const searchCall = (): PermissionCall => ({ toolName: "WebSearch", input: { query: "bun test runner", allowed_domains: ["bun.sh"] }, toolUseId: "toolu_search" });

const ALLOW: PromptDecision = { decision: "allow" };
const REFUSE: PromptDecision = { decision: "deny", message: "the user said no" };

const ALL_MODES: PermissionMode[] = ["default", "dontAsk", "acceptEdits", "plan", "auto", "bypassPermissions"];

// =====================================================================================================
// 1. WebFetch(domain:...) rules -- every rule kind, against a real call, through the real evaluator
// =====================================================================================================

describe("WebFetch(domain:...) rules are LIVE against a real {url, prompt} call", () => {
  test("DENY: the domain's deny rule denies the call in every mode, bypassPermissions included, and no prompt is raised", async () => {
    for (const mode of ALL_MODES) {
      const h = harness({ mode, rules: [rule("WebFetch(domain:example.com)", "deny")], answer: ALLOW, sessionBypassEnabled: true });
      const record = await evaluate(fetchCall("https://example.com/pricing?x=1"), h.ctx);
      expect(record.decision).toBe("deny");
      expect(record.mechanism).toBe("rule");
      expect(record.ruleRef).toContain("WebFetch(domain:example.com)");
      expect(h.prompts).toHaveLength(0);
      expect(h.classified).toHaveLength(0);
    }
  });

  test("ASK: the domain's ask rule forces a prompt even where the mode or an allow rule would allow silently", async () => {
    for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const) {
      const h = harness({
        mode,
        rules: [rule("WebFetch(domain:example.com)", "ask"), rule("WebFetch", "allow"), rule("WebFetch(domain:example.com)", "allow")],
        answer: ALLOW,
        sessionBypassEnabled: true,
      });
      const record = await evaluate(fetchCall("https://example.com/"), h.ctx);
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]!.meta.matchedAskRule).toEqual({ source: "user", toolName: "WebFetch", ruleContent: "domain:example.com" });
      expect(record.decision).toBe("allow");
      expect(record.mechanism).toBe("canUseTool");
      expect(h.classified).toHaveLength(0);
    }
  });

  test("ASK: a refusal at the prompt denies; dontAsk converts the ask rule to a denial; no handler fails closed", async () => {
    const rules = [rule("WebFetch(domain:example.com)", "ask")];
    expect((await evaluate(fetchCall("https://example.com/"), harness({ rules, answer: REFUSE }).ctx)).decision).toBe("deny");
    const dontAsk = await evaluate(fetchCall("https://example.com/"), harness({ mode: "dontAsk", rules, answer: ALLOW }).ctx);
    expect(dontAsk).toMatchObject({ decision: "deny", mechanism: "rule" });
    const headless = await evaluate(fetchCall("https://example.com/"), harness({ rules }).ctx);
    expect(headless).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("ALLOW: the domain's allow rule allows with no prompt -- in default, and in dontAsk where an unmatched fetch is denied", async () => {
    for (const mode of ["default", "dontAsk"] as const) {
      const h = harness({ mode, rules: [rule("WebFetch(domain:example.com)", "allow")], answer: REFUSE });
      const record = await evaluate(fetchCall("https://example.com/docs"), h.ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "rule" });
      expect(record.ruleRef).toContain("WebFetch(domain:example.com)");
      expect(h.prompts).toHaveLength(0);
    }
    // The negative control: the SAME session, a different host -- the rule does not reach it.
    expect((await evaluate(fetchCall("https://other.test/"), harness({ mode: "dontAsk", rules: [rule("WebFetch(domain:example.com)", "allow")] }).ctx)).decision).toBe("deny");
  });

  test("deny beats ask beats allow for the same domain", async () => {
    const all = [rule("WebFetch(domain:example.com)", "allow"), rule("WebFetch(domain:example.com)", "ask"), rule("WebFetch(domain:example.com)", "deny")];
    expect((await evaluate(fetchCall("https://example.com/"), harness({ rules: all, answer: ALLOW }).ctx)).mechanism).toBe("rule");
    expect((await evaluate(fetchCall("https://example.com/"), harness({ rules: all, answer: ALLOW }).ctx)).decision).toBe("deny");
    const askAndAllow = harness({ rules: all.slice(0, 2), answer: REFUSE });
    expect((await evaluate(fetchCall("https://example.com/"), askAndAllow.ctx)).decision).toBe("deny");
    expect(askAndAllow.prompts).toHaveLength(1);
  });

  test("case: neither the rule's nor the url's capitalisation matters", async () => {
    const h = harness({ rules: [rule("WebFetch(domain:Example.COM)", "deny")] });
    expect((await evaluate(fetchCall("HTTPS://EXAMPLE.com/Path"), h.ctx)).decision).toBe("deny");
  });

  test("EXACT host: a rule for example.com does not reach docs.example.com; the glob is the opt-in", async () => {
    const exact = [rule("WebFetch(domain:example.com)", "deny")];
    const sub = harness({ rules: exact, answer: ALLOW });
    const record = await evaluate(fetchCall("https://docs.example.com/"), sub.ctx);
    expect(record.decision).toBe("allow"); // not denied: it fell through to the ordinary prompt, which allowed
    expect(sub.prompts).toHaveLength(1);

    const glob = [rule("WebFetch(domain:*.example.com)", "deny")];
    expect((await evaluate(fetchCall("https://docs.example.com/"), harness({ rules: glob, answer: ALLOW }).ctx)).decision).toBe("deny");
    expect((await evaluate(fetchCall("https://example.com/"), harness({ rules: glob, answer: ALLOW }).ctx)).decision).toBe("allow"); // the glob does not cover the apex
    expect((await evaluate(fetchCall("https://example.com.evil.test/"), harness({ rules: exact, answer: ALLOW }).ctx)).decision).toBe("allow"); // nor does a rule cover a lookalike suffix
  });

  test("an unparseable url matches NO domain rule -- it does not throw, is not allowed by an allow rule, and still reaches the prompt", async () => {
    for (const bad of ["not a url", "", "example.com", 42, undefined]) {
      const allow = harness({ rules: [rule("WebFetch(domain:*)", "allow")], answer: REFUSE });
      const record = await evaluate(fetchCall(bad), allow.ctx);
      expect(record.decision).toBe("deny"); // the broad allow did not match; the prompt was asked and refused
      expect(allow.prompts).toHaveLength(1);
      // ...and a bare rule, which is about the TOOL rather than a domain, still governs it.
      expect((await evaluate(fetchCall(bad), harness({ rules: [rule("WebFetch", "deny")], answer: ALLOW }).ctx)).mechanism).toBe("rule");
    }
  });

  test("a project-tier allow rule needs workspace trust, exactly like any other allow; its deny does not", async () => {
    const allow = [rule("WebFetch(domain:example.com)", "allow", "project")];
    expect((await evaluate(fetchCall("https://example.com/"), harness({ mode: "dontAsk", rules: allow, trustedWorkspace: true }).ctx)).decision).toBe("allow");
    expect((await evaluate(fetchCall("https://example.com/"), harness({ mode: "dontAsk", rules: allow, trustedWorkspace: false }).ctx)).decision).toBe("deny");
    const deny = [rule("WebFetch(domain:example.com)", "deny", "project")];
    expect((await evaluate(fetchCall("https://example.com/"), harness({ rules: deny, trustedWorkspace: false, answer: ALLOW }).ctx)).decision).toBe("deny");
  });

  test("with no rule at all an ordinary fetch ASKS, and the prompt suggests WebFetch(domain:<host>)", async () => {
    const payloads: PermissionRequestPayload[] = [];
    const bridge = {
      request: (async (_subtype: string, payload: unknown) => {
        payloads.push(payload as PermissionRequestPayload);
        return { behavior: "allow" } satisfies PermissionResult;
      }) as RpcBridge["request"],
      ownsRequest: () => false,
      handleResponse: () => false,
      rejectAllPending: () => {},
      cancel: () => {},
    } satisfies RpcBridge;
    const h = harness({});
    const ctx = { ...h.ctx, promptStage: createBridgePromptStage(bridge) };
    const record = await evaluate(fetchCall("https://Docs.Example.com/guide"), ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "canUseTool" });
    expect(payloads[0]!.suggestions).toEqual([{ type: "addRules", rules: [{ toolName: "WebFetch", ruleContent: "domain:docs.example.com" }], behavior: "allow", destination: "session" }]);

    // An unparseable url names no host, so there is nothing to suggest.
    await evaluate(fetchCall("not a url"), ctx);
    expect(payloads[1]!.suggestions).toBeUndefined();

    // WebSearch suggests the bare tool name -- it has no specifier grammar.
    await evaluate(searchCall(), ctx);
    expect(payloads[2]!.suggestions).toEqual([{ type: "addRules", rules: [{ toolName: "WebSearch" }], behavior: "allow", destination: "session" }]);
  });
});

// =====================================================================================================
// 2. The preapproved-host auto-allow
// =====================================================================================================

describe("preapproved hosts are allowed without asking -- after deny and ask rules", () => {
  test("a preapproved url is allowed in EVERY mode with no prompt and no classifier, and records why", async () => {
    for (const mode of ALL_MODES) {
      const h = harness({ mode, answer: REFUSE, sessionBypassEnabled: mode === "bypassPermissions" });
      const record = await evaluate(fetchCall("https://docs.python.org/3/library/asyncio.html"), h.ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "mode", decisionReason: PREAPPROVED_HOST_REASON });
      expect(PREAPPROVED_HOST_REASON).toBe("Preapproved host");
      expect(h.prompts).toHaveLength(0);
      expect(h.classified).toHaveLength(0);
      // An auto-allow is NOT an explicit approval of this call.
      expect(record.explicitApproval).toBeUndefined();
    }
  });

  test("a user's DENY rule for a preapproved domain still wins", async () => {
    for (const mode of ALL_MODES) {
      const h = harness({ mode, rules: [rule("WebFetch(domain:docs.python.org)", "deny")], answer: ALLOW });
      const record = await evaluate(fetchCall("https://docs.python.org/3/"), h.ctx);
      expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
      expect(record.decisionReason).toBeUndefined();
    }
    // A bare deny on the tool wins too.
    expect((await evaluate(fetchCall("https://docs.python.org/3/"), harness({ rules: [rule("WebFetch", "deny")] }).ctx)).decision).toBe("deny");
  });

  test("a user's ASK rule for a preapproved domain still wins -- it prompts, and dontAsk denies it", async () => {
    const rules = [rule("WebFetch(domain:docs.python.org)", "ask")];
    const asked = harness({ rules, answer: REFUSE });
    expect((await evaluate(fetchCall("https://docs.python.org/3/"), asked.ctx)).decision).toBe("deny");
    expect(asked.prompts).toHaveLength(1);
    expect((await evaluate(fetchCall("https://docs.python.org/3/"), harness({ mode: "dontAsk", rules, answer: ALLOW }).ctx)).decision).toBe("deny");
    expect((await evaluate(fetchCall("https://docs.python.org/3/"), harness({ mode: "bypassPermissions", rules, answer: REFUSE }).ctx)).decision).toBe("deny");
  });

  test("ONLY WebFetch, only a listed host, only inside a path-scoped entry's path, never an unparseable url", async () => {
    const denied = async (call: PermissionCall) => (await evaluate(call, harness({ mode: "dontAsk" }).ctx)).decision;
    expect(await denied(fetchCall("https://docs.python.org/3/"))).toBe("allow");
    expect(await denied(fetchCall("https://sub.docs.python.org/3/"))).toBe("deny"); // exact host, no subdomains
    expect(await denied(fetchCall("https://docs.python.org.evil.test/"))).toBe("deny");
    expect(await denied(fetchCall("https://github.com/anthropics/claude-code"))).toBe("allow"); // path-scoped entry, inside
    expect(await denied(fetchCall("https://github.com/someone-else/repo"))).toBe("deny"); // same host, outside the scope
    expect(await denied(fetchCall("docs.python.org/3/"))).toBe("deny"); // no scheme: unparseable
    // Another tool carrying the same url gets nothing from the list.
    expect(await denied({ toolName: "WebSearch", input: { query: "x", url: "https://docs.python.org/3/" } })).toBe("deny");
    expect(await denied({ toolName: "mcp__fetch__get", input: { url: "https://docs.python.org/3/" } })).toBe("deny");
  });

  test("a PreToolUse hook that REWRITES the url is judged on the rewritten one", async () => {
    const rewriteTo = (url: string): HookStage => ({
      async preToolUse() {
        return { decision: "no_opinion", transformedInput: { url, prompt: "p" } };
      },
      async permissionRequest() {
        return null;
      },
    });
    expect((await evaluate(fetchCall("https://docs.python.org/3/"), harness({ mode: "dontAsk", hookStage: rewriteTo("https://evil.test/") }).ctx)).decision).toBe("deny");
    expect((await evaluate(fetchCall("https://evil.test/"), harness({ mode: "dontAsk", hookStage: rewriteTo("https://docs.python.org/3/") }).ctx)).decision).toBe("allow");
  });
});

// =====================================================================================================
// 3. The private-address policy: allow | ask | deny  x  host rule present/absent  x  can/cannot prompt
// =====================================================================================================

// Lexically private AND something the executor will really try: an IPv4 literal (four labels) or a
// name the URL parser leaves with two or more dot-separated labels. These are the targets an approval
// can actually do something about, so these are the ones that ask.
const PRIVATE_URLS = [
  "http://192.168.1.10:8080/status",
  "http://10.0.0.5/",
  "http://172.16.9.9/",
  "http://127.0.0.1:3000/",
  "http://127.1/", // IPv4 shorthand -- the url parser expands it
  "http://169.254.169.254/latest/meta-data/", // link-local: the cloud metadata address
  "http://100.64.0.1/", // CGNAT
  "http://api.localhost/",
  "http://printer.local/",
  "http://LOCALHOST./", // the trailing dot leaves TWO labels, so this one is fetchable (claude's behaviour too)
];

// Lexically private AND lexically UNFETCHABLE: `localhost` and every IPv6 literal are a single
// dot-separated label, which WebFetch refuses before any network access (whole-branch review M2). No
// prompt is raised for these at all -- see the dedicated describe block at the end of this section.
const UNFETCHABLE_PRIVATE_URLS = ["http://localhost:5173/", "http://[::1]:3000/", "http://[fd00::1]/", "http://[::1]:5173/"];

describe("privateAddressPolicy 'ask' (the default) -- a real pre-execution ask", () => {
  test("every lexically-private target asks, and the prompt says why and names the rule that would satisfy it", async () => {
    for (const url of PRIVATE_URLS) {
      const h = harness({ privateAddressPolicy: "ask", answer: ALLOW });
      const record = await evaluate(fetchCall(url), h.ctx);
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]!.meta.decisionReason).toContain("private or loopback address");
      expect(h.prompts[0]!.meta.decisionReason).toContain("WebFetch(domain:");
      expect(record).toMatchObject({ decision: "allow", mechanism: "canUseTool", explicitApproval: "prompt" });
    }
  });

  test("an ABSENT policy, and an unrecognised one, both behave as 'ask' -- fail closed", async () => {
    for (const privateAddressPolicy of [undefined, "sometimes", "ALLOW", ""]) {
      const h = harness({ mode: "bypassPermissions", answer: REFUSE, ...(privateAddressPolicy !== undefined ? { privateAddressPolicy } : {}) });
      expect((await evaluate(fetchCall("http://192.168.1.10/"), h.ctx)).decision).toBe("deny");
      expect(h.prompts).toHaveLength(1);
    }
  });

  test("it asks even where the MODE would allow silently -- bypassPermissions, and auto without consulting the classifier", async () => {
    for (const mode of ["bypassPermissions", "auto", "acceptEdits", "plan"] as const) {
      const h = harness({ mode, privateAddressPolicy: "ask", answer: REFUSE, sessionBypassEnabled: true });
      const record = await evaluate(fetchCall("http://192.168.1.10/"), h.ctx);
      expect(record.decision).toBe("deny");
      expect(h.prompts).toHaveLength(1);
      expect(h.classified).toHaveLength(0); // a classifier's verdict is not a person's consent
    }
  });

  test("it asks even where a BROAD allow rule would allow silently -- bare, Tool(*), and globs that cover the host", async () => {
    for (const broad of ["WebFetch", "WebFetch(*)", "WebFetch(domain:*)", "WebFetch(domain:192.168.1.*)", "WebFetch(domain:192.168.1.11)"]) {
      const h = harness({ privateAddressPolicy: "ask", rules: [rule(broad, "allow")], answer: REFUSE });
      const record = await evaluate(fetchCall("http://192.168.1.10/"), h.ctx);
      expect(record.decision).toBe("deny");
      expect(h.prompts).toHaveLength(1);
    }
  });

  test("it asks even where a PreToolUse hook pre-approved the call", async () => {
    const approving: HookStage = {
      async preToolUse() {
        return { decision: "allow", hookId: "auto-approver" };
      },
      async permissionRequest() {
        return null;
      },
    };
    const h = harness({ privateAddressPolicy: "ask", hookStage: approving, answer: REFUSE });
    expect((await evaluate(fetchCall("http://127.0.0.1:3000/"), h.ctx)).decision).toBe("deny");
    expect(h.prompts).toHaveLength(1);
  });

  test("an allow rule naming THAT EXACT host is standing consent: no prompt, allowed, marked 'rule' -- in every mode that can allow", async () => {
    for (const mode of ALL_MODES) {
      const h = harness({ mode, privateAddressPolicy: "ask", rules: [rule("WebFetch(domain:192.168.1.10)", "allow")], answer: REFUSE, sessionBypassEnabled: true });
      const record = await evaluate(fetchCall("http://192.168.1.10:8080/status"), h.ctx);
      expect(record.decision).toBe("allow");
      expect(record.explicitApproval).toBe("rule"); // under bypass the MODE allowed it, and the rule's consent is still recorded
      expect(h.prompts).toHaveLength(0);
    }
    // Named hosts work the same way. (`localhost` and an IPv6 literal are not in this table: they are
    // lexically unfetchable, so they never reach the ask a rule would satisfy -- see below.)
    for (const [ruleText, url] of [
      ["WebFetch(domain:api.localhost)", "http://api.localhost/"],
      ["WebFetch(domain:printer.local)", "http://printer.local/"],
      ["WebFetch(domain:127.0.0.1)", "http://127.1/"],
    ] as const) {
      const h = harness({ mode: "dontAsk", privateAddressPolicy: "ask", rules: [rule(ruleText, "allow")] });
      expect(await evaluate(fetchCall(url), h.ctx)).toMatchObject({ decision: "allow", explicitApproval: "rule" });
    }
  });

  test("a project-tier host rule in an UNTRUSTED workspace is not consent -- it still asks", async () => {
    const rules = [rule("WebFetch(domain:192.168.1.10)", "allow", "project")];
    const untrusted = harness({ privateAddressPolicy: "ask", rules, trustedWorkspace: false, answer: REFUSE });
    expect((await evaluate(fetchCall("http://192.168.1.10/"), untrusted.ctx)).decision).toBe("deny");
    expect(untrusted.prompts).toHaveLength(1);
    const trusted = harness({ privateAddressPolicy: "ask", rules, trustedWorkspace: true, answer: REFUSE });
    expect(await evaluate(fetchCall("http://192.168.1.10/"), trusted.ctx)).toMatchObject({ decision: "allow", explicitApproval: "rule" });
  });

  test("a deny rule for the host beats both the ask and a host allow rule", async () => {
    const h = harness({ privateAddressPolicy: "ask", rules: [rule("WebFetch(domain:192.168.1.10)", "allow"), rule("WebFetch(domain:192.168.1.10)", "deny")], answer: ALLOW });
    expect(await evaluate(fetchCall("http://192.168.1.10/"), h.ctx)).toMatchObject({ decision: "deny", mechanism: "rule" });
    expect(h.prompts).toHaveLength(0);
  });

  test("CANNOT PROMPT, no host rule: dontAsk DENIES and names the rule that would permit it", async () => {
    const h = harness({ mode: "dontAsk", privateAddressPolicy: "ask", answer: ALLOW });
    const record = await evaluate(fetchCall("http://192.168.1.10:8080/"), h.ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
    expect(record.message).toContain("192.168.1.10");
    expect(record.message).toContain("WebFetch(domain:192.168.1.10)");
    expect(h.prompts).toHaveLength(0); // dontAsk never calls the prompt handler
  });

  test("CANNOT PROMPT, no host rule: a session with NO prompt handler is denied -- it does not hang and is not allowed", async () => {
    for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const) {
      const record = await evaluate(fetchCall("http://api.localhost:5173/"), harness({ mode, privateAddressPolicy: "ask", sessionBypassEnabled: true }).ctx);
      expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
      expect(record.message).toContain("no prompt handler answered");
      expect(record.message).toContain("WebFetch(domain:api.localhost)");
    }
  });

  test("CANNOT PROMPT, host rule PRESENT: allowed -- the rule is the consent, no prompt was ever needed", async () => {
    const rules = [rule("WebFetch(domain:api.localhost)", "allow")];
    expect(await evaluate(fetchCall("http://api.localhost:5173/"), harness({ mode: "dontAsk", privateAddressPolicy: "ask", rules }).ctx)).toMatchObject({ decision: "allow", explicitApproval: "rule" });
    expect(await evaluate(fetchCall("http://api.localhost:5173/"), harness({ mode: "default", privateAddressPolicy: "ask", rules }).ctx)).toMatchObject({ decision: "allow", explicitApproval: "rule" });
  });

  test("a PermissionRequest hook's allow is an ANSWER to the ask, and is marked 'prompt'", async () => {
    const answering: HookStage = {
      async preToolUse() {
        return { decision: "no_opinion" };
      },
      async permissionRequest() {
        return { decision: "allow", hookId: "policy-bot" };
      },
    };
    const record = await evaluate(fetchCall("http://192.168.1.10/"), harness({ privateAddressPolicy: "ask", hookStage: answering }).ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "hook", explicitApproval: "prompt" });
  });

  test("a PUBLIC target is untouched by the policy -- and a plain prompt approval of one is still marked, a mode allow is not", async () => {
    const prompted = harness({ privateAddressPolicy: "ask", answer: ALLOW });
    const record = await evaluate(fetchCall("https://example.com/"), prompted.ctx);
    expect(record).toMatchObject({ decision: "allow", explicitApproval: "prompt" });
    expect(prompted.prompts[0]!.meta.decisionReason).not.toContain("private");

    const bypass = await evaluate(fetchCall("https://example.com/"), harness({ mode: "bypassPermissions", privateAddressPolicy: "ask" }).ctx);
    expect(bypass).toMatchObject({ decision: "allow", mechanism: "mode" });
    expect(bypass.explicitApproval).toBeUndefined();

    const broad = await evaluate(fetchCall("https://example.com/"), harness({ privateAddressPolicy: "ask", rules: [rule("WebFetch(domain:*)", "allow")] }).ctx);
    expect(broad).toMatchObject({ decision: "allow", mechanism: "rule" });
    expect(broad.explicitApproval).toBeUndefined(); // a glob never NAMED this host

    const exact = await evaluate(fetchCall("https://example.com/"), harness({ privateAddressPolicy: "ask", rules: [rule("WebFetch(domain:example.com)", "allow")] }).ctx);
    expect(exact).toMatchObject({ decision: "allow", mechanism: "rule", explicitApproval: "rule" });
  });

  test("a prompt answer that REWRITES the url is marked for what will execute, not for what was asked", async () => {
    const rules = [rule("WebFetch(domain:192.168.1.10)", "allow"), rule("WebFetch(domain:192.168.1.10)", "ask")];
    const h = harness({ privateAddressPolicy: "ask", rules, answer: { decision: "allow", transformedInput: { url: "http://192.168.1.99/", prompt: "p" } } });
    const record = await evaluate(fetchCall("http://192.168.1.10/"), h.ctx);
    expect(record.explicitApproval).toBe("prompt"); // the host rule names .10, and .99 is what runs
  });

  test("the marker is WebFetch's alone -- no other tool's record changes shape", async () => {
    const record = await evaluate({ toolName: "Bash", input: { command: "make deploy" } }, harness({ answer: ALLOW }).ctx);
    expect(record).toEqual({ decision: "allow", mechanism: "canUseTool", policyVersion: 7 });
    const search = await evaluate(searchCall(), harness({ answer: ALLOW }).ctx);
    expect(search).toEqual({ decision: "allow", mechanism: "canUseTool", policyVersion: 7 });
  });
});

describe("privateAddressPolicy 'deny' and 'allow'", () => {
  test("'deny': every private target is DENIED, host rule or not, prompt or not, in every mode -- and nothing is asked", async () => {
    for (const mode of ALL_MODES) {
      for (const rules of [[], [rule("WebFetch(domain:192.168.1.10)", "allow")], [rule("WebFetch", "allow")]]) {
        for (const answer of [ALLOW, undefined]) {
          const h = harness({ mode, privateAddressPolicy: "deny", rules, sessionBypassEnabled: true, ...(answer !== undefined ? { answer } : {}) });
          const record = await evaluate(fetchCall("http://192.168.1.10/"), h.ctx);
          expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
          expect(record.message).toContain("policy denies WebFetch access to private addresses");
          expect(h.prompts).toHaveLength(0);
        }
      }
    }
  });

  test("'deny' leaves a public target alone", async () => {
    expect((await evaluate(fetchCall("https://example.com/"), harness({ mode: "bypassPermissions", privateAddressPolicy: "deny" }).ctx)).decision).toBe("allow");
  });

  test("'allow': a private target gets NO extra ask -- it is an ordinary fetch (host rule absent and present, can and cannot prompt)", async () => {
    const bypass = harness({ mode: "bypassPermissions", privateAddressPolicy: "allow", answer: REFUSE });
    expect((await evaluate(fetchCall("http://192.168.1.10/"), bypass.ctx)).decision).toBe("allow");
    expect(bypass.prompts).toHaveLength(0);

    const broad = harness({ mode: "dontAsk", privateAddressPolicy: "allow", rules: [rule("WebFetch", "allow")] });
    expect((await evaluate(fetchCall("http://192.168.1.10/"), broad.ctx)).decision).toBe("allow");

    const withRule = harness({ mode: "dontAsk", privateAddressPolicy: "allow", rules: [rule("WebFetch(domain:192.168.1.10)", "allow")] });
    expect(await evaluate(fetchCall("http://192.168.1.10/"), withRule.ctx)).toMatchObject({ decision: "allow", explicitApproval: "rule" });

    // No rule, default mode: the ORDINARY unmatched-action prompt, with no private-address wording.
    const ordinary = harness({ privateAddressPolicy: "allow", answer: ALLOW });
    await evaluate(fetchCall("http://192.168.1.10/"), ordinary.ctx);
    expect(ordinary.prompts[0]!.meta.decisionReason).toBe("unmatched action reached the prompt stage");
    // ...and with no handler it is the ordinary unmatched denial.
    expect((await evaluate(fetchCall("http://192.168.1.10/"), harness({ privateAddressPolicy: "allow" }).ctx)).decision).toBe("deny");
  });

  test("an unparseable url is never 'private' -- the policy stays out of it under every value", async () => {
    for (const privateAddressPolicy of ["allow", "ask", "deny"]) {
      const h = harness({ mode: "bypassPermissions", privateAddressPolicy, answer: REFUSE });
      expect((await evaluate(fetchCall("http://[::1"), h.ctx)).decision).toBe("allow"); // bypass allows; the executor rejects the url itself
      expect(h.prompts).toHaveLength(0);
    }
  });

  test("the policy is WebFetch's alone", async () => {
    const h = harness({ mode: "bypassPermissions", privateAddressPolicy: "deny" });
    expect((await evaluate({ toolName: "mcp__http__get", input: { url: "http://192.168.1.10/" } }, h.ctx)).decision).toBe("allow");
  });
});

// =====================================================================================================
// 3b. A URL the EXECUTOR is certain to refuse lexically is never prompted for (whole-branch review M2)
// =====================================================================================================

describe("a lexically unfetchable WebFetch target raises NO ask and suggests NO rule", () => {
  test("localhost and an IPv6 literal: no prompt in any mode, and the reason says the executor refuses it", async () => {
    for (const url of UNFETCHABLE_PRIVATE_URLS) {
      for (const mode of ALL_MODES) {
        // `answer: ALLOW` on purpose: a prompt that DID fire would be answered and would pass, so the
        // only thing this can be measuring is whether one fired at all.
        const h = harness({ mode, privateAddressPolicy: "ask", answer: ALLOW, sessionBypassEnabled: true });
        const record = await evaluate(fetchCall(url), h.ctx);
        expect([url, mode, record.decision]).toEqual([url, mode, "allow"]);
        expect([url, mode, h.prompts.length]).toEqual([url, mode, 0]);
        expect([url, mode, record.decisionReason]).toEqual([url, mode, UNFETCHABLE_URL_REASON]);
        // Nothing was approved for this call, so no marker may make the executor treat it as consented.
        expect(record.explicitApproval).toBeUndefined();
      }
    }
  });

  test("it holds for a session that CANNOT prompt -- no hang, no denial naming a rule that would not help", async () => {
    for (const url of ["http://localhost:5173/", "http://[::1]:5173/"]) {
      const h = harness({ mode: "dontAsk", privateAddressPolicy: "ask" });
      const record = await evaluate(fetchCall(url), h.ctx);
      expect([url, record.decision]).toEqual([url, "allow"]);
      expect(record.message).toBeUndefined();
      expect(h.prompts).toHaveLength(0);
    }
  });

  test("it is not limited to private hosts: a single-label public name, and a url with credentials, are refused by the executor too", async () => {
    for (const url of ["https://intranet/docs", "https://user:secret@example.com/x"]) {
      const h = harness({ privateAddressPolicy: "ask", answer: ALLOW });
      expect([url, (await evaluate(fetchCall(url), h.ctx)).decisionReason]).toEqual([url, UNFETCHABLE_URL_REASON]);
      expect(h.prompts).toHaveLength(0);
    }
  });

  test("a DENY rule still wins over it -- the short-circuit sits after stage 2, never before it", async () => {
    for (const raw of ["WebFetch", "WebFetch(domain:localhost)"]) {
      const h = harness({ privateAddressPolicy: "ask", rules: [rule(raw, "deny")], answer: ALLOW });
      expect([raw, (await evaluate(fetchCall("http://localhost:5173/"), h.ctx)).decision]).toEqual([raw, "deny"]);
    }
    // ...and so does the `deny` POSTURE, which is a policy statement rather than a prompt.
    const denied = await evaluate(fetchCall("http://localhost:5173/"), harness({ privateAddressPolicy: "deny", answer: ALLOW }).ctx);
    expect(denied).toMatchObject({ decision: "deny", mechanism: "mode" });
  });

  test("an UNPARSEABLE url is NOT covered: it names no host, so it keeps prompting exactly as before", async () => {
    const h = harness({ privateAddressPolicy: "ask", answer: ALLOW });
    const record = await evaluate(fetchCall("not a url"), h.ctx);
    expect(h.prompts).toHaveLength(1);
    expect(record.decisionReason).not.toBe(UNFETCHABLE_URL_REASON);
  });

  test("the ask a FETCHABLE private target raises tells the truth about what is reachable", async () => {
    const h = harness({ privateAddressPolicy: "ask", answer: ALLOW });
    await evaluate(fetchCall("http://192.168.1.10/"), h.ctx);
    const reason = h.prompts[0]!.meta.decisionReason!;
    expect(reason).toContain("WebFetch(domain:192.168.1.10)");
    expect(reason).toContain("upgrades http to https");
    expect(reason).toContain("two or more dot-separated labels");
    expect(reason).not.toContain("dev server"); // the promise the doc and this text used to make
  });
});

// =====================================================================================================
// 4. WebSearch -- bare rules only
// =====================================================================================================

describe("WebSearch rules", () => {
  test("a bare DENY denies, in every mode", async () => {
    for (const mode of ALL_MODES) {
      const h = harness({ mode, rules: [rule("WebSearch", "deny")], answer: ALLOW, sessionBypassEnabled: true });
      const record = await evaluate(searchCall(), h.ctx);
      expect(record).toMatchObject({ decision: "deny", mechanism: "rule", deniedBareSchemaRemoval: true });
      expect(h.prompts).toHaveLength(0);
    }
  });

  test("a bare ASK prompts even under bypassPermissions, and dontAsk denies it", async () => {
    const h = harness({ mode: "bypassPermissions", rules: [rule("WebSearch", "ask")], answer: ALLOW });
    expect(await evaluate(searchCall(), h.ctx)).toMatchObject({ decision: "allow", mechanism: "canUseTool" });
    expect(h.prompts[0]!.meta.matchedAskRule).toEqual({ source: "user", toolName: "WebSearch" });
    expect((await evaluate(searchCall(), harness({ mode: "dontAsk", rules: [rule("WebSearch", "ask")], answer: ALLOW }).ctx)).decision).toBe("deny");
  });

  test("a bare ALLOW allows with no prompt -- including under dontAsk, where an unmatched search is denied", async () => {
    const h = harness({ mode: "dontAsk", rules: [rule("WebSearch", "allow")], answer: REFUSE });
    expect(await evaluate(searchCall(), h.ctx)).toMatchObject({ decision: "allow", mechanism: "rule" });
    expect(h.prompts).toHaveLength(0);
    expect((await evaluate(searchCall(), harness({ mode: "dontAsk" }).ctx)).decision).toBe("deny");
    // WebSearch(*) is the bare rule by another spelling.
    expect((await evaluate(searchCall(), harness({ mode: "dontAsk", rules: [rule("WebSearch(*)", "allow")] }).ctx)).decision).toBe("allow");
  });

  test("with no rule it 'requires permission': default asks, and no handler is a denial", async () => {
    const h = harness({ answer: ALLOW });
    expect((await evaluate(searchCall(), h.ctx)).decision).toBe("allow");
    expect(h.prompts).toHaveLength(1);
    expect((await evaluate(searchCall(), harness({}).ctx)).decision).toBe("deny");
  });

  test("a SCOPED rule cannot be loaded at all -- it never becomes a rule that silently matches nothing", () => {
    for (const behavior of ["allow", "deny", "ask"] as const) {
      expect(() => rule("WebSearch(query:bun test runner)", behavior)).toThrow(/WebSearch has no specifier grammar/);
      expect(() => rule("WebSearch(bun*)", behavior)).toThrow(/WebSearch has no specifier grammar/);
    }
  });

  test("a WebFetch domain rule does not reach WebSearch, and vice versa", async () => {
    expect((await evaluate(searchCall(), harness({ mode: "dontAsk", rules: [rule("WebFetch(domain:example.com)", "allow")] }).ctx)).decision).toBe("deny");
    expect((await evaluate(fetchCall("https://example.com/"), harness({ mode: "dontAsk", rules: [rule("WebSearch", "allow")] }).ctx)).decision).toBe("deny");
  });
});
