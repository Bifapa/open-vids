import { memo, useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Check, DotsThree, Info, Plus, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { Trans, useTranslation, type TranslationKey } from "../../i18n";
import { SearchInput } from "../ui/SearchInput";
import { IconButton } from "../ui/IconButton";
import { Menu, MenuItem } from "../ui/Menu";
import { Spinner } from "../ui/Status";
import { cn } from "../ui/cn";
import { PromptPreviewModal } from "./PromptPreviewModal";
import { useBlockCatalog } from "../../hooks/useBlockCatalog";
import { BLOCK_CATEGORIES, type BlockCategory } from "../../utils/blockCategories";
import { usePlayerStore } from "../../player";
import { formatTime } from "../../player/lib/time";
import { useStudioShellContext } from "../../contexts/StudioContext";
import { useMediaLoadSlot } from "../../hooks/useMediaLoadSlot";
import { TIMELINE_BLOCK_MIME } from "../../utils/timelineAssetDrop";

/** The catalog key of each registry category's name. */
const CATEGORY_LABEL_KEYS = {
  captions: "sidebar.blocks.category.captions",
  "code-animation": "sidebar.blocks.category.code-animation",
  vfx: "sidebar.blocks.category.vfx",
  transitions: "sidebar.blocks.category.transitions",
  effects: "sidebar.blocks.category.effects",
  "text-effects": "sidebar.blocks.category.text-effects",
  social: "sidebar.blocks.category.social",
  data: "sidebar.blocks.category.data",
  scenes: "sidebar.blocks.category.scenes",
} as const satisfies Record<BlockCategory, TranslationKey>;

export interface BlockPreviewInfo {
  videoUrl?: string;
  posterUrl?: string;
  title: string;
}

interface BlocksTabProps {
  onAddBlock?: (blockName: string) => void | Promise<void>;
  onPreviewBlock?: (preview: BlockPreviewInfo | null) => void;
}

export const BlocksTab = memo(function BlocksTab({ onAddBlock, onPreviewBlock }: BlocksTabProps) {
  const { t } = useTranslation();
  const { loading, error, search, setSearch, category, setCategory, filteredBlocks } =
    useBlockCatalog();
  const [promptModal, setPromptModal] = useState<{ title: string; prompt: string } | null>(null);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-fg-3">
        <Spinner size="sm" />
        {t("sidebar.blocks.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-error">
        {error}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-0">
      <div className="shrink-0 px-2 pb-1.5 pt-2">
        <SearchInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("sidebar.blocks.searchPlaceholder")}
          aria-label={t("sidebar.blocks.searchLabel")}
        />
      </div>

      {/* Category chips wrap like the prototype's, so every category stays in view. */}
      <div className="flex shrink-0 flex-wrap gap-1 px-2 pb-1.5">
        <CategoryChip
          label={t("common.all")}
          active={category === null}
          onClick={() => setCategory(null)}
        />
        {BLOCK_CATEGORIES.map((cat) => (
          <CategoryChip
            key={cat.id}
            label={t(CATEGORY_LABEL_KEYS[cat.id])}
            active={category === cat.id}
            onClick={() => setCategory(category === cat.id ? null : cat.id)}
          />
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border-subtle px-2 pb-2 pt-2">
        {category === "vfx" && (
          <p className="m-0 mb-2 grid grid-cols-[14px_minmax(0,1fr)] gap-1.5 text-xs leading-[15px] text-fg-3">
            <Info size={12} className="mt-px" aria-hidden />
            <span>
              <Trans
                i18nKey="sidebar.blocks.vfxNote"
                components={{ flag: <span className="font-mono text-num text-fg-2" /> }}
              />
            </span>
          </p>
        )}
        {filteredBlocks.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-fg-3">
            {t("sidebar.blocks.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-x-1 gap-y-1.5">
            {filteredBlocks.map((block) => {
              const dur = "duration" in block ? (block.duration as number) : undefined;
              return (
                <BlockCard
                  key={block.name}
                  name={block.name}
                  title={block.title}
                  description={block.description}
                  blockType={block.type}
                  duration={dur}
                  category={block.category}
                  tags={block.tags}
                  posterUrl={block.preview?.poster}
                  videoUrl={block.preview?.video}
                  onPreview={onPreviewBlock}
                  onShowPrompt={setPromptModal}
                  onAdd={
                    block.category === "vfx" ||
                    block.category === "social" ||
                    block.category === "scenes"
                      ? () => onAddBlock?.(block.name)
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>
      {promptModal &&
        createPortal(
          <PromptPreviewModal
            title={promptModal.title}
            prompt={promptModal.prompt}
            onClose={() => setPromptModal(null)}
          />,
          document.body,
        )}
    </div>
  );
});

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-5 shrink-0 whitespace-nowrap rounded-pill border px-[7px] text-xs font-medium transition-colors duration-hover",
        "outline-hidden focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        active
          ? "border-border-strong bg-surface-3 text-fg"
          : "border-border bg-transparent text-fg-2 hover:bg-surface-2 hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}
interface CompositionContext {
  currentTime: number;
  activeCompPath: string | null;
  elements: Array<{
    id: string;
    start: number;
    duration: number;
    track: number;
    label?: string;
    compositionSrc?: string;
  }>;
  compositionDimensions?: { width: number; height: number };
}

function formatCompositionContext(ctx: CompositionContext): string {
  const lines: string[] = [
    `Playback time: ${formatTime(ctx.currentTime)}`,
    `Active composition: ${ctx.activeCompPath || "index.html"}`,
  ];
  if (ctx.compositionDimensions) {
    lines.push(
      `Dimensions: ${ctx.compositionDimensions.width}x${ctx.compositionDimensions.height}`,
    );
  }
  const visibleNow = ctx.elements.filter(
    (el) => ctx.currentTime >= el.start && ctx.currentTime < el.start + el.duration,
  );
  if (visibleNow.length > 0) {
    lines.push(
      "",
      `Elements visible at ${formatTime(ctx.currentTime)}:`,
      ...visibleNow.map(
        (el) =>
          `- ${el.label || el.id} (track ${el.track}, ${formatTime(el.start)}–${formatTime(el.start + el.duration)}${el.compositionSrc ? `, src: ${el.compositionSrc}` : ""})`,
      ),
    );
  }
  const maxZ = ctx.elements.length > 0 ? Math.max(...ctx.elements.map((_, i) => i + 1)) : 0;
  lines.push("", `Highest track index: ${maxZ}`);
  return lines.join("\n");
}

function buildAgentPrompt(
  title: string,
  name: string,
  description: string,
  category: BlockCategory,
  blockType: string,
  context: CompositionContext,
): string {
  const isComponent = blockType === "hyperframes:component";
  const kind = isComponent ? "component" : "block";
  const compositionInfo = formatCompositionContext(context);

  const categoryPrompts: Record<string, string> = {
    captions: [
      `Using /hyperframes, add the "${title}" caption style (registry: ${name}) to my composition.`,
      `${description}`,
      `Transcribe the audio with /media-use, then wire the transcript into this caption component. Match the font colors and animation timing to my composition's design tokens. Place it as an overlay above the main content with the highest z-index.`,
    ].join("\n\n"),
    vfx: [
      `Using /hyperframes, add the "${title}" VFX (registry: ${name}) as a full-screen overlay on my composition.`,
      `${description}`,
      `This is a WebGL effect that requires chrome://flags/#html-in-canvas. Layer it on top of all content, adjust the shader uniforms and color palette to complement my scene, and set the duration to match the composition length.`,
    ].join("\n\n"),
    transitions: [
      `Using /hyperframes, add the "${title}" transition (registry: ${name}) between my scenes.`,
      `${description}`,
      `Place this transition at the cut point between the current scene and the next. Set the duration to 0.5–1s, position it at the scene boundary on the timeline, and make sure the z-index is above both scenes. Adjust colors to match my palette.`,
    ].join("\n\n"),
    effects: [
      `Using /hyperframes, add the "${title}" effect (registry: ${name}) as an overlay on my composition.`,
      `${description}`,
      `Layer this on top of the current content. Adjust the opacity, colors, and animation timing to enhance the scene without overwhelming the main content.`,
    ].join("\n\n"),
    social: [
      `Using /hyperframes, add the "${title}" template (registry: ${name}) to my composition.`,
      `${description}`,
      `Replace the placeholder text, handle, and avatar with my actual content. Match the typography and colors to my brand. Adjust timing so the elements animate in sync with the voiceover.`,
    ].join("\n\n"),
    data: [
      `Using /hyperframes, add the "${title}" visualization (registry: ${name}) to my composition.`,
      `${description}`,
      `Replace the placeholder data with my actual values and labels. Adjust the color scale, animation stagger timing, and typography to match my composition's design system. Size it to fit the current viewport.`,
    ].join("\n\n"),
    scenes: [
      `Using /hyperframes, add the "${title}" scene (registry: ${name}) to my composition.`,
      `${description}`,
      `Replace all placeholder text, images, and content with my actual material. Match fonts, colors, and layout to my existing design tokens. Set the timeline position and duration to fit the narrative flow.`,
    ].join("\n\n"),
  };

  const instruction =
    categoryPrompts[category] ??
    [
      `Using /hyperframes, add the "${title}" ${kind} (registry: ${name}) to my composition.`,
      `${description}`,
      `Customize it to match my composition's design and timeline.`,
    ].join("\n\n");

  return [instruction, "", "## Current composition state", "", compositionInfo].join("\n");
}

function BlockCard({
  name,
  title,
  description,
  blockType,
  duration,
  category,
  tags,
  posterUrl,
  videoUrl,
  onAdd,
  onShowPrompt,
  onPreview,
}: {
  name: string;
  title: string;
  description: string;
  blockType: string;
  duration?: number;
  category: BlockCategory;
  tags?: string[];
  posterUrl?: string;
  videoUrl?: string;
  onAdd?: () => void | Promise<void>;
  onShowPrompt?: (info: { title: string; prompt: string }) => void;
  onPreview?: (preview: BlockPreviewInfo | null) => void;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [addState, setAddState] = useState<"idle" | "adding" | "added" | "failed">("idle");
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needsWebGL = tags?.includes("html-in-canvas") || tags?.includes("webgl");

  const handleEnter = useCallback(() => {
    hoverTimer.current = setTimeout(() => {
      setHovered(true);
      onPreview?.({ videoUrl, posterUrl, title });
    }, 300);
  }, [onPreview, videoUrl, posterUrl, title]);

  const handleLeave = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHovered(false);
    onPreview?.(null);
  }, [onPreview]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, []);

  const handleAdd = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (addState !== "idle" || !onAdd) return;
      setAddState("adding");
      try {
        // Confirm only what actually happened — no optimistic "Added!".
        await onAdd();
        setAddState("added");
      } catch {
        setAddState("failed");
      }
      setTimeout(() => setAddState("idle"), 1500);
    },
    [onAdd, addState],
  );

  // The non-hover metadata video is a last-resort thumbnail; its load takes a
  // shared slot so a long catalog never opens dozens of media assets at once.
  const metadataSlot = useMediaLoadSlot(!hovered && !posterUrl && !!videoUrl);

  const { activeCompPath, compositionDimensions } = useStudioShellContext();

  const handleShowPrompt = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const state = usePlayerStore.getState();
      const context: CompositionContext = {
        currentTime: state.currentTime,
        activeCompPath,
        elements: state.elements.map((el) => ({
          id: el.id,
          start: el.start,
          duration: el.duration,
          track: el.track,
          label: el.label,
          compositionSrc: el.compositionSrc,
        })),
        compositionDimensions: compositionDimensions ?? undefined,
      };
      const prompt = buildAgentPrompt(title, name, description, category, blockType, context);
      onShowPrompt?.({ title, prompt });
    },
    [
      title,
      name,
      description,
      category,
      blockType,
      activeCompPath,
      compositionDimensions,
      onShowPrompt,
    ],
  );

  const known = BLOCK_CATEGORIES.some((c) => c.id === category);
  const categoryLabel = known ? t(CATEGORY_LABEL_KEYS[category]) : category;
  const meta = [categoryLabel];
  if (duration != null) meta.push(t("sidebar.blocks.durationSeconds", { seconds: duration }));
  if (needsWebGL) meta.push("WebGL");
  const addLabel =
    addState === "adding"
      ? t("sidebar.blocks.adding")
      : addState === "added"
        ? t("sidebar.blocks.added")
        : addState === "failed"
          ? t("sidebar.blocks.addFailed")
          : t("sidebar.blocks.addHint");

  return (
    <div
      className="group/card relative flex min-w-0 cursor-grab flex-col gap-[3px] rounded-md px-[3px] pb-[5px] pt-[3px] transition-colors duration-hover hover:bg-surface-1 focus-within:bg-surface-1"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(TIMELINE_BLOCK_MIME, JSON.stringify({ name }));
        e.dataTransfer.setData("text/plain", name);
        handleLeave(); // cancel the hover-preview timer so it doesn't fire mid-drag
      }}
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-xs bg-bg-1 shadow-[inset_0_0_0_1px_var(--color-border-subtle)]">
        {hovered && videoUrl ? (
          <video
            src={videoUrl}
            autoPlay
            muted
            loop
            playsInline
            className="h-full w-full object-cover"
          />
        ) : posterUrl ? (
          <img src={posterUrl} alt={title} loading="lazy" className="h-full w-full object-cover" />
        ) : videoUrl && metadataSlot.granted ? (
          <video
            src={videoUrl}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={metadataSlot.release}
            onError={metadataSlot.release}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-md font-bold tracking-[-0.01em] text-fg-3">
            {categoryLabel}
          </div>
        )}

        {/* Hover actions, also revealed while a control inside has focus. */}
        <div className="absolute right-[3px] top-[3px] opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100 has-[[data-popup-open]]:opacity-100">
          <Menu
            side="bottom"
            align="end"
            aria-label={t("sidebar.blocks.menuLabel", { title })}
            trigger={
              <IconButton
                size="xs"
                aria-label={t("sidebar.blocks.actionsFor", { title })}
                icon={<DotsThree size={14} weight="bold" aria-hidden />}
                className="bg-on-media-bg text-on-media hover:bg-on-media-bg hover:text-on-media"
              />
            }
          >
            {onAdd && (
              <MenuItem icon={<Plus size={14} aria-hidden />} onClick={handleAdd}>
                {t("sidebar.blocks.addAtPlayhead")}
              </MenuItem>
            )}
            <MenuItem icon={<Sparkle size={14} aria-hidden />} onClick={handleShowPrompt}>
              {t("sidebar.blocks.copyPrompt")}
            </MenuItem>
          </Menu>
        </div>
        {onAdd && (
          <button
            type="button"
            onClick={handleAdd}
            title={addLabel}
            aria-label={addLabel}
            className={cn(
              "absolute bottom-[3px] right-[3px] flex size-5 items-center justify-center rounded-sm transition-[opacity,background-color]",
              "outline-hidden focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
              addState === "idle"
                ? "bg-on-media-bg text-on-media opacity-0 hover:bg-accent hover:text-accent-ink group-hover/card:opacity-100 group-focus-within/card:opacity-100"
                : addState === "failed"
                  ? "bg-error text-on-media opacity-100"
                  : "bg-accent text-accent-ink opacity-100",
            )}
          >
            {addState === "adding" ? (
              <Spinner size="sm" />
            ) : addState === "added" ? (
              <Check size={12} weight="bold" aria-hidden />
            ) : addState === "failed" ? (
              <WarningCircle size={12} weight="bold" aria-hidden />
            ) : (
              <Plus size={12} weight="bold" aria-hidden />
            )}
          </button>
        )}
      </div>

      <div className="truncate px-px text-xs leading-[14px] text-fg-2 group-hover/card:text-fg">
        {title}
      </div>
      <div className="truncate px-px text-2xs leading-3 text-fg-3">{meta.join(" · ")}</div>
    </div>
  );
}
