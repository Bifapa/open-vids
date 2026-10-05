/**
 * Node-only asset-path helpers. The browser-safe URL primitives are in `assetUrls.ts`.
 */

import { isAbsolute, relative, resolve } from "node:path";

/**
 * Cross-platform containment check: is `childPath` inside `parentPath`?
 * Equality counts as "inside".
 */
export function isPathInside(childPath: string, parentPath: string): boolean {
  const absChild = resolve(childPath);
  const absParent = resolve(parentPath);
  if (absChild === absParent) return true;
  const rel = relative(absParent, absChild);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
