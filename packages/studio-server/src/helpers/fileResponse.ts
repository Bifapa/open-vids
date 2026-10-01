import { createReadStream, statSync } from "node:fs";
import { webBody } from "./nodeStream.js";

type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * A single `Range: bytes=…` window over a file of `size` bytes. `null` = no (or an unusable / multi-range) header,
 * which is answered with the whole file as RFC 9110 allows; "unsatisfiable" = 416.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    // Suffix form: the last `n` bytes.
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return null;
  return { start, end };
}

/**
 * Streams `filePath` (never buffering it) and honours one byte range: 206 + `Content-Range` for a window, 416 when
 * it lies past the end, the whole file otherwise. `headers` are added to every answer.
 */
export function fileResponse(
  filePath: string,
  rangeHeader: string | undefined,
  headers: Record<string, string>,
): Response {
  const size = statSync(filePath).size;
  const range = parseByteRange(rangeHeader, size);
  const common = { ...headers, "Accept-Ranges": "bytes" };
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...common, "Content-Range": `bytes */${size}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  const body = length > 0 ? webBody(createReadStream(filePath, { start, end })) : null;
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...common,
      "Content-Length": String(length),
      ...(range && { "Content-Range": `bytes ${start}-${end}/${size}` }),
    },
  });
}
