import { VERSION } from "../version.js";

/**
 * Wrap a JSON payload with the `_meta` version envelope. Keeps every
 * `--json` command output self-describing for agents: which CLI build
 * produced it. Synchronous, local-only — never fetches.
 */
export function withMeta<T extends object>(
  data: T,
  extra?: Record<string, unknown>,
): T & { _meta: { version: string } & Record<string, unknown> } {
  return { ...data, _meta: { version: VERSION, ...extra } };
}
/**
 * One-line deprecation notice for a command superseded by `check`. Always
 * writes to stderr (never stdout), so a --json invocation's stdout stays
 * pure, parseable JSON. Call once per invocation, before the command's own
 * output.
 */
export function printDeprecationNotice(command: string): void {
  process.stderr.write(
    `'hyperframes ${command}' is deprecated and will be removed in a future release. Use 'hyperframes check' instead.\n`,
  );
}
