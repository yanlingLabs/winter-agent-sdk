import { describe, expect, test } from "bun:test";
import { convertFetchedHtml, decodeHtmlEntities, htmlToMarkdown, WEB_FETCH_HTML_TRUNCATION_NOTICE } from "./_web-fetch-html.ts";

describe("decodeHtmlEntities", () => {
  test("named entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeHtmlEntities("&quot;q&quot; &#39;a&#39;")).toBe('"q" \'a\'');
    expect(decodeHtmlEntities("em&mdash;dash")).toBe("em—dash");
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
  });

  test("numeric decimal and hex", () => {
    expect(decodeHtmlEntities("&#8212;")).toBe("—");
    expect(decodeHtmlEntities("&#x2014;")).toBe("—");
    expect(decodeHtmlEntities("&#X2014;")).toBe("—");
  });

  test("unknown entity passes through unchanged", () => {
    expect(decodeHtmlEntities("&hamilt;")).toBe("&hamilt;");
  });

  test("no ampersand -> fast path, unchanged", () => {
    expect(decodeHtmlEntities("plain text")).toBe("plain text");
  });

  test("security review minor: NUL and a lone surrogate map to U+FFFD (the HTML spec's own rule), never a raw NUL or an unpaired surrogate", () => {
    expect(decodeHtmlEntities("a&#0;b")).toBe("a�b");
    expect(decodeHtmlEntities("a&#x0;b")).toBe("a�b");
    expect(decodeHtmlEntities("a&#xD800;b")).toBe("a�b");
    expect(decodeHtmlEntities("a&#55296;b")).toBe("a�b"); // 0xD800 in decimal
    expect(decodeHtmlEntities("a&#xDFFF;b")).toBe("a�b");
    // a well-formed SURROGATE PAIR (not a lone one) still decodes to the real character it encodes.
    expect(decodeHtmlEntities("&#x1F600;")).toBe("\u{1F600}");
  });
});

describe("htmlToMarkdown -- headings", () => {
  test("h1/h2 setext, h3-h6 atx", async () => {
    const md = await htmlToMarkdown("<h1>One</h1><h2>Two</h2><h3>Three</h3><h6>Six</h6>");
    expect(md).toBe(["One", "===", "", "Two", "---", "", "### Three", "", "###### Six"].join("\n"));
  });

  test("inline formatting inside a heading is preserved", async () => {
    const md = await htmlToMarkdown("<h3>Hello <b>World</b></h3>");
    expect(md).toBe("### Hello **World**");
  });
});

describe("htmlToMarkdown -- paragraphs and inline formatting", () => {
  test("basic paragraph with bold/italic/link", async () => {
    const md = await htmlToMarkdown('<p>Hello <strong>world</strong> and <em>emphasis</em>, see <a href="https://example.com">a link</a>.</p>');
    expect(md).toBe("Hello **world** and _emphasis_, see [a link](https://example.com).");
  });

  test("two paragraphs are blank-line separated", async () => {
    const md = await htmlToMarkdown("<p>First.</p><p>Second.</p>");
    expect(md).toBe("First.\n\nSecond.");
  });

  test("entities decode inside text and attributes", async () => {
    const md = await htmlToMarkdown('<p>Tom &amp; Jerry <a href="/p?a=1&amp;b=2" title="T &amp; T">link</a></p>');
    expect(md).toBe('Tom & Jerry [link](/p?a=1&b=2 "T & T")');
  });

  test("img renders alt/src/title", async () => {
    const md = await htmlToMarkdown('<img src="https://ex.com/a.png" alt="A pic" title="T">');
    expect(md).toBe('![A pic](https://ex.com/a.png "T")');
  });

  test("br becomes two trailing spaces then a newline", async () => {
    const md = await htmlToMarkdown("<p>line one<br>line two</p>");
    expect(md).toBe("line one  \nline two");
  });

  test("hr becomes the setext-style rule", async () => {
    const md = await htmlToMarkdown("<p>a</p><hr><p>b</p>");
    expect(md).toBe("a\n\n* * *\n\nb");
  });

  test("code wraps in backticks; backticks inside content bump the fence", async () => {
    expect(await htmlToMarkdown("<p>Use <code>foo()</code> here.</p>")).toBe("Use `foo()` here.");
    expect(await htmlToMarkdown("<p><code>a`b</code></p>")).toBe("``a`b``");
  });
});

