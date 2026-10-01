import { buildProjectApiPath } from "../../utils/projectRouting";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { CanvasResolution } from "@hyperframes/parsers";
import { generateId } from "../../utils/generateId";
import { confirmExportLicenses } from "../../research/exportLicenseGate";
import { studioResearchClient } from "../../research/researchContext";
import { readServerError } from "./serverError";
import { ffmpegInstallMessage, useFfmpegStatus } from "./useFfmpegStatus";
import { t } from "../../i18n";

export interface RenderJob {
  id: string;
  status: "rendering" | "complete" | "failed" | "cancelled";
  progress: number;
  stage?: string;
  error?: string;
  filename: string;
  createdAt: number;
  durationMs?: number;
}

// The CLI consumes this same source through @hyperframes/core's re-export.
// Importing from the browser-safe parsers package avoids the core barrel's
// Node-only transitive modules without duplicating the preset union in Studio.
export type ResolutionPreset = CanvasResolution;

export interface StartRenderOptions {
  fps?: number;
  quality?: "draft" | "standard" | "high";
  format?: "mp4" | "webm" | "mov";
  /** `"auto"` (default) renders at the composition's authored dimensions. */
  resolution?: ResolutionPreset | "auto";
  /**
   * Render a specific composition file. Omit it to render the composition the
   * user currently has open — only the sidebar's per-composition Render button
   * names one, because it renders a card the user is not looking at.
   */
  composition?: string;
  /**
   * Composition-variable overrides ({variableId: value}), forwarded to the
   * render route and injected as window.__hfVariables — the same channel
   * `hyperframes render --variables` uses.
   */
  variables?: Record<string, unknown>;
}

// "Hide" (formerly "Clear") is a view operation, not a delete: hidden ids are
// remembered here so hidden renders don't resurrect from the on-disk history
// on the next load. Per-project key so projects don't hide each other's rows.
function hiddenIdsKey(projectId: string): string {
  return `hf-studio-hidden-renders:${projectId}`;
}

