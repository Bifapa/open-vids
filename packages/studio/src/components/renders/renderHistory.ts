import type { RenderJob } from "./useRenderQueue";

/** One entry of the server's render history (`GET /projects/:id/renders`). */
export interface ServerRender {
  id: string;
  filename: string;
  createdAt: number;
  status?: string;
  durationMs?: number;
}

function isServerRender(value: unknown): value is ServerRender {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "filename" in value &&
    typeof value.filename === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "number"
  );
}

/** The usable entries of a history response; anything else reads as an empty history. */
export function readServerRenders(data: unknown): ServerRender[] {
  if (typeof data !== "object" || data === null || !("renders" in data)) return [];
  return Array.isArray(data.renders) ? data.renders.filter(isServerRender) : [];
}

/** A history entry as a row of the queue: a render the server has on disk, or its failed record. */
export function jobFromServer(render: ServerRender): RenderJob {
  return {
    id: render.id,
    status: render.status === "failed" ? "failed" : "complete",
    progress: 100,
    filename: render.filename,
    createdAt: render.createdAt,
    durationMs: render.durationMs,
  };
}

/**
 * The queue's rows once the server's history arrived. Entries this session has no row for are added (unless the user
 * hid them). A row this session only *guessed* had failed — its progress stream dropped and the server could not be
 * asked — is replaced by the server's record when that says the render finished. Every other row stays as it is:
 * for the renders this session watched, the progress stream was told the outcome first-hand.
 */
export function mergeServerRenders(
  rows: readonly RenderJob[],
  history: readonly ServerRender[],
  hidden: ReadonlySet<string>,
): RenderJob[] {
  const listed = new Map(history.map((render) => [render.id, render]));
  const known = new Set(rows.map((row) => row.id));
  const merged = rows.map((row) => {
    const record = listed.get(row.id);
    return row.connectionLost && record && record.status !== "failed" ? jobFromServer(record) : row;
  });
  const added = history
    .filter((render) => !known.has(render.id) && !hidden.has(render.id))
    .map(jobFromServer);
  return [...merged, ...added];
}
