// HTML -> MARKDOWN for `WebFetch`, in a module that REGISTERS NOTHING (see `_domains.ts`'s own
// header for why this convention exists: both this file and `impl/web-fetch.ts` must be importable
// with no risk of registering another tool).
//
// THE DEPENDENCY DECISION, recorded here rather than only in the report: no HTML-to-markdown package
// (turndown or otherwise) is a dependency anywhere in this workspace today (checked before writing
// this file). Turndown itself needs a DOM to walk (`window.DOMParser` in a browser, `domino`/`jsdom`
// as its Node fallback) -- a real dependency chain, and one more thing to prove survives
// `bun build --compile`. Bun ships a SAX-style HTML parser as a language-level global,
// `HTMLRewriter` (the same lol-html-backed API Cloudflare Workers expose), needing NOTHING from
// node_modules and therefore nothing to bundle at all: it is part of the `bun` binary itself, proven
// against THIS repo's own compiled-binary path (`bun build --compile`) before this module was
// written -- a two-line probe script that imports `HTMLRewriter`, compiles, and runs identically as a
// standalone executable. That is a stronger guarantee than "turndown's dependency tree is MIT and
// pure JS": there is no dependency tree to audit at all.
//
// `HTMLRewriter` does not decode entities in the text/attribute chunks it hands back (measured:
// `&amp;` arrives as the literal four characters `&amp;`) -- `decodeHtmlEntities` below is this
// module's own decoder, covering the numeric forms and the ~40 named entities real pages actually
// use (the HTML5 spec defines over 2000; a WebFetch digest pass has no use for `&hamilt;`).
//
// TURNDOWN-EQUIVALENT DEFAULTS (the extraction's own phrase), reproduced deliberately close to
// Turndown's actual `options.js` defaults rather than a generic markdown renderer of this module's
// own invention: `headingStyle: "setext"` (h1/h2 underlined, h3-h6 atx `#`), `hr: "* * *"`,
// `bulletListMarker: "*"` (rendered `*   item`; numbered `1.  item`), `codeBlockStyle: "indented"` (4-space, never fenced), `emDelimiter: "_"`,
// `strongDelimiter: "**"`, inlined links/images. Turndown's OWN block-element list (no GFM plugin,
// which this omits exactly as "default options" implies) includes `table`/`tr`/`td`/`th`/`thead`/
// `tbody`/`tfoot` as ordinary generic blocks -- NOT a markdown table -- so that is what this module
// does too, however noisy a real table becomes: inventing GFM-shaped table output here would not be
// "Turndown-equivalent defaults," it would be a different tool.

const HTML_TRUNCATION_LIMIT = 1_048_576;
export const WEB_FETCH_HTML_TRUNCATION_NOTICE = "\n\n[Content truncated due to length...]";

// --- entity decoding --------------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  laquo: "«",
  raquo: "»",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  sect: "§",
  para: "¶",
  middot: "·",
  bull: "•",
  dagger: "†",
  Dagger: "‡",
  permil: "‰",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  shy: "­",
  zwnj: "‌",
  zwj: "‍",
  lrm: "‎",
  rlm: "‏",
  larr: "←",
  uarr: "↑",
  rarr: "→",
  darr: "↓",
};

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** The Unicode replacement character -- the HTML spec's own answer for U+0000 and a lone surrogate. */
const REPLACEMENT_CHAR = "�";

/**
 * Security review minor: `&#0;` and `&#xD800;` (a lone UTF-16 surrogate, `0xD800..0xDFFF`) previously
 * round-tripped to U+0000 and an actual lone surrogate respectively -- both are exactly what the HTML
 * spec's own numeric-character-reference algorithm maps to U+FFFD instead, and a lone surrogate in
 * particular is a well-known way to make a downstream JSON/UTF-8 encode step (here: the digest
 * REQUEST to the inner model) fail outright on otherwise ordinary-looking input.
 */