describe("htmlToMarkdown -- removed subtrees", () => {
  test("style/script/noscript/iframe produce no output at all -- in `head` and in `body` alike", async () => {
    const md = await htmlToMarkdown(
      "<html><head><style>.x{color:red}</style><script>evil()</script><meta charset=\"utf-8\"><link rel=\"x\" href=\"y\"></head><body><script>evil()</script><p>Real content</p><noscript>no js</noscript><iframe src=\"https://x\"></iframe></body></html>",
    );
    expect(md).toBe("Real content");
  });
});

// claude converts the WHOLE document, not `document.body`, so the one piece of `head` that is prose
// -- the title -- opens its output (measured against the pinned binary). This module used to skip
// `head` whole and pinned "Ignored Title"; the title is now the first paragraph.
describe("htmlToMarkdown -- the page title", () => {
  test("the <title> text is the opening paragraph; the rest of head contributes nothing", async () => {
    const md = await htmlToMarkdown("<!doctype html><html><head><meta charset=\"utf-8\"><title>  Page &amp; Title\n </title><style>.x{}</style><script>window.x = 1;</script></head><body><h1>Heading</h1><p>Body.</p></body></html>");
    expect(md).toBe("Page & Title\n\nHeading\n=======\n\nBody.");
  });

  test("the title is its own paragraph even when the body opens with bare inline text", async () => {
    expect(await htmlToMarkdown("<head><title>T</title></head><body>hello <b>x</b></body>")).toBe("T\n\nhello **x**");
  });

  test("markup-looking text inside <title> is text (it is an RCDATA element), and an empty title adds nothing", async () => {
    expect(await htmlToMarkdown("<head><title>a <b>not bold</b></title></head><body><p>x</p></body>")).toBe("a <b>not bold</b>\n\nx");
    expect(await htmlToMarkdown("<head><title> </title></head><body><p>x</p></body>")).toBe("x");
  });
});

// Turndown's own `listItem` rule: `*` + THREE spaces, `N.` + TWO, and a FIXED four-space continuation
// indent. (This block used to pin `* one`, `3. x` and a two-space nested indent after a blank line --
// a generic markdown shape, not Turndown's.) Byte-identical on every non-blank line; the one disclosed
// deviation is that a BLANK line inside an item stays empty, where Turndown writes four bare spaces.
describe("htmlToMarkdown -- lists", () => {
  test("an unordered list: `*` and three spaces", async () => {
    const md = await htmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
    expect(md).toBe("*   one\n*   two");
  });

  test("an ordered list honours start=: `N.` and two spaces", async () => {
    const md = await htmlToMarkdown('<ol start="3"><li>x</li><li>y</li></ol>');
    expect(md).toBe("3.  x\n4.  y");
  });

  test("a nested list sits directly under its parent item, indented four spaces", async () => {
    const md = await htmlToMarkdown("<ul><li>outer<ul><li>inner</li></ul></li></ul>");
    expect(md).toBe("*   outer\n    *   inner");
    expect(await htmlToMarkdown("<ol><li>outer<ol><li>inner</li><li>two</li></ol></li><li>next</li></ol>")).toBe("1.  outer\n    1.  inner\n    2.  two\n2.  next");
  });

  test("the continuation indent is a FIXED four spaces, not the marker's width (item 10 and up); a blank line inside an item stays EMPTY (disclosed: Turndown pads it to four spaces)", async () => {
    const md = await htmlToMarkdown(`<ol start="10"><li><p>first</p><p>second</p></li></ol>`);
    expect(md).toBe("10.  first\n\n    second");
    // The same output with Turndown's padding applied is the ONLY difference.
    expect(md.replace("\n\n", "\n    \n")).toBe("10.  first\n    \n    second");
  });
});

