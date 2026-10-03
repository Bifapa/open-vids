import type { MessageReference } from "@hyperframes/agent-protocol";
import { TIMELINE_ASSET_MIME } from "../utils/timelineAssetDrop";

export type AttachmentKind = "image" | "video" | "audio" | "file";
export type AttachmentStatus = "uploading" | "ready" | "failed";

/** One file the next message carries, as the composer shows it. */
export interface ComposerAttachment {
  id: string;
  /** File name shown on the chip. */
  name: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  /** Project-relative path; null while the file is still uploading (or when the upload failed). */
  path: string | null;
  sizeBytes?: number;
  durationSeconds?: number;
}

/** A project file named by an internal drag (Media tile, file tree row). */
export interface DroppedProjectFile {
  path: string;
  sizeBytes?: number;
  durationSeconds?: number;
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/i;
const VIDEO_NAME = /\.(mp4|webm|mov|m4v|mkv|avi)$/i;
const AUDIO_NAME = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;

/** A file's kind by its MIME type, else by its extension; anything else is a plain file. */
export function attachmentKindOf(name: string, mimeType = ""): AttachmentKind {
  if (mimeType.startsWith("image/") || IMAGE_NAME.test(name)) return "image";
  if (mimeType.startsWith("video/") || VIDEO_NAME.test(name)) return "video";
  if (mimeType.startsWith("audio/") || AUDIO_NAME.test(name)) return "audio";
  return "file";
}

let nextAttachmentId = 0;

/** The chip of an OS file that is being uploaded into the project. */
export function uploadingAttachment(file: File): ComposerAttachment {
  return {
    id: `attach-${(nextAttachmentId += 1)}`,
    name: file.name,
    kind: attachmentKindOf(file.name, file.type),
    status: "uploading",
    path: null,
    sizeBytes: file.size,
  };
}

/** The chip of a file that already lives in the project. */
export function projectAttachment(file: DroppedProjectFile): ComposerAttachment {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1) || file.path;
  return {
    id: `attach-${(nextAttachmentId += 1)}`,
    name,
    kind: attachmentKindOf(name),
    status: "ready",
    path: file.path,
    ...(file.sizeBytes !== undefined && { sizeBytes: file.sizeBytes }),
    ...(file.durationSeconds !== undefined && { durationSeconds: file.durationSeconds }),
  };
}

/** The message reference of a ready attachment; null while it is uploading or after a failed upload. */
export function attachmentReference(attachment: ComposerAttachment): MessageReference | null {
  if (attachment.status !== "ready" || attachment.path === null) return null;
  const common = {
    id: attachment.id,
    label: attachment.name,
    ...(attachment.sizeBytes !== undefined && { sizeBytes: attachment.sizeBytes }),
    ...(attachment.durationSeconds !== undefined && {
      durationSeconds: attachment.durationSeconds,
    }),
  };
  if (attachment.kind === "file") return { ...common, kind: "asset", path: attachment.path };
  return {
    ...common,
    kind: attachment.kind,
    source: { type: "project-path", path: attachment.path },
  };
}

/** The references the next message sends: every ready attachment. */
export function attachmentReferences(
  attachments: readonly ComposerAttachment[],
): MessageReference[] {
  return attachments.flatMap((attachment) => attachmentReference(attachment) ?? []);
}

export function isUploading(attachments: readonly ComposerAttachment[]): boolean {
  return attachments.some((attachment) => attachment.status === "uploading");
}

/** True when the drag carries OS files. */
export function hasFileDrag(dataTransfer: Pick<DataTransfer, "types">): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

/**
 * True when the drag may carry a project file: a Media tile (its own type) or a file tree row (a plain-text path,
 * which is only known to be one once dropped).
 */
export function hasProjectFileDrag(dataTransfer: Pick<DataTransfer, "types">): boolean {
  const types = Array.from(dataTransfer.types);
  return types.includes(TIMELINE_ASSET_MIME) || types.includes("text/plain");
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseAssetPayload(raw: string): DroppedProjectFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const path: unknown = Reflect.get(parsed, "path");
  if (typeof path !== "string" || path.length === 0) return null;
  const sizeBytes = finiteNonNegative(Reflect.get(parsed, "bytes"));
  const durationSeconds = finiteNonNegative(Reflect.get(parsed, "duration"));
  return {
    path,
    ...(sizeBytes !== undefined && { sizeBytes }),
    ...(durationSeconds !== undefined && { durationSeconds }),
  };
}

/**
 * The project file an internal drag carries. A Media tile writes `{path, bytes?, duration?}` under the timeline asset
 * type; a file tree row writes its path as plain text, accepted only when it names a file of the project (so
 * dragged-in prose never becomes an attachment).
 */
export function readDroppedProjectFile(
  dataTransfer: Pick<DataTransfer, "getData">,
  projectFiles: ReadonlySet<string>,
): DroppedProjectFile | null {
  const asset = dataTransfer.getData(TIMELINE_ASSET_MIME);
  if (asset) return parseAssetPayload(asset);
  const plain = dataTransfer.getData("text/plain").trim();
  return plain && projectFiles.has(plain) ? { path: plain } : null;
}
