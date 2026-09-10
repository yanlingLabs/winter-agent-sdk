// THE ACCEPTORS THAT ENFORCE THE SCHEMAS — one definition, shared by both runtime branches.
//
// A REFUSAL IS DATA, NOT A THROW. The handler turns it into a `tool_result` the model reads and
// corrects from; an exception would be a crash the model never sees. And "no more" matters as much
// as "no less": an acceptor that quietly took an extra field would be a second, undocumented schema
// reachable only through the alias — precisely the "incompatible alias target" WS-14 §7 forbids.
//
// `to` IS VALIDATED BY THE MESSAGING SUBPATH'S OWN `validateToField`, never by a copy here. "The
// same schema on both branches" is then true by construction rather than by review.
//
// RULING P-4 settles the four places the two former copies disagreed, and three of them live here:
//
//   * STRICT on unknown fields, on BOTH branches. The Winter runtime's executor used to read the
//     fields it knew and ignore the rest; the router's acceptor refused. Refusing is the answer that
//     cannot hide a second schema.
//   * `summary` is TRUNCATED to 200, never refused. The router refused an overlong one; WS-10 §10.1
//     calls `summary` "truncated when overlong", which is a computed value, not a validation error —
//     and refusing a whole call over a decoration the runtime can fix itself costs a turn.
//   * THE EMPTY-MESSAGE RULE lives here rather than in the router. `""` is legal only as the pure
//     idle subscription (WS-10 §10.1), so a bare empty message is a mistake the model can correct;
//     the router's acceptor took it and let resolution produce a less legible answer downstream.
import { validateToField } from "../messaging/index.ts";

import { LIST_AGENTS_FIELD_MAX, NATIVE_LIST_AGENTS_SCHEMA, NATIVE_SEND_MESSAGE_SCHEMA, SEND_MESSAGE_SUMMARY_MAX } from "./schemas.ts";

/** The native `SendMessage` arguments (WS-10 §10.1), after validation. */
export interface NativeSendMessageArgs {
  to: string;
  message: string;
  summary?: string;
  notify_when_idle?: boolean;
}

/** The native `ListAgents` arguments (WS-10 §10.2). Both fields are reserved in the pinned build. */
export interface NativeListAgentsArgs {
  channel?: string;
  q?: string;
}

export type NativeArgsResult<T> = { ok: true; args: T } | { ok: false; reason: string };

/**
 * The accepted field sets are READ OFF THE SCHEMAS, so the advertised schema and the enforced one
 * cannot drift apart — adding a property to a schema is the whole change.
 */
const SEND_MESSAGE_FIELDS = new Set(Object.keys(NATIVE_SEND_MESSAGE_SCHEMA.properties ?? {}));
const LIST_AGENTS_FIELDS = new Set(Object.keys(NATIVE_LIST_AGENTS_SCHEMA.properties ?? {}));

function unknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(record).filter((key) => !allowed.has(key));
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

/** Accepts the native `SendMessage` arguments EXACTLY — no more, no less. */
export function acceptNativeSendMessageArgs(input: unknown): NativeArgsResult<NativeSendMessageArgs> {
  const record = asRecord(input);
  if (record === undefined) return { ok: false, reason: "expected an object of SendMessage arguments" };
  const extra = unknownFields(record, SEND_MESSAGE_FIELDS);
  if (extra.length > 0) return { ok: false, reason: `unknown argument(s): ${extra.join(", ")}` };

  const to = record["to"];
  const validated = validateToField(to);
  if (!validated.ok) return { ok: false, reason: validated.message };

  const message = record["message"];
  if (typeof message !== "string") return { ok: false, reason: "`message` is required and must be a string (an empty string is a pure idle subscription)" };

  const notify = record["notify_when_idle"];
  if (notify !== undefined && typeof notify !== "boolean") return { ok: false, reason: "`notify_when_idle` must be a boolean" };

  // RULING P-4's empty-message rule. Checked AFTER `notify_when_idle` is known to be a boolean, so
  // the reason names the real problem rather than blaming the message for a malformed flag.
  if (message.length === 0 && notify !== true) {
    return { ok: false, reason: "`message` may only be empty when `notify_when_idle` is true (a pure idle subscription, WS-10 §10.1)" };
  }

  const summary = record["summary"];
  if (summary !== undefined && typeof summary !== "string") return { ok: false, reason: "`summary` must be a string" };
  // Truncated, never refused (ruling P-4). A non-string is still a type error truncation cannot repair.
  const capped = summary === undefined ? undefined : summary.slice(0, SEND_MESSAGE_SUMMARY_MAX);

  return {
    ok: true,
    args: {
      to: to as string,
      message,
      ...(capped === undefined ? {} : { summary: capped }),
      ...(notify === undefined ? {} : { notify_when_idle: notify }),
    },
  };
}

/** The same treatment for `ListAgents`: two reserved optional fields, both capped, nothing else. */
export function acceptNativeListAgentsArgs(input: unknown): NativeArgsResult<NativeListAgentsArgs> {
  if (input === undefined || input === null) return { ok: true, args: {} };
  const record = asRecord(input);
  if (record === undefined) return { ok: false, reason: "expected an object of ListAgents arguments" };
  const extra = unknownFields(record, LIST_AGENTS_FIELDS);
  if (extra.length > 0) return { ok: false, reason: `unknown argument(s): ${extra.join(", ")}` };
  for (const field of ["channel", "q"] as const) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "string" || value.length > LIST_AGENTS_FIELD_MAX)) {
      return { ok: false, reason: `\`${field}\` must be a string of at most ${LIST_AGENTS_FIELD_MAX} characters` };
    }
  }
  return {
    ok: true,
    args: {
      ...(typeof record["channel"] === "string" ? { channel: record["channel"] } : {}),
      ...(typeof record["q"] === "string" ? { q: record["q"] } : {}),
    },
  };
}

/**
 * `ReadNotifications` takes the empty object, and only the empty object (ruling P-4).
 *
 * The Winter runtime's executor used to accept stray fields on the reasoning that an inert extra is
 * not a reason to fail an otherwise-harmless call. That reasoning is right about HARM and wrong
 * about SCHEMAS: a model that got away with `{ limit: 5 }` here has been told, by the runtime's own
 * silence, that a `limit` exists.
 */
export function acceptNativeReadNotificationsArgs(input: unknown): NativeArgsResult<Record<string, never>> {
  if (input === undefined || input === null) return { ok: true, args: {} };
  const record = asRecord(input);
  if (record === undefined) return { ok: false, reason: "expected an empty object of ReadNotifications arguments" };
  const extra = Object.keys(record);
  if (extra.length > 0) return { ok: false, reason: `unknown argument(s): ${extra.join(", ")} (ReadNotifications takes no arguments)` };
  return { ok: true, args: {} };
}

/**
 * WS-10 §10.1: "summary?: derived from first message line when absent; truncated when overlong."
 *
 * NEVER a validation error — a computed value, or absent when there is nothing to derive from (the
 * pure-idle-subscription case, whose message is empty by construction).
 */
export function deriveSendMessageSummary(rawSummary: string | undefined, message: string): string | undefined {
  if (rawSummary !== undefined) return rawSummary.slice(0, SEND_MESSAGE_SUMMARY_MAX);
  const firstLine = (message.split("\n")[0] ?? "").trim();
  if (firstLine.length === 0) return undefined;
  return firstLine.slice(0, SEND_MESSAGE_SUMMARY_MAX);
}
