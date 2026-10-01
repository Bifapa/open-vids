/** @deprecated Superseded by `src/styles/theme.css` (published as
 * `@hyperframes/studio/theme.css`); kept one more major for Tailwind v3
 * consumers. Dark-theme values of the CSS tokens these names alias, with the
 * `color-mix()` ones resolved; theme.test.ts fails if the literal ones drift.
 * Tailwind v3 cannot follow the light theme, so v3 consumers stay dark. */
const studioPreset = {
  theme: {
    extend: {
      colors: {
        studio: {
          bg: "oklch(15.5% 0.004 260)",
          surface: "oklch(18.5% 0.005 260)",
          border: "oklch(42% 0.008 260)",
          text: "oklch(94% 0.004 260)",
          muted: "oklch(65% 0.006 260)",
          accent: "oklch(74% 0.155 55)",
        },
        panel: {
          bg: "oklch(15.5% 0.004 260)",
          // Open inspector-section body — the chrome step above the panel body.
          "bg-inset": "oklch(18.5% 0.005 260)",
          input: "oklch(21.5% 0.005 260)",
          surface: "oklch(18.5% 0.005 260)",
          hover: "oklch(25.5% 0.006 260)",
          border: "oklch(24% 0.005 260)",
          "border-input": "oklch(31% 0.006 260)",
          hairline: "oklch(24% 0.005 260)",
          "text-0": "oklch(94% 0.004 260)",
          "text-1": "oklch(89.5% 0.004 260)",
          "text-2": "oklch(79% 0.005 260)",
          "text-3": "oklch(65% 0.006 260)",
          "text-4": "oklch(56.9% 0.006 260)",
          "text-5": "oklch(47% 0.006 260)",
          accent: "oklch(74% 0.155 55)",
          danger: "oklch(68% 0.2 22)",
          media: "oklch(63% 0.03 237.5)",
          container: "oklch(83% 0.14 95)",
        },
      },
    },
  },
  plugins: [],
};

export default studioPreset;
