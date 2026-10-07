import {
  STORY_CONTENT_FIELDS,
  type StoryAttachment,
  type StoryAuthor,
  type StoryEdge,
  type StoryGraph,
  type StoryNode,
  type StoryNodeKind,
  type StoryRemoval,
} from "@hyperframes/agent-protocol";
import { StoryFailure } from "./errors.js";
import { sameJson } from "./graphIo.js";

const USER: StoryAuthor = "user";

/** What an untouched new node holds per content field; a user-created node counts every other field as set by hand. */
export const DEFAULT_CONTENT: Record<StoryNodeKind, Record<string, unknown>> = {
  chapter: {
    purpose: "",
    description: "",
    narrativeRole: "main",
    estimatedDuration: 30,
    status: "proposed",
    sourceRanges: [],
    aRoll: "",
    bRoll: "",
    captions: false,
    graphics: "",
    audio: "",
    narration: "",
    previewFrame: null,
  },
  video: { sourceIn: 0, sourceOut: null, usageIntent: "", previewFrame: null },
  picture: { usageIntent: "" },
  music: { asset: null, bpm: null, volume: 1, usageIntent: "" },
  motion: { skill: null, inputs: {}, duration: null, usageIntent: "" },
  missing: { mediaKind: "video", need: "", neededDuration: null },
};

/** The authored content fields of a node and their values. */
export function contentValues(node: StoryNode): Record<string, unknown> {
  const all: Record<string, unknown> = { ...node };
  const values: Record<string, unknown> = {};
  for (const field of STORY_CONTENT_FIELDS[node.kind]) values[field] = all[field];
  return values;
}

/** Content fields in contract order, from a set of names. */
function inContractOrder(kind: StoryNodeKind, names: ReadonlySet<string>): string[] {
  return STORY_CONTENT_FIELDS[kind].filter((field) => names.has(field));
}

function nonDefaultFields(node: StoryNode): string[] {
  const values = contentValues(node);
  const defaults = DEFAULT_CONTENT[node.kind];
  return STORY_CONTENT_FIELDS[node.kind].filter(
    (field) => !(field in defaults) || !sameJson(values[field], defaults[field]),
  );
}

/**
 * `resolvedFrom` is the service's record of a resolved Missing Asset node, not authored content: a save keeps what is
 * stored for an existing node and drops whatever the client sent for a new one.
 */
function keepResolution(node: StoryNode, before: StoryNode | undefined): StoryNode {
  if (node.kind !== "video" && node.kind !== "picture" && node.kind !== "music") return node;
  const kept =
    before && (before.kind === "video" || before.kind === "picture" || before.kind === "music")
      ? before.resolvedFrom
      : undefined;
  const copy = { ...node };
  delete copy.resolvedFrom;
  if (kept) copy.resolvedFrom = kept;
  return copy;
}

const edgeKey = (edge: { from: string; to: string }) => `${edge.from}\0${edge.to}`;
const attachmentKey = (item: { node: string; chapter: string }) => `${item.node}\0${item.chapter}`;
const removalKey = (removal: StoryRemoval) =>
  removal.kind === "edge"
    ? `edge\0${removal.from}\0${removal.to}`
    : `attachment\0${removal.node}\0${removal.chapter}`;

/**
 * Records who decided what when Studio saves a whole graph. The client's authorship fields are ignored: what a user
 * changed is worked out against the stored graph.
 *
 * - a changed content field joins the node's `userEdited`; a new node is `createdBy: "user"` with its non-default
 *   content fields as `userEdited`;
 * - a new edge/attachment is `createdBy: "user"`; changing an AI edge's transition or an AI attachment's placement,
 *   offset or duration makes it the user's;
 * - an AI edge/attachment the user removed (both nodes still exist) is appended to `removedByUser`, and putting it
 *   back clears that tombstone;
 * - `review` and `build` are the service's records and stay as stored.
 */
export function applyUserAuthorship(
  stored: StoryGraph | null,
  incoming: StoryGraph,
  now: number,
): StoryGraph {
  const storedNodes = new Map((stored?.nodes ?? []).map((node) => [node.id, node]));
  const nodes = incoming.nodes.map((node): StoryNode => {
    const before = storedNodes.get(node.id);
    if (!before) {
      return keepResolution(
        { ...node, createdBy: USER, userEdited: nonDefaultFields(node) },
        undefined,
      );
    }
    if (before.kind !== node.kind) {
      throw new StoryFailure("invalid_request", `Node ${node.id} cannot change its kind`);
    }
    const was = contentValues(before);
    const after = contentValues(node);
    const names = new Set<string>(before.userEdited);
    for (const field of STORY_CONTENT_FIELDS[node.kind]) {
      if (!sameJson(was[field], after[field])) names.add(field);
    }
    return keepResolution(
      { ...node, createdBy: before.createdBy, userEdited: inContractOrder(node.kind, names) },
      before,
    );
  });
  const nodeIds = new Set(nodes.map((node) => node.id));

  const storedEdges = new Map((stored?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
  const edges = incoming.edges.map((edge): StoryEdge => {
    const before = storedEdges.get(edgeKey(edge));
    if (!before) return { ...edge, createdBy: USER };
    return {
      ...edge,
      id: before.id,
      createdBy: before.transition === edge.transition ? before.createdBy : USER,
    };
  });

  const storedAttachments = new Map(
    (stored?.attachments ?? []).map((item) => [attachmentKey(item), item]),
  );
  const attachments = incoming.attachments.map((item): StoryAttachment => {
    const before = storedAttachments.get(attachmentKey(item));
    if (!before) return { ...item, createdBy: USER };
    const same =
      before.placement === item.placement &&
      before.offset === item.offset &&
      before.duration === item.duration;
    return { ...item, id: before.id, createdBy: same ? before.createdBy : USER };
  });

  const present = new Set([
    ...edges.map((edge) => `edge\0${edge.from}\0${edge.to}`),
    ...attachments.map((item) => `attachment\0${item.node}\0${item.chapter}`),
  ]);
  const removals = new Map<string, StoryRemoval>();
  for (const removal of stored?.removedByUser ?? []) {
    if (!present.has(removalKey(removal))) removals.set(removalKey(removal), removal);
  }
  for (const edge of stored?.edges ?? []) {
    const gone = !incoming.edges.some((entry) => edgeKey(entry) === edgeKey(edge));
    if (gone && edge.createdBy === "ai" && nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      const removal: StoryRemoval = { kind: "edge", from: edge.from, to: edge.to };
      removals.set(removalKey(removal), removal);
    }
  }
  for (const item of stored?.attachments ?? []) {
    const gone = !incoming.attachments.some(
      (entry) => attachmentKey(entry) === attachmentKey(item),
    );
    if (gone && item.createdBy === "ai" && nodeIds.has(item.node) && nodeIds.has(item.chapter)) {
      const removal: StoryRemoval = { kind: "attachment", node: item.node, chapter: item.chapter };
      removals.set(removalKey(removal), removal);
    }
  }

  return {
    ...incoming,
    id: stored?.id ?? incoming.id,
    nodes,
    edges,
    attachments,
    removedByUser: [...removals.values()],
    review: stored?.review ?? null,
    build: stored?.build ?? null,
    updatedAt: now,
    updatedBy: USER,
  };
}
