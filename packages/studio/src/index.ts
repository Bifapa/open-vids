// UI primitives
export { Button, buttonBase, buttonSizes, buttonVariants } from "./components/ui/Button";
export type { ButtonSize, ButtonVariant, PreviewState } from "./components/ui/Button";
export { OpenvidsLogo, OpenvidsMark } from "./components/ui/OpenvidsLogo";
export { IconButton } from "./components/ui/IconButton";
export { Tab, TabPanel, Tabs, TabsList } from "./components/ui/Tabs";
export { BrandLoader } from "./components/ui/BrandLoader";
export type { BrandLoaderProps } from "./components/ui/BrandLoader";
export { Tooltip } from "./components/ui/Tooltip";
export { Kbd } from "./components/ui/Kbd";
export { cn } from "./components/ui/cn";
export {
  ContextMenu,
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  menuItemBase,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  popupSurface,
} from "./components/ui/Menu";
export type { MenuItemTone, PopupPreviewState } from "./components/ui/Menu";
export { Popover } from "./components/ui/Popover";
export { Dialog } from "./components/ui/Dialog";
export type { DialogProps } from "./components/ui/Dialog";
export { Input, fieldBase, fieldSizes, fieldText } from "./components/ui/Input";
export type { FieldSize, InputProps } from "./components/ui/Input";
export { NumberField } from "./components/ui/NumberField";
export type { NumberFieldProps } from "./components/ui/NumberField";
export { Select } from "./components/ui/Select";
export type { SelectOption, SelectProps } from "./components/ui/Select";
export { SegmentedControl } from "./components/ui/SegmentedControl";
export type { SegmentedControlProps, SegmentedOption } from "./components/ui/SegmentedControl";
export { Slider } from "./components/ui/Slider";
export type { SliderProps } from "./components/ui/Slider";
export { Toggle } from "./components/ui/Toggle";
export type { ToggleProps } from "./components/ui/Toggle";
export { Badge, Meter, Pill, Spinner, StatusDot } from "./components/ui/Status";
export type { StatusDotTone, StatusTone } from "./components/ui/Status";

// NLE Layout
export { EditorShell } from "./components/EditorShell";
export type { EditorShellProps } from "./components/EditorShell";
export { NLEPreview } from "./components/nle/NLEPreview";
export { DEFAULT_SHORTCUT_SECTIONS } from "./player/components/studioShortcuts";
export type { ShortcutHint, ShortcutSection } from "./player/components/studioShortcuts";
export { CompositionBreadcrumb } from "./components/nle/CompositionBreadcrumb";
export type { CompositionLevel } from "./components/nle/CompositionBreadcrumb";

// Player (preview, timeline, playback controls)
export {
  Player,
  PlayerControls,
  Timeline,
  VideoThumbnail,
  CompositionThumbnail,
  useTimelinePlayer,
  usePlayerHandle,
  resolveIframe,
  usePlayerStore,
  liveTime,
  formatTime,
} from "./player";
export type {
  PlayerHandle,
  PlayerHandleElement,
  PlayerHandleListener,
  PlayerHandleTimeListener,
  TimelineElement,
  TimelineTimeRange,
} from "./player";
export {
  TimelineFrame,
  TimelineLanes,
  TimelineOverlays,
  TimelinePlayhead,
  TimelineRazorGuide,
  TimelineRuler,
  TimelineEmptyStatePart,
  TimelineEditPopover,
  TimelineClipMenu,
  TimelineGapMenu,
  TimelineKeyframeMenu,
  TimelineShortcutHint,
} from "./player/components/TimelineParts";
export { TimelineProvider, useTimelineContext } from "./player/components/TimelineProvider";
export type { TimelineTheme } from "./player/components/timelineTheme";

// Clip content thumbnails: used by a host rendering its own timeline lane.
export { AudioWaveform } from "./player/components/AudioWaveform";
export type { AudioWaveformProps } from "./player/components/AudioWaveform";
export { ImageThumbnail } from "./player/components/ImageThumbnail";
export type { ImageThumbnailProps } from "./player/components/ImageThumbnail";
export { useRenderClipContent } from "./hooks/useRenderClipContent";
export type { UseRenderClipContentOptions } from "./hooks/useRenderClipContent";
export type { ThumbnailPriority } from "./player/lib/thumbnailScheduler";
export type { TimelineClipRenderContext } from "./player/components/TimelineTypes";

// Host overlays: draw over the preview in composition coordinates (see EditorShellProps.gestureOverlay)
export { usePreviewCompositionRect } from "./components/editor/usePreviewCompositionRect";
export type { PreviewCompositionRect } from "./components/editor/usePreviewCompositionRect";
export {
  PreviewOverlayProvider,
  usePreviewOverlayContext,
} from "./components/editor/PreviewOverlayProvider";
export type {
  PreviewOverlayProviderProps,
  PreviewSnapPreferences,
} from "./components/editor/PreviewOverlayProvider";
export { PreviewGuides } from "./components/editor/PreviewGuides";
export { GridOverlay } from "./components/editor/GridOverlay";
export { SnapToolbar } from "./components/editor/SnapToolbar";
export { usePreviewGuidesStore } from "./components/editor/previewGuidesStore";

