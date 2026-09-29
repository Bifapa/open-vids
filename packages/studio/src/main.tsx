import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IconContext } from "@phosphor-icons/react";
import { StudioApp } from "./App";
import { StudioErrorBoundary } from "./components/StudioErrorBoundary";
import { readIconTokens } from "./styles/iconTokens";
import { prefetchPreviewForHash } from "./utils/previewPrefetch";
import "./styles/studio.css";

prefetchPreviewForHash(window.location.hash);
window.addEventListener("hashchange", () => prefetchPreviewForHash(window.location.hash));

// Swallow the ResizeObserver loop noise the layout pass emits; everything else
// surfaces through the console like any other unhandled error.
window.addEventListener("error", (event) => {
  if (event.message?.includes("ResizeObserver loop")) {
    event.stopImmediatePropagation();
    event.preventDefault();
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* One icon size and weight for the whole app, taken from the theme file.
        Icons that pass their own size or weight still win. */}
    <IconContext.Provider value={readIconTokens()}>
      <StudioErrorBoundary>
        <StudioApp />
      </StudioErrorBoundary>
    </IconContext.Provider>
  </StrictMode>,
);
