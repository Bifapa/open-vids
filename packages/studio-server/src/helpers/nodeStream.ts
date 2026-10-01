import type { Readable } from "node:stream";

/** A DOM `ReadableStream` over a node stream, with back-pressure (`Readable.toWeb` yields node's own stream type). */
export function webBody(source: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on("data", (chunk: Uint8Array) => {
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) source.pause();
      });
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        finish();
      };
      source.on("end", () => settle(() => controller.close()));
      source.on("error", (error) => settle(() => controller.error(error)));
      // A connection cut mid-body closes without "end": that is a failure, not a short answer.
      source.on("close", () =>
        settle(() => controller.error(new Error("The connection closed before the body ended"))),
      );
    },
    pull() {
      source.resume();
    },
    cancel(reason) {
      source.destroy(reason instanceof Error ? reason : undefined);
    },
  });
}
