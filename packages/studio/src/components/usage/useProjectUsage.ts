import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UsageReport } from "@hyperframes/agent-protocol";
import { createAgentClient } from "../../agent/agentClient";
import { useAgentTurnRunning } from "../../agent/agentTurnLock";
import { usagePeriodQuery, type UsagePeriod } from "./usagePeriod";

/** How often the figures are re-read while a turn runs and the popover is open. */
export const USAGE_LIVE_REFRESH_MS = 2_000;

export interface ProjectUsage {
  /** The last report that arrived (kept while the next one loads or fails). */
  report: UsageReport | null;
  status: "loading" | "ready" | "error";
  reload: () => void;
}

/**
 * The project's agent usage for a period, read from the runtime while `active` (the popover is open). A running turn
 * makes it re-read every {@link USAGE_LIVE_REFRESH_MS}, and once more when the turn ends, so the journal's final lines
 * replace the live figures.
 */
export function useProjectUsage(
  projectId: string,
  period: UsagePeriod,
  active: boolean,
): ProjectUsage {
  const client = useMemo(() => createAgentClient(projectId), [projectId]);
  const turnRunning = useAgentTurnRunning(projectId);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [status, setStatus] = useState<ProjectUsage["status"]>("loading");
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = (latest.current += 1);
    client
      .getUsage(usagePeriodQuery(period, Date.now()))
      .then((next) => {
        if (request !== latest.current) return;
        setReport(next);
        setStatus("ready");
      })
      .catch(() => {
        if (request === latest.current) setStatus("error");
      });
  }, [client, period]);

  useEffect(() => {
    if (!active) return;
    setStatus("loading");
    load();
    if (!turnRunning) return;
    const timer = window.setInterval(load, USAGE_LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load, turnRunning]);

  useEffect(() => {
    setReport(null);
  }, [projectId]);

  return { report, status, reload: load };
}
