import {
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  WEBSITE_LIMITS,
  isRecord,
  type AssetSearchRequest,
  type ResearchMediaKind,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { ResearchToolError } from "./host.js";

/** A tool refusal the model reads (as opposed to a thrown {@link ResearchToolError}, which is formatted by the server's codes). */
export const refuse = (text: string): HostToolResult => ({ text, isError: true });

export const invalid = (message: string) => new ResearchToolError("invalid_request", message);

export function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) throw invalid("arguments must be a JSON object");
  return args;
}

/** Models send `null` for "not given". */
export function optionalText(
  record: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw invalid(`${key} must be at most ${max} characters`);
  return trimmed;
}

export function requiredText(record: Record<string, unknown>, key: string, max: number): string {
  const value = optionalText(record, key, max);
  if (value === undefined) throw invalid(`${key} is required`);
  return value;
}

export function optionalKind(record: Record<string, unknown>): ResearchMediaKind | undefined {
  const value = record.mediaKind;
  if (value === undefined || value === null) return undefined;
  const kind = RESEARCH_MEDIA_KINDS.find((candidate) => candidate === value);
  if (!kind) throw invalid(`mediaKind must be one of ${RESEARCH_MEDIA_KINDS.join(", ")}`);
  return kind;
}

export function parseSearch(args: unknown): AssetSearchRequest {
  const record = argsRecord(args);
  const query = requiredText(record, "query", RESEARCH_LIMITS.queryChars);
  const mediaKind = optionalKind(record);
  if (!mediaKind) throw invalid("mediaKind is required");
  const request: AssetSearchRequest = { query, mediaKind };
  const { sources, limit } = record;
  if (sources !== undefined && sources !== null) {
    if (!Array.isArray(sources) || !sources.every((id) => typeof id === "string"))
      throw invalid("sources must be an array of source ids");
    const ids = [...new Set(sources.map((id: string) => id.trim()).filter(Boolean))];
    if (ids.length > RESEARCH_LIMITS.sources) throw invalid("too many sources");
    if (ids.length > 0) request.sources = ids;
  }
  if (limit !== undefined && limit !== null) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
      throw invalid("limit must be a positive integer");
    request.limit = Math.min(limit, RESEARCH_LIMITS.searchResults);
  }
  return request;
}

/** A recording viewport side: an even integer within the limits, or nothing when not given. */
export function optionalSide(
  record: Record<string, unknown>,
  key: "width" | "height",
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 2 ||
    value > WEBSITE_LIMITS.recordMaxSide ||
    value % 2 !== 0
  )
    throw invalid(`${key} must be an even integer between 2 and ${WEBSITE_LIMITS.recordMaxSide}`);
  return value;
}
