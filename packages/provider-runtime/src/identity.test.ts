import { describe, expect, test } from "bun:test";
import { activeWinterIdentity, setWinterIdentity, winterUserAgent } from "./identity.ts";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import pkg from "../package.json";

describe("WS-13b honest identity", () => {
  test("the user agent names Winter and its version, never an editor or vendor CLI", () => {
    expect(winterUserAgent()).toBe(`winter-agent-sdk/${pkg.version}`);
    expect(winterUserAgent()).not.toMatch(/vscode|cursor|claude|codex|grok|copilot/i);
  });

  // The rule this file exists to keep true is not "the string is right" but "the string is OURS".
  // WS-13 §5 / D21: a client-identity header is never imported, and every adapter family authors its
  // own -- so the one place that authors it must be incapable of naming somebody else's product.
  test("it is a single well-formed product token — no vendor originator can be appended to it", () => {
    expect(winterUserAgent()).toMatch(/^winter-agent-sdk\/\S+$/);
    expect(winterUserAgent().includes(" ")).toBe(false);
  });
});

// --- P7a fix wave (item 5): overlapping installs unwind in ANY order ------------------------------
//
// Found while writing M-2's two-same-brand-session test. The old shape captured a `previous` value
// per call and no-oped when its own value was no longer active -- correct for STRICTLY NESTED
// teardown, and a leak for every other order, which two concurrent sessions produce routinely:
// install A, install B, dispose A (a no-op), dispose B (restores A's value, not the default). The
// process then presented as the LAST BRAND with no session live at all, so a subsequent UNBRANDED
// session would have put a reuser's product token and contact URL on the wire -- in the one field
// whose entire purpose is honest identity.
describe("P7a: setWinterIdentity frames", () => {
  const DEFAULTS = { product: WINTER_BRAND.packageName, codexOriginator: WINTER_BRAND.codexOriginator, contactUrl: WINTER_BRAND.contactUrl };
  const acme = { product: "acme", codexOriginator: "acme", contactUrl: "https://acme.example/support" };
  const zeda = { product: "zeda", codexOriginator: "zeda", contactUrl: "https://zeda.example/contact" };

  test("nested (LIFO) teardown behaves exactly as before", () => {
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
    const disposeA = setWinterIdentity(acme);
    const disposeB = setWinterIdentity(zeda);
    expect(activeWinterIdentity()).toEqual(zeda);
    disposeB();
    expect(activeWinterIdentity()).toEqual(acme);
    disposeA();
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
  });

  test("OUT-OF-ORDER teardown returns to the default -- the leak this replaced never did", () => {
    const disposeA = setWinterIdentity(acme);
    const disposeB = setWinterIdentity(zeda);
    disposeA(); // the OUTER one first: `zeda` is still live and must stay
    expect(activeWinterIdentity()).toEqual(zeda);
    disposeB();
    // Before the frame stack this asserted `acme` -- a brand nothing was running any more.
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
  });

  test("a disposer is idempotent and can only ever remove its OWN frame", () => {
    const disposeA = setWinterIdentity(acme);
    const disposeB = setWinterIdentity(zeda);
    disposeA();
    disposeA();
    disposeA();
    // Three calls, one frame removed: `zeda`'s is untouched.
    expect(activeWinterIdentity()).toEqual(zeda);
    disposeB();
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
  });

  test("two frames with the SAME value still unwind one at a time", () => {
    // Frames are compared by object identity, not by value, so two same-brand sessions (M-2's
    // topology) each hold their own -- disposing one must not withdraw the other's.
    const disposeA = setWinterIdentity(acme);
    const disposeB = setWinterIdentity(acme);
    disposeA();
    expect(activeWinterIdentity()).toEqual(acme);
    disposeB();
    expect(activeWinterIdentity()).toEqual(DEFAULTS);
  });
});
