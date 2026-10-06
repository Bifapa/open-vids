import type { ExportLicenseWarning } from "@hyperframes/agent-protocol";
import { readAttachedDesign } from "./snapshot.js";

/**
 * Pre-export warnings for the design system attached to a project: fonts and a logo whose license the library could
 * not establish, and fonts that exist only on the author's machine. Read from the project's own `design/design.json`,
 * so a fork or a moved project is checked without the library. Never blocking; empty without a snapshot.
 */
export function designLicenseWarnings(projectDir: string): ExportLicenseWarning[] {
  const attached = readAttachedDesign(projectDir);
  if (attached === null) return [];
  const where = `in the design system “${attached.name}”`;
  const notes = new Map<string, string[]>();
  const note = (asset: string, text: string) =>
    notes.set(asset, [...(notes.get(asset) ?? []), text]);
  for (const entry of attached.unknownLicenses) {
    if (entry === "logo") {
      note("design:logo", `The logo ${where}: license unknown; check it before publishing`);
    } else if (entry.startsWith("font:")) {
      const family = entry.slice("font:".length);
      note(
        `design:font:${family}`,
        `Font “${family}” ${where}: license unknown; check it before publishing`,
      );
    }
  }
  for (const family of attached.nonPortableFonts) {
    note(
      `design:font:${family}`,
      `Font “${family}” ${where} is installed on the author's machine only; it may render differently elsewhere`,
    );
  }
  return [...notes].map(([asset, messages]) => ({
    asset,
    status: "unknown",
    license: "unknown",
    message: messages.join("; "),
  }));
}
