import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type {
  Composition,
  CompositionVariable,
  VariableUsageReport,
  VariableValidationIssue,
} from "@hyperframes/sdk";
import type { PublishSdkSession } from "../../utils/sdkCutover";
import { useStudioPlaybackContext, useStudioShellContext } from "../../contexts/StudioContext";
import { useDomEditContext } from "../../contexts/DomEditContext";
import { useFileManagerContext } from "../../contexts/FileManagerContext";
import { VariablesBindElement, type BindAction, applyBind } from "./VariablesBindElement";
import { useVariablesPersist } from "../../hooks/useVariablesPersist";
import { VariablesOtherCompositions } from "./VariablesOtherCompositions";
import { RowAction } from "./VariablesRowAction";
import { usePreviewVariablesStore } from "../../hooks/previewVariablesStore";
import {
  DeclarationForm,
  draftFromDeclaration,
  mergeDeclarationEdit,
  EMPTY_DRAFT,
} from "./VariablesDeclarationForm";
import { PreviewValueControl } from "./VariablesValueControls";
import { copyTextToClipboard } from "../../utils/clipboard";
import { resolveMasterCompositionPath } from "../../utils/studioUrlState";
import { isScalarVariableValue as isScalar } from "@hyperframes/core/variables";

/** POSIX single-quote escaping so the copied command survives quotes in values. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface StudioEditPersistenceProps {
  sdkSession: Composition | null;
  publishSdkSession: PublishSdkSession;
  reloadPreview: () => void;
  recordEdit: (entry: {
    label: string;
    files: Record<string, { before: string; after: string }>;
  }) => Promise<void>;
}

type VariablesPanelProps = StudioEditPersistenceProps;

function formatIssue(issue: VariableValidationIssue): string {
  switch (issue.kind) {
    case "undeclared":
      return `"${issue.variableId}" is not declared.`;
    case "type-mismatch":
      return `"${issue.variableId}" expects ${issue.expected}, got ${issue.actual}.`;
    case "enum-out-of-range":
      return `"${issue.variableId}" must be one of: ${issue.allowed.join(", ")}.`;
  }
}

function ValidationStrip({ issues }: { issues: VariableValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-red-900/60 bg-red-950/30 p-2">
      {issues.map((issue) => (
        <p key={`${issue.kind}:${issue.variableId}`} className="text-xs text-red-300">
          {formatIssue(issue)}
        </p>
      ))}
    </div>
  );
}

function VariableRow({
  decl,
  value,
  overridden,
  unused,
  editing,
  onCommitPreview,
  onSetDefault,
  onToggleEdit,
  onSaveEdit,
  onRemove,
}: {
  decl: CompositionVariable;
  value: unknown;
  overridden: boolean;
  unused: boolean;
  editing: boolean;
  onCommitPreview: (value: unknown) => void;
  onSetDefault: (value: string | number | boolean) => void;
  onToggleEdit: () => void;
  onSaveEdit: (decl: CompositionVariable) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid min-w-0 gap-1 border-t border-border-subtle py-1.5 first:border-t-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="max-w-[60%] shrink-0 truncate text-sm font-medium text-fg">
          {decl.label}
        </span>
        {overridden && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-fg-2 shadow-[0_0_0_2px_var(--color-surface-3)]"
            title="Overridden in this preview"
          />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-num text-fg-3">
          {decl.id} · {decl.type}
        </span>
        {unused && (
          <span
            className="inline-flex h-4 shrink-0 items-center rounded-xs bg-warning-soft px-1 text-2xs text-warning"
            title="No script reads this variable"
          >
            unused
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {overridden && isScalar(value) && (
            <RowAction
              label="Set default"
              title="Persist this value as the declared default"
              onClick={() => onSetDefault(value)}
            />
          )}
          <RowAction label="Edit" title="Edit declaration" onClick={onToggleEdit} />
          <RowAction label="✕" title="Remove declaration" danger onClick={onRemove} />
        </span>
      </div>
      {decl.description && <p className="m-0 text-xs text-fg-3">{decl.description}</p>}
      {editing ? (
        <DeclarationForm
          initial={draftFromDeclaration(decl)}
          submitLabel="Save"
          onSubmit={(edited) => onSaveEdit(mergeDeclarationEdit(decl, edited))}
          onCancel={onToggleEdit}
        />
      ) : (
        <PreviewValueControl decl={decl} value={value} onCommit={onCommitPreview} />
      )}
    </div>
  );
}

function UndeclaredReads({
  usage,
  onDeclare,
}: {
  usage: VariableUsageReport | null;
  onDeclare: (id: string) => void;
}) {
  if (!usage || usage.undeclaredReads.length === 0) return null;
  return (
    <div className="grid gap-1 rounded-md border border-border bg-bg-1 p-2">
      <p className="m-0 text-xs font-semibold text-fg-2">Read by scripts, not declared</p>
      {usage.undeclaredReads.map((id) => (
        <div key={id} className="flex items-center gap-2">
          <code className="font-mono text-xs text-fg-2">{id}</code>
          <RowAction
            label="Declare"
            title="Declare as a string variable"
            onClick={() => onDeclare(id)}
          />
        </div>
      ))}
    </div>
  );
}

/** Preview-state pill + reset, shown in the panel header. */
function PreviewModeHeader({
  overrideCount,
  onReset,
}: {
  overrideCount: number;
  onReset: () => void;
}) {
  const hasOverrides = overrideCount > 0;
  return (
    <div className="flex h-head shrink-0 items-center justify-between border-b border-border-subtle pl-3 pr-1.5">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-sm font-semibold text-fg">Variables</span>
        <span className="truncate text-xs text-fg-3">
          {hasOverrides ? `${overrideCount} overridden` : "Preview and renders use these values."}
        </span>
      </div>
      {hasOverrides && (
        <button
          type="button"
          onClick={onReset}
          className="h-ctl-sm rounded-sm px-2 text-xs text-fg-2 hover:bg-surface-2 hover:text-fg"
        >
          Reset
        </button>
      )}
    </div>
  );
}

