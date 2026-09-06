// Verifier for a `derived-shapes-*.md` file in packages/conformance/compat/anthropic/<version>/.
//
// GATED — never runs in ordinary CI, and is deliberately in no CI job. Like
// capture-official-golden.ts it needs network egress: it re-fetches the pinned
// @anthropic-ai/claude-agent-sdk tarball through the repository's own checksum-verified path
// (`fetchAndVerifyUpstream`, sha256 + the npm registry sha512 integrity, both re-checked here and
// never trusted from an earlier step), extracts it into a throwaway mkdtemp, reads the `.d.ts` files
// in place, and deletes every directory it created in a `finally`. Nothing from the artifact is
// written anywhere persistent, and nothing it reads is printed except line numbers, identifier names
// and word counts. Run it deliberately:
//
//   RUN_DERIVED_SHAPES_CHECK=1 bun run scripts/check-derived-shapes.ts \
//     --file packages/conformance/compat/anthropic/0.3.250/derived-shapes-p6.md
//
// WHY THIS EXISTS (P6 Task 1, review rounds 1 and 2). A `derived-shapes-*.md` makes three kinds of
// claim, and two review rounds proved that checking only the first kind is not enough:
//
//   (a) "line N of sdk.d.ts says X" — a file:line -> substring check catches a stale line number.
//       It does NOT catch a citation that points at a real line while the sentence around it
//       describes a different thing. P6 round 1 shipped exactly that: the
//       `{ type: 'enabled', budgetTokens: number }` JSDoc example was cited at 1728, and line 1728
//       genuinely exists and genuinely says something — just not that (the example is on 1729).
//   (b) identifier ATTRIBUTION — round 1 also shipped a `Query.setSettings` method the pinned
//       artifact does not contain, on correctly-cited lines. No line check can catch a name that
//       simply is not there, so every identifier the document asserts is swept back against the
//       artifact, dotted `Class.method` forms included.
//   (c) "vendor prose is restated, not transcribed" — round 1 asserted this, round 2 disproved it.
//       A 12-word n-gram overlap measures it. The normalisation here strips ALL punctuation, which
//       the first, hand-rolled version of this scan did not: swapping the artifact's em dashes for
//       commas left five sentences reading as original to that scan while being word-for-word
//       reproductions. Punctuation-insensitive matching is the whole point.
//
// Exit code is non-zero on any hard failure — a mis-attributed citation, an identifier the artifact
// does not have, or a >=N-word run in PROSE. Runs inside fenced code blocks are expected (declared
// signatures and field lists are exactly what a derived-shapes file must reproduce exactly), and so
// are runs inside an explicit "..." quotation, which is how a document marks a clause it is quoting
// as evidence. Both are reported, neither fails.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchAndVerifyUpstream } from "./fetch-upstream.ts";

const DTS_FILES = ["sdk.d.ts", "sdk-tools.d.ts", "bridge.d.ts", "browser-sdk.d.ts", "extractFromBunfs.d.ts", "agentSdkTypes.d.ts"];
const NGRAM = 12;

// Names a derived-shapes document may legitimately assert while the artifact does NOT contain them.
// Each entry needs a reason, and the reason must be a claim the document itself makes — this list is
// not an escape hatch for a name nobody checked. Anything not listed here must exist in the artifact.
const ABSENCE_ALLOWLIST: Record<string, string> = {
  // Wire names observed only by RUNNING the pinned runtime. The document's headline finding is that
  // the artifact declares no stream-event or content-block payload, so these cannot be in it.
  text_delta: "runtime-captured wire name; the document states it is undeclared",
  thinking_delta: "runtime-captured wire name; the document states it is undeclared",
  signature_delta: "runtime-captured wire name; the document states it is undeclared",
  input_json_delta: "runtime-captured wire name; the document states it is undeclared",
  context_management: "runtime-captured request key; not in the declaration",
  end_turn: "runtime-captured stop_reason value; not in the declaration",
  overloaded_error: "runtime-captured API error type; not in the declaration",
  rate_limit_error: "runtime-captured API error type; not in the declaration",
  not_found_error: "runtime-captured API error type; not in the declaration",
  // Names the document reports as ABSENT — their absence is the finding.
  redacted_thinking: "the document reports zero occurrences; the absence is the finding",
  error_auth: "named as a result subtype that does NOT exist",
  error_model_not_found: "named as a result subtype that does NOT exist",
  error_overloaded: "named as a result subtype that does NOT exist",
  ThinkingBlock: "the EXTERNAL @anthropic-ai/sdk type R6-8 assumed; outside the pinned artifact",
  // Winter's own vocabulary and this repository's own machinery.
  anchorUuid: "Winter's own R6-7 sidecar field",
  reasoning_summary: "Winter-only system frame subtype R6-8 introduces; by construction not in the pin",
  ANTHROPIC_BASE_URL: "environment variable the capture harness sets",
  MAX_MCP_OUTPUT_TOKENS: "environment variable a P4 capture scenario sets",
  fetchAndVerifyUpstream: "this repository's own helper",
  cacheDir: "this repository's own helper parameter",
  checksums: "this directory's own checksums.json",
  mkdtemp: "Node/OS facility used by the harness",
  homedir: "Node facility referenced when explaining HOME isolation",
};

