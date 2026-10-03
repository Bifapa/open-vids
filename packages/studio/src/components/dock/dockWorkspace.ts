import type {
  Direction,
  DockviewApi,
  DockviewGroupPanel,
  SerializedDockview,
} from "dockview-react";
import { isRecord, type StoryRatios } from "./dockLayoutSchema";
import { addRegisteredPanel } from "./dockLayout";
import { isPanelId, type PanelId } from "./panelRegistry";

export type Workspace = "media" | "story" | "edit";

/** Each workspace is the centre panel it brings to the front; prototype order. */
export const WORKSPACE_PANELS = {
  media: "media",
  story: "story",
  edit: "preview",
} as const satisfies Record<Workspace, PanelId>;

export function isWorkspace(value: unknown): value is Workspace {
  return value === "media" || value === "story" || value === "edit";
}

/**
 * The dock holds one of two arrangements of the same panels. "edit" is the user's own layout
 * (Media is a state of it); "story" is the fixed Story layout, built from it by moving panels.
 */
export type Arrangement = "edit" | "story";

/** The panels the Story arrangement shows; every other panel waits, hidden, for the way back. */
const STORY_PANELS: readonly PanelId[] = ["chat", "media", "preview", "story"];

export function isStoryPanel(id: PanelId): boolean {
  return STORY_PANELS.includes(id);
}

export const DEFAULT_STORY_RATIOS: StoryRatios = { left: 0.36, top: 0.5 };

/** A stored layout reduced to what the way back needs: which panels share a group, in what order, how big. */
interface LeafNode {
  type: "leaf";
  views: PanelId[];
  active: PanelId | null;
  groupId: string | null;
  size: number | null;
  visible: boolean;
}
interface BranchNode {
  type: "branch";
  children: LayoutNode[];
  size: number | null;
}
type LayoutNode = LeafNode | BranchNode;
type Axis = "horizontal" | "vertical";

function readNode(node: unknown): LayoutNode | null {
  if (!isRecord(node)) return null;
  const size = typeof node.size === "number" ? node.size : null;
  if (node.type === "branch" && Array.isArray(node.data)) {
    const children = node.data.map(readNode);
    if (children.some((child) => child === null)) return null;
    return { type: "branch", children: children.filter((child) => child !== null), size };
  }
  const data = node.data;
  if (node.type !== "leaf" || !isRecord(data) || !Array.isArray(data.views)) return null;
  const views = data.views.filter(isPanelId);
  if (views.length !== data.views.length || views.length === 0) return null;
  const active = isPanelId(data.activeView) ? data.activeView : null;
  const groupId = typeof data.id === "string" ? data.id : null;
  return { type: "leaf", views, active, groupId, size, visible: node.visible !== false };
}

function flipped(axis: Axis): Axis {
  return axis === "horizontal" ? "vertical" : "horizontal";
}

/**
 * dockview keeps a branch around a lone child until something rebuilds the tree, so the same
 * arrangement can be stored with or without such wrappers. The tree here never has them: a lone
 * leaf takes its wrapper's place, a lone branch's children join the wrapper's parent (or become
 * the root). `axis` is the direction the node lays its children along, and the result's axis.
 */
function simplify(node: LayoutNode, axis: Axis): { node: LayoutNode; axis: Axis } {
  if (node.type === "leaf") return { node, axis };
  const children: LayoutNode[] = [];
  for (const child of node.children) {
    const result = simplify(child, flipped(axis));
    if (result.node.type === "branch" && result.axis === axis)
      children.push(...result.node.children);
    else children.push(result.node);
  }
  const only = children[0];
  if (children.length === 1 && only) {
    return {
      node: { ...only, size: node.size },
      axis: only.type === "branch" ? flipped(axis) : axis,
    };
  }
  return { node: { type: "branch", children, size: node.size }, axis };
}

/** The tree of a stored layout and the axis its root lays children along; null for a shape it does not know. */
function readLayout(layout: SerializedDockview): { root: LayoutNode; axis: Axis } | null {
  const root = readNode(layout.grid.root);
  if (!root) return null;
  const axis: Axis = String(layout.grid.orientation) === "HORIZONTAL" ? "horizontal" : "vertical";
  const simple = simplify(root, axis);
  return { root: simple.node, axis: simple.axis };
}

function leavesOf(node: LayoutNode): LeafNode[] {
  return node.type === "leaf" ? [node] : node.children.flatMap(leavesOf);
}

/** The groups' panels and active tabs as a string, ignoring ids, sizes and visibility. */
function structureOf(node: LayoutNode, axis: Axis): string {
  if (node.type === "leaf") return `(${node.views.join(",")}|${node.active ?? ""})`;
  const inner = node.children.map((child) => structureOf(child, flipped(axis))).join(" ");
  return `${axis === "horizontal" ? "h" : "v"}[${inner}]`;
}

