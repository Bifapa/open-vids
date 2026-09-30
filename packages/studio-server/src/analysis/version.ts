import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level, so equal values always serialize to the same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(entry).sort()) sorted[key] = Reflect.get(entry, key);
    return sorted;
  });
}

/** Content version of an analysis artifact: `sha256:<hex>` of its canonical JSON (bare token, no quotes). */
export function artifactVersion(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