describe("htmlToMarkdown -- blockquote", () => {
  test("every line is prefixed with '> '", async () => {
    const md = await htmlToMarkdown("<blockquote><p>Quoted text.</p></blockquote>");
    expect(md).toBe("> Quoted text.");
  });
});

describe("htmlToMarkdown -- pre/code blocks", () => {
  test("indented, 4 spaces, no fence, nested formatting ignored, whitespace preserved", async () => {
    const md = await htmlToMarkdown("<pre><code>const x = 1;\nconsole.log(x);</code></pre>");
    expect(md).toBe("    const x = 1;\n    console.log(x);");
  });

  test("bold inside pre is NOT turned into markdown delimiters", async () => {
    const md = await htmlToMarkdown("<pre><code>plain <b>not bold</b> text</code></pre>");
    expect(md).toBe("    plain not bold text");
  });
});

describe("htmlToMarkdown -- tables are generic blocks (no GFM), per Turndown's own defaults", () => {
  test("each cell becomes its own block, blank-line separated", async () => {
    const md = await htmlToMarkdown("<table><tr><td>a</td><td>b</td></tr></table>");
    expect(md).toBe("a\n\nb");
  });
});

describe("htmlToMarkdown -- malformed markup", () => {
  test("an unclosed tag at end-of-stream is force-closed, content not dropped", async () => {
    const md = await htmlToMarkdown("<p>Unterminated paragraph");
    expect(md).toBe("Unterminated paragraph");
  });
});

describe("htmlToMarkdown -- security review finding M3: omitted end tags (everyday HTML) do not drop content", () => {
  test("<ul><li>a<li>b</ul> -- both bullets survive, correctly separated", async () => {
    const md = await htmlToMarkdown("<ul><li>a<li>b</ul>");
    expect(md).toBe("*   a\n*   b");
  });

  test("<table><tr><td>x<td>y</table> -- both cells survive", async () => {
    const md = await htmlToMarkdown("<table><tr><td>x<td>y</table>");
    expect(md).toBe("x\n\ny");
  });

  test("<div><p>one<p>two</div><p>three</p> -- all three paragraphs survive, in order", async () => {
    const md = await htmlToMarkdown("<div><p>one<p>two</div><p>three</p>");
    expect(md).toBe("one\n\ntwo\n\nthree");
  });

  test("<div><span>hello</div> -- an entirely unclosed descendant's text is not lost", async () => {
    const md = await htmlToMarkdown("<div><span>hello</div>");
    expect(md).toBe("hello");
  });

  test("<div><span>hello</div> nested two levels deep, with trailing sibling text", async () => {
    const md = await htmlToMarkdown("<div><p>a<span>b<b>c</div>tail");
    // a, b and c all survive (b/c unclosed, force-closed by the div's own close); "tail" is root-level
    // text AFTER the div, proving onDocument text still interleaves correctly around the fix.
    expect(md).toBe("ab**c**\n\ntail");
  });

  test("root-level (unwrapped) text is captured -- security review finding M3, part 2", async () => {
    expect(await htmlToMarkdown("hello <b>bold</b> world")).toBe("hello **bold** world");
    expect(await htmlToMarkdown("tail only")).toBe("tail only");
  });

  test("dt/dd sibling omission", async () => {
    const md = await htmlToMarkdown("<dl><dt>Term<dd>Definition<dt>Term2<dd>Def2</dl>");
    expect(md).toContain("Term");
    expect(md).toContain("Definition");
    expect(md).toContain("Term2");
    expect(md).toContain("Def2");
  });
});

