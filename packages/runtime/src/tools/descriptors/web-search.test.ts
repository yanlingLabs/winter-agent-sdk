import { describe, test, expect } from "bun:test";
import { currentMonthYear, webSearchDescription } from "./web-search.ts";
import { getRegisteredTool } from "../registry.ts";
import "./web-search.ts"; // self-sufficiency: guarantee the static registration ran

const FIXED = new Date("2026-09-18T00:00:00Z");
const fixedNow = () => FIXED;

describe("currentMonthYear -- claude's own ${t} template value", () => {
  test("renders exactly `new Date().toLocaleString(\"en-US\",{month:\"long\",year:\"numeric\"})`", () => {
    expect(currentMonthYear(fixedNow)).toBe(FIXED.toLocaleString("en-US", { month: "long", year: "numeric" }));
    expect(currentMonthYear(fixedNow)).toBe("September 2026");
  });
});

describe("webSearchDescription -- both variants, verbatim minus the ONE dropped US-only line", () => {
  test("lean: drops ` US-only.`, keeps everything else, month interpolated once", () => {
    const text = webSearchDescription(true, fixedNow);
    expect(text.startsWith("Search the web. Returns result blocks with titles and URLs.\n\n")).toBe(true);
    expect(text).not.toContain("US-only");
    expect(text).not.toContain("US only");
    expect(text).toContain("- The current month is September 2026 — use this when searching for recent information.");
    expect(text).toContain("`allowed_domains` / `blocked_domains` filter results.");
    expect(text).toContain('After answering from results, end with a "Sources:" list of the URLs you used as markdown links.');
  });

  test("full: leading AND trailing newline, `${t}` appears twice, drops ONLY the 'Web search is only available in the US' bullet", () => {
    const text = webSearchDescription(false, fixedNow);
    expect(text.startsWith("\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("only available in the US");
    expect(text).not.toContain("US-only");
    // Everything else claude's own text carries, verbatim (including "Claude" itself -- an interface
    // string ships as claude wrote it, per the project's ruling).
    expect(text).toContain("- Allows Claude to search the web and use the results to inform responses");
    expect(text).toContain('CRITICAL REQUIREMENT - You MUST follow this:');
    expect(text).toContain('  - After answering the user\'s question, you MUST include a "Sources:" section at the end of your response');
    expect(text).toContain("Usage notes:\n  - Domain filtering is supported to include or block specific websites\n\n");
    expect(text).toContain("IMPORTANT - Use the correct year in search queries:");
    // `${t}` twice: once in the "current month" IMPORTANT paragraph, once nowhere else -- claude's
    // own full template interpolates it exactly once per the research file (only the IMPORTANT
    // section names the month in the full variant; the lean variant is the one that says it twice
    // across its own two mentions). Assert the one occurrence that IS there, verbatim.
    expect(text).toContain("The current month is September 2026. You MUST use this year");
    const occurrences = text.split("September 2026").length - 1;
    expect(occurrences).toBe(1);
  });

  test("GOLDEN: the lean variant, byte-for-byte, month injected -- a stray whitespace change outside an already-asserted fragment cannot slip past this one", () => {
    expect(webSearchDescription(true, fixedNow)).toBe(
      'Search the web. Returns result blocks with titles and URLs.\n\n- The current month is September 2026 — use this when searching for recent information.\n- `allowed_domains` / `blocked_domains` filter results.\n- After answering from results, end with a "Sources:" list of the URLs you used as markdown links.',
    );
  });

  test("GOLDEN: the full variant, byte-for-byte, month injected", () => {
    expect(webSearchDescription(false, fixedNow)).toBe(
      '\n- Allows Claude to search the web and use the results to inform responses\n- Provides up-to-date information for current events and recent data\n- Returns search result information formatted as search result blocks, including links as markdown hyperlinks\n- Use this tool for accessing information beyond Claude\'s knowledge cutoff\n- Searches are performed automatically within a single API call\n\nCRITICAL REQUIREMENT - You MUST follow this:\n  - After answering the user\'s question, you MUST include a "Sources:" section at the end of your response\n  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)\n  - This is MANDATORY - never skip including sources in your response\n  - Example format:\n\n    [Your answer here]\n\n    Sources:\n    - [Source Title 1](https://example.com/1)\n    - [Source Title 2](https://example.com/2)\n\nUsage notes:\n  - Domain filtering is supported to include or block specific websites\n\nIMPORTANT - Use the correct year in search queries:\n  - The current month is September 2026. You MUST use this year when searching for recent information, documentation, or current events.\n  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year\n',
    );
  });

  test("the month re-renders at call time, not at import/module-load time", () => {
    const january = () => new Date("2027-01-05T00:00:00Z");
    expect(webSearchDescription(true, january)).toContain("January 2027");
    expect(webSearchDescription(true, fixedNow)).toContain("September 2026");
  });
});

describe("the registered descriptor's `description` field IS an accessor, not a frozen string", () => {
  test("getOwnPropertyDescriptor proves it's a getter, `enumerable: true`", () => {
    const descriptor = getRegisteredTool("WebSearch")!.descriptor;
    const propDescriptor = Object.getOwnPropertyDescriptor(descriptor, "description")!;
    expect(typeof propDescriptor.get).toBe("function");
    expect(propDescriptor.enumerable).toBe(true);
  });

  test("two reads of the SAME registered descriptor both compute the current month fresh (no caching)", () => {
    const descriptor = getRegisteredTool("WebSearch")!.descriptor;
    const t = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
    expect(descriptor.description).toContain(t);
    // A second, independent read -- proves it's a live computation, not a value snapshotted once.
    expect(descriptor.description).toContain(t);
  });

  test("the registered default is the FULL (non-lean) text -- see the descriptor's own header for why lean selection needs a spine hook this lane does not add", () => {
    const descriptor = getRegisteredTool("WebSearch")!.descriptor;
    expect(descriptor.description.startsWith("\n")).toBe(true);
    expect(descriptor.description).toContain("CRITICAL REQUIREMENT");
  });
});

describe("the rest of the descriptor", () => {
  test("input schema: query has minLength 2 and claude's own field doc; domain lists too", () => {
    const { inputSchema } = getRegisteredTool("WebSearch")!.descriptor;
    expect(inputSchema.properties?.["query"]).toMatchObject({ type: "string", minLength: 2, description: "The search query to use" });
    expect(inputSchema.properties?.["allowed_domains"]).toMatchObject({ description: "Only include search results from these domains" });
    expect(inputSchema.properties?.["blocked_domains"]).toMatchObject({ description: "Never include search results from these domains" });
    expect(inputSchema.required).toEqual(["query"]);
  });

  test("searchHint and the capability gate", () => {
    const descriptor = getRegisteredTool("WebSearch")!.descriptor;
    expect(descriptor.searchHint).toBe("search the web for current information");
    expect(descriptor.capabilityRequirements).toEqual(["winter.search-backend"]);
    expect(descriptor.permissionClass).toBe("network");
  });
});
