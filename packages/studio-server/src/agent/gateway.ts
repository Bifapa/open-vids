import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  AGENT_HEADERS,
  AGENT_RUNTIME_PREFIX,
  encodeScopeHeader,
} from "@hyperframes/agent-protocol";
import type { ResolvedProject } from "../types.js";

export interface AgentRuntimeLaunch {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type AgentGatewayStatus = "stopped" | "starting" | "running" | "failed";

export interface AgentGateway {
  handle(
    request: Request,
    ctx: { project: ResolvedProject; subPath: string; origin: string },
  ): Promise<Response>;
  status(): AgentGatewayStatus;
  dispose(): Promise<void>;
}

export interface AgentGatewayOptions {
  launch: () => AgentRuntimeLaunch | null;
  /** The wait after a first failed start before the next may begin; it doubles per failure (default 1 s). */
  backoffMinMs?: number;
  /** How long a request may wait for the runtime's response headers before the runtime is probed (default 60 s). */
  requestTimeoutMs?: number;
  /** How long the health probe after a timed-out request may take (default 3 s). */
  healthProbeTimeoutMs?: number;
}

interface RuntimeInstance {
  child: ChildProcess;
  token: string;
  port: number | null;
  ready: boolean;
  exited: boolean;
  failureRecorded: boolean;
  lifecycleSettled: boolean;
  startupAbort: AbortController;
  rejectLifecycle: (error: Error) => void;
  requests: Set<AbortController>;
  healthyTimer: ReturnType<typeof setTimeout> | null;
}

const STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const HEALTHY_RESET_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
const HEALTH_PROBE_TIMEOUT_MS = 3_000;
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "last-event-id"];

class RuntimeUnavailableError extends Error {}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: Deferred<T>["resolve"];
  let rejectPromise!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function lifecyclePort(line: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("openvids-agent" in parsed) || parsed["openvids-agent"] !== "listening") return null;
  if (!("port" in parsed)) return null;
  const port = parsed.port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535
    ? port
    : null;
}

function jsonError(
  status: number,
  code: "invalid_request" | "runtime_unavailable",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

const NOT_INSTALLED_MESSAGE =
  "The local agent runtime is not installed. Rebuild or reinstall OpenVids to include it.";

/**
 * The answer while the runtime is being replaced: at once, never after waiting out the back-off inside the request.
 * 503, code `runtime_restarting`, `Retry-After` and `details.retryAfterSeconds` in whole seconds; the request was not
 * forwarded, so repeating it is safe.
 */
function restartingResponse(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return Response.json(
    {
      error: {
        code: "runtime_restarting",
        message: `The agent runtime is restarting. Try again in ${seconds} s.`,
        details: { retryAfterSeconds: seconds },
      },
    },
    { status: 503, headers: { "retry-after": String(seconds) } },
  );
}

function hasJsonBody(request: Request): boolean {
  if (request.method !== "POST" && request.method !== "PATCH") return false;
  if (request.body === null || request.headers.get("content-length") === "0") return false;
  return true;
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function originMatchesHost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const host = request.headers.get("host");
  if (host === null) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

function formatStartError(error: unknown): string {
  if (error instanceof RuntimeUnavailableError) return error.message;
  return "The local agent runtime could not be started. Please restart Studio and try again.";
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = createDeferred<void>();
  const timer = setTimeout(() => resolve(), ms);
  timer.unref?.();
  return promise;
}

function makeRuntimeUrl(port: number, subPath: string, requestUrl: string): URL {
  const url = new URL(`http://127.0.0.1:${port}${AGENT_RUNTIME_PREFIX}/`);
  const encodedPath = subPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  url.pathname = `${AGENT_RUNTIME_PREFIX}/${encodedPath}`;
  url.search = new URL(requestUrl).search;
  return url;
}

function copyResponseBody(
  response: Response,
  controller: AbortController,
  onFinished: () => void,
): ReadableStream<Uint8Array> | null {
  if (!response.body) {
    onFinished();
    return null;
  }

  const reader = response.body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const result = await reader.read();
        if (result.done) {
          onFinished();
          streamController.close();
        } else {
          streamController.enqueue(result.value);
        }
      } catch (error) {
        onFinished();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      controller.abort();
      try {
        await reader.cancel(reason);
      } finally {
        onFinished();
      }
    },
  });
}

