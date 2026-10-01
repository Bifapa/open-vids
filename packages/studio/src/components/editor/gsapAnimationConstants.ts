import type { TFunction } from "i18next";
import type { TranslationKey } from "../../i18n";
import { controlPointsForGsapEase, parseStudioCustomEaseData } from "./studioMotion";

export const METHOD_LABELS: Record<string, TranslationKey> = {
  set: "editor.animation.method.set",
  to: "editor.animation.method.to",
  from: "editor.animation.method.from",
  fromTo: "editor.animation.method.fromTo",
};

export const METHOD_TOOLTIPS: Record<string, TranslationKey> = {
  set: "editor.animation.methodTooltip.set",
  to: "editor.animation.methodTooltip.to",
  from: "editor.animation.methodTooltip.from",
  fromTo: "editor.animation.methodTooltip.fromTo",
};

export const PROP_LABELS: Record<string, TranslationKey> = {
  x: "editor.animation.prop.x",
  y: "editor.animation.prop.y",
  width: "editor.animation.prop.width",
  height: "editor.animation.prop.height",
  rotation: "editor.animation.prop.rotation",
  z: "editor.animation.prop.z",
  rotationX: "editor.animation.prop.rotationX",
  rotationY: "editor.animation.prop.rotationY",
  rotationZ: "editor.animation.prop.rotationZ",
  perspective: "editor.animation.prop.perspective",
  transformPerspective: "editor.animation.prop.perspective",
  transformOrigin: "editor.animation.prop.transformOrigin",
  opacity: "editor.animation.prop.opacity",
  scale: "editor.animation.prop.scale",
  scaleX: "editor.animation.prop.scaleX",
  scaleY: "editor.animation.prop.scaleY",
  autoAlpha: "editor.animation.prop.autoAlpha",
  visibility: "editor.animation.prop.visibility",
  scaleX_alias: "editor.animation.prop.scaleXAlias",
  filter: "editor.animation.prop.filter",
  clipPath: "editor.animation.prop.clipPath",
  color: "editor.animation.prop.color",
  backgroundColor: "editor.animation.prop.backgroundColor",
  borderColor: "editor.animation.prop.borderColor",
  borderRadius: "editor.animation.prop.borderRadius",
  fontSize: "editor.animation.prop.fontSize",
  letterSpacing: "editor.animation.prop.letterSpacing",
  skewX: "editor.animation.prop.skewX",
  skewY: "editor.animation.prop.skewY",
  innerText: "editor.animation.prop.innerText",
};

export const PROP_UNITS: Record<string, string> = {
  x: "px",
  y: "px",
  width: "px",
  height: "px",
  rotation: "°",
  z: "px",
  rotationX: "°",
  rotationY: "°",
  rotationZ: "°",
  perspective: "px",
  transformPerspective: "px",
  transformOrigin: "",
  opacity: "%",
  scale: "×",
  scaleX: "×",
  scaleY: "×",
  autoAlpha: "%",
  visibility: "",
};

export const PROP_TOOLTIPS: Record<string, TranslationKey> = {
  x: "editor.animation.propTooltip.x",
  y: "editor.animation.propTooltip.y",
  opacity: "editor.animation.propTooltip.opacity",
  scale: "editor.animation.propTooltip.scale",
  scaleX: "editor.animation.propTooltip.scaleX",
  scaleY: "editor.animation.propTooltip.scaleY",
  rotation: "editor.animation.propTooltip.rotation",
  z: "editor.animation.propTooltip.z",
  rotationX: "editor.animation.propTooltip.rotationX",
  rotationY: "editor.animation.propTooltip.rotationY",
  rotationZ: "editor.animation.propTooltip.rotationZ",
  perspective: "editor.animation.propTooltip.perspective",
  transformPerspective: "editor.animation.propTooltip.transformPerspective",
  transformOrigin: "editor.animation.propTooltip.transformOrigin",
  width: "editor.animation.propTooltip.width",
  height: "editor.animation.propTooltip.height",
  autoAlpha: "editor.animation.propTooltip.autoAlpha",
  visibility: "editor.animation.propTooltip.visibility",
  innerText: "editor.animation.propTooltip.innerText",
};

/** The tween method's label; an unknown method shows as its own name. */
export function methodLabel(t: TFunction, method: string): string {
  const key = METHOD_LABELS[method];
  return key ? t(key) : method;
}

/** The tween method's tooltip, or undefined for an unknown method. */
export function methodTooltip(t: TFunction, method: string): string | undefined {
  const key = METHOD_TOOLTIPS[method];
  return key ? t(key) : undefined;
}

/** The animated property's label; a property without one shows as its own name. */
export function propLabel(t: TFunction, prop: string): string {
  const key = PROP_LABELS[prop];
  return key ? t(key) : prop;
}

/** The animated property's tooltip, or undefined when it has none. */
export function propTooltip(t: TFunction, prop: string): string | undefined {
  const key = PROP_TOOLTIPS[prop];
  return key ? t(key) : undefined;
}