// Editor
export { SourceEditor } from "./components/editor/SourceEditor";
export { PropertyPanel } from "./components/editor/PropertyPanel";
export { FileTree } from "./components/editor/FileTree";

// App
export { StudioApp } from "./App";

// Picker agent prompts
export {
  buildPickerAgentPrompt,
  buildPickerAgentContextPreview,
} from "./components/editor/domEditingAgentPrompt";
export type { AgentPromptElementInfo } from "./components/editor/domEditingAgentPrompt";

// Render queue
export { RenderQueue } from "./components/renders/RenderQueue";
export type { RenderQueueProps } from "./components/renders/RenderQueue";
export type { CompositionDimensions } from "./components/renders/RenderSettingsForm";
export { useRenderQueue } from "./components/renders/useRenderQueue";
export type { FfmpegStatus } from "./components/renders/useFfmpegStatus";
export type {
  RenderJob,
  ResolutionPreset,
  StartRenderOptions,
} from "./components/renders/useRenderQueue";
export {
  getPersistedRenderSettings,
  persistRenderSettings,
} from "./components/renders/renderSettings";
export type { PersistedRenderSettings } from "./components/renders/renderSettings";

// Hooks
export { useElementPicker } from "./hooks/useElementPicker";
export type { PickedElement } from "./hooks/useElementPicker";

// Utilities
export { resolveSourceFile, applyPatch } from "./utils/sourcePatcher";
export type { PatchOperation } from "./utils/sourcePatcher";
export { parseStyleString, mergeStyleIntoTag, findElementBlock } from "./utils/htmlEditor";

// Timeline editing: Studio's own hand-edit path, undo/redo, the
// etag-guarded writer and the conflict banner, for a host mounting the
// timeline outside EditorShell.
export { usePersistentEditHistory } from "./hooks/usePersistentEditHistory";
export type { UsePersistentEditHistoryOptions } from "./hooks/usePersistentEditHistory";
export { useTimelineEditing } from "./hooks/useTimelineEditing";
export type { UseTimelineEditingOptions } from "./hooks/useTimelineEditingTypes";
// A host's own waitForPendingDomEditSaves must also call this, or undo/redo
// can race a write still in flight (see useTrackPendingTimelineEdit.ts).
export { flushStudioPendingEdits } from "./utils/studioPendingEdits";
export type { StudioPendingEditsDrainResult } from "./utils/studioPendingEdits";
export type {
  CanEditTimelineElement,
  TimelineEditPermission,
  TimelineEditOutcome,
} from "./hooks/timelineEditPermission";
export { useEditHistoryActions } from "./hooks/useEditHistoryActions";
export type {
  EditHistoryHandle,
  UseEditHistoryActionsOptions,
} from "./hooks/useEditHistoryActions";
export { useProjectFileWriter } from "./hooks/useProjectFileWriter";
export type { UseProjectFileWriterOptions } from "./hooks/useProjectFileWriter";
// A host's writeProjectFile throws this on a 409; catch it to know when
// to show ExternalFileConflictBanner.
export { StudioFileConflictError } from "./utils/studioSaveDiagnostics";
export { ExternalFileConflictBanner } from "./components/ExternalFileConflictBanner";
export type {
  ExternalFileChangeCoordinatorHandle,
  ExternalFileChangeBlockedState,
} from "./hooks/useExternalFileChangeCoordinator";
export { TimelinePane } from "./components/nle/TimelinePane";
export type { TimelinePaneProps } from "./components/nle/TimelinePane";
export { TimelineEditProvider } from "./contexts/TimelineEditContext";
export type { TimelineEditCallbacks } from "./player/components/timelineCallbacks";
export type { BlockedTimelineEditIntent } from "./player/components/timelineEditing";
export { TimelineToolbar } from "./components/TimelineToolbar";
export type { TimelineToolbarProps } from "./components/TimelineToolbar";
export { TimelineHistoryButtons } from "./components/TimelineHistoryButtons";
export type { TimelineHistoryButtonsProps } from "./components/TimelineHistoryButtons";
export { AudioMeterStrip } from "./components/nle/AudioMeterStrip";
export type { AudioMeterStripProps } from "./components/nle/AudioMeterStrip";
export { useClipboard } from "./hooks/useClipboard";
export type { UseClipboardOptions } from "./hooks/useClipboard";

export {
  playSeamTransitionLoop,
  type SeamTransitionFrameSource,
  type SeamTransitionLoopHandle,
  type SeamTransitionLoopOptions,
} from "@hyperframes/shader-transitions";
