import { t, type TranslationKey } from "../../i18n";

/**
 * The grade runtime reports its state as an English sentence: the preview runtime
 * (`core/src/runtime/colorGrading.ts`) and `useColorGradingController` both hand over
 * `{ state, message }`. The sentences are the only contract, so the panel translates the
 * ones it knows by their exact text and shows anything else (a shader or LUT error with
 * its own detail) as it came.
 */
const STATUS_MESSAGE_KEYS = {
  "Waiting for runtime": "inspector.grade.status.waitingRuntime",
  "Preview unavailable": "inspector.grade.status.previewUnavailable",
  "Save failed — reverted": "inspector.grade.status.saveFailed",
  "Updating shader": "inspector.grade.status.updatingShader",
  "Media not found": "inspector.grade.status.mediaNotFound",
  "Loading LUT": "inspector.grade.status.loadingLut",
  "Waiting for media frame": "inspector.grade.status.waitingFrame",
  "Shader + LUT active": "inspector.grade.status.shaderLutActive",
  "Shader active": "inspector.grade.status.shaderActive",
  "Waiting for visible media": "inspector.grade.status.waitingVisible",
  "WebGL unavailable": "inspector.grade.status.webglUnavailable",
  "No grading applied": "inspector.grade.status.none",
} as const satisfies Record<string, TranslationKey>;

type KnownStatusMessage = keyof typeof STATUS_MESSAGE_KEYS;

function isKnownStatusMessage(message: string): message is KnownStatusMessage {
  return Object.hasOwn(STATUS_MESSAGE_KEYS, message);
}

/** The grade status line in the active language. Call at render time. */
export function gradeStatusText(message: string): string {
  return isKnownStatusMessage(message) ? t(STATUS_MESSAGE_KEYS[message]) : message;
}
