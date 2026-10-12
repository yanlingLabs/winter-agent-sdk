/** Normalize public copies only; never use this text to execute a measured workload. */
export function publicEvidenceText(text: string, home: string): string {
  return text.split(home + "/").join("<USER_HOME>/")
    .replace(/(?:\/private)?\/var\/folders\/[A-Za-z0-9_-]+(?:\/([A-Za-z0-9_-]+))?/g,
      (_prefix, owner: string | undefined) => "/private/var/folders/xx" + (owner === undefined ? "" : "/yyyy"));
}

/** Evidence envelopes contain JSON data. Preserve numbers/outcomes while normalizing strings. */
export function publicEvidenceJson(value: unknown, home: string): string {
  return JSON.stringify(value, (_key, field) => typeof field === "string" ? publicEvidenceText(field, home) : field, 2) + "\n";
}
