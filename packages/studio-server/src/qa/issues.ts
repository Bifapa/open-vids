import {
  QA_LIMITS,
  parseQaIssueDraft,
  sameQaIssue,
  type QaIssueDraft,
  type QaSeverity,
} from "@hyperframes/agent-protocol";

const SEVERITY_RANK: Record<QaSeverity, number> = { error: 0, warning: 1, info: 2 };

function mergeCluster(group: readonly QaIssueDraft[]): QaIssueDraft | null {
  const ranked = [...group].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.start - b.start,
  );
  const base = ranked[0];
  if (!base) return null;
  return {
    ...base,
    start: Math.min(...group.map((entry) => entry.start)),
    end: Math.max(...group.map((entry) => entry.end)),
    clipIds: [...new Set(group.flatMap((entry) => entry.clipIds))].slice(0, QA_LIMITS.clipIds),
    fixable: group.some((entry) => entry.fixable),
    owner: base.owner ?? group.find((entry) => entry.owner !== null)?.owner ?? null,
    message:
      group.length > 1 ? `${base.message} (and ${group.length - 1} more like it)` : base.message,
  };
}

/**
 * One issue per (kind, subject, stretch of time): the same thing found by several checks, or in neighbouring
 * moments, is reported once. The same kind on the same subject at moments that do not touch (frozen at 2–5 s and
 * again at 40–45 s) stays two issues, so each can be fixed and checked on its own.
 */
export function mergeSameSubject(drafts: readonly QaIssueDraft[]): QaIssueDraft[] {
  const merged: QaIssueDraft[] = [];
  const bySubject = new Map<string, QaIssueDraft[]>();
  for (const draft of drafts) {
    if (draft.subject === null) {
      merged.push(draft);
      continue;
    }
    const key = `${draft.kind}\0${draft.subject}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), draft]);
  }
  for (const group of bySubject.values()) {
    const sorted = [...group].sort((a, b) => a.start - b.start || a.end - b.end);
    const clusters: Array<{ start: number; end: number; drafts: QaIssueDraft[] }> = [];
    for (const draft of sorted) {
      const last = clusters[clusters.length - 1];
      // Sorted by start, so only the cluster in progress can still touch this draft.
      if (last && sameQaIssue({ kind: draft.kind, subject: draft.subject, ...last }, draft)) {
        last.drafts.push(draft);
        last.end = Math.max(last.end, draft.end);
      } else {
        clusters.push({ start: draft.start, end: draft.end, drafts: [draft] });
      }
    }
    for (const cluster of clusters) {
      const one = mergeCluster(cluster.drafts);
      if (one) merged.push(one);
    }
  }
  return merged;
}

/** A timeline hole the render's own black-frame detection found too is one issue, reported with the render's numbers. */
function withoutConfirmedGaps(drafts: readonly QaIssueDraft[]): QaIssueDraft[] {
  const black = drafts.filter((draft) => draft.check === "blackdetect");
  return drafts.filter((draft) => {
    if (draft.check !== "timeline.gap") return true;
    const length = draft.end - draft.start;
    return !black.some(
      (found) => Math.min(found.end, draft.end) - Math.max(found.start, draft.start) >= length / 2,
    );
  });
}

/** Merges, validates and bounds the findings of one pass; the result is ordered by time. */
export function finalizeIssues(drafts: readonly QaIssueDraft[]): QaIssueDraft[] {
  const checked: QaIssueDraft[] = [];
  for (const draft of mergeSameSubject(withoutConfirmedGaps(drafts))) {
    const parsed = parseQaIssueDraft(draft);
    if (parsed.ok) checked.push(parsed.value);
  }
  const kept = checked
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.start - b.start)
    .slice(0, QA_LIMITS.issues);
  return kept.sort(
    (a, b) => a.start - b.start || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}