export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      if (codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return REPLACEMENT_CHAR;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

// --- tag classification -----------------------------------------------------------------------------

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Subtree discarded entirely, whatever it contains. claude removes `style`/`script`/`noscript`/
// `iframe` before converting; `template`/`svg`/`math` are this module's own additions (markup, not
// prose). `head` is deliberately NOT here: see `HEAD_TEXT_TAGS` below.
const SKIP_TAGS = new Set(["script", "style", "noscript", "iframe", "template", "svg", "math"]);
// THE PAGE TITLE SURVIVES, as the opening paragraph. claude hands Turndown the WHOLE document string,
// not `document.body`, so the one piece of `head` that is text -- `<title>` -- comes out as the first
// thing the digest model reads (measured against the pinned binary: its converted content BEGINS with
// the title). Everything else in `head` is either void (`meta`/`link`/`base`) or already discarded
// above, so rendering `head` and `title` as ordinary blocks reproduces exactly that and nothing more.
// An earlier version of this module skipped `head` whole on the assumption that Turndown only ever
// sees the body; the measurement says otherwise, and the title is useful context for the digest.
const HEAD_TEXT_TAGS = new Set(["head", "title"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
// Turndown's own block-element list minus the tags with a dedicated rule below (heading/hr/pre/
// blockquote/ul/ol/li) -- every one of these gets the generic "join children, separate blocks with a
// blank line" treatment, INCLUDING the table family (see header: no GFM plugin, so no table rule).
const GENERIC_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "body",
  "center",
  "dd",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "html",
  "main",
  "menu",
  "nav",
  "output",
  "p",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
]);

// --- pieces + joining --------------------------------------------------------------------------------

interface Piece {
  tag: string;
  text: string;
  isBlock: boolean;
}

// Item 7 (memory): a <br>/<hr> piece is always byte-identical and NEVER mutated after being pushed --
// no consumer anywhere in this file assigns `.text`/`.isBlock`/`.tag`, so it is safe for every
// occurrence to share ONE object instead of each allocating its own `{tag,text,isBlock}` literal.
// A text-heavy adversarial page can carry hundreds of thousands of `<br>` tags (the 512-deep-
// blockquote reproduction that motivated this measurement has ~209,000 of them); measured, this alone
// cuts that case's peak RSS by roughly 15% (isolated single-run measurement, `/usr/bin/time -l`).
const BR_PIECE: Piece = { tag: "br", text: "  \n", isBlock: false };
const HR_PIECE: Piece = { tag: "hr", text: "* * *", isBlock: true };

/** Joins a frame's accumulated children: adjacent inline runs concatenate directly; each block piece becomes its own paragraph, blank-line separated. */
function joinPieces(pieces: readonly Piece[]): string {
  const parts: { text: string; isBlock: boolean }[] = [];
  for (const piece of pieces) {
    if (piece.isBlock) {
      // Trim BLANK leading/trailing lines only -- not leading whitespace on the first surviving
      // line, which for a `<pre>` block IS its own indentation (`.trim()` would eat it).
      const t = piece.text.replace(/^[ \t]*\n+/, "").replace(/\s+$/, "");
      if (t.length > 0) parts.push({ text: t, isBlock: true });
    } else {
      if (piece.text === "") continue;
      const last = parts[parts.length - 1];
      if (last !== undefined && !last.isBlock) last.text += piece.text;
      else parts.push({ text: piece.text, isBlock: false });
    }
  }
  return parts
    .map((p) => (p.isBlock ? p.text : p.text.trim()))
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/** Verbatim concatenation for `<pre>` content -- no trimming, no whitespace collapsing, no blank-line insertion. */
function joinVerbatim(pieces: readonly Piece[]): string {
  return pieces.map((p) => p.text).join("");
}

// Security review finding M4: the earlier lazy-`.*?` regex could take quadratic-ish time on a large
// run of non-whitespace text (the engine re-tries the lazy middle group at every position hunting
// for the trailing `\s*$` anchor). `trimStart`/`trimEnd` are linear, built-in, and cannot backtrack.
function wrapInline(text: string, delim: string): string {
  const core = text.trim();
  if (core === "") return text;
  const leadLen = text.length - text.trimStart().length;
  const trailLen = text.length - text.trimEnd().length;
  const lead = leadLen > 0 ? text.slice(0, leadLen) : "";
  const trail = trailLen > 0 ? text.slice(text.length - trailLen) : "";
  return `${lead}${delim}${core}${delim}${trail}`;
}

/** The length of the longest run of consecutive backticks in `text`, in ONE linear pass. */
function longestBacktickRun(text: string): number {
  let max = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x60 /* ` */) {
      run += 1;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return max;
}

function wrapCode(text: string): string {
  if (text === "") return "";
  // Security review finding M4: the earlier `while (text.includes(fence)) fence += "\`"` re-scanned
  // the WHOLE string on every iteration -- O(n*k) for k = the longest backtick run, which a
  // 500,000-backtick `<code>` block turns into a multi-second stall. One linear scan replaces it.
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || /^\s|\s$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Turndown's list-item shape, from its own `listItem` rule: the marker is `*` plus THREE spaces for a
 * bullet and `N.` plus TWO for a numbered item, and every continuation line is indented by a FIXED
 * four spaces -- not by the marker's width, so item 10's continuation still sits at four.
 */
const BULLET_MARKER = "*   ";
const orderedMarker = (n: number): string => `${n}.  `;
const LIST_CONTINUATION_INDENT = "    ";

function indentContinuation(text: string, marker: string): string {
  const pad = LIST_CONTINUATION_INDENT;
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? marker + line : line.length > 0 ? pad + line : line))
    .join("\n");
}

function attr(map: Readonly<Record<string, string>>, name: string): string | undefined {
  const v = map[name];
  return v === undefined || v === "" ? undefined : decodeHtmlEntities(v);
}

function renderImage(attrs: Readonly<Record<string, string>>): string {
  const src = attr(attrs, "src") ?? "";
  const alt = attr(attrs, "alt") ?? "";
  const title = attr(attrs, "title");
  return `![${alt}](${src}${title !== undefined ? ` "${title}"` : ""})`;
}

// --- the frame stack ----------------------------------------------------------------------------

interface Frame {
  tag: string;
  attrs: Readonly<Record<string, string>>;
  buf: Piece[];
  insidePre: boolean;
  /** How many `blockquote`/`ul`/`ol` ancestors (inclusive of this frame, if it is one) are open -- security review finding N2. */
  prefixDepth: number;
}

/**
 * Security review finding N2: the running RENDERED-OUTPUT budget. Every level of `blockquote`/`ul`/
 * `ol` nesting re-splits and re-prefixes EVERY LINE of its own content again (`> ` per blockquote
 * level, marker+indent per list level) -- so N nesting levels cost O(N) work on the SAME growing
 * text, not O(1). Two adversarial inputs measured before this fix: 512 nested `<blockquote>` around
 * ~200k `<br>`-separated lines (1 MiB HTML in) produced 214 MB of output in 37.7s at 7.4 GB peak
 * RSS; 500 nested `<blockquote>` around a 400,000-line `<pre>` (806 KB in) produced 402 MB in 40.8s
 * at 7.5 GB. `MAX_DEPTH` (512) did not save either case -- both landed just inside it.
 *
 * THE FIX IS TWO-LAYERED, matching the report: (1) `MAX_PREFIX_DEPTH` below caps blockquote/ul/ol
 * nesting SPECIFICALLY at 32 (deeper ones go transparent -- no additional prefix, but their content
 * is not lost), which bounds the multiplication factor directly and is what actually stops the two
 * cases above; (2) this budget is the BACKSTOP for whatever shape (1) does not anticipate: it is
 * spent by the LENGTH of every frame's own rendered text as frames close, and throws
 * `HtmlBudgetExceededError` the moment it goes negative. `convertFetchedHtml`'s existing `catch`
 * already falls back to the raw HTML on ANY conversion throw (claude's own "turndown throws -> raw
 * HTML" rule) -- and since only the first 100,000 characters of whatever comes back ever reach the
 * digest model anyway, a hostile page that trips this budget costs no more than one bounded parse.
 */
const HTML_RENDER_BUDGET_BYTES = 6 * 1024 * 1024;

export class HtmlBudgetExceededError extends Error {}

/** `blockquote`/`ul`/`ol` nesting DEEPER than this goes transparent -- the frame is never pushed, so it adds no further `> `/marker+indent prefix layer, though its content still reaches its nearest tracked ancestor (never silently dropped). Independent of, and much narrower than, `MAX_DEPTH` below -- THESE THREE tags are the only ones whose prefix cost multiplies with every additional level. */
const MAX_PREFIX_DEPTH = 32;
const PREFIX_TAGS = new Set(["blockquote", "ul", "ol"]);

function renderFrame(frame: Frame, budget: { remaining: number }): Piece {
  const piece = renderFrameUnbudgeted(frame);
  budget.remaining -= piece.text.length;
  if (budget.remaining < 0) throw new HtmlBudgetExceededError("WebFetch: the HTML->markdown conversion's output budget was exceeded");
  return piece;
}

function renderFrameUnbudgeted(frame: Frame): Piece {
  const { tag, attrs, buf, insidePre } = frame;

  if (SKIP_TAGS.has(tag)) return { tag, text: "", isBlock: false };

  if (HEADING_TAGS.has(tag)) {
    const content = joinPieces(buf).replace(/\s*\n+\s*/g, " ").trim();
    if (content.length === 0) return { tag, text: "", isBlock: false };
    const level = Number(tag[1]);
    let text: string;
    if (level === 1) text = `${content}\n${"=".repeat(Math.max(content.length, 1))}`;
    else if (level === 2) text = `${content}\n${"-".repeat(Math.max(content.length, 1))}`;
    else text = `${"#".repeat(level)} ${content}`;
    return { tag, text, isBlock: true };
  }

  if (tag === "pre") {
    const raw = joinVerbatim(buf).replace(/^\n+/, "").replace(/\s+$/, "");
    if (raw.length === 0) return { tag, text: "", isBlock: false };
    const indented = raw
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    return { tag, text: indented, isBlock: true };
  }

  if (tag === "blockquote") {
    const content = joinPieces(buf);
    if (content.length === 0) return { tag, text: "", isBlock: false };
    // Item 7 (memory) investigated an in-place mutation of the split() array here, in place of
    // .map(), to avoid materializing a second n-element array. MEASURED: it reduced peak RSS ~3%
    // on the <br>-heavy reproduction (512 nested blockquotes around ~200k <br> lines) but INCREASED
    // it ~14% on the other reviewer-measured case (500 nested blockquotes around a 400,000-line
    // <pre>) -- reproducible across five runs each way, byte-identical output and identical
    // per-frame render trace in both cases, so the regression is a real allocator/GC-scheduling
    // interaction with JSC, not a bug in the rewrite. Not worth shipping a change whose net effect
    // depends on input shape in a way this lane cannot predict or explain; reverted, kept as .map().
    const text = content
      .split("\n")
      .map((l) => (l.length > 0 ? `> ${l}` : ">"))
      .join("\n");
    return { tag, text, isBlock: true };
  }

  if (tag === "ul" || tag === "ol") {
    // Security review finding N5: this used to DROP every non-`li` piece outright
    // (`if (piece.tag !== "li") continue`) -- a bare nested `<ul>` directly inside another `<ul>`
    // (not wrapped in an `<li>`, which browsers and Turndown both still render) or stray text/a
    // `<div>` sitting directly inside a list lost its content entirely. Every piece is now emitted:
    // an `li` gets its marker and indent as before; another BLOCK piece (a bare nested list, a
    // wrapped `<div>`, ...) becomes its own line; stray INLINE content (bare text, an anchor) is
    // appended onto the previous line so it does not fabricate a spurious empty bullet.
    const ordered = tag === "ol";
    let n = Number.parseInt(attrs["start"] ?? "1", 10);
    if (!Number.isFinite(n)) n = 1;
    const lines: string[] = [];
    for (const piece of buf) {
      if (piece.tag === "li") {
        const marker = ordered ? orderedMarker(n) : BULLET_MARKER;
        n += 1;
        lines.push(indentContinuation(piece.text, marker));
      } else if (piece.isBlock) {
        const t = piece.text.trim();
        if (t.length > 0) lines.push(t);
      } else {
        if (piece.text.trim().length === 0) continue;
        if (lines.length > 0) lines[lines.length - 1] += piece.text;
        else lines.push(piece.text);
      }
    }
    return { tag, text: lines.join("\n"), isBlock: true };
  }

  if (tag === "li") {
    // Turndown's `list` rule: a list that CLOSES its parent item sits directly under the item's own
    // text, one newline down -- never a blank line, which is what every other block gets.
    let end = buf.length;
    while (end > 0 && !buf[end - 1]!.isBlock && buf[end - 1]!.text.trim() === "") end -= 1;
    const last = end > 0 ? buf[end - 1]! : undefined;
    if (last !== undefined && (last.tag === "ul" || last.tag === "ol") && last.text.length > 0) {
      const lead = joinPieces(buf.slice(0, end - 1));
      return { tag, text: lead.length > 0 ? `${lead}\n${last.text}` : last.text, isBlock: true };
    }
    return { tag, text: joinPieces(buf), isBlock: true };
  }

  if (tag === "a") {
    const inner = insidePre ? joinVerbatim(buf) : joinPieces(buf);
    const href = attr(attrs, "href");
    if (href === undefined) return { tag, text: inner, isBlock: false };
    const title = attr(attrs, "title");
    return { tag, text: `[${inner}](${href}${title !== undefined ? ` "${title}"` : ""})`, isBlock: false };
  }

  if (tag === "strong" || tag === "b") {
    const inner = insidePre ? joinVerbatim(buf) : joinPieces(buf);
    return { tag, text: insidePre ? inner : wrapInline(inner, "**"), isBlock: false };
  }

  if (tag === "em" || tag === "i") {
    const inner = insidePre ? joinVerbatim(buf) : joinPieces(buf);
    return { tag, text: insidePre ? inner : wrapInline(inner, "_"), isBlock: false };
  }

  if (tag === "code") {
    if (insidePre) return { tag, text: joinVerbatim(buf), isBlock: false };
    return { tag, text: wrapCode(joinPieces(buf)), isBlock: false };
  }

  if (GENERIC_BLOCK_TAGS.has(tag) || HEAD_TEXT_TAGS.has(tag)) {
    return { tag, text: joinPieces(buf), isBlock: true };
  }

  // Unknown / plain inline element (span, small, sub, sup, mark, abbr, cite, q, u, kbd, time, ...):
  // Turndown's own default for a tag with no matching rule is to keep its text content and drop the
  // tag, exactly like this.
  const inner = insidePre ? joinVerbatim(buf) : joinPieces(buf);
  return { tag, text: inner, isBlock: false };
}

// Security review finding M3, part 1: `HTMLRewriter#onEndTag` fires an element's callback with the
// nearest ENCLOSING end tag it actually sees on the wire, not necessarily its own -- for an omitted
// `</li>`/`</p>`/`</td>` (everyday HTML: `<ul><li>a<li>b</ul>` has NO closing `</li>` at all), the
// first `<li>`'s callback fires at `</ul>`, reporting `end.name === "ul"`. The earlier version popped
// by NAME, discarding every frame it walked past on the way -- for exactly that input, the FIRST
// `<li>` was thrown away, unrendered, with its own second `<li>` sibling wrongly nested inside it.
// Measured (see the report): `<ul><li>a<li>b</ul>` -> `""`; `<table><tr><td>x<td>y…` -> `""`;
// `<div><p>one<p>two</div><p>three</p>` -> `"three"`; `<div><span>hello</div>` lost "hello" entirely.
//
// TWO closing paths now cooperate:
//   (a) PROACTIVE SIBLING AUTO-CLOSE, at the moment a NEW element opens: HTML5's own implied-end-tag
//       rules for the common omission patterns (li/li, td-or-th/td-or-th/tr, tr/tr, dt-or-dd/dt-or-dd,
//       p/[block-level-or-list-or-hr]) close the CONFLICTING open frame immediately, before the new
//       one is pushed -- there is no interleaving to get wrong, because nothing has opened yet.
//   (b) IDENTITY-BASED onEndTag, for whatever (a) does not cover (an entirely unclosed descendant
//       chain closed by an ancestor's real end tag, e.g. `<div><span>hello</div>`): the callback
//       closes over its OWN frame object and locates it by IDENTITY (`stack.indexOf`), never by
//       name, then closes every frame from the top of the stack down to and including it -- each one
//       RENDERED into its own parent, never merely discarded. A frame already closed by (a) is simply
//       absent (`indexOf` returns -1) and the callback no-ops.
//
// Security review finding M3, part 2: `.on("*", {text})` never sees text that is a DIRECT child of
// the document with no enclosing element at all (`hello <b>bold</b> world` loses "hello "/" world";
// a document with no elements at all loses everything). `HTMLRewriter#onDocument({text})` is the
// only source for that text -- and, measured, it ALSO reports every OTHER text node HTMLRewriter's
// element-scoped handler would have, in the same document order interleaved correctly with element
// open/close events -- so routing ALL text through `onDocument` (and none through `.on("*",{text})`)
// is a strict superset, not a second source to reconcile.
//
// Security review finding M4, part 3: elements past `MAX_DEPTH` (an adversarial, deeply nested
// document) stop pushing their own frame -- their content flows straight into the deepest frame that
// IS still tracked, so nesting depth (and the per-frame render work that comes with it) is bounded
// regardless of how deep the real markup goes.
const MAX_DEPTH = 512;

/** Tags whose transparent (depth-capped) skip should still leave a SEPARATOR behind (security review nit): without one, text on either side of a skipped block-level element runs together (`DEEP-TEXTdeep paradeep bold`), which is a smaller, cheaper fix than fully reconstructing the block it would have been. */
const BLOCK_LIKE_TAGS = new Set<string>([...GENERIC_BLOCK_TAGS, ...HEADING_TAGS, "li", "ul", "ol", "blockquote", "pre", "hr"]);

/** HTML5's own implied-end-tag rule, narrowly: does opening `newTag` close the CURRENT top frame first? */
function closesOnSiblingOpen(topTag: string, newTag: string): boolean {
  if (topTag === "li") return newTag === "li";
  if (topTag === "td" || topTag === "th") return newTag === "td" || newTag === "th" || newTag === "tr";
  if (topTag === "tr") return newTag === "tr";
  if (topTag === "dt" || topTag === "dd") return newTag === "dt" || newTag === "dd";
  if (topTag === "p") return newTag === "p" || newTag === "hr" || newTag === "ul" || newTag === "ol" || newTag === "pre" || newTag === "blockquote" || HEADING_TAGS.has(newTag) || GENERIC_BLOCK_TAGS.has(newTag);
  return false;
}

/**
 * Converts `html` to markdown using the rules above, driven by Bun's `HTMLRewriter` as a SAX walk
 * (see the module header). Never throws for malformed markup on its own -- `HTMLRewriter` tolerates
 * it the way a real HTML5 parser does -- but a genuine internal failure (including
 * `HtmlBudgetExceededError`, security review finding N2) is caught and reported so the caller can
 * fall back to the raw HTML, matching claude's own "turndown throwing -> raw HTML" rule.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  const root: Frame = { tag: "#root", attrs: {}, buf: [], insidePre: false, prefixDepth: 0 };
  const stack: Frame[] = [root];
  const budget = { remaining: HTML_RENDER_BUDGET_BYTES };

  /** Closes every frame from the top of the stack down to and including `frame`, rendering each into its NEW top's buf. A no-op if `frame` was already closed (not found). */
  function closeFrame(frame: Frame): void {
    const idx = stack.indexOf(frame);
    if (idx === -1) return;
    while (stack.length > idx) {
      const closed = stack.pop()!;
      stack[stack.length - 1]!.buf.push(renderFrame(closed, budget));
    }
  }

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        const parent = stack[stack.length - 1]!;

        if (VOID_TAGS.has(tag)) {
          const attrs: Record<string, string> = {};
          for (const [k, v] of el.attributes) attrs[k.toLowerCase()] = v;
          if (tag === "br") parent.buf.push(BR_PIECE);
          else if (tag === "hr") parent.buf.push(HR_PIECE);
          else if (tag === "img") parent.buf.push({ tag, text: renderImage(attrs), isBlock: false });
          // meta/link/base/area/col/embed/input/param/source/track/wbr: no useful text -- contribute nothing.
          return;
        }

        if (parent !== root && closesOnSiblingOpen(parent.tag, tag)) closeFrame(parent);

        const top = stack[stack.length - 1]!;

        if (stack.length > MAX_DEPTH) {
          // Transparent: content attaches to the deepest tracked frame instead (security review
          // finding M4, part 3) -- but leave a SEPARATOR so it does not run into its neighbours
          // (security review nit).
          if (BLOCK_LIKE_TAGS.has(tag)) top.buf.push({ tag: "#text", text: "\n\n", isBlock: false });
          return;
        }

        const isPrefixTag = PREFIX_TAGS.has(tag);
        const newPrefixDepth = top.prefixDepth + (isPrefixTag ? 1 : 0);
        if (isPrefixTag && newPrefixDepth > MAX_PREFIX_DEPTH) {
          // Security review finding N2: a blockquote/ul/ol past the prefix-depth cap is ALSO
          // transparent -- its own content still reaches the nearest tracked ancestor, it just adds
          // no further `> `/marker-and-indent layer, which is what bounds the multiplication.
          top.buf.push({ tag: "#text", text: "\n\n", isBlock: false });
          return;
        }

        const attrs: Record<string, string> = {};
        for (const [k, v] of el.attributes) attrs[k.toLowerCase()] = v;
        const frame: Frame = { tag, attrs, buf: [], insidePre: top.insidePre || tag === "pre", prefixDepth: newPrefixDepth };
        stack.push(frame);
        el.onEndTag(() => closeFrame(frame));
      },
    })
    .onDocument({
      text(t) {
        if (t.text === "") return;
        const frame = stack[stack.length - 1]!;
        const decoded = decodeHtmlEntities(t.text);
        const text = frame.insidePre ? decoded : decoded.replace(/[\t\n\r ]+/g, " ");
        if (!frame.insidePre && text === "") return;
        frame.buf.push({ tag: "#text", text, isBlock: false });
      },
    });

  await rewriter.transform(new Response(html)).text();
  // Whatever is still open at end-of-stream (malformed/truncated HTML) is force-closed root-ward so
  // its content is not silently dropped. `stack[1]` is the outermost still-open frame (index 0 is
  // always `root`, which must never itself be popped).
  if (stack.length > 1) closeFrame(stack[1]!);
  return joinPieces(root.buf);
}

/**
 * The full conversion claude's own WebFetch applies: cap the RAW HTML at 1,048,576 chars first (so a
 * pathological document costs conversion no more than that), convert what remains, and append the
 * verbatim truncation notice when it was capped. A conversion failure falls back to the (possibly
 * capped) raw HTML, per claude's own "turndown throwing -> raw HTML."
 */
export async function convertFetchedHtml(html: string): Promise<string> {
  const truncated = html.length > HTML_TRUNCATION_LIMIT;
  const capped = truncated ? html.slice(0, HTML_TRUNCATION_LIMIT) : html;
  let content: string;
  try {
    content = await htmlToMarkdown(capped);
  } catch {
    content = capped;
  }
  return truncated ? content + WEB_FETCH_HTML_TRUNCATION_NOTICE : content;
}
