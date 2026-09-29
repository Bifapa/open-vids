/**
 * Minimal Server-Sent-Events framing shared by the runtime (encode), the
 * gateway (pass-through) and any non-EventSource client/test (decode).
 */

export interface SseMessage {
  /** `id:` field; the chat stream uses the event seq. */
  id?: string;
  event?: string;
  data: string;
}

export function encodeSseMessage(message: SseMessage): string {
  const lines: string[] = [];
  if (message.id !== undefined) lines.push(`id: ${message.id}`);
  if (message.event !== undefined) lines.push(`event: ${message.event}`);
  for (const line of message.data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** A comment frame; keeps idle connections alive through proxies. */
export const SSE_KEEPALIVE = ": keepalive\n\n";

/**
 * Incremental SSE parser: feed decoded text chunks, get complete messages.
 * Comment frames and frames without data are dropped.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const messages: SseMessage[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const message = parseFrame(frame);
      if (message) messages.push(message);
      boundary = this.buffer.indexOf("\n\n");
    }
    return messages;
  }
}

function parseFrame(frame: string): SseMessage | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":") || line.length === 0) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const raw = colon < 0 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return {
    data: data.join("\n"),
    ...(id !== undefined && { id }),
    ...(event !== undefined && { event }),
  };
}

/** SSE event names used by the runtime. */
export const SSE_EVENTS = {
  chat: "chat",
  project: "project",
} as const;
