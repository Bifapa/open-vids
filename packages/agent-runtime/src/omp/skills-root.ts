import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = join("hyperframes", "SKILL.md");

/**
 * The bundled skills tree (composition conventions, presets, animation guidance) agents may read, or null when it
 * cannot be found. `OPENVIDS_SKILLS_DIR` wins; otherwise the tree is searched for next to this runtime:
 * a source checkout has it at the repo root (`skills/`), the packaged app stages it beside the runtime
 * (`<resources>/runtime/hyperframes/skills`, the runtime itself being `<resources>/runtime/agent-runtime`).
 */
export function bundledSkillsRoot(
  here: string = dirname(fileURLToPath(import.meta.url)),
  override: string | undefined = process.env["OPENVIDS_SKILLS_DIR"],
): string | null {
  if (override) {
    const dir = isAbsolute(override) ? override : resolve(override);
    return existsSync(join(dir, MARKER)) ? dir : null;
  }
  let dir = resolve(here);
  for (let depth = 0; depth < 12; depth += 1) {
    for (const candidate of [join(dir, "skills"), join(dir, "hyperframes", "skills")]) {
      if (existsSync(join(candidate, MARKER))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The line that tells an agent where the read-only skills are (they are outside the project folder). */
export function skillsInstruction(root: string): string {
  return `\n\nBundled HyperFrames skills (read-only reference for composition conventions, presets and animation; outside the project): ${root}. Use read, grep, glob or find with absolute paths under it; you cannot edit or write there.`;
}
