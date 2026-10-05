import { join } from "node:path";

/**
 * Join a directory and an image2 frame pattern (`frame_%06d.jpg`) into one
 * ffmpeg path.
 *
 * The image2 demuxer and muxer printf-expand the WHOLE path, not just the file
 * name, so a literal `%` in a directory (`Promo 50% off`) is read as a broken
 * format specifier and the open fails. Only the directory part is escaped
 * (`%` → `%%`); the pattern keeps its own specifiers.
 */
export function image2PatternPath(dir: string, pattern: string): string {
  return join(dir.replaceAll("%", "%%"), pattern);
}
