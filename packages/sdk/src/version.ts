// The package's own version, as a source constant: a single-file `$bunfs` binary cannot read its
// package.json and `import … with { type: "json" }` breaks the dist-only tsc emit (build-packages.ts).
// Rewritten by `bun run version:sync` (scripts/sync-version.ts, stampVersionConstant) — never by hand.
export const SDK_VERSION: string = "0.0.5";
