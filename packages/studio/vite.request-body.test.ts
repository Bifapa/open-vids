import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ServerResponse, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { clientAbortSignal, readNodeRequestBody } from "./vite.request-body.js";

describe("readNodeRequestBody", () => {
  it("preserves binary request bytes", async () => {
    const source = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const body = await readNodeRequestBody(
      Readable.from([source.subarray(0, 3), source.subarray(3)]),
    );

    expect(Buffer.compare(body, source)).toBe(0);
  });

  it("returns an empty buffer when the request has no body", async () => {
    const body = await readNodeRequestBody(Readable.from([]));

    expect(body.byteLength).toBe(0);
  });
});

describe("clientAbortSignal", () => {
  function response(): ServerResponse {
    return new ServerResponse(new IncomingMessage(new Socket()));
  }

  it("aborts when the connection closes before the response ended", () => {
    const res = response();
    const signal = clientAbortSignal(res);
    expect(signal.aborted).toBe(false);

    res.emit("close");

    expect(signal.aborted).toBe(true);
  });

  it("stays live when the response finished normally", () => {
    const res = response();
    const signal = clientAbortSignal(res);

    res.end();
    res.emit("close");

    expect(signal.aborted).toBe(false);
  });

  it("is already aborted when the connection went away before the signal was made", () => {
    const socket = new Socket();
    const res = new ServerResponse(new IncomingMessage(socket));
    res.assignSocket(socket);
    socket.destroy();

    expect(clientAbortSignal(res).aborted).toBe(true);
  });

  it("is already aborted for a destroyed response", () => {
    const res = response();
    res.destroy();

    expect(clientAbortSignal(res).aborted).toBe(true);
  });

  it("is not aborted for a response that already ended", () => {
    const socket = new Socket();
    const res = new ServerResponse(new IncomingMessage(socket));
    res.assignSocket(socket);
    res.end();
    socket.destroy();

    expect(clientAbortSignal(res).aborted).toBe(false);
  });
});
