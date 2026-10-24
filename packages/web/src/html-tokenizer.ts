// A STREAMING HTML TOKENIZER with just enough structure for the markdown converter (`html.ts`): start
// tags with their attributes, end-tag callbacks, and text. Dependency-free and runtime-neutral, so the
// converter runs the same under Node and Bun.
//
// It reproduces the event model of the lol-html tokenizer (Bun's `HTMLRewriter`) that the converter
// was first written against, measured case by case:
//   - tag and attribute NAMES are lowercased; attribute VALUES and text are handed over RAW, entities
//     undecoded (the converter decodes them);
//   - every attribute is listed, duplicates included, in source order;
//   - an end tag closes the nearest open element of that name, firing the end callbacks of every
//     element opened after it first (innermost first); an end tag with no open element of its name
//     is ignored, and nothing fires at end of input for what is still open;
//   - `script`, `style`, `iframe`, `noscript`, `noembed`, `noframes`, `xmp` (raw text) and `title`,
//     `textarea` (RCDATA) hold text up to their own end tag, never markup; `plaintext` holds the
//     rest of the document;
//   - comments, doctypes, processing instructions and CDATA sections produce nothing; a `<` that
//     opens no tag is text; a tag cut off by the end of input is dropped;
//   - a self-closing tag (`<div/>`) is an ordinary start tag in HTML content. INSIDE `svg`/`math`
//     it closes itself at once -- where lol-html instead throws from `onEndTag` ("No end tag."), and
//     that throw failed the whole conversion for any page with an inline icon (`<path .../>`).
// Text may be delivered in fewer pieces than lol-html would (it splits at every raw `<`); the
// converter treats adjacent text pieces alike either way.

export interface TokenizedElement {
  readonly tagName: string;
  readonly attributes: Iterable<[string, string]>;
  /** Registers the callback fired when this element is closed by an end tag. */
  onEndTag(callback: () => void): void;
}

export interface TokenizerHandlers {
  element(element: TokenizedElement): void;
  text(text: string): void;
}

const RAW_TEXT_TAGS = new Set(["script", "style", "iframe", "noscript", "noembed", "noframes", "xmp", "title", "textarea"]);
const FOREIGN_ROOTS = new Set(["svg", "math"]);

const WS = /[\t\n\f\r ]/;

interface Open {
  tag: string;
  callbacks: Array<() => void>;
}

