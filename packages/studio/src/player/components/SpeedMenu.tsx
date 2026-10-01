import { memo } from "react";
import { CaretDown } from "@phosphor-icons/react";
import {
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  buttonBase,
  buttonSizes,
  buttonVariants,
  cn,
} from "../../components/ui";
import { formatNumber, useTranslation } from "../../i18n";

const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2] as const;

interface SpeedMenuProps {
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  disabled: boolean;
}

export const SpeedMenu = memo(function SpeedMenu({
  playbackRate,
  setPlaybackRate,
  disabled,
}: SpeedMenuProps) {
  const { t } = useTranslation();
  return (
    <Menu
      side="top"
      align="end"
      aria-label={t("player.speed.options")}
      className="min-w-[120px]"
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={t("player.speed.label")}
          className={cn(
            buttonBase,
            buttonVariants.ghost,
            buttonSizes.sm,
            "min-w-10 gap-1 pr-1.5 pl-2 font-normal tabular-nums data-[popup-open]:bg-surface-2 data-[popup-open]:text-fg",
            playbackRate !== 1 && "text-fg",
          )}
        >
          {formatNumber(playbackRate)}×
          <CaretDown size={10} weight="bold" aria-hidden="true" />
        </button>
      }
    >
      <MenuRadioGroup
        value={playbackRate}
        onValueChange={(value) => {
          if (typeof value === "number") setPlaybackRate(value);
        }}
      >
        {SPEED_OPTIONS.map((rate) => (
          <MenuRadioItem key={rate} value={rate}>
            {rate === 1
              ? t("player.speed.normal", { rate: formatNumber(rate) })
              : `${formatNumber(rate)}×`}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
});