const PROSE_WORDS = new Set(
  ("the and not for null true false string number boolean undefined type subtype yes its one two only per new has any all see was are this that from with into over out does did but now why how what when which there here also both each then than they them their been being have had will would can could may might must should shall about after before because between during under above below through against without within across among around behind beyond except inside outside toward upon via").split(" "),
);

interface Doc {
  raw: string;
  lines: string[];
  fenced: boolean[]; // per line: inside a ``` block
}

function loadDoc(path: string): Doc {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const fenced: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      fenced.push(true); // the fence marker itself counts as fenced
      inFence = !inFence;
      continue;
    }
    fenced.push(inFence);
  }
  return { raw, lines, fenced };
}

// --- check (a): does the sentence around a citation actually describe the line it cites? ---------
//
// A citation's "claimed substring" is not written down anywhere, so it is inferred: the backticked
// code spans in the same sentence are what the sentence is talking about. If NONE of them appears in
// the declaration unit the cited line belongs to, but at least one appears somewhere else in the
// file, the citation points somewhere the sentence is not describing. A sentence whose spans appear
// nowhere in the artifact is left to check (b) rather than guessed at here.
//
// KNOWN BOUND, stated rather than implied: matching at the granularity of a declaration unit means
// this check does NOT flag a citation that lands on the wrong LINE of the right unit — which is the
// shape of the round-1 1728/1729 defect. It cannot: "cited the JSDoc, named the type below it" is
// the document's dominant and correct style and has the identical signature. Those cases are counted
// and reported as a note for a human to eye, never failed. What this check does catch is the class
// no amount of proofreading reliably does: a citation pointing at an unrelated part of the file.
interface CitationProblem {
  docLine: number;
  cited: number;
  tokens: string[];
  foundAt?: number[];
}

// SCOPING, stated because it bounds what this check can promise. A bare backticked number is only
// read as an sdk.d.ts line citation in the DERIVATION half of the document (everything before the
// "## Hermetic captures" heading), where the Method states that convention. After that heading the
// same notation is overwhelmingly HTTP statuses, byte counts and millisecond timings — `429`, `529`,
// `2000` — and reading those as line numbers produces nothing but noise. The explicit
// `sdk.d.ts:NNNN` form is honoured everywhere. A RANGE (`NNNN-MMMM`) names a whole declaration whose
// members legitimately live anywhere inside it, so ranges are left to check (b).
//
// The subject of a citation is taken to be the backticked code spans immediately PRECEDING it in the
// same sentence — which is how these citations are actually written ("`X.y` (`NNNN`)") — rather than
// every span in the sentence, and it is satisfied if any of them lands within 3 lines of the cited
// line. Three, because the overwhelmingly common shape is a JSDoc line cited for a claim about the
// declaration 2-3 lines below it.
const SUBJECT_LOOKBACK = 3;
const AFTER_JSDOC = 2;
const DECLARATION_SCAN_LIMIT = 60;
const SUBJECT_LOOKAHEAD = 2;