/** Walks `html` once, in order, calling `handlers` for every start tag and text run. */
export function tokenizeHtml(html: string, handlers: TokenizerHandlers): void {
  const open: Open[] = [];
  // How many open elements carry each name. An end tag whose name has none is ignored in O(1): without
  // this every unmatched end tag scanned the whole stack, so a page of N start tags then M stray end
  // tags cost N*M (a 1 MB page blocked the event loop for ~17 s). A matching end tag's scan stops at its
  // match and everything it passes is popped, so the walk stays linear overall.
  const openCount = new Map<string, number>();
  const len = html.length;
  let i = 0;
  let foreignDepth = 0;

  const emitText = (from: number, to: number): void => {
    if (to > from) handlers.text(html.slice(from, to));
  };

  const closeTo = (index: number): void => {
    while (open.length > index) {
      const closed = open.pop()!;
      const remaining = openCount.get(closed.tag)! - 1;
      if (remaining > 0) openCount.set(closed.tag, remaining);
      else openCount.delete(closed.tag);
      if (FOREIGN_ROOTS.has(closed.tag) && foreignDepth > 0) foreignDepth -= 1;
      for (const cb of closed.callbacks) cb();
    }
  };

  const endTag = (tag: string): void => {
    if (!openCount.has(tag)) return;
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k]!.tag === tag) {
        closeTo(k);
        return;
      }
    }
  };

  /** Finds the end of a raw-text element's content: the index of `</tag` followed by whitespace, `/` or `>`. */
  const rawTextEnd = (tag: string, from: number): number => {
    let at = from;
    for (;;) {
      const lt = html.indexOf("</", at);
      if (lt === -1) return len;
      const name = html.slice(lt + 2, lt + 2 + tag.length).toLowerCase();
      const after = html[lt + 2 + tag.length];
      if (name === tag && (after === undefined || after === ">" || after === "/" || WS.test(after))) return lt;
      at = lt + 2;
    }
  };

  /** Parses a start tag at `i` (which holds `<` followed by an ASCII letter). Returns the index after `>` or -1 at end of input. */
  const startTag = (from: number): number => {
    let p = from + 1;
    while (p < len && !WS.test(html[p]!) && html[p] !== "/" && html[p] !== ">") p++;
    const tag = html.slice(from + 1, p).toLowerCase();
    const attributes: Array<[string, string]> = [];
    let selfClosing = false;
    for (;;) {
      while (p < len && (WS.test(html[p]!) || html[p] === "/")) {
        selfClosing = html[p] === "/";
        p++;
      }
      if (p >= len) return -1;
      if (html[p] === ">") {
        p++;
        break;
      }
      selfClosing = false;
      const nameStart = p;
      p++; // the first character of a name may be `=`
      while (p < len && !WS.test(html[p]!) && html[p] !== "/" && html[p] !== ">" && html[p] !== "=") p++;
      const name = html.slice(nameStart, p).toLowerCase();
      while (p < len && WS.test(html[p]!)) p++;
      let value = "";
      if (html[p] === "=") {
        p++;
        while (p < len && WS.test(html[p]!)) p++;
        const quote = html[p];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, p + 1);
          if (close === -1) return -1;
          value = html.slice(p + 1, close);
          p = close + 1;
        } else {
          const valueStart = p;
          while (p < len && !WS.test(html[p]!) && html[p] !== ">") p++;
          value = html.slice(valueStart, p);
        }
      }
      attributes.push([name, value]);
    }
    const entry: Open = { tag, callbacks: [] };
    handlers.element({
      tagName: tag,
      attributes,
      onEndTag: (cb) => void entry.callbacks.push(cb),
    });
    if (selfClosing && foreignDepth > 0) {
      for (const cb of entry.callbacks) cb();
      return p;
    }
    open.push(entry);
    openCount.set(tag, (openCount.get(tag) ?? 0) + 1);
    if (FOREIGN_ROOTS.has(tag)) foreignDepth += 1;
    if (foreignDepth === 0 && tag === "plaintext") {
      emitText(p, len);
      return len;
    }
    if (foreignDepth === 0 && RAW_TEXT_TAGS.has(tag)) {
      const end = rawTextEnd(tag, p);
      emitText(p, end);
      return end;
    }
    return p;
  };

  let textStart = 0;
  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html[lt + 1];
    if (next === undefined) break;
    if (/[A-Za-z]/.test(next)) {
      emitText(textStart, lt);
      const after = startTag(lt);
      if (after === -1) {
        textStart = len;
        i = len;
        break;
      }
      i = textStart = after;
      continue;
    }
    if (next === "/") {
      const third = html[lt + 2];
      if (third !== undefined && /[A-Za-z]/.test(third)) {
        emitText(textStart, lt);
        let p = lt + 2;
        while (p < len && !WS.test(html[p]!) && html[p] !== "/" && html[p] !== ">") p++;
        const tag = html.slice(lt + 2, p).toLowerCase();
        const gt = html.indexOf(">", p);
        if (gt === -1) {
          textStart = i = len;
          break;
        }
        endTag(tag);
        i = textStart = gt + 1;
        continue;
      }
      if (third === ">") {
        emitText(textStart, lt);
        i = textStart = lt + 3;
        continue;
      }
      // `</` + anything else: a bogus comment up to the next `>`.
      emitText(textStart, lt);
      const gt = html.indexOf(">", lt + 2);
      i = textStart = gt === -1 ? len : gt + 1;
      continue;
    }
    if (next === "!") {
      emitText(textStart, lt);
      if (html.startsWith("<!--", lt)) {
        // `<!-->` and `<!--->` close at once; otherwise the first `-->` (or `--!>`) does.
        if (html.startsWith("<!-->", lt)) i = lt + 5;
        else if (html.startsWith("<!--->", lt)) i = lt + 6;
        else {
          const a = html.indexOf("-->", lt + 4);
          const b = html.indexOf("--!>", lt + 4);
          const end = a === -1 ? (b === -1 ? -1 : b + 4) : b === -1 || a < b ? a + 3 : b + 4;
          i = end === -1 ? len : end;
        }
      } else {
        const gt = html.indexOf(">", lt + 2);
        i = gt === -1 ? len : gt + 1;
      }
      textStart = i;
      continue;
    }
    if (next === "?") {
      emitText(textStart, lt);
      const gt = html.indexOf(">", lt + 2);
      i = textStart = gt === -1 ? len : gt + 1;
      continue;
    }
    // A `<` that opens nothing is text.
    i = lt + 1;
  }
  emitText(textStart, len);
}
