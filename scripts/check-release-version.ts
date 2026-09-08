// P7a pre-publish (item 6): THE VERSION/TAG CONSISTENCY GATE.
//
// A publish is triggered by pushing `v<version>`, and the version that actually SHIPS is whatever
// each package's `package.json` says at that commit -- `release.yml` deliberately does NOT run
// `version:bump`/`version:sync` itself (a workflow that bumped and committed on every tag push would
// create a commit the pushed tag does not point at). Those two facts are only ever equal because a
// human ran the bump before tagging, and nothing checked.
//
// What goes wrong when they diverge is not a failed publish; it is a SUCCESSFUL one. Tag `v0.0.2` on
// a tree whose manifests still say `0.0.1` publishes `0.0.1` — to a registry where a version can
// never be re-published — and the tag then names a release that does not exist. On npm that is
// unrecoverable without a new version number.
//
// So: the tag's version must equal EVERY publishable package's `version`, and the repo's own
// `VERSION` file (which `version:sync` stamps the manifests from) must agree too — otherwise the
// next `version:sync` would silently rewrite what was just published.
//
// Run as a step BEFORE the first publish command. On `workflow_dispatch` there is no tag at all,
// which is a legitimate way to run this workflow: the tag check is then skipped and the
// manifest-vs-VERSION half still runs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverPublishablePackages } from "./release-pack.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface VersionCheckInput {
  /** The pushed ref, e.g. `refs/tags/v0.0.1`. Absent/blank on `workflow_dispatch`. */
  ref?: string | undefined;
  root?: string;
}

export type VersionCheckResult = { ok: true; version: string; taggedVersion?: string; packages: Array<{ name: string; version: string }> } | { ok: false; reason: string };

/** `refs/tags/v1.2.3` -> `1.2.3`; anything that is not a `v*` tag ref -> undefined. */
export function taggedVersionFrom(ref: string | undefined): string | undefined {
  if (ref === undefined || ref.trim() === "") return undefined;
  const match = /^refs\/tags\/v(.+)$/.exec(ref.trim());
  return match?.[1];
}

export function checkReleaseVersion(input: VersionCheckInput = {}): VersionCheckResult {
  const root = input.root ?? REPO_ROOT;
  const packages = discoverPublishablePackages(root).map((pkg) => ({
    name: pkg.name,
    version: (JSON.parse(readFileSync(pkg.packageJsonPath, "utf8")) as { version?: string }).version ?? "",
  }));
  if (packages.length === 0) return { ok: false, reason: "no publishable packages found -- refusing to publish a set this script cannot see" };

  const versionFile = readFileSync(`${root}VERSION`, "utf8").trim();
  // `VERSION` is `#.#.###` (zero-padded patch, the repo's own format) while a manifest carries plain
  // semver, so they are compared through the same normalisation `sync-version.ts` applies.
  const normalized = versionFile.split(".").map((part) => String(Number(part))).join(".");

  const disagreeing = packages.filter((p) => p.version !== normalized);
  if (disagreeing.length > 0) {
    return {
      ok: false,
      reason:
        `VERSION says ${versionFile} (${normalized}) but ${disagreeing.length} package(s) disagree: ` +
        `${disagreeing.map((p) => `${p.name}@${p.version || "(none)"}`).join(", ")}. Run \`bun run version:sync\` and commit before tagging.`,
    };
  }

  const taggedVersion = taggedVersionFrom(input.ref);
  if (taggedVersion === undefined) {
    // `workflow_dispatch`: no tag to compare. The manifest/VERSION half above still ran.
    return { ok: true, version: normalized, packages };
  }
  if (taggedVersion !== normalized) {
    return {
      ok: false,
      reason:
        `the pushed tag is v${taggedVersion} but every publishable package is at ${normalized}. ` +
        `Publishing would ship ${normalized} under a tag naming ${taggedVersion}, and neither registry lets a version be re-published. ` +
        `Bump (\`bun run version:bump\`), commit, then tag v${normalized}.`,
    };
  }
  return { ok: true, version: normalized, taggedVersion, packages };
}

if (import.meta.main) {
  const result = checkReleaseVersion({ ref: process.env["GITHUB_REF"] });
  if (!result.ok) {
    console.error(`check-release-version: REFUSING TO PUBLISH -- ${result.reason}`);
    process.exit(1);
  }
  console.log(
    `check-release-version: OK -- ${result.packages.length} package(s) at ${result.version}` +
      (result.taggedVersion !== undefined ? ` matching tag v${result.taggedVersion}` : " (no tag: workflow_dispatch)"),
  );
}
