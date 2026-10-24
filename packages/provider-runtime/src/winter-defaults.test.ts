// 0.0.56 (W9): the values and shapes `winter-defaults.ts` declares are the sdk's own, kept equal here.
//
// This is the ONE place in the package that may import `@yanlinglabs/winter-agent-sdk` (a dev
// dependency): a test is never published, so it costs a consumer nothing, and it is what turns two
// declarations into one meaning -- a change to either side fails this file.
import { describe, expect, test } from "bun:test";
import { DEFAULT_COMPACTION_THRESHOLD, FIRST_PARTY_ORIGINATORS as SDK_FIRST_PARTY_ORIGINATORS, WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialRef as SdkCredentialRef, ModelInfo as SdkModelInfo, SessionStoreEntry as SdkSessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { FIRST_PARTY_ORIGINATORS, WINTER_DEFAULT_COMPACTION_THRESHOLD, WINTER_DEFAULT_IDENTITY, WINTER_INSTRUCTIONS_FILE } from "./winter-defaults.ts";
import type { CredentialRef, ModelInfo, SessionStoreEntry } from "./winter-defaults.ts";

// Mutual assignability, checked by `bun run typecheck` (the file is in the typecheck project): each
// alias below fails to compile when the two declarations stop describing the same values.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const credentialRefIsSame: Same<CredentialRef, SdkCredentialRef> = true;
const modelInfoIsSame: Same<ModelInfo, SdkModelInfo> = true;
const sessionStoreEntryIsSame: Same<SessionStoreEntry, SdkSessionStoreEntry> = true;

describe("winter-defaults mirrors the sdk", () => {
  test("Winter's default identity is the sdk brand's, byte for byte", () => {
    expect(WINTER_DEFAULT_IDENTITY).toEqual({ product: WINTER_BRAND.packageName, codexOriginator: WINTER_BRAND.codexOriginator, contactUrl: WINTER_BRAND.contactUrl });
    expect(Object.isFrozen(WINTER_DEFAULT_IDENTITY)).toBe(true);
  });

  test("the instructions file, the compaction threshold and the first-party originators agree", () => {
    expect(WINTER_INSTRUCTIONS_FILE).toBe(WINTER_BRAND.instructionsFile);
    expect(WINTER_DEFAULT_COMPACTION_THRESHOLD).toBe(DEFAULT_COMPACTION_THRESHOLD);
    expect([...FIRST_PARTY_ORIGINATORS]).toEqual([...SDK_FIRST_PARTY_ORIGINATORS]);
  });

  test("the three shapes are mutually assignable (compile-time; asserted at runtime only as a marker)", () => {
    expect([credentialRefIsSame, modelInfoIsSame, sessionStoreEntryIsSame]).toEqual([true, true, true]);
  });
});
