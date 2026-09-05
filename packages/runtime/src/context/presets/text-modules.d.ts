// Phase 5 Lane C (task 6): lets `import text from "./winter-code.md" with { type: "text" }`
// type-check under `tsc`, which has no built-in notion of Bun's text-import attribute.
//
// WHY THE PRESET IS A .md FILE AND NOT A TS TEMPLATE LITERAL. It is authored prose that a reviewer
// reads as prose and greps as prose (the P5 review checks category coverage structurally and greps
// for vendor phrasing). It is also full of backticks and `${`-adjacent punctuation, every one of
// which would need escaping inside a template literal -- an escaping mistake would silently change
// the prompt Winter ships. Keeping it a document removes that whole class of error.
//
// The declaration is project-wide (TypeScript's wildcard module syntax allows exactly one `*`, so
// it cannot be narrowed to this one file). That is acceptable here because Bun's text import is
// the only way a `.md` is ever imported in this repo, and it always yields a string. Verified end
// to end before adopting: `tsc --noEmit` clean, correct at runtime under `bun test`, and embedded
// by `bun build --compile` -- the last one matters because `verify:compiled` runs the real binary.
declare module "*.md" {
  const text: string;
  export default text;
}
