import { Hono } from "hono";
import type { StudioApiAdapter } from "./types.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerPreviewRoutes } from "./routes/preview.js";
import { registerLintRoutes } from "./routes/lint.js";
import { registerRenderRoutes } from "./routes/render.js";
import { registerImageThumbnailRoutes } from "./routes/imageThumbnail.js";
import { registerThumbnailRoutes } from "./routes/thumbnail.js";
import { registerWaveformRoutes } from "./routes/waveform.js";
import { registerFontRoutes } from "./routes/fonts.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import { registerSelectionRoutes } from "./routes/selection.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerGlobalAssetRoutes } from "./routes/globalAssets.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerEditingRoutes } from "./routes/editing.js";
import { registerCompositionFrameRoutes } from "./routes/editingFrames.js";
import { registerAnalysisRoutes } from "./routes/analysis.js";
import { registerStoryRoutes } from "./routes/story.js";
import { registerResearchRoutes } from "./routes/research.js";
import { registerCrossProjectRoutes } from "./routes/crossProject.js";
import { registerQaRoutes } from "./routes/qa.js";
import { registerAppPreferencesRoutes } from "./routes/appPreferences.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerDesignRoutes } from "./routes/design.js";
import { registerProjectDesignRoutes } from "./routes/projectDesign.js";
import { registerVoiceRoutes } from "./routes/voice.js";
import { registerProjectVoiceRoutes } from "./routes/projectVoice.js";

/**
 * Create a Hono sub-app with all studio API routes.
 *
 * Both the vite dev server and CLI embedded server mount this app
 * under /api, each providing their own adapter for host-specific behavior.
 *
 * `shutdownSignal`: the host's shutdown. Aborting it cancels running analysis jobs, so their ffmpeg and speech
 * recognizer children do not outlive the server.
 */
export function createStudioApi(
  adapter: StudioApiAdapter,
  options: { shutdownSignal?: AbortSignal } = {},
): Hono {
  const api = new Hono();

  registerProjectRoutes(api, adapter);
  registerAppPreferencesRoutes(api);
  registerFileRoutes(api, adapter);
  registerPreviewRoutes(api, adapter);
  registerLintRoutes(api, adapter);
  const renders = registerRenderRoutes(api, adapter);
  registerActivityRoutes(api, adapter, renders);
  registerThumbnailRoutes(api, adapter);
  registerImageThumbnailRoutes(api, adapter);
  registerSelectionRoutes(api, adapter);
  registerMediaRoutes(api, adapter);
  registerWaveformRoutes(api, adapter);
  registerFontRoutes(api);
  registerRegistryRoutes(api, adapter);
  registerGlobalAssetRoutes(api);
  registerHistoryRoutes(api, adapter);
  registerAgentRoutes(api, adapter);
  registerCompositionFrameRoutes(api, adapter);
  const analysis = registerAnalysisRoutes(api, adapter);
  registerEditingRoutes(api, adapter, { analysis });
  const story = registerStoryRoutes(api, adapter, analysis);
  registerResearchRoutes(api, adapter, story);
  registerCrossProjectRoutes(api, adapter);
  const designLibrary = registerDesignRoutes(api, adapter);
  registerProjectDesignRoutes(api, adapter, designLibrary);
  const voiceEngine = registerVoiceRoutes(api, adapter);
  registerProjectVoiceRoutes(api, adapter, voiceEngine);
  const qa = registerQaRoutes(api, adapter, analysis);
  options.shutdownSignal?.addEventListener(
    "abort",
    () => {
      analysis.shutdown();
      qa.shutdown();
    },
    { once: true },
  );

  return api;
}
