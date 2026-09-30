import type { HostToolResult } from "../backend.ts";

export type OmpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** A host tool's result as OMP tool-result content: the text first, then every image. */
export function hostToolContent(result: HostToolResult): OmpToolContent[] {
  return [
    { type: "text", text: result.text },
    ...(result.images ?? []).map(
      (image): OmpToolContent => ({ type: "image", data: image.data, mimeType: image.mimeType }),
    ),
  ];
}