export function sameStructure(a: SerializedDockview, b: SerializedDockview): boolean {
  const left = readLayout(a);
  const right = readLayout(b);
  if (!left || !right) return false;
  return structureOf(left.root, left.axis) === structureOf(right.root, right.axis);
}

function panelsOf(group: DockviewGroupPanel): string[] {
  return group.panels.map((panel) => panel.id);
}

/**
 * Builds the Story arrangement out of whatever the dock holds, by moving panels: Chat with Media as
 * its second tab in a new full-height left group, the preview on top of the Story graph on the
 * right, every other group hidden. dockview keeps panel content mounted across moves, so the
 * preview iframe and the chat are not reloaded. Returns the ids of the groups it created (they
 * vanish again when their panels leave), or null when a Story panel is missing.
 */
export function arrangeStory(api: DockviewApi, ratios: StoryRatios): Set<string> | null {
  const chat = api.getPanel("chat");
  const media = api.getPanel("media");
  const story = api.getPanel("story");
  const preview = api.getPanel("preview");
  if (!chat || !media || !story || !preview) return null;
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();

  // A preview group the user filled with other tabs keeps them; the preview gets a group of its own.
  const previewGroupIsPlain = panelsOf(preview.group).every(
    (id) => id === "preview" || id === "media" || id === "story",
  );
  const left = api.addGroup({ direction: "left" });
  const created = new Set([left.id]);
  chat.api.moveTo({ group: left, position: "center", skipSetActive: true });
  media.api.moveTo({ group: left, position: "center", skipSetActive: true });
  let top = preview.group;
  if (!previewGroupIsPlain) {
    top = api.addGroup({ referenceGroup: left, direction: "right" });
    created.add(top.id);
    preview.api.moveTo({ group: top, position: "center", skipSetActive: true });
  }
  story.api.moveTo({ group: top, position: "bottom", skipSetActive: true });
  const bottom = story.group;
  created.add(bottom.id);

  const shown = new Set([left.id, top.id, bottom.id]);
  for (const group of api.groups) {
    if (shown.has(group.id)) group.api.setVisible(true);
    else group.api.setVisible(false);
  }
  chat.api.setActive();
  story.api.setActive();
  preview.api.setActive();
  left.api.setSize({ width: Math.round(api.width * ratios.left) });
  top.api.setSize({ height: Math.round((top.height + bottom.height) * ratios.top) });
  return created;
}

/** The Story arrangement's current splits, or null while it has no left/top/bottom split to read. */
export function readStoryRatios(api: DockviewApi): StoryRatios | null {
  const chat = api.getPanel("chat")?.group;
  const preview = api.getPanel("preview")?.group;
  const story = api.getPanel("story")?.group;
  if (!chat || !preview || !story || preview === story || chat === preview) return null;
  const width = chat.width + preview.width;
  const height = preview.height + story.height;
  if (width <= 0 || height <= 0) return null;
  return { left: chat.width / width, top: preview.height / height };
}

function firstLeaf(node: LayoutNode): LeafNode | null {
  return leavesOf(node)[0] ?? null;
}

/** Sets every child's extent along its parent's axis, outside in; the last child takes what is left. */
function applySizes(
  node: BranchNode,
  axis: Axis,
  hosts: ReadonlyMap<LeafNode, DockviewGroupPanel>,
): void {
  for (const child of node.children) {
    const leaf = firstLeaf(child);
    const group = leaf ? hosts.get(leaf) : undefined;
    if (group && child.size !== null) {
      group.api.setSize(axis === "horizontal" ? { width: child.size } : { height: child.size });
    }
    if (child.type === "branch") applySizes(child, flipped(axis), hosts);
  }
}

interface Placement {
  parent: BranchNode;
  index: number;
  axis: Axis;
}

function placementsOf(root: LayoutNode, axis: Axis): Map<LayoutNode, Placement> {
  const placements = new Map<LayoutNode, Placement>();
  const walk = (node: LayoutNode, nodeAxis: Axis) => {
    if (node.type !== "branch") return;
    node.children.forEach((child, index) => {
      placements.set(child, { parent: node, index, axis: nodeAxis });
      walk(child, flipped(nodeAxis));
    });
  };
  walk(root, axis);
  return placements;
}

