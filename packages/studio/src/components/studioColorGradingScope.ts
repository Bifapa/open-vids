import { t } from "../i18n";
import { saveProjectFilesWithHistory } from "../utils/studioFileHistory";
import { patchMediaColorGradingInHtml } from "./editor/colorGradingScopePatch";
import { hasRelativeLutSource } from "./studioMediaJobs";

export type ColorGradingScope = "source-file" | "project";
export type ColorGradingScopeResult = { changedFiles: number; changedElements: number };

type ProjectFileReader = (path: string) => Promise<string>;
type ProjectFileWriter = (path: string, content: string) => Promise<void>;
type ShowToast = (message: string, tone?: "error" | "info") => void;
type RecordEdit = (entry: {
  label: string;
  files: Record<string, { before: string; after: string }>;
}) => Promise<void>;

export const EMPTY_COLOR_GRADING_SCOPE_RESULT: ColorGradingScopeResult = {
  changedFiles: 0,
  changedElements: 0,
};

interface ApplyColorGradingScopeOptions {
  scope: ColorGradingScope;
  value: string | null;
  selectedSourceFile: string;
  compositionPaths: string[];
  projectId: string;
  waitForPendingDomEditSaves: () => Promise<void>;
  readProjectFile: ProjectFileReader;
  writeProjectFile: ProjectFileWriter;
  recordEdit: RecordEdit;
  reloadPreview: () => void;
  showToast: ShowToast;
}

function colorGradingScopePaths(
  scope: ColorGradingScope,
  selectedSourceFile: string,
  compositionPaths: string[],
): string[] {
  return scope === "source-file" ? [selectedSourceFile] : compositionPaths;
}

export async function applyColorGradingScopeUpdate({
  scope,
  value,
  selectedSourceFile,
  compositionPaths,
  projectId,
  waitForPendingDomEditSaves,
  readProjectFile,
  writeProjectFile,
  recordEdit,
  reloadPreview,
  showToast,
}: ApplyColorGradingScopeOptions): Promise<ColorGradingScopeResult> {
  await waitForPendingDomEditSaves();
  if (scope === "project" && hasRelativeLutSource(value)) {
    showToast(t("shell.colorGrading.relativeLut"), "error");
    return EMPTY_COLOR_GRADING_SCOPE_RESULT;
  }

  let changedElements = 0;
  const patchGrading = (before: string) => {
    const result = patchMediaColorGradingInHtml(before, value);
    changedElements += result.count;
    return result.html;
  };
  const paths = colorGradingScopePaths(scope, selectedSourceFile, compositionPaths);
  const changedPaths = await saveProjectFilesWithHistory({
    projectId,
    label: value ? t("shell.colorGrading.applyLabel") : t("shell.colorGrading.clearLabel"),
    files: Object.fromEntries(paths.map((path) => [path, patchGrading])),
    readFile: readProjectFile,
    writeFile: writeProjectFile,
    recordEdit,
  });
  if (changedPaths.length === 0) {
    showToast(t("shell.colorGrading.unchanged"), "info");
    return EMPTY_COLOR_GRADING_SCOPE_RESULT;
  }
  reloadPreview();
  showToast(
    t(value ? "shell.colorGrading.applied" : "shell.colorGrading.cleared", {
      count: changedElements,
    }),
    "info",
  );
  return { changedFiles: changedPaths.length, changedElements };
}
