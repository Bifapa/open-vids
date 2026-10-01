import { t, type TranslationKey } from "../../i18n";

export const EASE_PRESETS = [
  { id: "linear", label: "editor.ease.preset.linear", ease: "none", kind: "curve" },
  { id: "ease-in", label: "editor.ease.preset.easeIn", ease: "power1.in", kind: "curve" },
  { id: "quad-in", label: "editor.ease.preset.quadIn", ease: "power2.in", kind: "curve" },
  { id: "cubic-in", label: "editor.ease.preset.cubicIn", ease: "power3.in", kind: "curve" },
  { id: "ease-out", label: "editor.ease.preset.easeOut", ease: "power1.out", kind: "curve" },
  { id: "quad-out", label: "editor.ease.preset.quadOut", ease: "power2.out", kind: "curve" },
  { id: "cubic-out", label: "editor.ease.preset.cubicOut", ease: "power3.out", kind: "curve" },
  { id: "ease", label: "editor.ease.preset.easeInOut", ease: "power1.inOut", kind: "curve" },
  { id: "quad-ease", label: "editor.ease.preset.quadEase", ease: "power2.inOut", kind: "curve" },
  { id: "cubic-ease", label: "editor.ease.preset.cubicEase", ease: "power3.inOut", kind: "curve" },
  {
    id: "circular-ease",
    label: "editor.ease.preset.circularEase",
    ease: "circ.inOut",
    kind: "curve",
  },
  { id: "rebound-in", label: "editor.ease.preset.easeInBack", ease: "back.in", kind: "curve" },
  { id: "rebound-out", label: "editor.ease.preset.easeOutBack", ease: "back.out", kind: "curve" },
  {
    id: "flow-1",
    label: "editor.ease.preset.flow1",
    ease: "wiggle(1,easeInOut,0.20)",
    kind: "wiggle",
  },
  {
    id: "flow-2",
    label: "editor.ease.preset.flow2",
    ease: "wiggle(2,easeInOut,0.15)",
    kind: "wiggle",
  },
  {
    id: "flow-3",
    label: "editor.ease.preset.flow3",
    ease: "wiggle(3,easeInOut,0.12)",
    kind: "wiggle",
  },
  {
    id: "flow-4",
    label: "editor.ease.preset.flow4",
    ease: "wiggle(4,easeInOut,0.10)",
    kind: "wiggle",
  },
  {
    id: "flow-5",
    label: "editor.ease.preset.flow5",
    ease: "wiggle(5,easeInOut,0.08)",
    kind: "wiggle",
  },
  {
    id: "flow-6",
    label: "editor.ease.preset.flow6",
    ease: "wiggle(6,easeInOut,0.07)",
    kind: "wiggle",
  },
  {
    id: "flow-7",
    label: "editor.ease.preset.flow7",
    ease: "wiggle(7,easeInOut,0.06)",
    kind: "wiggle",
  },
  {
    id: "bounce-1",
    label: "editor.ease.preset.bounce1",
    ease: "wiggle(4,easeOut,0.22)",
    kind: "wiggle",
  },
  {
    id: "bounce-2",
    label: "editor.ease.preset.bounce2",
    ease: "wiggle(6,easeOut,0.26)",
    kind: "wiggle",
  },
  {
    id: "bounce-3",
    label: "editor.ease.preset.bounce3",
    ease: "wiggle(9,uniform,0.32)",
    kind: "wiggle",
  },
  {
    id: "bounce-4",
    label: "editor.ease.preset.bounce4",
    ease: "wiggle(5,anticipate,0.28)",
    kind: "wiggle",
  },
  { id: "hold", label: "editor.ease.preset.hold", ease: "hold", kind: "curve" },
  {
    id: "rebound-ease",
    label: "editor.ease.preset.easeInOutBack",
    ease: "back.inOut",
    kind: "curve",
  },
  { id: "expo-in", label: "editor.ease.preset.expoIn", ease: "expo.in", kind: "curve" },
  { id: "expo-out", label: "editor.ease.preset.expoOut", ease: "expo.out", kind: "curve" },
  // Runtime spring(bounce) approximates Figma stiffness and damping with bounce alone.
  { id: "spring-gentle", label: "editor.ease.preset.gentle", ease: "spring(0.15)", kind: "spring" },
  { id: "spring-quick", label: "editor.ease.preset.quick", ease: "spring(0.4)", kind: "spring" },
  { id: "spring-bouncy", label: "editor.ease.preset.bouncy", ease: "spring(0.6)", kind: "spring" },
  { id: "spring-slow", label: "editor.ease.preset.slow", ease: "spring(0.25)", kind: "spring" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: TranslationKey;
  ease: string;
  kind: "curve" | "spring" | "wiggle";
}>;

/** The preset's name in the active language, or null when `ease` is not a preset's ease. */
export function easePresetLabel(ease: string): string | null {
  const preset = EASE_PRESETS.find((candidate) => candidate.ease === ease);
  return preset ? t(preset.label) : null;
}