/**
 * Developer/agent handoff: copy the effective values as JSON or as a
 * ready-to-run render command mirroring exactly what the preview shows.
 */
function HandoffFooter({
  effectiveValues,
  compPath,
  onCopy,
}: {
  effectiveValues: Record<string, unknown>;
  compPath: string;
  onCopy: (text: string, what: string) => void;
}) {
  const json = JSON.stringify(effectiveValues);
  const command = `npx hyperframes render ${shellSingleQuote(compPath)} --variables ${shellSingleQuote(json)}`;
  return (
    <div className="space-y-1.5 rounded-md border border-border/70 bg-surface-1/40 p-2">
      <p className="text-2xs font-medium uppercase tracking-wider text-fg-3">Use this template</p>
      <code className="block truncate font-mono text-2xs text-fg-3" title={command}>
        {command}
      </code>
      <div className="flex items-center gap-2">
        <RowAction
          label="Copy render command"
          title="CLI command rendering exactly what the preview shows"
          onClick={() => onCopy(command, "Render command")}
        />
        <RowAction
          label="Copy values JSON"
          title="Effective values (defaults merged with preview overrides)"
          onClick={() => onCopy(json, "Values JSON")}
        />
      </div>
    </div>
  );
}

const EMPTY_STATE = (
  <p className="text-xs leading-relaxed text-fg-3">
    No variables declared. Variables make parts of this composition dynamic — declare them here (or
    in <code className="font-mono">data-composition-variables</code>), read them with{" "}
    <code className="font-mono">getVariables()</code>, and pass values at render time with{" "}
    <code className="font-mono">--variables</code>.
  </p>
);