export function createAgentGateway(options: AgentGatewayOptions): AgentGateway {
  let state: AgentGatewayStatus = "stopped";
  let current: RuntimeInstance | null = null;
  let starting: Promise<RuntimeInstance> | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const backoffMinMs = options.backoffMinMs ?? BACKOFF_MIN_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  let restartDelayMs = backoffMinMs;
  let retryAfter = 0;
  /** Set while the last launch found no runtime to start: that is not a crash, so it is answered as what it is. */
  let notInstalled = false;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelBackoff: (() => void) | null = null;

  const recordFailure = (instance?: RuntimeInstance): void => {
    if (instance) {
      if (instance.failureRecorded) return;
      instance.failureRecorded = true;
    }
    retryAfter = Date.now() + restartDelayMs;
    restartDelayMs = Math.min(restartDelayMs * 2, BACKOFF_MAX_MS);
  };

  const signalChild = (instance: RuntimeInstance, signal: NodeJS.Signals): void => {
    const pid = instance.child.pid;
    if (pid === undefined) return;
    // A signal only reaches the direct child on Windows, so escalate to
    // `taskkill /T` and reap the runtime's descendants too.
    if (process.platform === "win32") {
      try {
        const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 10_000,
        });
        if (result.status === 0) return;
      } catch {
        // Fall through to the direct kill below.
      }
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-pid, signal);
      } else {
        instance.child.kill(signal);
      }
    } catch {
      // The child can exit between the state check and the signal.
    }
  };

  const onChildExit = (instance: RuntimeInstance, error?: Error): void => {
    if (instance.exited) return;
    instance.exited = true;
    instance.startupAbort.abort();
    instance.rejectLifecycle(
      error ?? new Error("The local agent runtime exited before becoming ready."),
    );
    for (const requestController of instance.requests) requestController.abort();
    if (instance.healthyTimer !== null) clearTimeout(instance.healthyTimer);
    instance.healthyTimer = null;
    if (current === instance) current = null;
    if (disposed) {
      state = "stopped";
      return;
    }
    state = "failed";
    recordFailure(instance);
  };

  const stopChild = async (instance: RuntimeInstance): Promise<void> => {
    for (const requestController of instance.requests) requestController.abort();
    instance.startupAbort.abort();
    signalChild(instance, "SIGTERM");
    if (instance.exited) return;

    const { promise: exited, resolve: finishExit } = createDeferred<void>();
    instance.child.once("exit", () => finishExit());
    const { promise: shutdownTimeout, resolve: finishShutdownTimeout } = createDeferred<void>();
    const shutdownTimer = setTimeout(() => finishShutdownTimeout(), SHUTDOWN_TIMEOUT_MS);
    shutdownTimer.unref?.();
    await Promise.race([exited, shutdownTimeout]);
    clearTimeout(shutdownTimer);
    instance.child.removeListener("exit", finishExit);
    if (!instance.exited) signalChild(instance, "SIGKILL");
  };

  const launchRuntime = async (): Promise<RuntimeInstance> => {
    if (disposed) throw new RuntimeUnavailableError("The agent gateway is shutting down.");
    const remainingBackoff = retryAfter - Date.now();
    if (remainingBackoff > 0) {
      const { promise: backoff, resolve: finishBackoff } = createDeferred<void>();
      const timer = setTimeout(() => {
        backoffTimer = null;
        cancelBackoff = null;
        finishBackoff();
      }, remainingBackoff);
      backoffTimer = timer;
      cancelBackoff = () => {
        clearTimeout(timer);
        backoffTimer = null;
        cancelBackoff = null;
        finishBackoff();
      };
      timer.unref?.();
      await backoff;
    }
    if (disposed) throw new RuntimeUnavailableError("The agent gateway is shutting down.");

    let launch: AgentRuntimeLaunch | null;
    try {
      launch = options.launch();
    } catch (error) {
      notInstalled = false;
      recordFailure();
      state = disposed ? "stopped" : "failed";
      throw error;
    }
    notInstalled = launch === null;
    if (!launch) {
      recordFailure();
      state = "failed";
      throw new RuntimeUnavailableError(NOT_INSTALLED_MESSAGE);
    }

    const token = randomBytes(32).toString("hex");
    // The link to the desktop's home server (every project's folder) is for this server only, never the agents'.
    const {
      OPENVIDS_HOME_URL: _homeUrl,
      OPENVIDS_HOME_SECRET: _homeSecret,
      OPENVIDS_HOME_FILE: _homeFile,
      ...inheritedEnv
    } = process.env;
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: {
          ...inheritedEnv,
          ...launch.env,
          OPENVIDS_AGENT_TOKEN: token,
          OPENVIDS_AGENT_PORT: "0",
          OPENVIDS_AGENT_PARENT_PID: String(process.pid),
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        // A GUI-launched server has no console; without this the runtime
        // child flashes one on Windows. No-op on POSIX.
        windowsHide: true,
      });
    } catch (error) {
      recordFailure();
      state = "failed";
      throw error;
    }

    const instance: RuntimeInstance = {
      child,
      token,
      port: null,
      ready: false,
      exited: false,
      failureRecorded: false,
      lifecycleSettled: false,
      startupAbort: new AbortController(),
      rejectLifecycle: () => {},
      requests: new Set(),
      healthyTimer: null,
    };
    current = instance;

    if (!child.stdout || !child.stderr) {
      onChildExit(instance, new Error("The agent runtime did not provide output streams."));
      throw new RuntimeUnavailableError("The local agent runtime failed during startup.");
    }

    const {
      promise: lifecycle,
      resolve: resolveLifecycle,
      reject: rejectLifecycle,
    } = createDeferred<number>();
    instance.rejectLifecycle = (error) => {
      if (instance.lifecycleSettled) return;
      instance.lifecycleSettled = true;
      rejectLifecycle(error);
    };

    const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stdoutLines.on("line", (line) => {
      const port = lifecyclePort(line);
      if (port !== null && !instance.lifecycleSettled) {
        instance.port = port;
        instance.lifecycleSettled = true;
        resolveLifecycle(port);
      } else {
        console.log(`[agent-runtime] ${line}`);
      }
    });
    stderrLines.on("line", (line) => console.error(`[agent-runtime] ${line}`));
    child.on("error", (error) => onChildExit(instance, error));
    child.on("exit", () => onChildExit(instance));

    const { promise: timeout, reject: rejectStartupTimeout } = createDeferred<never>();
    const startupTimer = setTimeout(() => {
      instance.startupAbort.abort();
      rejectStartupTimeout(
        new RuntimeUnavailableError(
          "The local agent runtime did not become ready within 20 seconds.",
        ),
      );
    }, STARTUP_TIMEOUT_MS);
    startupTimer.unref?.();

    try {
      const port = await Promise.race([lifecycle, timeout]);
      instance.port = port;
      await Promise.race([waitForHealthy(instance), timeout]);
      if (disposed || instance.exited) {
        throw new RuntimeUnavailableError("The local agent runtime exited during startup.");
      }
      instance.ready = true;
      state = "running";
      retryAfter = 0;
      instance.healthyTimer = setTimeout(() => {
        restartDelayMs = backoffMinMs;
        retryAfter = 0;
      }, HEALTHY_RESET_MS);
      instance.healthyTimer.unref?.();
      return instance;
    } catch (error) {
      if (!instance.exited) await stopChild(instance);
      if (!disposed) {
        recordFailure(instance);
        state = "failed";
      }
      throw error instanceof RuntimeUnavailableError
        ? error
        : new RuntimeUnavailableError("The local agent runtime failed during startup.");
    } finally {
      clearTimeout(startupTimer);
    }
  };

  async function waitForHealthy(instance: RuntimeInstance): Promise<void> {
    if (instance.port === null)
      throw new RuntimeUnavailableError("The runtime did not report a port.");
    const healthUrl = `http://127.0.0.1:${instance.port}${AGENT_RUNTIME_PREFIX}/health`;
    while (!instance.startupAbort.signal.aborted) {
      try {
        const response = await fetch(healthUrl, {
          headers: { [AGENT_HEADERS.token]: `Bearer ${instance.token}` },
          signal: instance.startupAbort.signal,
        });
        if (response.ok) {
          const health: unknown = await response.json();
          if (
            typeof health === "object" &&
            health !== null &&
            "ok" in health &&
            health.ok === true
          ) {
            return;
          }
        } else {
          await response.body?.cancel();
        }
      } catch (error) {
        if (instance.startupAbort.signal.aborted) throw error;
      }
      await delay(100);
    }
    throw new RuntimeUnavailableError("The local agent runtime failed its health check.");
  }

  const getRuntime = (): Promise<RuntimeInstance> => {
    if (disposed)
      return Promise.reject(new RuntimeUnavailableError("The agent gateway is shutting down."));
    if (current?.ready && !current.exited) return Promise.resolve(current);
    if (starting) return starting;
    state = "starting";
    const attempt = launchRuntime();
    starting = attempt;
    void attempt
      .finally(() => {
        if (starting === attempt) starting = null;
      })
      .catch(() => {});
    return attempt;
  };

  const handle = async (
    request: Request,
    ctx: { project: ResolvedProject; subPath: string; origin: string },
  ): Promise<Response> => {
    if (!originMatchesHost(request)) {
      return jsonError(403, "invalid_request", "The request Origin does not match its Host.");
    }
    if (hasJsonBody(request) && !hasJsonContentType(request)) {
      return jsonError(
        415,
        "invalid_request",
        "POST and PATCH request bodies must use application/json.",
      );
    }

    // A runtime that just failed is replaced after a back-off; the request is answered now instead of waiting for it.
    const backoffLeft = retryAfter - Date.now();
    if (!disposed && backoffLeft > 0 && !(current?.ready && !current.exited)) {
      // A runtime that is not installed is not restarting: say so, and do not launch what cannot start.
      if (notInstalled) return jsonError(503, "runtime_unavailable", NOT_INSTALLED_MESSAGE);
      void getRuntime().catch(() => undefined);
      return restartingResponse(backoffLeft);
    }

    let instance: RuntimeInstance;
    try {
      instance = await getRuntime();
    } catch (error) {
      return jsonError(503, "runtime_unavailable", formatStartError(error));
    }
    if (instance.exited || !instance.ready || instance.port === null) {
      return jsonError(
        502,
        "runtime_unavailable",
        "The local agent runtime exited while handling the request.",
      );
    }

    const upstreamController = new AbortController();
    const cancelForClient = (): void => upstreamController.abort();
    request.signal.addEventListener("abort", cancelForClient, { once: true });
    if (request.signal.aborted) upstreamController.abort();
    instance.requests.add(upstreamController);
    const releaseRequest = (): void => {
      request.signal.removeEventListener("abort", cancelForClient);
      instance.requests.delete(upstreamController);
    };

    // The runtime must start answering (response headers) in time; a long call still answers its headers at once.
    let timedOut = false;
    const answerTimer = setTimeout(() => {
      timedOut = true;
      upstreamController.abort();
    }, requestTimeoutMs);
    try {
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      headers.set(AGENT_HEADERS.token, `Bearer ${instance.token}`);
      headers.set(AGENT_HEADERS.projectId, encodeScopeHeader(ctx.project.id));
      headers.set(AGENT_HEADERS.projectDir, encodeScopeHeader(ctx.project.dir));
      headers.set(AGENT_HEADERS.studioOrigin, ctx.origin);

      const init: RequestInit = {
        method: request.method,
        headers,
        signal: upstreamController.signal,
        redirect: "manual",
      };
      if (request.body !== null && request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
        Object.assign(init, { duplex: "half" });
      }

      const upstream = await fetch(makeRuntimeUrl(instance.port, ctx.subPath, request.url), init);
      clearTimeout(answerTimer);
      if (instance.exited || upstreamController.signal.aborted) {
        await upstream.body?.cancel();
        releaseRequest();
        return jsonError(
          502,
          "runtime_unavailable",
          "The local agent runtime exited while handling the request.",
        );
      }
      const responseHeaders = new Headers(upstream.headers);
      if (responseHeaders.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        responseHeaders.set("cache-control", "no-store");
        responseHeaders.set("x-accel-buffering", "no");
      }
      const responseBody = copyResponseBody(upstream, upstreamController, releaseRequest);
      return new Response(responseBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch {
      clearTimeout(answerTimer);
      releaseRequest();
      if (timedOut && !disposed) return answerTimedOut(instance);
      return jsonError(
        502,
        "runtime_unavailable",
        "The local agent runtime could not complete the request.",
      );
    }
  };

  /**
   * A request got no answer in time. The runtime may only be busy with a long call (it still answers its health
   * check), or its event loop may be wedged, in which case every later request would wait the same way. The request is
   * not repeated either way; a runtime that fails a short health probe is stopped, and the next request starts a fresh one.
   */
  const answerTimedOut = async (instance: RuntimeInstance): Promise<Response> => {
    if (await answersHealthCheck(instance)) {
      return jsonError(
        504,
        "runtime_unavailable",
        `The local agent runtime did not answer within ${Math.round(requestTimeoutMs / 1000)} seconds.`,
      );
    }
    console.error("[agent-runtime] the runtime stopped answering; restarting it");
    await stopChild(instance);
    return restartingResponse(Math.max(retryAfter - Date.now(), 1_000));
  };

  async function answersHealthCheck(instance: RuntimeInstance): Promise<boolean> {
    if (instance.exited || instance.port === null) return false;
    try {
      const response = await fetch(
        `http://127.0.0.1:${instance.port}${AGENT_RUNTIME_PREFIX}/health`,
        {
          headers: { [AGENT_HEADERS.token]: `Bearer ${instance.token}` },
          signal: AbortSignal.timeout(healthProbeTimeoutMs),
        },
      );
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    state = "stopped";
    if (backoffTimer !== null) clearTimeout(backoffTimer);
    backoffTimer = null;
    cancelBackoff?.();
    const instance = current;
    current = null;
    if (instance?.healthyTimer !== null && instance?.healthyTimer !== undefined) {
      clearTimeout(instance.healthyTimer);
    }
    if (!instance) {
      disposePromise = Promise.resolve();
      return disposePromise;
    }
    disposePromise = stopChild(instance).finally(() => {
      state = "stopped";
    });
    return disposePromise;
  };

  return {
    handle,
    status: () => state,
    dispose,
  };
}
