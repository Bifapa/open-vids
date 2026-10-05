import { homedir } from "node:os";
import path from "node:path";

/**
 * How OMP's file tools read a path string before touching the filesystem, so the project guards
 * judge the file a tool will really act on rather than the spelling the model typed.
 *
 * OMP's own helpers (`normalizePathLikeInput`, `unwrapHashlineHeaderPath`, `expandPath`,
 * `resolveToCwd`, `isReadableUrlPath`) cannot be imported here: they pull in OMP's native loader,
 * which only starts under Bun, while the guards are also exercised by Node test runners. They are
 * mirrored instead, and deliberately as a superset: each normalization step is applied
 * unconditionally and in every order, so the guards check every file OMP could choose and a few it
 * would not. `path-forms.parity.test.ts` runs OMP's real helpers under Bun and fails when one of
 * them lands somewhere these readings do not cover.
 */

const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const READABLE_WEB_URL = /^https?:\/\/?/i;
const WWW_HOST = /^www\./i;
// OMP's InternalUrlRouter.normalize rewrites the single-slash spelling of a scheme that declares
// `singleSlashAlias` to `scheme://`. `local` is the only built-in one (local-protocol.ts); the parity test
// fails when OMP gains another.
const INTERNAL_URL_ALIAS = /^local:\/(?!\/)/i;
const HASHLINE_HEADER = /^\[(.+)\]$/;
const HASHLINE_TAG = /#[0-9A-Za-z]+$/;

/** Strings OMP fetches from the network or routes to a scheme handler instead of a file. */
export function isUrlShaped(reading: string): boolean {
  return (
    URL_SCHEME.test(reading) ||
    READABLE_WEB_URL.test(reading) ||
    WWW_HOST.test(reading) ||
    INTERNAL_URL_ALIAS.test(reading)
  );
}

/** One normalization step per entry: the readings it adds for a string (none when it does not apply). */
const STEPS: ReadonlyArray<(reading: string) => string[]> = [
  // surrounding double quotes
  (reading) =>
    reading.length > 1 && reading.startsWith('"') && reading.endsWith('"')
      ? [reading.slice(1, -1)]
      : [],
  // hashline headers: `[path]` and `[path#TAG]`
  (reading) => {
    const inner = HASHLINE_HEADER.exec(reading.trimEnd())?.[1];
    return inner === undefined ? [] : [inner, inner.replace(HASHLINE_TAG, "")];
  },
  // a stray leading `:` before a path
  (reading) => (reading.startsWith(":") ? [reading.slice(1)] : []),
  // a leading `@` shorthand
  (reading) => (reading.startsWith("@") ? [reading.slice(1)] : []),
];

function expandTilde(reading: string): string[] {
  if (!reading.startsWith("~")) return [];
  // `~`, `~/x`, `~\x` and `~name/x` all land under the home directory; OMP joins `~/x` and `~\x`
  // by plain concatenation and `~name` through `path.join`
  const rest = reading.slice(1);
  return [path.join(homedir(), rest), homedir() + rest];
}

/** Every reading of `raw` OMP might act on, `raw` itself included. */
export function pathReadings(raw: string): string[] {
  const readings = new Set<string>([raw]);
  const queue = [raw];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const step of STEPS) {
      for (const reading of step(next)) {
        if (readings.has(reading)) continue;
        readings.add(reading);
        queue.push(reading);
      }
    }
  }
  return [...readings];
}

/**
 * The absolute paths `raw` can name for a tool running in `cwd`, in decreasing order of how
 * likely OMP is to use them (its normalized reading first, the literal one last), or `null` when
 * any reading is a URL.
 */
export function resolveLikeOmp(cwd: string, raw: string): string[] | null {
  const readings = pathReadings(raw).reverse();
  const absolutes = new Set<string>();
  for (const reading of readings) {
    if (isUrlShaped(reading)) return null;
    for (const expanded of expandTilde(reading)) absolutes.add(path.resolve(cwd, expanded));
  }
  for (const reading of readings) absolutes.add(path.resolve(cwd, reading));
  return [...absolutes];
}