// Ease labels surface the raw GSAP token (e.g. "power2.out", "back.out") rather
// than friendly names — motion authors recognize the GSAP vocabulary, and the
// invented labels ("Smooth speedup") confused users. Every consumer reads
// `EASE_LABELS[token] ?? token`, so an empty map cleanly falls through to the
// token; re-add an entry here only to override a specific token's display.
export const EASE_LABELS: Record<string, string> = {};

export const EASE_CURVES: Record<string, [number, number, number, number]> = {
  none: [0, 0, 1, 1],
  "power1.out": [0, 0, 0.58, 1],
  "power2.out": [0.16, 1, 0.3, 1],
  "power3.out": [0.08, 0.82, 0.17, 1],
  "power4.out": [0.06, 0.73, 0.09, 1],
  "power1.in": [0.42, 0, 1, 1],
  "power2.in": [0.55, 0.06, 0.68, 0.19],
  "power3.in": [0.6, 0.04, 0.98, 0.34],
  "power4.in": [0.7, 0, 0.84, 0],
  "power1.inOut": [0.42, 0, 0.58, 1],
  "power2.inOut": [0.45, 0.05, 0.55, 0.95],
  "power3.inOut": [0.65, 0.05, 0.35, 1],
  "power4.inOut": [0.76, 0, 0.24, 1],
  "back.out": [0.34, 1.56, 0.64, 1],
  "back.in": [0.36, 0, 0.66, -0.56],
  "back.inOut": [0.68, -0.55, 0.27, 1.55],
  "circ.inOut": [0.785, 0.135, 0.15, 0.86],
  "expo.out": [0.16, 1, 0.3, 1],
  "expo.in": [0.7, 0, 0.84, 0],
  "expo.inOut": [0.87, 0, 0.13, 1],
  "bounce.out": [0.34, 1.56, 0.64, 0.74],
  "bounce.in": [0.36, 0.26, 0.66, -0.56],
  "elastic.out(1,0.3)": [0.16, 1.45, 0.28, 0.82],
  "elastic.inOut(1,0.3)": [0.68, -0.55, 0.32, 1.55],
  // After Effects polarity: "in" eases into the keyframe (slow END, CP2 y=1),
  // "out" eases out of it (slow START, CP1 y=0). Matches the "(AE)" labels.
  "ae-ease": [0.333, 0, 0.667, 1],
  "ae-ease-in": [0.333, 0.333, 0.667, 1],
  "ae-ease-out": [0.333, 0, 0.667, 0.667],
};

export function resolveEaseCurveTuple(ease: string): [number, number, number, number] {
  if (ease.startsWith("custom(")) {
    const points = parseStudioCustomEaseData(ease.match(/^custom\((.+)\)$/)?.[1]);
    if (points) return [points.x1, points.y1, points.x2, points.y2];
  }
  const curve = EASE_CURVES[ease];
  if (curve) return curve;
  const points = controlPointsForGsapEase(ease);
  return [points.x1, points.y1, points.x2, points.y2];
}

export const PERCENT_PROPS = new Set(["opacity", "autoAlpha"]);

export const PROP_CONSTRAINTS: Record<string, { min?: number; max?: number; step?: number }> = {
  opacity: { min: 0, max: 1, step: 0.01 },
  autoAlpha: { min: 0, max: 1, step: 0.01 },
  scale: { min: -10, max: 10, step: 0.01 },
  scaleX: { min: -10, max: 10, step: 0.01 },
  scaleY: { min: -10, max: 10, step: 0.01 },
  rotation: { step: 1 },
  z: { step: 1 },
  rotationX: { step: 1 },
  rotationY: { step: 1 },
  rotationZ: { step: 1 },
  perspective: { min: 0, step: 1 },
  transformPerspective: { min: 0, step: 1 },
  skewX: { min: -90, max: 90, step: 1 },
  skewY: { min: -90, max: 90, step: 1 },
  width: { min: 0, step: 1 },
  height: { min: 0, step: 1 },
  borderRadius: { min: 0, step: 1 },
  x: { step: 1 },
  y: { step: 1 },
  fontSize: { min: 1, step: 1 },
  letterSpacing: { step: 0.1 },
  innerText: { step: 1 },
};

export function clampPropertyValue(prop: string, value: number): number {
  const constraint = PROP_CONSTRAINTS[prop];
  if (!constraint) return value;
  let clamped = value;
  if (constraint.min !== undefined) clamped = Math.max(constraint.min, clamped);
  if (constraint.max !== undefined) clamped = Math.min(constraint.max, clamped);
  return clamped;
}

export const ADD_METHODS = ["to", "from", "fromTo", "set"] as const;

export const ADD_METHOD_LABELS: Record<string, TranslationKey> = {
  to: "editor.animation.method.to",
  from: "editor.animation.method.from",
  fromTo: "editor.animation.method.fromTo",
  set: "editor.animation.addMethod.set",
};