/** The lines a citation of `line` may legitimately be describing. A citation almost always points
 *  either at a declaration or at a line of the JSDoc immediately above one, and the sentence around
 *  it names the declaration, one of its fields, or something the comment says — so the
 *  neighbourhood is the whole unit: the comment block the line sits in (expanded both ways while
 *  lines are comment continuations) plus the declaration that follows it, out to the closing brace
 *  of a braced type or the end of a single-line one. Modelling the unit rather than a fixed +/-N
 *  window is what lets "cited the JSDoc, named a field of the type it documents" pass while the
 *  round-1 failure — a citation landing on a DIFFERENT line of a long comment than the claim it is
 *  attached to — still fails, because that claim's own words are elsewhere in the file. */
function citationNeighbourhood(dts: string[], line: number): string {
  const at = (n: number): string => dts[n - 1] ?? "";
  const isComment = (n: number): boolean => /^\s*(\/\*\*|\*|\*\/)/.test(at(n));
  let lo = line;
  let hi = line;
  while (lo > 1 && isComment(lo - 1)) lo--;
  while (hi < dts.length && isComment(hi + 1)) hi++;
  // Past the comment: take the declaration it introduces, to its closing brace when it has one.
  let scan = hi + 1;
  let depth = 0;
  let seen = 0;
  while (scan <= dts.length && seen < DECLARATION_SCAN_LIMIT) {
    const text = at(scan);
    depth += (text.match(/[{[]/g) ?? []).length - (text.match(/[}\]]/g) ?? []).length;
    hi = scan;
    seen++;
    if (depth <= 0 && /[;}]\s*$/.test(text)) break;
    scan++;
  }
  hi = Math.min(dts.length, Math.max(hi, line + AFTER_JSDOC));
  return dts.slice(lo - 1, hi).join("\n");
}

