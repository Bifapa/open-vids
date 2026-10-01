import { Film } from "../../icons/SystemIcons";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";
import { useTranslation } from "../../i18n";
import { usePlayerStore } from "../../player";
import { STUDIO_PREVIEW_FPS, formatTime } from "../../player/lib/time";

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * What the inspector shows with nothing selected: the open composition's own
 * header and its facts (the prototype's composition inspector). Read-only; every
 * value comes from state the viewer and timeline already hold.
 */
export function InspectorCompositionFacts() {
  const { t } = useTranslation();
  const shell = useStudioShellContextOptional();
  const duration = usePlayerStore((state) => state.duration);
  const elements = usePlayerStore((state) => state.elements);
  if (!shell) return null;
  const path = shell.activeCompPath ?? "index.html";
  const file = path.split("/").pop() ?? path;
  const name = file.replace(/\.html?$/i, "") || file;
  const dims = shell.compositionDimensions;
  const divisor = dims ? greatestCommonDivisor(dims.width, dims.height) || 1 : 1;
  const trackCount = new Set(elements.map((element) => element.track)).size;
  const facts: Array<[string, string]> = [
    [t("inspector.composition.resolution"), dims ? `${dims.width} × ${dims.height}` : "—"],
    [
      t("inspector.composition.aspect"),
      dims ? `${dims.width / divisor}:${dims.height / divisor}` : "—",
    ],
    [
      t("inspector.composition.frameRate"),
      t("inspector.composition.fps", { fps: STUDIO_PREVIEW_FPS }),
    ],
    [t("inspector.composition.duration"), duration > 0 ? formatTime(duration) : "—"],
    [
      t("inspector.composition.clips"),
      t("inspector.composition.clipsValue", { count: elements.length, tracks: trackCount }),
    ],
  ];
  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle px-3 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-k-video-l bg-k-video-h text-clip-ink">
          <Film size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-md font-semibold text-fg">{name}</div>
          <div className="mt-px truncate font-mono text-num text-fg-3">
            {t("inspector.composition.path", { path })}
          </div>
        </div>
      </div>
      <section className="border-b border-border-subtle" data-testid="inspector-composition-facts">
        <h3 className="m-0 flex h-[30px] items-center pl-3 pr-2.5 text-sm font-semibold text-fg">
          {t("inspector.composition.title")}
        </h3>
        <dl className="m-0 grid grid-cols-[minmax(72px,max-content)_minmax(0,1fr)] gap-x-2 gap-y-1.5 px-3 pb-3 pt-0.5 text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-fg-3">{label}</dt>
              <dd className="m-0 truncate tabular-nums text-fg">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
