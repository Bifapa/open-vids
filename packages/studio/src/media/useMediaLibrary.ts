import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type {
  AnalysisJob,
  ProjectAsset,
  SourceAnalysisStatus,
  StoryGraph,
} from "@hyperframes/agent-protocol";
import { usePlayerStore } from "../player/store/playerStore";
import { deriveUsedPaths } from "../components/sidebar/AssetsTab";
import { studioStoryStore } from "../story/storyContext";
import { t } from "../i18n";
import { useSourcesStore } from "../research/researchContext";
import { mediaClient } from "./mediaClient";
import {
  analysisRunning,
  buildMediaItems,
  stageOf,
  type MediaItem,
  type SearchableAnalysis,
} from "./mediaLibrary";

const RUNNING_POLL_MS = 4000;
const JOB_POLL_MS = 1000;

/** Asset paths the Story Graph's material nodes stand for. */
function storyAssetPaths(graph: StoryGraph | null): Set<string> {
  const paths = new Set<string>();
  for (const node of graph?.nodes ?? []) {
    if ("asset" in node && typeof node.asset === "string") paths.add(node.asset);
  }
  return paths;
}

export interface AnalysisQueueState {
  /** Sources queued by "Analyze", oldest first, not yet started. */
  waiting: string[];
  /** The source whose job is being started. */
  starting: string | null;
  /** The job the workspace started and follows, if one runs. */
  job: AnalysisJob | null;
  error: string | null;
}

export interface MediaLibrary {
  items: MediaItem[];
  loading: boolean;
  queue: AnalysisQueueState;
  analyze(paths: readonly string[]): void;
  refresh(): void;
  /** Transcript sentences and vision notes by source, loaded on the first search. */
  searchIndex: ReadonlyMap<string, SearchableAnalysis>;
  loadSearchIndex(): void;
}

export function useMediaLibrary(projectId: string, assets: readonly string[]): MediaLibrary {
  const [inventory, setInventory] = useState<ReadonlyMap<string, ProjectAsset>>(new Map());
  const [analysis, setAnalysis] = useState<ReadonlyMap<string, SourceAnalysisStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState<AnalysisQueueState>({
    waiting: [],
    starting: null,
    job: null,
    error: null,
  });
  const [searchIndex, setSearchIndex] = useState<ReadonlyMap<string, SearchableAnalysis>>(
    new Map(),
  );
  const generation = useRef(0);

  const records = useSourcesStore((state) => state.view?.records);
  const elements = usePlayerStore((state) => state.elements);
  const graph = useStore(studioStoryStore, (state) => state.graph);
  const usedPaths = useMemo(() => {
    const used = deriveUsedPaths(elements);
    for (const path of storyAssetPaths(graph)) used.add(path);
    return used;
  }, [elements, graph]);

  const refreshAnalysis = useCallback(async () => {
    const sources = await mediaClient.analysisSources(projectId).catch(() => null);
    if (sources) setAnalysis(new Map(sources.map((source) => [source.source, source])));
  }, [projectId]);

  const assetsKey = assets.join("|");
  const refresh = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    void Promise.allSettled([
      mediaClient.inventory(projectId),
      mediaClient.analysisSources(projectId),
    ]).then(([inv, sources]) => {
      if (mine !== generation.current) return;
      if (inv.status === "fulfilled") {
        setInventory(new Map(inv.value.assets.map((asset) => [asset.path, asset])));
      }
      if (sources.status === "fulfilled") {
        setAnalysis(new Map(sources.value.map((source) => [source.source, source])));
      }
      setLoading(false);
    });
  }, [projectId]);

  // The file list is the trigger: an import, rename or delete changes what there is to probe.
  useEffect(() => {
    refresh();
  }, [refresh, assetsKey]);

  const items = useMemo(
    () =>
      buildMediaItems({
        assets,
        inventory,
        analysis,
        provenance: records ?? [],
        usedPaths,
      }),
    [assets, inventory, analysis, records, usedPaths],
  );

  // An agent (or another window) may be analysing: follow it until nothing runs.
  const anyRunning = items.some(analysisRunning);
  useEffect(() => {
    if (!anyRunning || queue.job) return;
    const timer = window.setInterval(() => void refreshAnalysis(), RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyRunning, queue.job, refreshAnalysis]);

  const analyze = useCallback((paths: readonly string[]) => {
    setQueue((state) => {
      const busy = new Set([...state.waiting, state.starting, state.job?.source]);
      const added = paths.filter((path) => !busy.has(path));
      return added.length
        ? { ...state, waiting: [...state.waiting, ...added], error: null }
        : state;
    });
  }, []);

  // One job at a time: the service runs whisper and ffmpeg, which a whole library at once would swamp.
  useEffect(() => {
    if (queue.job || queue.starting || queue.waiting.length === 0) return;
    const source = queue.waiting[0];
    if (!source) return;
    setQueue((state) => ({ ...state, waiting: state.waiting.slice(1), starting: source }));
    mediaClient.startAnalysis(projectId, source).then(
      (job) => setQueue((state) => ({ ...state, starting: null, job })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : t("media.analysis.startFailed");
        setQueue((state) => ({ ...state, starting: null, error: message }));
      },
    );
  }, [projectId, queue.job, queue.starting, queue.waiting]);

  const jobId = queue.job?.id;
  useEffect(() => {
    if (!jobId) return;
    const timer = window.setInterval(() => {
      void mediaClient.job(projectId, jobId).then(
        (job) => {
          if (job.status === "running") {
            setQueue((state) => (state.job?.id === job.id ? { ...state, job } : state));
            return;
          }
          void refreshAnalysis();
          const error =
            job.status === "failed" ? (job.error?.message ?? t("media.analysis.failed")) : null;
          setQueue((state) => (state.job?.id === job.id ? { ...state, job: null, error } : state));
        },
        () => setQueue((state) => (state.job?.id === jobId ? { ...state, job: null } : state)),
      );
    }, JOB_POLL_MS);
    return () => window.clearInterval(timer);
  }, [projectId, jobId, refreshAnalysis]);

  // Transcripts and vision notes feed the search; each is fetched once per version.
  const indexed = useRef(new Map<string, string>());
  const loadSearchIndex = useCallback(() => {
    for (const item of items) {
      const transcript = stageOf(item, "transcript");
      const vision = stageOf(item, "vision");
      const key = `${transcript?.version ?? ""}|${vision?.version ?? ""}`;
      const hasAny = transcript?.status === "fresh" || vision?.status === "fresh";
      if (!hasAny || indexed.current.get(item.path) === key) continue;
      indexed.current.set(item.path, key);
      void Promise.allSettled([
        transcript?.status === "fresh"
          ? mediaClient.transcript(projectId, item.path)
          : Promise.resolve(null),
        vision?.status === "fresh"
          ? mediaClient.overview(projectId, item.path)
          : Promise.resolve(null),
      ]).then(([view, overview]) => {
        const sentences = view.status === "fulfilled" ? (view.value?.sentences ?? []) : [];
        const notes = overview.status === "fulfilled" ? (overview.value?.vision?.notes ?? []) : [];
        setSearchIndex((previous) =>
          new Map(previous).set(item.path, { sentences, vision: notes }),
        );
      });
    }
  }, [items, projectId]);

  return { items, loading, queue, analyze, refresh, searchIndex, loadSearchIndex };
}
