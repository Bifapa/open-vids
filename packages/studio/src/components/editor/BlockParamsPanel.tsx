import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { BlockParam } from "@hyperframes/core/registry";
import { useFileManagerContextOptional } from "../../contexts/FileManagerContext";
import { useStudioPlaybackContext } from "../../contexts/StudioContext";
import { serializeStudioFileMutation } from "../../utils/studioFileMutationCoordinator";
import { Check } from "../../icons/SystemIcons";
import { fieldBase, fieldSizes } from "../ui/Input";
import {
  INSP_MINI_BUTTON,
  INSP_ROW,
  INSP_ROW_LABEL,
  INSP_SELECT,
  rangeFillStyle,
} from "./inspectorStyles";

/** A 24px inspector field. */
const BLOCK_FIELD = `${fieldBase} ${fieldSizes.sm} w-full min-w-0 text-fg`;

interface BlockParamsPanelProps {
  blockName: string;
  blockTitle: string;
  params: BlockParam[];
  compositionPath: string;
  onClose: () => void;
}

type CommitState = { tone: "idle" | "saving" | "saved" | "error"; message?: string };

export const BlockParamsPanel = memo(function BlockParamsPanel({
  blockTitle,
  params,
  compositionPath,
  onClose,
}: BlockParamsPanelProps) {
  const fileManager = useFileManagerContextOptional();
  const { setRefreshKey } = useStudioPlaybackContext();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const p of params) {
      initial[p.key] = p.default;
    }
    return initial;
  });
  // Last value actually written to the block file per param — the literal we
  // substitute when the next commit rewrites the file.
  const appliedRef = useRef<Record<string, string>>(
    Object.fromEntries(params.map((p) => [p.key, p.default])),
  );
  const [commitState, setCommitState] = useState<CommitState>({ tone: "idle" });
  // Per-param debounce timers: a single shared timer would let a second
  // param's edit silently cancel the first param's pending commit.
  const commitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const commitParamNow = useCallback(
    async (key: string, nextValue: string) => {
      if (!fileManager) return;
      const previous = appliedRef.current[key];
      if (previous === undefined || previous === nextValue || !nextValue.trim()) return;
      setCommitState({ tone: "saving" });
      try {
        const content = await fileManager.readProjectFile(compositionPath);
        // Token-boundary match so "#0c0c0c" never rewrites part of "#0c0c0cff".
        const matcher = new RegExp(
          `(?<![-\\w#])${previous.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![-\\w])`,
          "g",
        );
        const matches = content.match(matcher)?.length ?? 0;
        if (matches === 0) {
          setCommitState({
            tone: "error",
            message: `Couldn't find the current value in ${compositionPath} — it may have been edited by hand.`,
          });
          return;
        }
        // The panel maps a param to a bare literal, with no per-occurrence
        // binding metadata. At the string level it cannot tell "both of these
        // belong to this param" from "one is unrelated adjacent content" (a
        // sibling block, a decoration, a comment). A blind replace of a literal
        // that appears more than once could silently mutate that unrelated
        // content — so refuse and tell the user to disambiguate by hand. Only a
        // unique single occurrence is safe to rewrite automatically.
        if (matches > 1) {
          setCommitState({
            tone: "error",
            message: `"${previous}" appears ${matches}× in ${compositionPath} — the panel can't tell which one belongs to this parameter, so it won't risk changing unrelated content. Edit the file directly to disambiguate.`,
          });
          return;
        }
        await fileManager.writeProjectFile(
          compositionPath,
          content.replace(matcher, nextValue),
          content,
        );
        appliedRef.current[key] = nextValue;
        setCommitState({ tone: "saved" });
        setRefreshKey((k) => k + 1);
      } catch {
        setCommitState({ tone: "error", message: "Couldn't save the block file. Retry?" });
      }
    },
    [fileManager, compositionPath, setRefreshKey],
  );

  // Commits join the file's queue: two read-modify-writes of one file must not interleave.
  const commitParam = useCallback(
    (key: string, nextValue: string) =>
      fileManager
        ? serializeStudioFileMutation(fileManager.writeProjectFile, compositionPath, () =>
            commitParamNow(key, nextValue),
          )
        : Promise.resolve(),
    [commitParamNow, compositionPath, fileManager],
  );

  const handleChange = useCallback(
    (key: string, value: string) => {
      setValues((prev) => ({ ...prev, [key]: value }));
      const timers = commitTimersRef.current;
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          void commitParam(key, value);
        }, 300),
      );
    },
    [commitParam],
  );

  // Flush (not discard) pending commits on unmount so closing the panel
  // within the debounce window doesn't silently drop the last edit.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    for (const [key, timer] of commitTimersRef.current) {
      clearTimeout(timer);
      const value = values[key];
      if (value !== undefined) void commitParam(key, value);
    }
    commitTimersRef.current.clear();
  };
  useEffect(() => () => flushRef.current(), []);

  return (
    <div className="flex h-full flex-col bg-bg-0">
      <div className="flex h-[30px] shrink-0 items-center justify-between gap-2 border-b border-border-subtle pr-1.5 pl-3">
        <div className="truncate text-sm font-semibold text-fg">{blockTitle}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close block parameters"
          className={INSP_MINI_BUTTON}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <div className="grid flex-1 content-start gap-1.5 overflow-y-auto p-3">
        <div className="flex min-w-0 items-baseline justify-between gap-1.5 text-xs font-semibold text-fg-2">
          Block Parameters
          {commitState.tone === "saving" && (
            <span className="font-normal text-fg-3" role="status">
              Saving…
            </span>
          )}
          {commitState.tone === "saved" && (
            <span
              className="inline-flex min-w-0 items-center gap-1 truncate font-normal text-fg-3"
              role="status"
              title={`Saved to ${compositionPath}`}
            >
              <Check size={10} className="shrink-0 text-success" aria-hidden="true" />
              Saved
            </span>
          )}
        </div>
        {params.length === 0 && (
          <div className="text-sm text-fg-3">This block has no editable parameters.</div>
        )}
        {!fileManager && params.length > 0 && (
          <div className="rounded-sm border border-warning/35 bg-warning-soft px-2 py-1.5 text-xs text-fg-2">
            Block params can't be edited here — no project file access.
          </div>
        )}
        {params.map((param) => (
          <ParamControl
            key={param.key}
            param={param}
            value={values[param.key] ?? param.default}
            disabled={!fileManager}
            onChange={(v) => handleChange(param.key, v)}
          />
        ))}
        {commitState.tone === "error" && (
          <div className="text-xs text-error" role="alert">
            {commitState.message}
          </div>
        )}
      </div>
    </div>
  );
});

