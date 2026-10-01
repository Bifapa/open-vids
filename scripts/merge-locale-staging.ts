/**
 * Merge `locales/staging/<area>.json` files into `locales/en.json`, `locales/ru.json` and `locales/NOTES.md`.
 *
 * A staging file is `{ "en": { key: message }, "ru": { key: message }, "notes": { key: "context" } }`.
 * Several extraction streams write their own staging file and run this script; a lock directory serialises
 * the rewrite of the shared catalogs. A key already present with a different message is a conflict and
 * fails the merge. Staging files are left in place (they are the stream's working set) and deleted once the
 * area is committed.
 *
 *   bun scripts/merge-locale-staging.ts            # merge every staging file
 *   bun scripts/merge-locale-staging.ts chat       # merge locales/staging/chat.json only
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LOCALES = join(ROOT, "locales");
const STAGING = join(LOCALES, "staging");
const LOCK = join(STAGING, ".lock");

type Catalog = Record<string, string>;

function isCatalog(value: unknown): value is Catalog {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function readCatalog(path: string): Catalog {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isCatalog(parsed)) throw new Error(`${path} is not a flat catalog`);
  return parsed;
}

function writeCatalog(path: string, catalog: Catalog): void {
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
}

async function withLock<T>(work: () => T): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      if (Date.now() > deadline)
        throw new Error(`stale lock ${LOCK}: remove it if no merge is running`);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 100);
      await promise;
    }
  }
  try {
    return work();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

function merge(areas: string[]): void {
  const en = readCatalog(join(LOCALES, "en.json"));
  const ru = readCatalog(join(LOCALES, "ru.json"));
  const notesPath = join(LOCALES, "NOTES.md");
  let notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
  const conflicts: string[] = [];
  let added = 0;

  for (const area of areas) {
    const file = join(STAGING, `${area}.json`);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file}: expected an object with en/ru/notes`);
    }
    const staged: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
    const stagedEn = isCatalog(staged.en) ? staged.en : {};
    const stagedRu = isCatalog(staged.ru) ? staged.ru : {};
    const stagedNotes = isCatalog(staged.notes) ? staged.notes : {};

    for (const [key, message] of Object.entries(stagedEn)) {
      if (key in en && en[key] !== message) {
        conflicts.push(`${area}: en "${key}" already exists with a different message`);
        continue;
      }
      if (!(key in en)) added += 1;
      en[key] = message;
    }
    for (const [key, message] of Object.entries(stagedRu)) {
      if (!(key in stagedEn) && !(key in en)) {
        conflicts.push(`${area}: ru "${key}" has no English source`);
        continue;
      }
      if (key in ru && ru[key] !== message && !(key in stagedEn)) {
        conflicts.push(`${area}: ru "${key}" already exists with a different message`);
        continue;
      }
      ru[key] = message;
    }
    const newNotes = Object.entries(stagedNotes).filter(([key]) => !notes.includes(`- \`${key}\``));
    if (newNotes.length > 0) {
      const heading = `## ${area}`;
      if (!notes.includes(`${heading}\n`))
        notes += `${notes.endsWith("\n") ? "" : "\n"}\n${heading}\n\n`;
      const lines = newNotes.map(([key, note]) => `- \`${key}\` — ${note}`).join("\n");
      const at = notes.indexOf(`${heading}\n`) + heading.length + 1;
      const nextHeading = notes.indexOf("\n## ", at);
      const end = nextHeading === -1 ? notes.length : nextHeading;
      const section = notes.slice(at, end).replace(/\s+$/, "");
      notes = `${notes.slice(0, at)}${section}\n${lines}\n${nextHeading === -1 ? "" : notes.slice(end)}`;
    }
  }

  if (conflicts.length > 0) {
    for (const conflict of conflicts) process.stderr.write(`CONFLICT ${conflict}\n`);
    throw new Error(`${conflicts.length} conflict(s); nothing merged`);
  }
  writeCatalog(join(LOCALES, "en.json"), en);
  writeCatalog(join(LOCALES, "ru.json"), ru);
  writeFileSync(notesPath, notes);
  process.stdout.write(
    `Merged ${areas.join(", ")}: +${added} new key(s); en ${Object.keys(en).length}, ru ${Object.keys(ru).length}\n`,
  );
}

const requested = process.argv.slice(2);
const areas =
  requested.length > 0
    ? requested
    : existsSync(STAGING)
      ? readdirSync(STAGING)
          .filter((name) => name.endsWith(".json"))
          .map((name) => name.slice(0, -".json".length))
          .sort()
      : [];
if (areas.length === 0) {
  process.stdout.write("Nothing to merge.\n");
} else {
  try {
    await withLock(() => merge(areas));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
