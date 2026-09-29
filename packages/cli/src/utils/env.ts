/**
 * Detect whether we're running from source (monorepo dev) or from the built bundle.
 * In dev: files are .ts (running via tsx). In production: bundled into .js by tsup.
 */
export function isDevMode(): boolean {
  try {
    const url = new URL(import.meta.url);
    return url.pathname.endsWith(".ts");
  } catch {
    // Fail-safe: if URL parsing fails for any reason, assume production.
    // Fail closed so dev-only behavior stays off unless positively detected.
    return false;
  }
}
