import { useState } from "react";
import { Coins } from "@phosphor-icons/react";
import { useTranslation } from "../../i18n";
import { IconButton, Popover, Tooltip } from "../ui";
import { UsagePanel } from "./UsagePanel";
import type { UsagePeriod } from "./usagePeriod";
import { useProjectUsage } from "./useProjectUsage";

/**
 * The titlebar's "Agent costs": an icon-only button whose popover (under it, ~320 px, the editor stays lit) shows what
 * the project's agents used. It closes on an outside click, on Esc and on a second press of the button (Base UI's
 * popover); the figures are read only while it is open.
 */
export function UsageButton({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<UsagePeriod>("all");
  const usage = useProjectUsage(projectId, period, open);
  return (
    <Tooltip label={t("shell.usage.button")} side="bottom">
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        aria-label={t("shell.usage.title")}
        className="w-80 max-w-[calc(100vw-16px)]"
        trigger={
          <IconButton
            aria-label={t("shell.usage.button")}
            data-testid="header-usage"
            icon={<Coins size={14} />}
          />
        }
      >
        <UsagePanel usage={usage} period={period} onPeriodChange={setPeriod} />
      </Popover>
    </Tooltip>
  );
}
