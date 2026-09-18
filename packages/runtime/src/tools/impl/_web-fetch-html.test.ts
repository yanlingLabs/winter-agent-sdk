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
  test("style/script/noscript/iframe/head produce no output at all", async () => {
    const md = await htmlToMarkdown(
      "<html><head><title>Ignored Title</title><style>.x{color:red}</style></head><body><script>evil()</script><p>Real content</p><noscript>no js</noscript><iframe src=\"https://x\"></iframe></body></html>",
    );
    expect(md).toBe("Real content");
  });
});

describe("htmlToMarkdown -- lists", () => {
  test("an unordered list", async () => {
    const md = await htmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
    expect(md).toBe("* one\n* two");
  });

  test("an ordered list honours start=", async () => {
    const md = await htmlToMarkdown('<ol start="3"><li>x</li><li>y</li></ol>');
    expect(md).toBe("3. x\n4. y");
  });

  test("a nested list is indented under its parent item", async () => {
    const md = await htmlToMarkdown("<ul><li>outer<ul><li>inner</li></ul></li></ul>");
    expect(md).toBe("* outer\n\n  * inner");
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
    expect(md).toBe("* a\n* b");
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
