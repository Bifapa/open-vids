import { memo } from "react";

export type DiamondState = "active" | "inactive" | "ghost";

interface KeyframeDiamondProps {
  state: DiamondState;
  onClick: () => void;
  title?: string;
  size?: number;
  isHold?: boolean;
}

export const KeyframeDiamond = memo(function KeyframeDiamond({
  state,
  onClick,
  title,
  size = 10,
  isHold = false,
}: KeyframeDiamondProps) {
  const isFilled = state === "active";
  const opacity = state === "ghost" ? 0.6 : 1;
  const tone = state === "active" ? "text-fg" : state === "inactive" ? "text-fg-2" : "text-fg-3";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`relative shrink-0 rounded-xs p-0.5 transition-colors hover:bg-surface-2 hover:text-fg hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent before:absolute before:-inset-1.5 before:content-[''] ${tone}`}
      style={{ opacity }}
      title={title}
      aria-label={title}
      aria-pressed={state === "active"}
    >
      <svg width={size} height={size} viewBox="0 0 10 10">
        {isHold ? (
          <rect
            x="2"
            y="2"
            width="6"
            height="6"
            rx="0.5"
            fill={isFilled ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.2"
          />
        ) : (
          <rect
            x="5"
            y="0.7"
            width="6"
            height="6"
            rx="1"
            transform="rotate(45 5 0.7)"
            fill={isFilled ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.2"
          />
        )}
      </svg>
    </button>
  );
});
