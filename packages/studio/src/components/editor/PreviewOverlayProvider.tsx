import { createContext, useContext, useRef, type ReactNode, type RefObject } from "react";
import {
  usePreviewCompositionRect,
  type PreviewCompositionRect,
} from "./usePreviewCompositionRect";
import { usePreviewGuidesStore, type PreviewSnapPreferences } from "./previewGuidesStore";
import { useLivePreviewIframe } from "../../player/store/previewIframeStore";

export type { PreviewSnapPreferences } from "./previewGuidesStore";

interface PreviewOverlayContextValue {
  state: {
    snapPrefs: PreviewSnapPreferences;
    rulerVisible: boolean;
    safeMarginsVisible: boolean;
    iframeRef: RefObject<HTMLIFrameElement | null>;
    compositionRect: PreviewCompositionRect;
  };
  actions: {
    setSnapPrefs: (patch: Partial<PreviewSnapPreferences>) => void;
    toggleRulers: () => void;
    toggleSafeMargins: () => void;
  };
}

const PreviewOverlayContext = createContext<PreviewOverlayContextValue | null>(null);

export interface PreviewOverlayProviderProps {
  iframe?: HTMLIFrameElement | null;
  children: ReactNode;
}

export function PreviewOverlayProvider({ iframe, children }: PreviewOverlayProviderProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const snapPrefs = usePreviewGuidesStore((state) => state.snapPrefs);
  const rulerVisible = usePreviewGuidesStore((state) => state.rulerVisible);
  const safeMarginsVisible = usePreviewGuidesStore((state) => state.safeMarginsVisible);
  const liveIframe = useLivePreviewIframe();
  const resolvedIframe = iframe ?? liveIframe;
  const iframeRef = useRef<HTMLIFrameElement | null>(resolvedIframe);
  iframeRef.current = resolvedIframe;
  const compositionRect = usePreviewCompositionRect(overlayRef, resolvedIframe);

  const contextValue: PreviewOverlayContextValue = {
    state: { snapPrefs, rulerVisible, safeMarginsVisible, iframeRef, compositionRect },
    actions: {
      setSnapPrefs: (patch) => usePreviewGuidesStore.getState().setSnapPrefs(patch),
      toggleRulers: () => usePreviewGuidesStore.getState().toggle("rulerVisible"),
      toggleSafeMargins: () => usePreviewGuidesStore.getState().toggle("safeMarginsVisible"),
    },
  };

  return (
    <PreviewOverlayContext.Provider value={contextValue}>
      <div ref={overlayRef} className="absolute inset-0">
        {children}
      </div>
    </PreviewOverlayContext.Provider>
  );
}

export function usePreviewOverlayContext(): PreviewOverlayContextValue {
  const context = useContext(PreviewOverlayContext);
  if (!context)
    throw new Error("usePreviewOverlayContext must be used within PreviewOverlayProvider");
  return context;
}
