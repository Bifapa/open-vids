import { t } from "../i18n";

const STUDIO_SAVE_ATTEMPT_PROPERTY = "__studioSaveAttempt";

export class StudioSaveHttpError extends Error {
  readonly statusCode: number;
  readonly alreadyToasted: boolean;

  constructor(message: string, statusCode: number, options: { alreadyToasted?: boolean } = {}) {
    super(message);
    this.name = "StudioSaveHttpError";
    this.statusCode = statusCode;
    this.alreadyToasted = options.alreadyToasted ?? false;
  }
}

export class StudioSaveNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StudioSaveNetworkError";
  }
}

export class StudioFileConflictError extends StudioSaveHttpError {
  readonly filePath: string;
  readonly currentVersion: string | null;
  readonly currentContent: string | null;
  readonly attemptedContent: string;

  constructor(input: {
    filePath: string;
    currentVersion: string | null;
    currentContent: string | null;
    attemptedContent: string;
  }) {
    super(`Save conflict: ${input.filePath} changed outside this Studio session`, 409);
    this.name = "StudioFileConflictError";
    this.filePath = input.filePath;
    this.currentVersion = input.currentVersion;
    this.currentContent = input.currentContent;
    this.attemptedContent = input.attemptedContent;
  }
}

export type StudioSaveDrainResult<Failure = unknown> =
  | { status: "clean" }
  | { status: "conflict"; error: StudioFileConflictError }
  | { status: "failed"; error: Failure };

function readNumericProperty(value: object, key: string): number | undefined {
  const record = value as Record<string, unknown>;
  const property = record[key];
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function createStudioSaveAbortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("Save aborted", "AbortError");
  const error = new Error("Save aborted");
  error.name = "AbortError";
  return error;
}

function throwIfStudioSaveAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createStudioSaveAbortError();
}

function attachStudioSaveAttempt(error: unknown, attempt: number): unknown {
  if (!error || typeof error !== "object") return error;
  try {
    Object.defineProperty(error, STUDIO_SAVE_ATTEMPT_PROPERTY, {
      value: attempt,
      configurable: true,
    });
  } catch {
    // Best-effort diagnostic only.
  }
  return error;
}

export function getStudioSaveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return t("app.save.unknown");
}

export function markStudioSaveErrorAlreadyToasted<T>(error: T): T {
  if (!error || typeof error !== "object") return error;
  try {
    Object.defineProperty(error, "alreadyToasted", { value: true, configurable: true });
  } catch {
    // Best effort: failure reporting must not replace the original save error.
  }
  return error;
}

export function isStudioSaveErrorAlreadyToasted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { alreadyToasted?: unknown }).alreadyToasted === true) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== error && isStudioSaveErrorAlreadyToasted(cause);
}

export function getStudioSaveStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct =
    readNumericProperty(error, "statusCode") ??
    readNumericProperty(error, "status") ??
    readNumericProperty(error, "status_code");
  if (direct != null) return direct;

  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return getStudioSaveStatusCode(cause);
  return undefined;
}

function isStudioSaveAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRetryableStudioSaveError(error: unknown): boolean {
  if (isStudioSaveAbortError(error)) return false;
  if (error instanceof StudioSaveNetworkError) return true;
  const statusCode = getStudioSaveStatusCode(error);
  if (statusCode == null) return false;
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

export async function createStudioSaveHttpError(
  response: Response,
  fallbackMessage: string,
  options: { alreadyToasted?: boolean } = {},
): Promise<StudioSaveHttpError> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const detail = body.trim().slice(0, 300);
  const message = detail
    ? t("app.save.httpError", { message: fallbackMessage, status: response.status, detail })
    : t("app.save.httpErrorNoDetail", { message: fallbackMessage, status: response.status });
  return new StudioSaveHttpError(message, response.status, options);
}

export async function retryStudioSave<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    random?: () => number;
    signal?: AbortSignal;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? isRetryableStudioSaveError;
  const sleep =
    options.sleep ??
    ((delayMs: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        throwIfStudioSaveAborted(signal);
        const onAbort = () => {
          globalThis.clearTimeout(timeout);
          reject(createStudioSaveAbortError());
        };
        const timeout = globalThis.setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delayMs);
        signal?.addEventListener("abort", onAbort, { once: true });
      }));
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      throwIfStudioSaveAborted(options.signal);
      return await operation(attempt);
    } catch (error) {
      const failure = attachStudioSaveAttempt(error, attempt);
      if (attempt >= maxAttempts || !shouldRetry(failure, attempt)) throw failure;
      const retryIndex = attempt - 1;
      const exponentialDelay = Math.min(baseDelayMs * 2 ** retryIndex, maxDelayMs);
      const jitterSpan = exponentialDelay * jitterRatio;
      const jitteredDelay = Math.round(exponentialDelay + (random() * 2 - 1) * jitterSpan);
      const delayMs = Math.max(0, Math.min(maxDelayMs, jitteredDelay));
      await sleep(delayMs, options.signal);
    }
  }

  throw new Error("Save retry loop exited unexpectedly");
}
