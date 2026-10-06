import type { ImportFromProjectResult } from "@hyperframes/agent-protocol";
import { megabytes, provenanceLine } from "../research/format.js";
import type { AttachedProject } from "./access.js";

const RESULT_CHARS = 8_000;

/**
 * What the model reads after `import_from_project`: where each file landed, how big it is, whether it was copied or
 * already there, and under which license it came (or that it has no license record). The facts come from Studio's
 * records, never from the model.
 */
export function formatImportFromProject(
  project: AttachedProject,
  result: ImportFromProjectResult,
  requested: number,
): string {
  const lines: string[] = [];
  const done = result.imported.length;
  lines.push(
    done === 0
      ? `Nothing was copied from "${project.name}".`
      : `Copied ${done} of ${requested} ${requested === 1 ? "file" : "files"} from "${project.name}" into this project:`,
  );
  for (const file of result.imported) {
    const size = megabytes(file.bytes);
    lines.push(
      file.status === "existing"
        ? `- ${file.source} → ${file.asset} (${size}; existing: this project already held the same bytes, nothing was added)`
        : `- ${file.source} → ${file.asset} (${size}; copied)`,
    );
    const record = file.provenance;
    if (record === null) {
      lines.push(
        "  License: NO license record came with it — in the other project it has none, so it is the user's own file or its origin is unknown. Do not claim a license; say so when you report it.",
      );
      continue;
    }
    lines.push(`  Source: ${provenanceLine(record)}`);
    if (record.licenseStatus !== "clear") lines.push(`  Credit line: ${record.attribution}`);
  }
  if (result.skipped.length > 0) {
    lines.push("Skipped:");
    for (const skipped of result.skipped) lines.push(`- ${skipped.source}: ${skipped.reason}`);
  }
  if (done > 0)
    lines.push(
      "Use the project paths above (the right side of →) with edit_timeline; never the other project's paths.",
    );
  const text = lines.join("\n");
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS - 1).trimEnd()}…` : text;
}
