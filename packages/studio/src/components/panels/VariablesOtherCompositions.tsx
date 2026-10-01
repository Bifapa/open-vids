/**
 * Variables tab section for compositions OTHER than the active one. A variable
 * promoted into a sub-comp lives in that frame's file, not the active session —
 * this surfaces every such file's declarations grouped by path, with per-file
 * management (edit declaration / remove). Live-preview override for these is a
 * follow-up (values are per-composition-scope), so no preview control is shown.
 */

import { useCallback, useState } from "react";
import type { Composition, CompositionVariable } from "@hyperframes/sdk";
import {
  useEditVariablesInFile,
  useProjectCompositionVariables,
  type CompositionVariableGroup,
  type RecordEditFn,
} from "../../hooks/useProjectCompositionVariables";
import {
  DeclarationForm,
  draftFromDeclaration,
  mergeDeclarationEdit,
} from "./VariablesDeclarationForm";
import { RowAction } from "./VariablesRowAction";
import { useTranslation } from "../../i18n";

function CompositionSection({
  group,
  editingKey,
  onToggleEdit,
  onSave,
  onRemove,
}: {
  group: CompositionVariableGroup;
  editingKey: string | null;
  onToggleEdit: (key: string | null) => void;
  onSave: (path: string, decl: CompositionVariable) => void;
  onRemove: (path: string, id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <p
        className="truncate text-2xs font-medium uppercase tracking-wider text-fg-3"
        title={group.path}
      >
        {group.path}
      </p>
      {group.variables.map((decl) => {
        const key = `${group.path}::${decl.id}`;
        const editing = editingKey === key;
        return (
          <div key={key} className="space-y-1.5 rounded-md border border-border/70 p-2">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium text-fg-2">{decl.label}</span>
              <span className="rounded-sm bg-surface-2 px-1 py-px font-mono text-[8px] text-fg-3">
                {decl.type}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <RowAction
                  label={t("panels.variables.row.edit")}
                  title={t("panels.variables.row.editTitle")}
                  onClick={() => onToggleEdit(editing ? null : key)}
                />
                <RowAction
                  label="✕"
                  title={t("panels.variables.row.removeTitle")}
                  danger
                  onClick={() => onRemove(group.path, decl.id)}
                />
              </span>
            </div>
            {decl.description && <p className="text-2xs text-fg-3">{decl.description}</p>}
            {editing && (
              <DeclarationForm
                initial={draftFromDeclaration(decl)}
                submitLabel={t("common.save")}
                onSubmit={(edited) => onSave(group.path, mergeDeclarationEdit(decl, edited))}
                onCancel={() => onToggleEdit(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function VariablesOtherCompositions({
  compositionPaths,
  excludePath,
  refreshKey,
  readProjectFile,
  writeProjectFile,
  recordEdit,
  reloadPreview,
}: {
  compositionPaths: string[];
  excludePath: string | null;
  refreshKey: unknown;
  readProjectFile: (path: string) => Promise<string>;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: RecordEditFn;
  reloadPreview: () => void;
}) {
  const { t } = useTranslation();
  const [selfRefresh, setSelfRefresh] = useState(0);
  const groups = useProjectCompositionVariables(
    compositionPaths,
    excludePath,
    readProjectFile,
    `${refreshKey}:${selfRefresh}`,
  );
  const editInFile = useEditVariablesInFile({
    readProjectFile,
    writeProjectFile,
    recordEdit,
    reloadPreview,
  });
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const onSave = useCallback(
    (path: string, decl: CompositionVariable) => {
      setEditingKey(null);
      void editInFile(
        path,
        t("panels.variables.history.update", { id: decl.id }),
        (s: Composition) => s.updateVariableDeclaration(decl.id, decl),
      ).then(() => setSelfRefresh((r) => r + 1));
    },
    [editInFile, t],
  );
  const onRemove = useCallback(
    (path: string, id: string) => {
      void editInFile(path, t("panels.variables.history.remove", { id }), (s: Composition) =>
        s.removeVariableDeclaration(id),
      ).then(() => setSelfRefresh((r) => r + 1));
    },
    [editInFile, t],
  );

  if (groups.length === 0) return null;

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <p className="text-2xs font-medium uppercase tracking-wider text-fg-disabled">
        {t("panels.variables.otherCompositions")}
      </p>
      {groups.map((group) => (
        <CompositionSection
          key={group.path}
          group={group}
          editingKey={editingKey}
          onToggleEdit={setEditingKey}
          onSave={onSave}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
