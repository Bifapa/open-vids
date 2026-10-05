export async function readNodeRequestBody(
  req: AsyncIterable<string | Uint8Array>,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

interface CloseEmitter {
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  readonly socket?: { readonly destroyed: boolean } | null;
  once(event: "close", listener: () => void): unknown;
}

/**
 * A signal that aborts when the client goes away before the response finished.
 * The API routes that stop child processes on cancel (QA, analysis, research,
 * site recording) listen to the forwarded request's signal, so the bridge has to
 * carry the disconnect across, as the CLI host does with the raw request signal.
 *
 * Create it before anything is awaited: `close` fires once and is not replayed,
 * so a client that left while the studio module was still loading is only seen
 * through the response and socket state, which this checks at once.
 */
export function clientAbortSignal(res: CloseEmitter): AbortSignal {
  const controller = new AbortController();
  if (!res.writableEnded && (res.destroyed || res.socket?.destroyed === true)) {
    controller.abort();
    return controller.signal;
  }
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
