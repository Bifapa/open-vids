/**
 * Studio's tailwind-merge config: teaches it the scales `theme.css` invents
 * (`text-step-*`, the role type sizes, the control/row/icon spacing, the shadow
 * and radius names) so overrides replace, not stack.
 */

import { createCn } from "cn/config";

/** `text-step-11`, `text-num`, `text-tc` — type sizes tailwind-merge would read as colours. */
const isTypeSize = (value: string) => /^(step-\d+|num|tc)$/.test(value);

/** `ctl-xs` … `ctl-lg`, `head`, `nav`, `row-*`, `icon-*` — the sized boxes from `theme.css`. */
const isBoxSize = (value: string) =>
  /^(ctl(-xs|-sm|-lg)?|head|list-head|nav|row(-sm|-lg)?|icon-(xs|sm|md|lg|xl))$/.test(value);

export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: [isTypeSize] }],
      h: [{ h: [isBoxSize] }],
      w: [{ w: [isBoxSize] }],
      size: [{ size: [isBoxSize] }],
      "min-h": [{ "min-h": [isBoxSize] }],
      "min-w": [{ "min-w": [isBoxSize] }],
      shadow: [{ shadow: ["pop", "raise", "lift", "tip", "menu", "popover"] }],
      rounded: [{ rounded: ["window", "pill", "button"] }],
    },
  },
});
