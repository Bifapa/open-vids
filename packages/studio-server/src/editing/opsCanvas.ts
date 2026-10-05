import postcss from "postcss";
import type { EditOperation, EditOperationResult } from "@hyperframes/agent-protocol";
import { parseStyleDecls } from "../helpers/sourceStyleMutation.js";
import {
  CAPTIONS_HOST,
  canvasOf,
  commit,
  fmt,
  loadModel,
  round3,
  setRootDuration,
  setStyle,
  type Batch,
  type EditEnv,
} from "./batch.js";
import type { CompositionModel } from "./timeline.js";

export async function setComposition(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "set_composition" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  setRootDuration(model, op.duration);
  commit(batch, model);
  batch.explicitDuration = true;
  return { op: op.op, clipId: null, newClipId: null };
}

/** The selectors whose rule carries the stage size in the blank template's inline CSS. */
const STAGE_SELECTORS = /^(?:html|body|:root)$/i;

/** The px size of the `html`/`body` rule of one inline style sheet; `%`/`auto` and min-/max- sizes stay as they are. */
function replaceStageCssSize(css: string, width: number, height: number): string {
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    return css;
  }
  let changed = false;
  root.walkRules((rule) => {
    if (!rule.selectors.some((selector) => STAGE_SELECTORS.test(selector.trim()))) return;
    rule.walkDecls((decl) => {
      if (decl.prop !== "width" && decl.prop !== "height") return;
      if (!/^\d+px$/.test(decl.value.trim())) return;
      decl.value = `${decl.prop === "width" ? width : height}px`;
      changed = true;
    });
  });
  return changed ? root.toString() : css;
}

/**
 * The stage size lives in three places in the blank template: the root's `data-width`/`data-height`, the inline
 * `html, body` CSS and the viewport meta. create.rs patches the same three when a project is scaffolded.
 */
function setCanvasSize(model: CompositionModel, width: number, height: number): void {
  model.root.setAttribute("data-width", String(width));
  model.root.setAttribute("data-height", String(height));
  const viewport = model.document.querySelector('meta[name="viewport"]');
  const content = viewport?.getAttribute("content");
  if (viewport && content) {
    viewport.setAttribute(
      "content",
      content.replace(
        /\b(width|height)\s*=\s*\d+/g,
        (_match, dim: string) => `${dim}=${dim === "width" ? width : height}`,
      ),
    );
  }
  for (const style of Array.from(model.document.querySelectorAll("style"))) {
    const css = style.textContent ?? "";
    const patched = replaceStageCssSize(css, width, height);
    if (patched !== css) style.textContent = patched;
  }
}

const PX = /^(-?\d+(?:\.\d+)?)px$/;

/** How many clips a reframe moved and how many it could not (no pixel frame of their own). */
interface ReframeOutcome {
  moved: number;
  skipped: number;
  scale: number;
}

/**
 * Maps the old canvas into the new one: "contain" fits the whole old picture inside it (bars where the shapes
 * differ), "cover" fills the new canvas (the old picture is cropped). Every clip's pixel left/top/right/bottom/
 * width/height/font-size moves with the picture; a clip sized by CSS classes or percentages has no pixel frame and
 * stays. The captions host always fills the new canvas.
 */
function reframeClips(
  model: CompositionModel,
  from: { width: number; height: number },
  to: { width: number; height: number },
  fit: "contain" | "cover",
): ReframeOutcome {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const scale = fit === "contain" ? Math.min(sx, sy) : Math.max(sx, sy);
  const offX = (to.width - from.width * scale) / 2;
  const offY = (to.height - from.height * scale) / 2;
  const mapped: Array<[string, (value: number) => number]> = [
    ["left", (v) => v * scale + offX],
    ["top", (v) => v * scale + offY],
    ["right", (v) => v * scale + (to.width - offX - from.width * scale)],
    ["bottom", (v) => v * scale + (to.height - offY - from.height * scale)],
    ["width", (v) => v * scale],
    ["height", (v) => v * scale],
    ["font-size", (v) => v * scale],
  ];
  const outcome: ReframeOutcome = { moved: 0, skipped: 0, scale };
  for (const clip of model.clips) {
    if (clip.kind === "audio") continue;
    if (clip.element.matches(CAPTIONS_HOST)) {
      clip.element.setAttribute("data-width", String(to.width));
      clip.element.setAttribute("data-height", String(to.height));
      setStyle(clip.element, "left", "0px");
      setStyle(clip.element, "top", "0px");
      setStyle(clip.element, "width", `${to.width}px`);
      setStyle(clip.element, "height", `${to.height}px`);
      continue;
    }
    const { props } = parseStyleDecls(clip.element.getAttribute("style") ?? "");
    let touched = false;
    for (const [name, map] of mapped) {
      const match = PX.exec(props.get(name) ?? "");
      if (!match?.[1]) continue;
      setStyle(clip.element, name, `${Math.round(map(Number.parseFloat(match[1])) * 100) / 100}px`);
      touched = true;
    }
    if (touched) outcome.moved += 1;
    else outcome.skipped += 1;
  }
  return outcome;
}

export async function setCanvas(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "set_canvas" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const from = canvasOf(model);
  const fit = op.fit ?? "keep";
  const outcome =
    fit === "keep" || (from.width === op.width && from.height === op.height)
      ? null
      : reframeClips(model, from, { width: op.width, height: op.height }, fit);
  setCanvasSize(model, op.width, op.height);
  commit(batch, model);
  const note =
    outcome === null
      ? undefined
      : `reframed ${outcome.moved} clips (${fit}, ×${fmt(round3(outcome.scale))})${outcome.skipped > 0 ? `; ${outcome.skipped} clips have no pixel frame and were left as they are — check them with set_clip frame` : ""}`;
  return { op: op.op, clipId: null, newClipId: null, ...(note !== undefined && { note }) };
}