function checkCitations(doc: Doc, dts: string[]): { checked: number; problems: CitationProblem[]; exactLineMisses: CitationProblem[] } {
  const problems: CitationProblem[] = [];
  const exactLineMisses: CitationProblem[] = [];
  let checked = 0;
  const capturesHeading = doc.lines.findIndex((l) => l.startsWith("## Hermetic captures"));
  const derivationEnd = capturesHeading === -1 ? doc.lines.length : capturesHeading;
  // Wrapped lines are joined into blocks first: a citation and the span naming its subject routinely
  // land on different physical lines of the same sentence, and scanning line-by-line reads those as
  // a subject-less citation (or, worse, pairs it with a neighbouring sentence's span).
  const blocks: Array<{ start: number; text: string }> = [];
  let cur: { start: number; text: string } | null = null;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.fenced[i] || doc.lines[i]!.trim() === "") { if (cur) blocks.push(cur); cur = null; continue; }
    if (cur === null) cur = { start: i + 1, text: doc.lines[i]! };
    else cur.text += " " + doc.lines[i]!;
  }
  if (cur) blocks.push(cur);

  for (const block of blocks) {
    const i = block.start - 1;
    const bareNumbersAreCitations = i < derivationEnd;
    // Sentences, so a block citing several lines does not pool every token into one claim.
    for (const sentence of block.text.split(/(?<=[.;])\s+/)) {
      const rangeEnds = new Set([...sentence.matchAll(/`(?:sdk\.d\.ts:)?(\d{1,4})-(\d{1,4})`/g)].flatMap((m) => [Number(m[1]), Number(m[2])]));
      const cites = [...sentence.matchAll(/`(sdk\.d\.ts:)?(\d{1,4})`/g)]
        .filter((m) => (m[1] !== undefined || bareNumbersAreCitations) && !rangeEnds.has(Number(m[2])))
        .map((m) => ({ at: m.index!, line: Number(m[2]) }));
      if (cites.length === 0) continue;
      // Identifier spans AND backticked string literals — `'rate_limit_event'` is as much the
      // subject of a citation as `SDKRateLimitEvent` is, and skipping quoted forms was making the
      // check report a mismatch where the document was right.
      const spans = [...sentence.matchAll(/`'?([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)/g)]
        .map((m) => ({ at: m.index!, parts: m[1]!.split(".").filter((t) => t.length >= 4 && !PROSE_WORDS.has(t.toLowerCase())) }))
        .filter((sp) => sp.parts.length > 0);
      for (const cite of cites) {
        if (cite.line < 1 || cite.line > dts.length) continue;
        // Reported subject: the spans nearest the citation on either side — "`X` (`NNNN`)" is the
        // common shape, but a bullet list writes "`sdk.d.ts:NNNN` — `X` from …", putting the subject
        // after its own citation. TESTED subject: every span in the sentence. A sentence that cites
        // three sibling declarations in one parenthetical has three subjects and three citations,
        // and pairing them positionally produces mismatches the document does not actually contain.
        const reported = [
          ...spans.filter((sp) => sp.at < cite.at).slice(-SUBJECT_LOOKBACK),
          ...spans.filter((sp) => sp.at > cite.at).slice(0, SUBJECT_LOOKAHEAD),
        ].flatMap((sp) => sp.parts);
        const subjects = spans.flatMap((sp) => sp.parts);
        if (subjects.length === 0) continue;
        checked++;
        const near = citationNeighbourhood(dts, cite.line);
        // Underscore/case-insensitive, because a JSDoc writes in prose what the declaration writes as
        // an identifier ("stream event" for `stream_event`).
        const squash = (t: string): string => t.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
        const nearSquashed = squash(near);
        if (subjects.some((t) => near.includes(t) || nearSquashed.includes(squash(t)))) continue;
        // T10 (Minor 1, parked at T1): the `push` immediately followed by `pop` that used to stand
        // here was DEAD CODE -- `exactLineMisses` was appended to and un-appended in the same two
        // statements, so the channel it feeds (`exactLineMisses`, reported separately from
        // `problems`) received nothing, ever, and the "exact line missed but the token exists
        // nearby" case was silently indistinguishable from the "token is nowhere" case. Recorded
        // rather than merely deleted: the array is still reported, and it is now genuinely fed --
        // an exact-line miss is a real, separately-reported observation about a citation whose
        // sentence is otherwise sound.
        exactLineMisses.push({ docLine: block.start, cited: cite.line, tokens: reported });
        const foundAt: number[] = [];
        for (const t of reported.length > 0 ? reported : subjects) {
          for (let k = 0; k < dts.length && foundAt.length < 6; k++) if (dts[k]!.includes(t)) foundAt.push(k + 1);
        }
        if (foundAt.length > 0) problems.push({ docLine: block.start, cited: cite.line, tokens: reported, foundAt: [...new Set(foundAt)].slice(0, 6) });
      }
    }
  }
  return { checked, problems, exactLineMisses };
}

// --- check (b): every identifier the document asserts must exist in the artifact -----------------

function checkIdentifiers(doc: Doc, haystack: string): { checked: number; missing: Array<{ name: string; dotted: string[] }> } {
  const names = new Map<string, Set<string>>(); // bare name -> the dotted forms it appeared in
  for (const m of doc.raw.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)(?:\?)?(?:\(\))?`/g)) {
    const dotted = m[1]!;
    for (const part of dotted.split(".")) {
      if (part.length < 3) continue;
      if (PROSE_WORDS.has(part.toLowerCase())) continue;
      if (!names.has(part)) names.set(part, new Set());
      names.get(part)!.add(dotted);
    }
  }
  const missing: Array<{ name: string; dotted: string[] }> = [];
  for (const [name, dottedForms] of names) {
    if (haystack.includes(name)) continue;
    if (name in ABSENCE_ALLOWLIST) continue;
    missing.push({ name, dotted: [...dottedForms] });
  }
  // Dotted forms get a second, stricter pass: `A.b` is only meaningful if BOTH halves exist.
  return { checked: names.size, missing: missing.sort((a, b) => a.name.localeCompare(b.name)) };
}

// --- check (c): the n-gram prose scan -----------------------------------------------------------
//
// PUNCTUATION-INSENSITIVE, deliberately: the whole class this catches is a vendor sentence
// reproduced with an em dash swapped for a comma. Anything that survives normalisation as the same
// twelve words in the same order is a reproduction, however it is punctuated.
function normalise(text: string): string {
  return text
    .replace(/[`*_|]/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type RunKind = "fenced" | "quoted" | "prose";
interface NgramRun {
  docLine: number;
  words: number;
  kind: RunKind;
  text: string;
}

function checkNgrams(doc: Doc, hayText: string): NgramRun[] {
  const hayWords = normalise(hayText).split(" ").filter(Boolean);
  const hayGrams = new Set<string>();
  for (let i = 0; i + NGRAM <= hayWords.length; i++) hayGrams.add(hayWords.slice(i, i + NGRAM).join(" "));

  // Blocks: consecutive non-blank lines of the SAME kind, so a run can span wrapped lines.
  const blocks: Array<{ start: number; fenced: boolean; text: string }> = [];
  let cur: { start: number; fenced: boolean; text: string } | null = null;
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i]!;
    const isFenced = doc.fenced[i]!;
    if (line.trim() === "") { if (cur) blocks.push(cur); cur = null; continue; }
    if (cur === null || cur.fenced !== isFenced) { if (cur) blocks.push(cur); cur = { start: i + 1, fenced: isFenced, text: line }; }
    else cur.text += " " + line;
  }
  if (cur) blocks.push(cur);

  // Every "..." span in non-fenced text, normalised — a run inside one is a marked quotation.
  //
  // T10 (Minor 2, parked at T1): AND THE QUOTING LINE MUST CARRY A CITATION. The summary line calls
  // this bucket "quoted-and-cited" and only the first half was ever checked, so a document could
  // reproduce vendor prose word for word, wrap it in quotation marks, cite nothing, and be excused by
  // the one scan whose entire purpose is to catch transcription. A quotation with no citation is not
  // evidence; it is a transcription with punctuation around it, and it now falls through to `prose`,
  // which FAILS.
  //
  // The citation form is the same one check (a) parses: a backticked `sdk.d.ts:NNN` or, inside the
  // derivation section, a bare backticked number.
  const CITATION_ON_LINE = /`(?:sdk\.d\.ts:)?\d{1,4}`/;
  const quoted = new Set<string>();
  let uncitedQuotations = 0;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.fenced[i]) continue;
    const line = doc.lines[i]!;
    const spans = [...line.matchAll(/"([^"]{8,})"/g)];
    if (spans.length === 0) continue;
    // The citation may sit on the quoting line or on the line immediately after it — a long quotation
    // is routinely followed by its own `(sdk.d.ts:NNN)` attribution on the next line.
    const cited = CITATION_ON_LINE.test(line) || CITATION_ON_LINE.test(doc.lines[i + 1] ?? "") || CITATION_ON_LINE.test(doc.lines[i - 1] ?? "");
    if (!cited) {
      uncitedQuotations += spans.length;
      continue;
    }
    for (const m of spans) quoted.add(normalise(m[1]!));
  }
  if (uncitedQuotations > 0) {
    console.log(`  note: ${uncitedQuotations} quoted span(s) carry NO citation on or beside their line — a run inside one is classified PROSE, not "quoted-and-cited"`);
  }
  const quotedJoined = [...quoted].join(" || ");

  const runs: NgramRun[] = [];
  for (const b of blocks) {
    const words = normalise(b.text).split(" ").filter(Boolean);
    let i = 0;
    while (i + NGRAM <= words.length) {
      if (!hayGrams.has(words.slice(i, i + NGRAM).join(" "))) { i++; continue; }
      let len = NGRAM;
      while (i + len < words.length && hayGrams.has(words.slice(i + len + 1 - NGRAM, i + len + 1).join(" "))) len++;
      const text = words.slice(i, i + len).join(" ");
      const kind: RunKind = b.fenced ? "fenced" : quotedJoined.includes(text) ? "quoted" : "prose";
      runs.push({ docLine: b.start, words: len, kind, text });
      i += len;
    }
  }
  return runs;
}

async function main(): Promise<void> {
  const fileArg = process.argv.indexOf("--file");
  if (fileArg === -1 || process.argv[fileArg + 1] === undefined) {
    console.error("usage: check-derived-shapes.ts --file <path to a derived-shapes-*.md>");
    process.exit(2);
  }
  const docPath = process.argv[fileArg + 1]!;
  const doc = loadDoc(docPath);

  const cleanups: Array<() => void> = [];
  let failures = 0;
  try {
    const cacheDir = mkdtempSync(join(tmpdir(), "winter-derived-shapes-cache-"));
    cleanups.push(() => rmSync(cacheDir, { recursive: true, force: true }));
    const { tarballPath, sha256 } = await fetchAndVerifyUpstream({ cacheDir });
    const extractDir = mkdtempSync(join(tmpdir(), "winter-derived-shapes-extract-"));
    cleanups.push(() => rmSync(extractDir, { recursive: true, force: true }));
    const tar = Bun.spawn(["tar", "-xzf", tarballPath, "-C", extractDir], { stdout: "pipe", stderr: "pipe" });
    const tarOut = (await new Response(tar.stdout).text()) + (await new Response(tar.stderr).text());
    if ((await tar.exited) !== 0) throw new Error(`tar failed: ${tarOut}`);
    void dirname(tarballPath);

    const pkg = join(extractDir, "package");
    const sdkLines = readFileSync(join(pkg, "sdk.d.ts"), "utf8").split("\n");
    let haystack = readFileSync(join(pkg, "package.json"), "utf8");
    for (const f of DTS_FILES) haystack += "\n" + readFileSync(join(pkg, f), "utf8");
    const ngramHay = readFileSync(join(pkg, "sdk.d.ts"), "utf8") + "\n" + readFileSync(join(pkg, "sdk-tools.d.ts"), "utf8");

    console.log(`check-derived-shapes: ${docPath}`);
    console.log(`  pinned tarball verified: sha256 ${sha256}`);
    console.log(`  sdk.d.ts ${sdkLines.length} lines; ${DTS_FILES.length} declaration files read\n`);

    // (a)
    const cit = checkCitations(doc, sdkLines);
    console.log(`(a) citation attribution — ${cit.checked} single-line citations checked against the line they name`);
    if (cit.problems.length === 0) console.log("    OK: every checked citation names something the declaration unit at that line actually contains");
    for (const p of cit.problems) {
      failures++;
      console.log(`    FAIL doc:${p.docLine} cites sdk.d.ts:${p.cited}, but no name from that sentence appears anywhere in the declaration unit at that line; nearest named [${p.tokens.join(", ")}], which is at ${(p.foundAt ?? []).join(", ") || "(nowhere)"}`);
    }
    // Informational, never a failure. A citation whose subject is elsewhere in the SAME declaration
    // unit is either "cited the JSDoc for the type below it" (correct, and the dominant style) or
    // "cited the wrong line of a long comment" (the round-1 1728/1729 defect). The two are
    // indistinguishable from the text, so they are listed for a human rather than failed.
    if (cit.exactLineMisses.length > 0) {
      console.log(`    note: ${cit.exactLineMisses.length} citation(s) name their subject elsewhere in the same declaration unit rather than on the cited line itself — normal for a JSDoc citation, worth an eye when a line number changes`);
    }

    // (b)
    const ids = checkIdentifiers(doc, haystack);
    console.log(`\n(b) identifier existence — ${ids.checked} distinct names asserted by the document (dotted forms decomposed)`);
    if (ids.missing.length === 0) console.log(`    OK: every one exists in the artifact, or is one of the ${Object.keys(ABSENCE_ALLOWLIST).length} documented absences`);
    for (const m of ids.missing) {
      failures++;
      console.log(`    FAIL "${m.name}" is asserted (as ${m.dotted.join(", ")}) but appears NOWHERE in the pinned artifact`);
    }

    // (c)
    const runs = checkNgrams(doc, ngramHay);
    const byKind = { fenced: 0, quoted: 0, prose: 0 } as Record<RunKind, number>;
    for (const r of runs) byKind[r.kind]++;
    console.log(`\n(c) verbatim overlap — ${NGRAM}-word n-grams vs sdk.d.ts + sdk-tools.d.ts, punctuation-insensitive`);
    console.log(`    ${runs.length} run(s) of >=${NGRAM} words: ${byKind.fenced} fenced code, ${byKind.quoted} quoted-and-cited, ${byKind.prose} PROSE`);
    for (const r of runs) {
      const label = r.kind === "prose" ? "FAIL prose" : `ok   ${r.kind}`;
      console.log(`    ${label}  doc:${r.docLine} (${r.words}w) ${r.text.slice(0, 110)}`);
      if (r.kind === "prose") failures++;
    }

    console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} problem(s)`}`);
  } finally {
    for (const c of cleanups) c();
  }
  if (failures > 0) process.exit(1);
}

if (import.meta.main) {
  if (process.env.RUN_DERIVED_SHAPES_CHECK !== "1") {
    console.log("check-derived-shapes: skipped (set RUN_DERIVED_SHAPES_CHECK=1 to run — ephemeral, network-using, in no CI job)");
    process.exit(0);
  }
  await main();
}