function ParamControl({
  param,
  value,
  disabled,
  onChange,
}: {
  param: BlockParam;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className={INSP_ROW}>
      <label className={INSP_ROW_LABEL}>{param.label}</label>

      {param.type === "color" && (
        <div className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)] items-center gap-1.5">
          <input
            type="color"
            value={value}
            disabled={disabled}
            aria-label={`${param.label} color`}
            onChange={(e) => onChange(e.target.value)}
            className="size-6 cursor-pointer rounded-sm border border-border bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <input
            type="text"
            value={value}
            disabled={disabled}
            aria-label={`${param.label} value`}
            onChange={(e) => onChange(e.target.value)}
            className={`${BLOCK_FIELD} font-mono text-num`}
          />
        </div>
      )}

      {param.type === "number" && (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_56px] items-center gap-1.5">
          <input
            type="range"
            min={param.min ?? 0}
            max={param.max ?? 100}
            step={param.step ?? 1}
            value={value}
            disabled={disabled}
            aria-label={param.label}
            onChange={(e) => onChange(e.target.value)}
            className="hf-insp-rng"
            style={rangeFillStyle(Number(value), param.min ?? 0, param.max ?? 100)}
          />
          <span className="flex h-[22px] items-center justify-end rounded-sm border border-border bg-surface-1 px-1.5 font-mono text-num tabular-nums text-fg">
            {value}
          </span>
        </div>
      )}

      {param.type === "text" && (
        <input
          type="text"
          value={value}
          disabled={disabled}
          aria-label={param.label}
          onChange={(e) => onChange(e.target.value)}
          className={`${BLOCK_FIELD} text-sm`}
        />
      )}

      {param.type === "select" && param.options && (
        <select
          value={value}
          disabled={disabled}
          aria-label={param.label}
          onChange={(e) => onChange(e.target.value)}
          className={INSP_SELECT}
        >
          {param.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
