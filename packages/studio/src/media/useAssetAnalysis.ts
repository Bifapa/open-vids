import { useEffect, useState } from "react";
import type { AnalysisOverview, Shot, TranscriptSentence } from "@hyperframes/agent-protocol";
import { mediaClient } from "./mediaClient";
import { stageReady, type MediaItem } from "./mediaLibrary";

export interface AssetAnalysis {
  overview: AnalysisOverview | null;
  sentences: TranscriptSentence[];
  shots: Shot[];
  loading: boolean;
}

const NONE: AssetAnalysis = { overview: null, sentences: [], shots: [], loading: false };

/** The selected source's overview, transcript and shots, refetched whenever a stage's stored version changes. */
export function useAssetAnalysis(projectId: string, item: MediaItem | null): AssetAnalysis {
  const [state, setState] = useState<AssetAnalysis>(NONE);
  const source = item?.analysis && !item.offline ? item.path : null;
  const transcriptReady = item ? stageReady(item, "transcript") : false;
  const shotsReady = item ? stageReady(item, "shots") : false;
  const versions = item?.analysis?.stages.map((stage) => stage.version ?? stage.status).join("|");

  useEffect(() => {
    if (!source) {
      setState(NONE);
      return;
    }
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true }));
    void Promise.allSettled([
      mediaClient.overview(projectId, source),
      transcriptReady ? mediaClient.transcript(projectId, source) : Promise.resolve(null),
      shotsReady ? mediaClient.shots(projectId, source) : Promise.resolve(null),
    ]).then(([overview, transcript, shots]) => {
      if (cancelled) return;
      setState({
        overview: overview.status === "fulfilled" ? overview.value : null,
        sentences: transcript.status === "fulfilled" ? (transcript.value?.sentences ?? []) : [],
        shots: shots.status === "fulfilled" ? (shots.value?.shots ?? []) : [],
        loading: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, source, transcriptReady, shotsReady, versions]);

  return state;
}
