/**
 * Add/edit form for a variable declaration. Builds a typed
 * CompositionVariable from free-text drafts; structural validation beyond
 * the field-level checks here is the SDK's job (can() on dispatch).
 */

import { useState } from "react";
import type { CompositionVariable, CompositionVariableType } from "@hyperframes/sdk";
import { VARIABLES_INPUT_CLASS } from "./VariablesValueControls";
import { t, useTranslation, type TranslationKey } from "../../i18n";

const VARIABLE_TYPES: CompositionVariableType[] = [
  "string",
  "number",
  "color",
  "boolean",
  "enum",
  "font",
  "image",
];

const CONSTRAINT_LABEL_KEYS = {
  min: "panels.variables.form.min",
  max: "panels.variables.form.max",
  step: "panels.variables.form.step",
} as const satisfies Record<"min" | "max" | "step", TranslationKey>;

export interface DeclarationDraft {
  id: string;
  label: string;
  type: CompositionVariableType;
  defaultRaw: string;
  description: string;
  min: string;
  max: string;
  step: string;
  optionsRaw: string;
}

export const EMPTY_DRAFT: DeclarationDraft = {
  id: "",
  label: "",
  type: "string",
  defaultRaw: "",
  description: "",
  min: "",
  max: "",
  step: "",
  optionsRaw: "",
};

// Per-type field mapping — one ternary per optional field.
export function draftFromDeclaration(decl: CompositionVariable): DeclarationDraft {
  const numeric = decl.type === "number" ? decl : null;
  return {
    ...EMPTY_DRAFT,
    id: decl.id,
    label: decl.label,
    type: decl.type,
    defaultRaw: String(decl.default),
    description: decl.description ?? "",
    min: numeric?.min !== undefined ? String(numeric.min) : "",
    max: numeric?.max !== undefined ? String(numeric.max) : "",
    step: numeric?.step !== undefined ? String(numeric.step) : "",
    optionsRaw:
      decl.type === "enum" ? decl.options.map((o) => `${o.value}:${o.label}`).join("\n") : "",
  };
}

function numberDeclFromDraft(
  base: { id: string; label: string; description?: string },
  draft: DeclarationDraft,
): CompositionVariable | string {
  const value = Number(draft.defaultRaw);
  if (!Number.isFinite(value)) return t("panels.variables.form.error.defaultNumber");
  const constraint = (key: "min" | "max" | "step") => {
    const raw = draft[key].trim();
    if (!raw) return {};
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? { [key]: parsed } : {};
  };
  return {
    ...base,
    type: "number",
    default: value,
    ...constraint("min"),
    ...constraint("max"),
    ...constraint("step"),
  };
}

function enumDeclFromDraft(
  base: { id: string; label: string; description?: string },
  draft: DeclarationDraft,
): CompositionVariable | string {
  const options = draft.optionsRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, ...rest] = line.split(":");
      const v = (value ?? "").trim();
      return { value: v, label: rest.join(":").trim() || v };
    })
    .filter((o) => o.value.length > 0);
  if (options.length === 0) return t("panels.variables.form.error.enumNeedsOption");
  const value = draft.defaultRaw.trim() || (options[0]?.value ?? "");
  if (!options.some((o) => o.value === value))
    return t("panels.variables.form.error.defaultInOptions");
  return { ...base, type: "enum", default: value, options };
}

/**
 * Fields the form actually models. On an unchanged-type edit, every OTHER key
 * of the original declaration (font source/default_name/default_source,
 * brandRole, placeholder, maxLength, unit, …) must ride through untouched —
 * updateVariableDeclaration replaces wholesale, so dropping them here would
 * silently strip schema metadata on every Edit + Save.
 */
const FORM_OWNED_KEYS = new Set([
  "id",
  "label",
  "type",
  "default",
  "description",
  "min",
  "max",
  "step",
  "options",
]);

export function mergeDeclarationEdit(
  original: CompositionVariable,
  edited: CompositionVariable,
): CompositionVariable {
  // Type changed → old type-specific metadata no longer applies.
  if (original.type !== edited.type) return edited;
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(original)) {
    if (!FORM_OWNED_KEYS.has(key)) passthrough[key] = value;
  }
  // Both sides are same-type declarations and edited owns every form key, so
  // the merge preserves the declared shape.
  return { ...passthrough, ...edited };
}