/** Assigns each stored group the live group that holds most of its panels, never one Story created. */
function matchHosts(
  api: DockviewApi,
  leaves: readonly LeafNode[],
  created: ReadonlySet<string>,
): Map<LeafNode, DockviewGroupPanel> {
  const hosts = new Map<LeafNode, DockviewGroupPanel>();
  const claimed = new Set<string>();
  for (const leaf of leaves) {
    let best: DockviewGroupPanel | null = null;
    let bestCount = 0;
    for (const group of api.groups) {
      if (claimed.has(group.id) || created.has(group.id)) continue;
      const present = panelsOf(group);
      const count = leaf.views.filter((view) => present.includes(view)).length;
      if (count > bestCount) {
        best = group;
        bestCount = count;
      }
    }
    if (best) {
      hosts.set(leaf, best);
      claimed.add(best.id);
    }
  }
  return hosts;
}

/** Makes a group beside its stored neighbour for each stored group that has no live host yet. */
function createMissingHosts(
  api: DockviewApi,
  leaves: readonly LeafNode[],
  placements: ReadonlyMap<LayoutNode, Placement>,
  hosts: Map<LeafNode, DockviewGroupPanel>,
): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const leaf of leaves) {
      const placement = placements.get(leaf);
      if (hosts.has(leaf) || !placement) continue;
      const { parent, index, axis } = placement;
      const before = parent.children[index - 1];
      const after = parent.children[index + 1];
      const beforeHost = before ? hosts.get(leavesOf(before).at(-1) ?? leaf) : undefined;
      const afterHost = after ? hosts.get(firstLeaf(after) ?? leaf) : undefined;
      const group = beforeHost
        ? api.addGroup({
            referenceGroup: beforeHost,
            direction: axis === "horizontal" ? "right" : "below",
          })
        : afterHost
          ? api.addGroup({
              referenceGroup: afterHost,
              direction: axis === "horizontal" ? "left" : "above",
            })
          : null;
      if (!group) continue;
      hosts.set(leaf, group);
      progressed = true;
    }
  }
}

/**
 * Puts the Edit layout back after Story, by moving panels into groups again and restoring sizes,
 * visibility and tab order from `edit` (the layout as it was when Story began). No panel is
 * re-created unless it was closed meanwhile. If the result does not have the stored structure
 * (a layout moves cannot reproduce), falls back to `fromJSON`, which remounts every panel.
 */
export function restoreEdit(
  api: DockviewApi,
  edit: SerializedDockview,
  created: ReadonlySet<string>,
): "moved" | "rebuilt" {
  const layout = readLayout(edit);
  if (!layout) {
    api.fromJSON(edit);
    return "rebuilt";
  }
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  const leaves = leavesOf(layout.root);
  const wanted = new Set(leaves.flatMap((leaf) => leaf.views));
  for (const id of wanted) if (!api.getPanel(id)) addRegisteredPanel(api, id);
  for (const panel of [...api.panels]) {
    if (isPanelId(panel.id) && !wanted.has(panel.id)) api.removePanel(panel);
  }

  const hosts = matchHosts(api, leaves, created);
  createMissingHosts(api, leaves, placementsOf(layout.root, layout.axis), hosts);
  for (const leaf of leaves) {
    const host = hosts.get(leaf);
    if (!host) continue;
    leaf.views.forEach((id, index) => {
      const panel = api.getPanel(id);
      if (panel && (panel.group !== host || host.panels.indexOf(panel) !== index)) {
        panel.api.moveTo({ group: host, position: "center", index, skipSetActive: true });
      }
    });
  }
  for (const group of hosts.values()) group.api.setVisible(true);
  for (const leaf of leaves) {
    if (leaf.active && leaf.groupId !== edit.activeGroup)
      api.getPanel(leaf.active)?.api.setActive();
  }
  const activeLeaf = leaves.find((leaf) => leaf.groupId === edit.activeGroup);
  if (activeLeaf?.active) api.getPanel(activeLeaf.active)?.api.setActive();

  if (layout.root.type === "branch") applySizes(layout.root, layout.axis, hosts);
  for (const leaf of leaves) if (!leaf.visible) hosts.get(leaf)?.api.setVisible(false);

  if (sameStructure(api.toJSON(), edit)) return "moved";
  api.fromJSON(edit);
  return "rebuilt";
}

/** Where the Story arrangement reopens one of its panels that was closed, or undefined when it has no place for it. */
export function storyPlacement(
  api: DockviewApi,
  id: PanelId,
): { referencePanel: PanelId; direction: Direction; index?: number } | undefined {
  if (id === "chat" && api.getPanel("media")) {
    return { referencePanel: "media", direction: "within", index: 0 };
  }
  if (id === "media" && api.getPanel("chat"))
    return { referencePanel: "chat", direction: "within" };
  if (id === "story" && api.getPanel("preview"))
    return { referencePanel: "preview", direction: "below" };
  if (id === "preview" && api.getPanel("story"))
    return { referencePanel: "story", direction: "above" };
  return undefined;
}
