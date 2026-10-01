import { isRecord } from "@hyperframes/agent-protocol";
import { LANGUAGE_CODES, SOURCE_LANGUAGE } from "./languages";

/** One locale file: flat dotted keys to ICU message strings. */
export type Catalog = Record<string, string>;

export function isCatalog(value: unknown): value is Catalog {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Every locale file except `en` (bundled with the app) and the catalog's own `index.json` / `cases.json`.
 * Vite turns each one into its own chunk, fetched only when that language is first shown.
 */
const LOADERS = import.meta.glob<unknown>(
  ["../../../../locales/*.json", "!../../../../locales/{en,index,cases}.json"],
  { import: "default" },
);

const LOADER_BY_CODE = new Map<string, () => Promise<unknown>>(
  Object.entries(LOADERS).flatMap(([path, load]) => {
    const code = /([^/]+)\.json$/.exec(path)?.[1];
    return code && LANGUAGE_CODES.includes(code) && code !== SOURCE_LANGUAGE
      ? [[code, load] as const]
      : [];
  }),
);

/** The messages of one language, imported on demand. */
export async function loadCatalog(code: string): Promise<Catalog> {
  const load = LOADER_BY_CODE.get(code);
  if (!load) throw new Error(`No locale file for language "${code}".`);
  const data = await load();
  if (!isCatalog(data)) throw new Error(`locales/${code}.json is not a flat message catalog.`);
  return data;
}
