/** What a render still has ahead of it: waiting for the machine's render slot, or running. */
export type ActiveRenderStatus = "queued" | "rendering";

/** Where a render stands in the machine-wide queue (the render route's `queued` answer and progress events). */
export interface QueueStanding {
  /** 1 for the next render to start, 2 for the one after it. */
  position?: number;
  /** The project of the render that holds the slot now. */
  holder?: string;
}

/** The live status of a start answer or progress event: `queued`, else `rendering` (anything else is an outcome). */
export function readActiveStatus(data: unknown): ActiveRenderStatus | null {
  if (typeof data !== "object" || data === null || !("status" in data)) return null;
  if (data.status === "queued") return "queued";
  if (data.status === "rendering") return "rendering";
  return null;
}

/** The queue place a start answer or progress event reports; empty once the render is no longer queued. */
export function readQueueStanding(data: unknown): QueueStanding {
  if (readActiveStatus(data) !== "queued" || typeof data !== "object" || data === null) return {};
  const position =
    "queuePosition" in data && typeof data.queuePosition === "number"
      ? data.queuePosition
      : undefined;
  const holder =
    "queueHolder" in data &&
    typeof data.queueHolder === "object" &&
    data.queueHolder !== null &&
    "projectName" in data.queueHolder &&
    typeof data.queueHolder.projectName === "string"
      ? data.queueHolder.projectName
      : undefined;
  return { position, holder };
}

/** Whether a row is still going to produce a file: it waits in the queue or renders. */
export function isActiveStatus(status: string): status is ActiveRenderStatus {
  return status === "queued" || status === "rendering";
}