/** Build a typed declaration from the form draft; string on validation error. */
export function declarationFromDraft(draft: DeclarationDraft): CompositionVariable | string {
  const id = draft.id.trim();
  if (!id) return t("panels.variables.form.error.idRequired");
  const label = draft.label.trim() || id;
  const description = draft.description.trim() || undefined;
  const base = { id, label, ...(description ? { description } : {}) };
  switch (draft.type) {
    case "number":
      return numberDeclFromDraft(base, draft);
    case "boolean":
      return { ...base, type: "boolean", default: draft.defaultRaw.trim() === "true" };
    case "enum":
      return enumDeclFromDraft(base, draft);
    default:
      // string / color / font / image — string default, verbatim.
      return { ...base, type: draft.type, default: draft.defaultRaw };
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-2xs font-medium text-fg-3">{label}</label>
      {children}
    </div>
  );
}

function DefaultField({
  draft,
  onChange,
}: {
  draft: DeclarationDraft;
  onChange: (defaultRaw: string) => void;
}) {
  if (draft.type === "boolean") {
    return (
      <select
        value={draft.defaultRaw === "true" ? "true" : "false"}
        onChange={(e) => onChange(e.target.value)}
        className={VARIABLES_INPUT_CLASS}
      >
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
    );
  }
  return (
    <input
      type="text"
      value={draft.defaultRaw}
      onChange={(e) => onChange(e.target.value)}
      className={VARIABLES_INPUT_CLASS}
    />
  );
}

export function DeclarationForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: DeclarationDraft;
  submitLabel: string;
  onSubmit: (decl: CompositionVariable) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DeclarationDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const editingExisting = initial.id.length > 0;
  const set = (patch: Partial<DeclarationDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = () => {
    const result = declarationFromDraft(draft);
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setError(null);
    onSubmit(result);
  };

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1/60 p-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("panels.variables.form.id")}>
          <input
            type="text"
            value={draft.id}
            disabled={editingExisting}
            onChange={(e) => set({ id: e.target.value })}
            placeholder="title"
            className={`${VARIABLES_INPUT_CLASS} font-mono disabled:opacity-50`}
          />
        </Field>
        <Field label={t("panels.variables.form.label")}>
          <input
            type="text"
            value={draft.label}
            onChange={(e) => set({ label: e.target.value })}
            placeholder={t("panels.variables.form.labelPlaceholder")}
            className={VARIABLES_INPUT_CLASS}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("panels.variables.form.type")}>
          <select
            value={draft.type}
            onChange={(e) => {
              const type = VARIABLE_TYPES.find((candidate) => candidate === e.target.value);
              if (type) set({ type });
            }}
            className={VARIABLES_INPUT_CLASS}
          >
            {VARIABLE_TYPES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("common.default")}>
          <DefaultField draft={draft} onChange={(defaultRaw) => set({ defaultRaw })} />
        </Field>
      </div>
      {draft.type === "number" && (
        <div className="grid grid-cols-3 gap-2">
          {(["min", "max", "step"] as const).map((key) => (
            <Field key={key} label={t(CONSTRAINT_LABEL_KEYS[key])}>
              <input
                type="text"
                value={draft[key]}
                onChange={(e) => set({ [key]: e.target.value })}
                className={`${VARIABLES_INPUT_CLASS} tabular-nums`}
              />
            </Field>
          ))}
        </div>
      )}
      {draft.type === "enum" && (
        <Field label={t("panels.variables.form.options")}>
          <textarea
            value={draft.optionsRaw}
            onChange={(e) => set({ optionsRaw: e.target.value })}
            rows={3}
            className={`${VARIABLES_INPUT_CLASS} resize-y font-mono`}
          />
        </Field>
      )}
      <Field label={t("panels.variables.form.description")}>
        <input
          type="text"
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          className={VARIABLES_INPUT_CLASS}
        />
      </Field>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-6 rounded-sm px-2 text-xs text-fg-3 hover:text-fg-2"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={submit}
          className="h-6 rounded-sm bg-surface-2 px-2 text-xs font-medium text-fg hover:bg-neutral-700"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