describe("htmlToMarkdown -- security review finding M4: performance on hostile input", () => {
  test("300KB of individually-wrapped <b> characters converts well under a second (depth cap bounds the quadratic blowup)", async () => {
    const html = Array.from({ length: 100_000 }, (_, i) => `<b>${i % 10}</b>`).join("");
    const t0 = Date.now();
    const md = await htmlToMarkdown(html);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    expect(md.length).toBeGreaterThan(0);
  });

  test("a <code> block with 500,000 backticks converts in well under a second", async () => {
    const html = `<pre><code>${"`".repeat(500_000)}</code></pre>`;
    const t0 = Date.now();
    const md = await htmlToMarkdown(html);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    expect(md.length).toBeGreaterThan(0);
  });

  test("a single inline <code> run with many backticks (not inside pre) fences correctly AND quickly", async () => {
    const html = `<p><code>${"`".repeat(50_000)}x</code></p>`;
    const t0 = Date.now();
    const md = await htmlToMarkdown(html);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(md.startsWith("`".repeat(50_001))).toBe(true); // fence = longest run + 1
  });

  test("the full 1,048,576-char conversion cap completes quickly even on deeply-nested hostile input", async () => {
    const one = "<b>";
    const openCount = Math.floor(1_048_000 / one.length);
    const html = one.repeat(openCount) + "x";
    const t0 = Date.now();
    await convertFetchedHtml(html);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("convertFetchedHtml -- security review finding N2: nesting-driven output amplification is bounded", () => {
  // The reviewer's own two worst measured cases (bounded generators, matching probe12.ts):
  //   512 nested <blockquote> around ~200k <br>-separated lines (~1 MiB HTML in) -- pre-fix: 214 MB
  //   out, 37.7s, 7.4 GB peak RSS.
  //   500 nested <blockquote> around a 400,000-line <pre> (~806 KB in) -- pre-fix: 402 MB out, 40.8s,
  //   7.5 GB peak RSS.
  // Both ran synchronously and were UNINTERRUPTIBLE by `ctx.signal`/the hop timeout, which govern the
  // NETWORK phase only -- a slow conversion has no abort path of its own.
  const CAP = 1_048_576;

  function bq512BrLines(): string {
    const prefix = "<blockquote>".repeat(512);
    const unit = "a<br>";
    const bodyLen = CAP - prefix.length;
    return prefix + unit.repeat(Math.floor(bodyLen / unit.length));
  }

  function preInBq500Lines(): string {
    return "<blockquote>".repeat(500) + "<pre>" + "a\n".repeat(400_000);
  }

  function measureRssMb<T>(fn: () => T): { result: T; ms: number; peakRssMb: number } {
    // WHY a delta, not an absolute: every test file in a full-repo `bun test` shares one
    // process, so absolute RSS already sits at 1.2-1.3 GB from earlier files and an absolute
    // < 1000 MB guard fails on a warm process. The guard's intent is "no 7+ GB spike from THIS
    // conversion" (pre-fix peak ~7,400 MB), so only rss-after-minus-rss-before can catch a real
    // regression without failing on shared-process warmth. A forced GC first keeps the baseline
    // from carrying one test's garbage into the next test's delta.
    const t0 = Date.now();
    collectGarbageForRss();
    const before = process.memoryUsage().rss;
    const result = fn();
    const after = process.memoryUsage().rss;
    const deltaMb = Math.max(0, Math.round((after - before) / (1024 * 1024)));
    return { result, ms: Date.now() - t0, peakRssMb: deltaMb };
  }

  function collectGarbageForRss(): void {
    try {
      (Bun as unknown as { gc?: (force: boolean) => void }).gc?.(true);
    } catch {
      // No GC hook (non-Bun runner?) -- the delta still reads correctly, just noisier.
    }
  }

  test("512 nested <blockquote> around ~200k <br> lines: bounded time, bounded output, no 7+ GB RSS spike", async () => {
    const html = bq512BrLines();
    collectGarbageForRss();
    const before = process.memoryUsage().rss;
    const t0 = Date.now();
    const out = await convertFetchedHtml(html);
    const ms = Date.now() - t0;
    const rssMb = Math.max(0, Math.round((process.memoryUsage().rss - before) / (1024 * 1024)));
    // eslint-disable-next-line no-console
    console.log(`[N2 bq512-br-lines] html=${html.length} ms=${ms} out=${out.length} rssDeltaMB=${rssMb}`);
    expect(ms).toBeLessThan(5000); // pre-fix: 37,700ms
    expect(out.length).toBeLessThan(2_000_000); // pre-fix: 214,000,000+ chars
    expect(rssMb).toBeLessThan(1000); // pre-fix: ~7,400 MB spike; a delta, so shared-process warmth can't trip it
  });

  test("500 nested <blockquote> around a 400,000-line <pre>: bounded time, bounded output, no 7+ GB RSS spike", async () => {
    const html = preInBq500Lines();
    collectGarbageForRss();
    const before = process.memoryUsage().rss;
    const t0 = Date.now();
    const out = await convertFetchedHtml(html);
    const ms = Date.now() - t0;
    const rssMb = Math.max(0, Math.round((process.memoryUsage().rss - before) / (1024 * 1024)));
    // eslint-disable-next-line no-console
    console.log(`[N2 pre-in-bq500-lines] html=${html.length} ms=${ms} out=${out.length} rssDeltaMB=${rssMb}`);
    expect(ms).toBeLessThan(5000); // pre-fix: 40,800ms
    expect(out.length).toBeLessThan(4_000_000); // pre-fix: 402,000,000+ chars
    expect(rssMb).toBeLessThan(1000); // pre-fix: ~7,500 MB spike; a delta, so shared-process warmth can't trip it
  });

  test("a budget-exceeding conversion falls back to raw HTML (claude's own turndown-throws rule), never propagates the throw", async () => {
    // A shape the 32-level prefix cap does NOT anticipate (deep GENERIC block nesting, not
    // blockquote/ul/ol) -- still bounded, but by the byte BUDGET backstop specifically. Assert the
    // budget genuinely trips for pathological-enough input and that `convertFetchedHtml` still
    // returns a usable string rather than rejecting.
    const html = "<div>".repeat(500) + "x".repeat(CAP - 3000);
    const out = await convertFetchedHtml(html);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("ordinary, non-adversarial nested blockquotes still render correctly under the prefix-depth cap", async () => {
    const html = "<blockquote><blockquote><blockquote><p>three deep</p></blockquote></blockquote></blockquote>";
    const out = await convertFetchedHtml(html);
    expect(out).toBe("> > > three deep");
  });
});

describe("convertFetchedHtml -- security review nit: a depth-capped transparent element still leaves a separator", () => {
  test("text on either side of a skipped block-level element does not run together", async () => {
    const html = "<b>".repeat(600) + "DEEP-TEXT" + "</b>".repeat(300) + "<p>deep para</p>" + "<b>deep bold</b>" + "</b>".repeat(300);
    const out = await convertFetchedHtml(html);
    expect(out).not.toContain("DEEP-TEXTdeep para");
    expect(out).not.toContain("paradeep bold");
  });
});

describe("htmlToMarkdown -- security review finding N5: ul/ol no longer drop non-li children", () => {
  test("a bare nested <ul> directly inside another <ul> (not wrapped in <li>) is not dropped", async () => {
    const md = await htmlToMarkdown("<ul><li>a</li><ul><li>nested</li></ul><li>b</li></ul>");
    expect(md).toContain("a");
    expect(md).toContain("nested");
    expect(md).toContain("b");
  });

  test("stray text and a block element directly inside a <ul> are not dropped", async () => {
    const md = await htmlToMarkdown("<ul>stray text<div>div-in-ul</div><li>ok</li></ul>");
    expect(md).toContain("stray text");
    expect(md).toContain("div-in-ul");
    expect(md).toContain("ok");
  });
});

describe("convertFetchedHtml -- the truncation cap", () => {
  test("short content is unaffected", async () => {
    const out = await convertFetchedHtml("<p>short</p>");
    expect(out).toBe("short");
  });

  test("content over 1,048,576 chars is capped and the verbatim notice appended", async () => {
    const big = `<p>${"a".repeat(1_100_000)}</p>`;
    const out = await convertFetchedHtml(big);
    expect(out.endsWith(WEB_FETCH_HTML_TRUNCATION_NOTICE)).toBe(true);
    expect(out.length).toBeLessThan(big.length);
  });
});
