import { useEffect, useState } from "react";
import { Palette } from "@phosphor-icons/react";
import { IconButton, Popover, Tooltip } from "../components/ui";
import { isBetaFeatureEnabled } from "../betaFeatures";
import { useTranslation } from "../i18n";
import { useDesignStore, useDesignStoreApi } from "./designContext";
import { DesignPanel } from "./DesignPanel";

/**
 * The titlebar's design-system entry (beta): an icon-only button whose popover (under it, ~360 px, the editor stays
 * lit) shows the project's system and the library. It closes on an outside click, on Esc and on a second press of
 * the button (Base UI's popover); the state is read again each time it opens. A dot on the icon says the library
 * holds a newer version of the attached system — nothing updates until the user presses the button inside.
 */
export function DesignButton({ projectId }: { projectId: string }) {
  if (!isBetaFeatureEnabled("designSystems")) return null;
  return <DesignButtonBody projectId={projectId} />;
}

function DesignButtonBody({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const store = useDesignStoreApi();
  const [open, setOpen] = useState(false);
  const updateAvailable = useDesignStore((state) => state.project.state?.updateAvailable === true);
  useEffect(() => {
    void store.getState().open(projectId);
  }, [store, projectId]);

  const label = updateAvailable ? t("studio.design.button.update") : t("studio.design.button");
  return (
    <Tooltip label={label} side="bottom">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) void store.getState().refresh();
        }}
        align="end"
        aria-label={t("studio.design.title")}
        className="w-[360px] max-w-[calc(100vw-16px)]"
        trigger={
          <IconButton
            aria-label={label}
            data-testid="header-design"
            data-update={updateAvailable || undefined}
            icon={
              <span className="relative inline-flex">
                <Palette size={14} />
                {updateAvailable ? (
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent"
                  />
                ) : null}
              </span>
            }
          />
        }
      >
        <DesignPanel projectId={projectId} onDone={() => setOpen(false)} />
      </Popover>
    </Tooltip>
  );
}