function readHiddenIds(projectId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(hiddenIdsKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeHiddenIds(projectId: string, ids: Set<string>): void {
  try {
    // Cap the list so it doesn't grow unbounded across months of renders.
    window.localStorage.setItem(hiddenIdsKey(projectId), JSON.stringify([...ids].slice(-200)));
  } catch {
    /* localStorage may be unavailable or full */
  }
}

export function useRenderQueue(
  projectId: string | null,
  // A ref, not the value: the render target has to be read at click time, and
  // threading the value through would rebuild every callback below on each
  // composition switch.
  activeCompPathRef: { current: string | null },
) {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  // History fetch failure — distinguished from "no renders yet" so the panel
  // never shows a false empty state.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Failure of a user action (delete/cancel), surfaced inline in the panel.
  const [actionError, setActionError] = useState<string | null>(null);
  // Owned here rather than in the panel: Studio renders from three places —
  // the panel's Export button, the header's, and each composition card in the
  // left sidebar — and a check living in one of them leaves the rest free to
  // start a render this machine cannot finish. Every caller routes through
  // `startRender`, so that is where the refusal belongs. Call sites still
  // read `ffmpegMissing` to put the prompt on screen, because a refusal the
  // user cannot see reads as a broken button.
  const { status: ffmpeg, checking: ffmpegChecking, recheck: recheckFfmpeg } = useFfmpegStatus();
  // A null status means the probe gave no answer (older server, failed
  // request), which is not evidence of a missing encoder. Unknown fails open.
  const ffmpegMissing = ffmpeg !== null && !ffmpeg.ok;
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const addSessionJob = useCallback((job: RenderJob) => {
    setJobs((prev) => [...prev, job]);
  }, []);

  const closeActiveEventSource = useCallback((jobId?: string) => {
    if (jobId && activeJobRef.current !== jobId) return;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    activeJobRef.current = null;
  }, []);

  // Load completed renders from the server
  const loadRenders = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(buildProjectApiPath(projectId, `/renders`));
      if (!res.ok) {
        setLoadError(t("renders.error.loadHistoryStatus", { status: res.status }));
        return;
      }
      const data = await res.json();
      setLoadError(null);
      if (Array.isArray(data.renders)) {
        const hidden = readHiddenIds(projectId);
        setJobs((prev) => {
          const existing = new Set(prev.map((j) => j.id));
          const fromServer: RenderJob[] = data.renders
            .filter((r: { id: string }) => !existing.has(r.id) && !hidden.has(r.id))
            .map(
              (r: {
                id: string;
                filename: string;
                createdAt: number;
                size: number;
                status?: string;
                durationMs?: number;
              }) => ({
                id: r.id,
                status: (r.status === "failed" ? "failed" : "complete") as "complete" | "failed",
                progress: 100,
                filename: r.filename,
                createdAt: r.createdAt,
                durationMs: r.durationMs,
              }),
            );
          return [...prev, ...fromServer];
        });
      }
    } catch {
      setLoadError(t("renders.error.loadHistory"));
    }
  }, [projectId]);

  useEffect(() => {
    loadRenders();
  }, [loadRenders]);

  // Start a render and track progress via SSE
  // Pre-existing branchy fetch/poll flow — the variables passthrough added one branch.
  const startRender = useCallback(
    async (opts: StartRenderOptions = {}) => {
      if (!projectId) return;
      // The server would answer this with a 503 anyway. Refusing here keeps
      // the reason and the fix in the message, and keeps a control that
      // forgot to disable itself from producing a mystery failure.
      if (ffmpegMissing) {
        addSessionJob({
          id: generateId(),
          status: "failed",
          progress: 0,
          error: ffmpegInstallMessage(ffmpeg),
          filename: t("renders.job.exportBlocked"),
          createdAt: Date.now(),
        });
        return;
      }

      const fps = opts.fps ?? 30;
      const quality = opts.quality ?? "standard";
      const format = opts.format ?? "mp4";
      const resolution = opts.resolution;
      // Which composition a render targets belongs here, with the same
      // argument the FFmpeg gate above makes: Studio starts renders from three
      // controls, and a default living in one of them leaves the others
      // exporting a file the user is not looking at. The header's Export
      // passed no options at all, so every render it started went to
      // index.html no matter which composition was selected (#3549).
      const composition = opts.composition ?? activeCompPathRef.current ?? undefined;
      // Researched assets with an unknown or restricted license are warned about here, for the same
      // every-caller reason; the user can always export anyway, and a failed check never blocks.
      if (!(await confirmExportLicenses(studioResearchClient, projectId, composition ?? null))) {
        return;
      }

      const startTime = Date.now();
      // "auto" / undefined means "render at the composition's authored size".
      // Omit the field entirely — sending "auto" would trip the route's
      // enum validation set.
      const body: {
        fps: number;
        quality: string;
        format: string;
        resolution?: string;
        composition?: string;
        variables?: Record<string, unknown>;
      } = {
        fps,
        quality,
        format,
      };
      if (resolution && resolution !== "auto") body.resolution = resolution;
      if (composition) body.composition = composition;
      if (opts.variables && Object.keys(opts.variables).length > 0) {
        body.variables = opts.variables;
      }
      let res: Response;
      try {
        res = await fetch(buildProjectApiPath(projectId, `/render`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // The cause used to be discarded. Every failure — a dead server, an
        // aborted request, a DNS error, a mid-render crash — surfaced as the
        // same sentence. Keep the CLI guidance, name the cause after it.
        const cause = err instanceof Error ? err.message : String(err);
        const failedJob: RenderJob = {
          id: generateId(),
          status: "failed",
          progress: 0,
          error: t("renders.error.unreachable", { cause }),
          filename: t("renders.job.exportFailed"),
          createdAt: startTime,
        };
        addSessionJob(failedJob);
        return;
      }
      if (!res.ok) {
        const failedJob: RenderJob = {
          id: generateId(),
          status: "failed",
          progress: 0,
          error: await readServerError(res),
          filename: t("renders.job.exportFailed"),
          createdAt: startTime,
        };
        addSessionJob(failedJob);
        return;
      }
      const { jobId } = await res.json();

      const FORMAT_EXT: Record<string, string> = { mp4: ".mp4", webm: ".webm", mov: ".mov" };
      const ext = FORMAT_EXT[format] ?? ".mp4";
      const job: RenderJob = {
        id: jobId,
        status: "rendering",
        progress: 0,
        filename: `${jobId}${ext}`,
        createdAt: startTime,
      };
      addSessionJob(job);
      activeJobRef.current = jobId;

      // Track progress via SSE
      const es = new EventSource(`/api/render/${jobId}/progress`);
      eventSourceRef.current = es;

      es.addEventListener("progress", (event) => {
        try {
          const data = JSON.parse(event.data);
          const terminal =
            data.status === "complete" || data.status === "failed" || data.status === "cancelled";
          setJobs((prev) =>
            prev.map((j) =>
              j.id === jobId
                ? {
                    ...j,
                    progress: data.progress ?? j.progress,
                    stage: data.stage ?? data.message ?? j.stage,
                    status: terminal ? (data.status as RenderJob["status"]) : j.status,
                    durationMs: data.status === "complete" ? Date.now() - startTime : undefined,
                    error: data.error ?? j.error,
                  }
                : j,
            ),
          );
          if (terminal) {
            closeActiveEventSource(jobId);
          }
        } catch {
          // ignore parse errors
        }
      });

      es.onerror = () => {
        es.close();
        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId && j.status === "rendering"
              ? {
                  ...j,
                  status: "failed" as const,
                  error: t("renders.error.connectionLost"),
                }
              : j,
          ),
        );
        activeJobRef.current = null;
      };

      return jobId;
    },
    [projectId, activeCompPathRef, closeActiveEventSource, addSessionJob, ffmpeg, ffmpegMissing],
  );

  // Cancel an in-flight render. The job row stays (as "cancelled") so the
  // user sees the outcome; the SSE stream is closed either way.
  const cancelRender = useCallback(
    async (jobId: string) => {
      setActionError(null);
      closeActiveEventSource(jobId);
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId && j.status === "rendering" ? { ...j, status: "cancelled" } : j,
        ),
      );
      try {
        const res = await fetch(`/api/render/${jobId}/cancel`, { method: "POST" });
        if (!res.ok && res.status !== 404) {
          setActionError(t("renders.error.cancelFailed"));
          return;
        }
        // Reconcile with the status the route reports: if the render actually
        // finished (or failed) before the cancel landed, don't leave the row
        // stuck on the optimistic "cancelled" — reload to pick up the real
        // outcome (and the finished file's metadata).
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { status?: string } | null;
          if (body?.status && body.status !== "cancelled") {
            void loadRenders();
          }
        }
      } catch {
        setActionError(t("renders.error.cancelUnreachable"));
      }
    },
    [closeActiveEventSource, loadRenders],
  );

  const deleteRender = useCallback(
    async (jobId: string) => {
      setActionError(null);
      closeActiveEventSource(jobId);
      try {
        const res = await fetch(`/api/render/${jobId}`, { method: "DELETE" });
        if (!res.ok) {
          setActionError(t("renders.error.deleteFailed"));
          return;
        }
      } catch {
        setActionError(t("renders.error.deleteUnreachable"));
        return;
      }
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
    },
    [closeActiveEventSource],
  );

  // Hide finished rows from the list (view-only — files stay on disk and can
  // be recovered from the renders/ directory). Remembered per project so the
  // rows don't resurrect from history on reload.
  const clearCompleted = useCallback(() => {
    setJobs((prev) => {
      const finished = prev.filter((j) => j.status !== "rendering");
      if (projectId && finished.length > 0) {
        const hidden = readHiddenIds(projectId);
        for (const j of finished) hidden.add(j.id);
        writeHiddenIds(projectId, hidden);
      }
      return prev.filter((j) => j.status === "rendering");
    });
  }, [projectId]);

  const dismissActionError = useCallback(() => setActionError(null), []);

  // Clean up EventSource on unmount or projectId change
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [projectId]);

  const isRendering = jobs.some((j) => j.status === "rendering");
  return useMemo(
    () => ({
      jobs,
      isRendering,
      loadError,
      actionError,
      dismissActionError,
      reloadRenders: loadRenders,
      deleteRender,
      cancelRender,
      clearCompleted,
      startRender: startRender as (options: unknown) => Promise<void>,
      // Every Export control reads these, so no caller has to decide for
      // itself whether this machine can encode.
      ffmpeg,
      ffmpegMissing,
      ffmpegChecking,
      recheckFfmpeg,
    }),
    [
      jobs,
      isRendering,
      loadError,
      actionError,
      dismissActionError,
      loadRenders,
      deleteRender,
      cancelRender,
      clearCompleted,
      startRender,
      ffmpeg,
      ffmpegMissing,
      ffmpegChecking,
      recheckFfmpeg,
    ],
  );
}