// Panel orchestrator — JSX conditionals per section, same shape as StudioRightPanels.
export const VariablesPanel = memo(function VariablesPanel({
  sdkSession,
  publishSdkSession,
  reloadPreview,
  recordEdit,
}: VariablesPanelProps) {
  const { activeCompPath, showToast } = useStudioShellContext();
  const { refreshKey } = useStudioPlaybackContext();
  const { readProjectFile, writeProjectFile, compositions } = useFileManagerContext();
  const { domEditSelection } = useDomEditContext();
  // Master view (no activeCompPath) targets the real main composition, not a
  // hardcoded index.html — used for both the persist write target and the
  // handoff render command. Null only when the project has no composition.
  const effectiveCompPath = activeCompPath ?? resolveMasterCompositionPath(compositions);
  const previewValues = usePreviewVariablesStore((s) => s.values);
  const setPreviewValues = usePreviewVariablesStore((s) => s.setValues);

  // Bumped after each persisted schema edit so declarations re-derive without
  // waiting for the session reload round-trip.
  const [revision, setRevision] = useState(0);
  // Also bump on any session mutation (undo/redo, edits dispatched by other
  // panels or agents) — the memos below must never trust refreshKey alone.
  useEffect(() => {
    if (!sdkSession) return;
    return sdkSession.on("change", () => setRevision((r) => r + 1));
  }, [sdkSession]);
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const persistVariables = useVariablesPersist({
    sdkSession,
    activeCompPath: effectiveCompPath,
    readProjectFile,
    writeProjectFile,
    recordEdit,
    reloadPreview,
    publishSdkSession,
  });

  const declarations = useMemo(
    () => sdkSession?.getVariableDeclarations() ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sdkSession, refreshKey, revision],
  );
  const usage = useMemo(
    () => sdkSession?.getVariableUsage() ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sdkSession, refreshKey, revision],
  );
  const issues = useMemo(
    () => (previewValues && sdkSession ? sdkSession.validateVariableValues(previewValues) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sdkSession, previewValues, refreshKey, revision],
  );
  const effectiveValues = useMemo(
    () => sdkSession?.getVariableValues(previewValues ?? undefined) ?? {},
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sdkSession, previewValues, refreshKey, revision],
  );

  const copyToClipboard = useCallback(
    (text: string, what: string) => {
      // Shared helper carries the execCommand fallback Safari needs.
      void copyTextToClipboard(text).then((ok) =>
        showToast(
          ok ? `${what} copied` : `Couldn't copy ${what.toLowerCase()}`,
          ok ? "info" : "error",
        ),
      );
    },
    [showToast],
  );

  const dropPreviewOverride = useCallback(
    (id: string) => {
      if (previewValues && id in previewValues) {
        const next = { ...previewValues };
        delete next[id];
        setPreviewValues(next);
      }
    },
    [previewValues, setPreviewValues],
  );

  const commitPreviewValue = useCallback(
    (id: string, value: unknown, declDefault: unknown) => {
      const next = { ...(previewValues ?? {}) };
      if (JSON.stringify(value) === JSON.stringify(declDefault)) {
        delete next[id];
      } else {
        next[id] = value;
      }
      setPreviewValues(next);
      reloadPreview();
    },
    [previewValues, setPreviewValues, reloadPreview],
  );

  const runSchemaEdit = useCallback(
    async (label: string, mutate: (session: Composition) => void): Promise<boolean> => {
      try {
        const changed = await persistVariables(label, mutate);
        if (changed) setRevision((r) => r + 1);
        else showToast(`${label}: no change applied`, "info");
        return changed;
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
        return false;
      }
    },
    [persistVariables, showToast],
  );

  const handleAdd = useCallback(
    (decl: CompositionVariable) => {
      if (!sdkSession) return;
      const check = sdkSession.can({ type: "declareVariable", declaration: decl });
      if (!check.ok) {
        showToast(check.message, "error");
        return;
      }
      setAddOpen(false);
      void runSchemaEdit(`Declare variable "${decl.id}"`, (s) => s.declareVariable(decl));
    },
    [sdkSession, runSchemaEdit, showToast],
  );

  const handleUpdate = useCallback(
    (decl: CompositionVariable) => {
      if (!sdkSession) return;
      const check = sdkSession.can({
        type: "updateVariableDeclaration",
        id: decl.id,
        declaration: decl,
      });
      if (!check.ok) {
        showToast(check.message, "error");
        return;
      }
      setEditingId(null);
      void runSchemaEdit(`Edit variable "${decl.id}"`, (s) =>
        s.updateVariableDeclaration(decl.id, decl),
      );
    },
    [sdkSession, runSchemaEdit, showToast],
  );

  const handleRemove = useCallback(
    (id: string) => {
      if (!sdkSession) return;
      const check = sdkSession.can({ type: "removeVariableDeclaration", id });
      if (!check.ok) {
        showToast(check.message, "error");
        return;
      }
      // Drop the preview override only if the declaration was actually removed —
      // otherwise a rejected/failed edit would leave the row on disk but silently
      // wipe the user's custom preview value.
      void runSchemaEdit(`Remove variable "${id}"`, (s) => s.removeVariableDeclaration(id)).then(
        (changed) => {
          if (changed) dropPreviewOverride(id);
        },
      );
    },
    [sdkSession, runSchemaEdit, dropPreviewOverride, showToast],
  );

  const handleSetDefault = useCallback(
    (id: string, value: string | number | boolean) => {
      void runSchemaEdit(`Set default for "${id}"`, (s) => s.setVariableValue(id, value));
      // The override now equals the persisted default — drop it from preview state.
      dropPreviewOverride(id);
    },
    [runSchemaEdit, dropPreviewOverride],
  );

  const resetPreview = useCallback(() => {
    setPreviewValues(null);
    reloadPreview();
  }, [setPreviewValues, reloadPreview]);

  const handleBind = useCallback(
    // Guard chain (session, selection, type-compat) — one branch per guard.
    (action: BindAction, id: string) => {
      if (!sdkSession || !domEditSelection?.hfId) return;
      // Binding to an existing variable is allowed, but only when the types
      // agree — wiring a color style to a string variable silently breaks
      // the element's styling.
      const existing = sdkSession.getVariableDeclarations().find((d) => d.id === id);
      const wanted = action.declaration(id).type;
      if (existing && existing.type !== wanted) {
        showToast(
          `"${id}" is already a ${existing.type} variable — pick another id for this ${wanted} binding`,
          "error",
        );
        return;
      }
      const hfId = domEditSelection.hfId;
      void runSchemaEdit(`Bind ${action.label.toLowerCase()} to "${id}"`, (s) =>
        applyBind(s, hfId, action, id),
      );
    },
    [sdkSession, domEditSelection, runSchemaEdit, showToast],
  );

  // The bind gesture targets the composition the session models — a selection
  // from another source file must not write bindings into this one.
  const bindableSelection =
    domEditSelection?.hfId && domEditSelection.sourceFile === (activeCompPath ?? "index.html")
      ? domEditSelection
      : null;

  if (!sdkSession) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-xs text-fg-3">Open a composition to manage its variables.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PreviewModeHeader
        overrideCount={previewValues ? Object.keys(previewValues).length : 0}
        onReset={resetPreview}
      />
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {bindableSelection && (
          <VariablesBindElement
            key={bindableSelection.hfId}
            selection={bindableSelection}
            sdkSession={sdkSession}
            onBind={handleBind}
          />
        )}
        <ValidationStrip issues={issues} />
        {declarations.length === 0 && !addOpen && EMPTY_STATE}
        {declarations.map((decl) => (
          <VariableRow
            key={decl.id}
            decl={decl}
            value={
              previewValues && decl.id in previewValues ? previewValues[decl.id] : decl.default
            }
            overridden={previewValues !== null && decl.id in previewValues}
            unused={
              usage !== null && !usage.scanIncomplete && usage.unusedDeclarations.includes(decl.id)
            }
            editing={editingId === decl.id}
            onCommitPreview={(v) => commitPreviewValue(decl.id, v, decl.default)}
            onSetDefault={(v) => handleSetDefault(decl.id, v)}
            onToggleEdit={() => setEditingId(editingId === decl.id ? null : decl.id)}
            onSaveEdit={handleUpdate}
            onRemove={() => handleRemove(decl.id)}
          />
        ))}
        <UndeclaredReads
          usage={usage}
          onDeclare={(id) => handleAdd({ id, type: "string", label: id, default: "" })}
        />
        {usage?.scanIncomplete && (
          <p className="text-2xs text-fg-disabled">
            Scripts access variables dynamically — usage info may be incomplete.
          </p>
        )}
        {declarations.length > 0 && (
          <HandoffFooter
            effectiveValues={effectiveValues}
            compPath={effectiveCompPath ?? "index.html"}
            onCopy={copyToClipboard}
          />
        )}
        {addOpen ? (
          <DeclarationForm
            initial={EMPTY_DRAFT}
            submitLabel="Add variable"
            onSubmit={handleAdd}
            onCancel={() => setAddOpen(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="h-7 w-full rounded-md border border-dashed border-border text-xs font-medium text-fg-3 transition-colors hover:border-border hover:text-fg-2"
          >
            + Add variable
          </button>
        )}
        <VariablesOtherCompositions
          compositionPaths={compositions}
          excludePath={effectiveCompPath}
          refreshKey={`${refreshKey}:${revision}`}
          readProjectFile={readProjectFile}
          writeProjectFile={writeProjectFile}
          recordEdit={recordEdit}
          reloadPreview={reloadPreview}
        />
      </div>
    </div>
  );
});
