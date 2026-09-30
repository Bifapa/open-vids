import {
  isChapter,
  type StoryGraph,
  type StoryNodeFacts,
  type TimelineClip,
  type TimelineSnapshot,
} from "@hyperframes/agent-protocol";

type OnTimeline = NonNullable<StoryNodeFacts["timeline"]>;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function spanOf(clips: readonly TimelineClip[]): OnTimeline | null {
  if (clips.length === 0) return null;
  return {
    clips: clips.length,
    start: round3(Math.min(...clips.map((clip) => clip.start))),
    end: round3(Math.max(...clips.map((clip) => clip.end))),
  };
}

/**
 * Where each node is on the timeline right now, from the clips that carry its id (`data-ov-story-node`). Derived on
 * every read, so after a revert or a manual delete nothing is reported as built, whatever the stored build record says.
 * A chapter without A-roll of its own (its length was filled by material) is reported from the build record's span,
 * as long as clips of its attached material are still there.
 */
export function timelineFacts(
  graph: StoryGraph,
  timeline: TimelineSnapshot | null,
): Map<string, OnTimeline | null> {
  const facts = new Map<string, OnTimeline | null>();
  const clips = timeline?.clips ?? [];
  const byNode = new Map<string, TimelineClip[]>();
  for (const clip of clips) {
    const node = clip.provenance?.storyNode;
    if (!node) continue;
    const list = byNode.get(node) ?? [];
    list.push(clip);
    byNode.set(node, list);
  }
  for (const node of graph.nodes) {
    let span = spanOf(byNode.get(node.id) ?? []);
    if (
      !span &&
      isChapter(node) &&
      timeline &&
      graph.build?.composition === timeline.composition.path
    ) {
      const record = graph.build.chapters.find((entry) => entry.node === node.id);
      if (record) {
        const attached = new Set(
          graph.attachments.filter((item) => item.chapter === node.id).map((item) => item.node),
        );
        const inside = clips.filter(
          (clip) =>
            clip.provenance?.storyNode != null &&
            attached.has(clip.provenance.storyNode) &&
            clip.start < record.end &&
            clip.end > record.start,
        );
        span = spanOf(inside);
      }
    }
    facts.set(node.id, span);
  }
  return facts;
}
