import { useState, useRef, type CSSProperties } from "react";
import { CaretRight, X } from "@phosphor-icons/react";
import { useMountEffect } from "../hooks/useMountEffect";
import { type AgentModalAnchorPoint, clampNumber } from "../utils/studioHelpers";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Kbd } from "./ui/Kbd";
import { useDialogBehavior } from "./ui/useDialogBehavior";

const MODAL_WIDTH = 420;

function getAgentModalPositionStyle(
  anchorPoint: AgentModalAnchorPoint | null,
): CSSProperties | undefined {
  if (!anchorPoint || typeof window === "undefined") return undefined;

  const estimatedModalHeight = 240;
  const margin = 16;
  const left = clampNumber(
    anchorPoint.x,
    margin + MODAL_WIDTH / 2,
    window.innerWidth - margin - MODAL_WIDTH / 2,
  );
  const top = clampNumber(
    anchorPoint.y + 12,
    margin,
    window.innerHeight - margin - estimatedModalHeight,
  );

  return { left, top, transform: "translateX(-50%)" };
}

export interface AskAgentModalProps {
  selectionLabel: string;
  contextPreview?: string;
  anchorPoint?: AgentModalAnchorPoint | null;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}

/** Canvas menu › Ask Agent…: a floating card anchored at the element, in the prototype's `.float` chrome. */
export function AskAgentModal({
  selectionLabel,
  contextPreview,
  anchorPoint = null,
  onSubmit,
  onClose,
}: AskAgentModalProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const modalPositionStyle = getAgentModalPositionStyle(anchorPoint);
  // A dirty draft vetoes Escape/backdrop closes — a stray click must not
  // discard typed instructions. The X button and Copy still close directly.
  const { requestClose } = useDialogBehavior({
    open: true,
    onClose,
    containerRef,
    canClose: () => !value.trim(),
  });

  useMountEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  });

  const handleSubmit = () => {
    if (!value.trim()) return;
    onSubmit(value.trim());
  };

  return (
    <div
      className={
        anchorPoint
          ? "hf-backdrop-in fixed inset-0 z-100 bg-scrim"
          : "hf-backdrop-in fixed inset-0 z-100 flex items-center justify-center bg-scrim"
      }
      onClick={requestClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Copy prompt to AI agent"
        tabIndex={-1}
        className={`flex flex-col overflow-hidden rounded-lg border border-border bg-bg-1 text-sm text-fg shadow-pop outline-hidden ${
          anchorPoint ? "fixed" : ""
        }`}
        style={{ width: MODAL_WIDTH, ...modalPositionStyle }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-head shrink-0 items-center gap-1.5 border-b border-border-subtle pl-3 pr-1">
          <h3 className="m-0 shrink-0 text-sm font-semibold">Ask Agent</h3>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-3" title={selectionLabel}>
            {selectionLabel}
          </span>
          <IconButton
            size="sm"
            aria-label="Close"
            onClick={onClose}
            icon={<X size={12} aria-hidden />}
          />
        </div>
        <div className="grid gap-2 p-3">
          <textarea
            ref={inputRef}
            className="h-24 w-full resize-none rounded-sm border border-border bg-surface-1 px-2 py-[5px] text-sm leading-4 text-fg placeholder:text-fg-3 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            placeholder="Describe what you want to change…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
              // Escape is handled at the document level by useDialogBehavior,
              // guarded against discarding a dirty draft.
            }}
          />
          {contextPreview && (
            <details className="group">
              <summary className="flex cursor-pointer select-none list-none items-center gap-1 text-xs text-fg-3 hover:text-fg-2 [&::-webkit-details-marker]:hidden">
                <CaretRight
                  size={10}
                  aria-hidden
                  className="transition-transform duration-expand group-open:rotate-90"
                />
                Context included in prompt
              </summary>
              <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-border-subtle bg-bg-0 px-2.5 py-2 font-mono text-num leading-4 text-fg-3">
                {contextPreview}
              </pre>
            </details>
          )}
        </div>
        <div className="flex min-h-11 items-center gap-1.5 border-t border-border-subtle py-2 pl-3 pr-2.5">
          <span className="mr-auto flex items-center gap-1 text-xs text-fg-3">
            <Kbd>{navigator.platform.includes("Mac") ? "⌘↵" : "Ctrl+↵"}</Kbd> to copy
          </span>
          <Button variant="primary" size="sm" disabled={!value.trim()} onClick={handleSubmit}>
            Copy Prompt
          </Button>
        </div>
      </div>
    </div>
  );
}
