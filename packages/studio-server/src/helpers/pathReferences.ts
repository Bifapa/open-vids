import { encodeAssetUrlPath } from "@hyperframes/core/editing/timeline-asset";

/** What may stand just before a path token: the start, whitespace, or a delimiter that opens a value. */
const BEFORE_TOKEN = "(?:^|[\\s\"'`()\\[\\]{}=,;>|])";
/**
 * What may follow a file path token: the end, whitespace, a closing delimiter, a query / fragment, or a quote written
 * as an entity (`&quot;`, `&#39;`, ... inside an attribute value) or escaped (`\"` inside a JS or JSON string). A bare
 * `&` or `\` ends nothing: only those whole spellings of a quote do.
 */
const AFTER_FILE_TOKEN =
  "(?=$|[\\s\"'`()\\[\\]{},;<>|?#]|&(?:quot|apos|#0*39|#x0*27|#0*34|#x0*22);|\\\\+[\"'])";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceTokens(content: string, pattern: RegExp, replacement: string): string {
  return content.replace(
    pattern,
    (_match, before: string, prefix: string) => `${before}${prefix}${replacement}`,
  );
}

/**
 * Rewrite the references to a renamed project path in a text file (markup, style, script, JSON, Markdown).
 *
 * A reference is the whole path as a token: after the start or a value delimiter (a quote, `(`, `=`, whitespace, ...),
 * optionally behind `/`, `./` or `../`, and ending at the end of the token. Part of a longer name is never touched:
 * renaming the folder `img` leaves `<img>` and `my-img/a.png` alone, renaming `logo.png` leaves `my-logo.png` alone.
 * A folder is only a reference when something inside it is named (`img/a.png`), so its bare name in a class, an id
 * or a sentence stays as written. The URL-encoded spelling (`my%20clip.mp4`, what Studio writes into `src`) is
 * rewritten along with the literal one.
 */
export function rewritePathReferences(
  content: string,
  oldPath: string,
  newPath: string,
  isDirectory: boolean,
): string {
  const spellings: Array<[string, string]> = [[oldPath, newPath]];
  const encodedOld = encodeAssetUrlPath(oldPath);
  if (encodedOld !== oldPath) spellings.push([encodedOld, encodeAssetUrlPath(newPath)]);

  let result = content;
  for (const [from, to] of spellings) {
    if (!result.includes(from)) continue;
    const tail = isDirectory ? "(?=/)" : AFTER_FILE_TOKEN;
    const pattern = new RegExp(
      `(${BEFORE_TOKEN})(/|(?:\\.{1,2}/)*)${escapeRegExp(from)}${tail}`,
      "g",
    );
    result = replaceTokens(result, pattern, to);
  }
  return result;
}

/**
 * The same for the JSON records Studio keeps under `.hyperframes` that name project files (story graph, sync ledger,
 * source provenance, picked ranges): only a whole string, as a value or a key, is a path there, so a path inside prose
 * stays put and the file keeps its formatting.
 */
export function rewriteJsonPathStrings(
  content: string,
  oldPath: string,
  newPath: string,
  isDirectory: boolean,
): string {
  const quoted = (path: string) => JSON.stringify(path).slice(1, -1);
  const tail = isDirectory ? "(?=/)" : '(?=")';
  const pattern = new RegExp(`(")()${escapeRegExp(quoted(oldPath))}${tail}`, "g");
  return replaceTokens(content, pattern, quoted(newPath));
}
