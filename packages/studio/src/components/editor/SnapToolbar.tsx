import { memo, useEffect } from "react";
import { CaretDown, FrameCorners, Path } from "@phosphor-icons/react";
import { usePlayerStore } from "../../player/store/playerStore";
import { useTranslation } from "../../i18n";
import { IconButton, Menu, MenuCheckboxItem, MenuSeparator, NumberField, Tooltip } from "../ui";
import { usePreviewGuidesStore, type PreviewSnapPreferences } from "./previewGuidesStore";

const GRID_SPACING_MIN = 10;
const GRID_SPACING_MAX = 500;

function setSnapPrefs(patch: Partial<PreviewSnapPreferences>) {
  usePreviewGuidesStore.getState().setSnapPrefs(patch);
}

/** S toggles snapping and G the grid, unless something else already claimed the key. */
function useSnapShortcutKeys(prefs: PreviewSnapPreferences) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (t instanceof HTMLElement && t.isContentEditable) return;
      if (t instanceof HTMLIFrameElement) return;
      if (e.key === "s" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setSnapPrefs({ snapEnabled: !prefs.snapEnabled });
      }
      if (e.key === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setSnapPrefs({ gridVisible: !prefs.gridVisible });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [prefs.gridVisible, prefs.snapEnabled]);
}

/**
 * The viewer head's canvas tools: safe areas with a Guides & snapping menu
 * (rulers, grid, grid spacing, snapping) and, while the selection can take a
 * path, the motion-destination toggle.
 */
export const SnapToolbar = memo(function SnapToolbar() {
  const { t } = useTranslation();
  const prefs = usePreviewGuidesStore((s) => s.snapPrefs);
  const rulerVisible = usePreviewGuidesStore((s) => s.rulerVisible);
  const safeMarginsVisible = usePreviewGuidesStore((s) => s.safeMarginsVisible);
  const toggleGuide = usePreviewGuidesStore((s) => s.toggle);
  // Motion-path "set destination" toggle — shown only when the selected element
  // can take a path; arms a single canvas click to place it (MotionPathOverlay).
  const motionPathCreateAvailable = usePlayerStore((s) => s.motionPathCreateAvailable);
  const motionPathArmed = usePlayerStore((s) => s.motionPathArmed);
  const setMotionPathArmed = usePlayerStore((s) => s.setMotionPathArmed);
  useSnapShortcutKeys(prefs);

  return (
    <>
      <span className="inline-flex shrink-0" role="group" aria-label={t("editor.guides.group")}>
        <Tooltip
          label={
            safeMarginsVisible ? t("editor.guides.hideSafeAreas") : t("editor.guides.showSafeAreas")
          }
        >
          <IconButton
            size="sm"
            className="rounded-r-none"
            aria-label={t("editor.guides.toggleSafeMargins")}
            aria-pressed={safeMarginsVisible}
            icon={<FrameCorners size={14} weight={safeMarginsVisible ? "fill" : "regular"} />}
            onClick={() => toggleGuide("safeMarginsVisible")}
          />
        </Tooltip>
        <Menu
          align="end"
          aria-label={t("editor.guides.menu")}
          className="min-w-[236px]"
          trigger={
            <IconButton
              size="sm"
              className="w-3.5 rounded-l-none"
              aria-label={t("editor.guides.menuOptions")}
              icon={<CaretDown size={10} weight="bold" />}
            />
          }
        >
          <MenuCheckboxItem
            checked={safeMarginsVisible}
            onCheckedChange={() => toggleGuide("safeMarginsVisible")}
          >
            {t("editor.guides.safeAreas")}
          </MenuCheckboxItem>
          <MenuCheckboxItem
            aria-label={t("editor.guides.toggleRuler")}
            checked={rulerVisible}
            onCheckedChange={() => toggleGuide("rulerVisible")}
          >
            {t("editor.guides.rulers")}
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={prefs.gridVisible}
            onCheckedChange={() => setSnapPrefs({ gridVisible: !prefs.gridVisible })}
          >
            {t("editor.guides.grid")}
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={prefs.snapToGrid}
            onCheckedChange={() => setSnapPrefs({ snapToGrid: !prefs.snapToGrid })}
          >
            {t("editor.guides.snapToGrid")}
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={prefs.snapEnabled}
            onCheckedChange={() => setSnapPrefs({ snapEnabled: !prefs.snapEnabled })}
          >
            {t("editor.guides.snapToElements")}
          </MenuCheckboxItem>
          <MenuSeparator />
          <div
            className="flex h-ctl items-center justify-between gap-2 pr-1 pl-2 text-sm text-fg"
            // Keeps digits typed in the spacing field away from the menu's typeahead.
            onKeyDown={(event) => {
              if (event.key !== "Escape") event.stopPropagation();
            }}
          >
            <span>{t("editor.guides.gridSpacing")}</span>
            <NumberField
              label={t("editor.guides.gridSpacingLabel")}
              className="w-[76px]"
              value={prefs.gridSpacing}
              min={GRID_SPACING_MIN}
              max={GRID_SPACING_MAX}
              step={10}
              unit="px"
              onCommit={(next) => {
                if (next >= GRID_SPACING_MIN && next <= GRID_SPACING_MAX) {
                  setSnapPrefs({ gridSpacing: next });
                }
              }}
            />
          </div>
        </Menu>
      </span>
      {motionPathCreateAvailable && (
        <Tooltip
          label={motionPathArmed ? t("editor.guides.motionArmed") : t("editor.guides.motionSet")}
        >
          <IconButton
            size="sm"
            aria-label={t("editor.guides.motionSet")}
            aria-pressed={motionPathArmed}
            icon={<Path size={14} weight={motionPathArmed ? "bold" : "regular"} />}
            onClick={() => setMotionPathArmed(!motionPathArmed)}
          />
        </Tooltip>
      )}
    </>
  );
});
