import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Plus, Type } from "../../icons/SystemIcons";
import { t as translate, useTranslation, type TranslationKey } from "../../i18n";
import { isTextEditableSelection, type DomEditSelection } from "./domEditing";
import type { ImportedFontAsset } from "./fontAssets";
import { FIELD, LABEL, normalizeTextMetricValue, RESPONSIVE_GRID } from "./propertyPanelHelpers";
import { MetricField, Section, SelectField } from "./propertyPanelPrimitives";
import { ColorField } from "./propertyPanelColor";
import { FontFamilyField } from "./propertyPanelFont";
import { PromotableControl } from "./PromotableControl";

/* ------------------------------------------------------------------ */
/*  Text helpers (used only by text section components)                */
/* ------------------------------------------------------------------ */

export function formatTextFieldPreview(value: string): string {
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (collapsed.length <= 56) return collapsed;
  return `${collapsed.slice(0, 55)}…`;
}

export function getTextFieldColor(
  field: { computedStyles: Record<string, string> },
  inheritedStyles: Record<string, string>,
): string {
  return field.computedStyles.color || inheritedStyles.color || "rgb(0, 0, 0)";
}

export function getTextStyleValue(
  field: { computedStyles: Record<string, string> },
  inheritedStyles: Record<string, string>,
  property: string,
  fallback: string,
): string {
  return field.computedStyles[property] || inheritedStyles[property] || fallback;
}

const ALL_WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"];
const WEIGHT_LABEL_KEYS = {
  "100": "inspector.text.weight.100",
  "200": "inspector.text.weight.200",
  "300": "inspector.text.weight.300",
  "400": "inspector.text.weight.400",
  "500": "inspector.text.weight.500",
  "600": "inspector.text.weight.600",
  "700": "inspector.text.weight.700",
  "800": "inspector.text.weight.800",
  "900": "inspector.text.weight.900",
} as const satisfies Record<string, TranslationKey>;

function isKnownWeight(weight: string): weight is keyof typeof WEIGHT_LABEL_KEYS {
  return Object.hasOwn(WEIGHT_LABEL_KEYS, weight);
}

/** A font weight as the weight pickers list it ("400 · Regular"); an unknown weight is shown as is. */
export function weightLabel(weight: string): string {
  return isKnownWeight(weight) ? translate(WEIGHT_LABEL_KEYS[weight]) : weight;
}

export function detectAvailableWeights(fontFamily: string): string[] {
  const fonts = document.fonts;
  if (!fonts) return ALL_WEIGHTS;
  const family = fontFamily.split(",")[0]?.trim().replace(/['"]/g, "");
  if (!family) return ALL_WEIGHTS;
  const available: string[] = [];
  for (const w of ALL_WEIGHTS) {
    if (fonts.check(`${w} 16px "${family}"`)) available.push(w);
  }
  return available.length > 0 ? available : ALL_WEIGHTS;
}

export function TextAreaField({
  label,
  value,
  disabled,
  autoFocus,
  flat,
  onCommit,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  autoFocus?: boolean;
  flat?: boolean;
  onCommit: (nextValue: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactionChangedRef = useRef(false);
  const focusedRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (focusedRef.current) return;
    setDraft(value);
  }, [value]);
  useEffect(
    () => () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (!autoFocus) return;
    textareaRef.current?.focus();
  }, [autoFocus]);

  const commitDraft = (d: string) => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    if (interactionChangedRef.current) {
      interactionChangedRef.current = false;
    }
    if (d !== valueRef.current) onCommit(d);
  };
  const scheduleCommit = (d: string) => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      if (d !== valueRef.current) {
        if (interactionChangedRef.current) {
          interactionChangedRef.current = false;
        }
        onCommit(d);
      }
    }, 120);
  };

  const handleFocus = () => {
    focusedRef.current = true;
  };
  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    interactionChangedRef.current = true;
    scheduleCommit(e.target.value);
  };
  const handleBlur = () => {
    focusedRef.current = false;
    commitDraft(draft);
  };

  if (flat) {
    return (
      <div className="grid gap-1">
        <div className="text-sm text-fg-3">{label}</div>
        <textarea
          ref={textareaRef}
          value={draft}
          disabled={disabled}
          rows={2}
          onFocus={handleFocus}
          onChange={handleChange}
          onBlur={handleBlur}
          className="field-sizing-content max-h-[40vh] min-h-12 w-full resize-y overflow-x-hidden overflow-y-auto rounded-sm border border-border bg-surface-1 px-2 py-[5px] text-sm leading-4 text-fg outline-hidden transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-fg-3"
        />
      </div>
    );
  }

  return (
    <label className="grid min-w-0 gap-1.5">
      <span className={LABEL}>{label}</span>
      <div className={FIELD}>
        <textarea
          ref={textareaRef}
          value={draft}
          disabled={disabled}
          rows={4}
          onFocus={handleFocus}
          onChange={handleChange}
          onBlur={handleBlur}
          className="field-sizing-content max-h-[40vh] min-h-20 w-full resize-y overflow-x-hidden overflow-y-auto bg-transparent text-sm font-medium text-fg outline-hidden disabled:cursor-not-allowed disabled:text-fg-disabled"
        />
      </div>
    </label>
  );
}

function FontWeightField({
  value,
  disabled,
  fontFamily,
  onCommit,
}: {
  value: string;
  disabled?: boolean;
  fontFamily?: string;
  onCommit: (nextValue: string) => void;
}) {
  const { t } = useTranslation();
  const options = fontFamily ? detectAvailableWeights(fontFamily) : ALL_WEIGHTS;
  const displayOptions = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <div className={FIELD}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 text-sm font-medium text-fg-3">{t("inspector.text.weight")}</span>
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onCommit(e.target.value);
          }}
          className="min-w-0 w-full appearance-none bg-transparent text-sm font-medium text-fg outline-hidden disabled:cursor-not-allowed disabled:text-fg-disabled"
        >
          {displayOptions.map((o) => (
            <option key={o} value={o}>
              {weightLabel(o)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function AdvancedTextControls({
  field,
  inheritedStyles,
  disabled,
  onCommit,
}: {
  field: DomEditSelection["textFields"][number];
  inheritedStyles: Record<string, string>;
  disabled?: boolean;
  onCommit: (property: string, value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className={RESPONSIVE_GRID}>
        <SelectField
          label={t("inspector.text.line")}
          value={getTextStyleValue(field, inheritedStyles, "line-height", "normal")}
          disabled={disabled}
          options={["normal", "1", "1.1", "1.2", "1.25", "1.3", "1.4", "1.5", "1.6", "1.75", "2"]}
          onChange={(n) => onCommit("line-height", normalizeTextMetricValue("line-height", n))}
        />
        <SelectField
          label={t("inspector.text.track")}
          value={getTextStyleValue(field, inheritedStyles, "letter-spacing", "0px")}
          disabled={disabled}
          options={[
            "0px",
            "-0.05em",
            "-0.04em",
            "-0.03em",
            "-0.02em",
            "-0.01em",
            "0em",
            "0.01em",
            "0.02em",
            "0.03em",
            "0.05em",
            "0.1em",
            "0.15em",
            "0.2em",
          ]}
          onChange={(n) =>
            onCommit("letter-spacing", normalizeTextMetricValue("letter-spacing", n))
          }
        />
      </div>
      <div className={RESPONSIVE_GRID}>
        <SelectField
          label={t("inspector.text.align")}
          value={getTextStyleValue(field, inheritedStyles, "text-align", "start")}
          disabled={disabled}
          onChange={(n) => onCommit("text-align", n)}
          options={["start", "left", "center", "right", "justify", "end"]}
        />
        <SelectField
          label={t("inspector.text.case")}
          value={getTextStyleValue(field, inheritedStyles, "text-transform", "none")}
          disabled={disabled}
          onChange={(n) => onCommit("text-transform", n)}
          options={["none", "uppercase", "lowercase", "capitalize"]}
        />
      </div>
      <SelectField
        label={t("inspector.text.style")}
        value={getTextStyleValue(field, inheritedStyles, "font-style", "normal")}
        disabled={disabled}
        onChange={(n) => onCommit("font-style", n)}
        options={["normal", "italic"]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Text section                                                       */
/* ------------------------------------------------------------------ */

function TextFieldEditor({
  field,
  styles,
  fontAssets,
  onImportFonts,
  showRemove,
  onSetText,
  onSetTextFieldStyle,
  onRemoveTextField,
}: {
  field: DomEditSelection["textFields"][number];
  styles: Record<string, string>;
  fontAssets: ImportedFontAsset[];
  onImportFonts?: (files: FileList | File[]) => Promise<ImportedFontAsset[]>;
  showRemove: boolean;
  onSetText: (value: string, fieldKey?: string) => void;
  onSetTextFieldStyle: (fieldKey: string, property: string, value: string) => void;
  onRemoveTextField: (fieldKey: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className={showRemove ? "flex min-w-0 items-center justify-between gap-2" : "min-w-0"}>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-fg">
            {formatTextFieldPreview(field.value) || t("inspector.group.text")}
          </div>
          <div className="text-xs text-fg-3">{field.tagName}</div>
        </div>
        {showRemove && (
          <button
            type="button"
            onClick={() => {
              onRemoveTextField(field.key);
            }}
            className="inline-flex h-7 shrink-0 items-center rounded-lg border border-border bg-neutral-950 px-2.5 text-sm font-medium text-fg-2 transition-colors hover:border-neutral-600 hover:text-white"
          >
            {t("inspector.text.remove")}
          </button>
        )}
      </div>
      <PromotableControl channel={{ kind: "text" }} enabled={field.source === "self"}>
        {({ value, onCommit }) => (
          <TextAreaField
            key={field.key}
            label={t("inspector.text.content")}
            value={value ?? field.value}
            disabled={false}
            autoFocus={showRemove}
            onCommit={onCommit ?? ((next) => onSetText(next, field.key))}
          />
        )}
      </PromotableControl>
      <PromotableControl
        channel={{ kind: "style", prop: "color" }}
        enabled={field.source === "self"}
      >
        {({ value, onCommit }) => (
          <ColorField
            label={t("inspector.text.color")}
            value={value ?? getTextFieldColor(field, styles)}
            disabled={false}
            onCommit={onCommit ?? ((next) => onSetTextFieldStyle(field.key, "color", next))}
          />
        )}
      </PromotableControl>
      <div className={RESPONSIVE_GRID}>
        <MetricField
          label={t("inspector.text.size")}
          value={field.computedStyles["font-size"] || styles["font-size"] || "16px"}
          disabled={false}
          liveCommit
          onCommit={(next) => onSetTextFieldStyle(field.key, "font-size", next)}
        />
        <FontWeightField
          value={field.computedStyles["font-weight"] || styles["font-weight"] || "400"}
          fontFamily={field.computedStyles["font-family"] || styles["font-family"]}
          disabled={false}
          onCommit={(next) => onSetTextFieldStyle(field.key, "font-weight", next)}
        />
      </div>
      <PromotableControl
        channel={{ kind: "style", prop: "font-family" }}
        enabled={field.source === "self"}
      >
        {({ value, onCommit }) => (
          <FontFamilyField
            value={
              value ?? (field.computedStyles["font-family"] || styles["font-family"] || "inherit")
            }
            disabled={false}
            importedFonts={fontAssets}
            onImportFonts={onImportFonts}
            onCommit={onCommit ?? ((next) => onSetTextFieldStyle(field.key, "font-family", next))}
          />
        )}
      </PromotableControl>
      <AdvancedTextControls
        field={field}
        inheritedStyles={styles}
        disabled={false}
        onCommit={(property, value) => onSetTextFieldStyle(field.key, property, value)}
      />
    </div>
  );
}

export function TextSection({
  element,
  styles,
  fontAssets,
  onImportFonts,
  onSetText,
  onSetTextFieldStyle,
  onAddTextField,
  onRemoveTextField,
  hideOwnHeading = false,
}: {
  element: DomEditSelection;
  styles: Record<string, string>;
  fontAssets: ImportedFontAsset[];
  onImportFonts?: (files: FileList | File[]) => Promise<ImportedFontAsset[]>;
  onSetText: (value: string, fieldKey?: string) => void;
  onSetTextFieldStyle: (fieldKey: string, property: string, value: string) => void;
  onAddTextField: (afterFieldKey?: string) => string | Promise<string | null> | null;
  onRemoveTextField: (fieldKey: string) => void;
  /** Skip TextSection's own "Text" Section heading/wrapper — for callers (the
   *  flat inspector's multi-field fallback) that already render their own
   *  "Text" heading one level up, to avoid a doubled heading. Defaults to
   *  false so the legacy (non-flat) call site is unaffected. */
  hideOwnHeading?: boolean;
}) {
  const { t } = useTranslation();
  const hasTextControls = isTextEditableSelection(element);
  const [activeTextFieldKey, setActiveTextFieldKey] = useState<string | null>(
    element.textFields[0]?.key ?? null,
  );

  useEffect(() => {
    const nextFields = element.textFields;
    setActiveTextFieldKey((current) => {
      if (current && nextFields.some((field) => field.key === current)) return current;
      return nextFields[0]?.key ?? null;
    });
  }, [element.id, element.selector, element.textFields]);

  if (!hasTextControls) return null;

  const textFields = element.textFields;
  const activeField = textFields.find((field) => field.key === activeTextFieldKey) ?? textFields[0];
  if (!activeField) return null;

  if (textFields.length === 1) {
    const content = (
      <TextFieldEditor
        field={activeField}
        styles={styles}
        fontAssets={fontAssets}
        onImportFonts={onImportFonts}
        showRemove={false}
        onSetText={onSetText}
        onSetTextFieldStyle={onSetTextFieldStyle}
        onRemoveTextField={onRemoveTextField}
      />
    );
    if (hideOwnHeading) return content;
    return (
      <Section title={t("inspector.group.text")} icon={<Type size={15} />} defaultCollapsed>
        {content}
      </Section>
    );
  }

  const content = (
    <div className="space-y-4">
      <div className="grid gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className={LABEL}>{t("inspector.text.layers")}</span>
          <button
            type="button"
            onClick={() => {
              void Promise.resolve(onAddTextField(activeField.key)).then((nextKey) => {
                if (nextKey) setActiveTextFieldKey(nextKey);
              });
            }}
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-border bg-neutral-950 px-2.5 text-sm font-medium text-fg-2 transition-colors hover:border-neutral-600 hover:text-white"
          >
            <Plus size={12} className="shrink-0" />
            <span className="truncate">{t("inspector.text.addText")}</span>
          </button>
        </div>
        <div className="grid gap-2">
          {textFields.map((field, index) => {
            const active = field.key === activeField.key;
            return (
              <button
                key={field.key}
                type="button"
                onClick={() => setActiveTextFieldKey(field.key)}
                className={`min-w-0 w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                  active
                    ? "border-studio-accent/50 bg-studio-accent/10"
                    : "border-border bg-surface-1/80 hover:border-border hover:bg-surface-1"
                }`}
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-4 w-4 shrink-0 rounded-sm border border-border bg-neutral-950"
                      style={{ backgroundColor: getTextFieldColor(field, styles) }}
                    />
                    <span className="min-w-0 truncate text-sm font-medium text-fg">
                      {formatTextFieldPreview(field.value) ||
                        t("inspector.text.layerFallback", { n: index + 1 })}
                    </span>
                  </div>
                  <span className="shrink-0 rounded-md border border-border bg-neutral-950 px-1.5 py-0.5 text-xs text-fg-3">
                    {field.tagName}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <TextFieldEditor
        field={activeField}
        styles={styles}
        fontAssets={fontAssets}
        onImportFonts={onImportFonts}
        showRemove={true}
        onSetText={onSetText}
        onSetTextFieldStyle={onSetTextFieldStyle}
        onRemoveTextField={onRemoveTextField}
      />
    </div>
  );
  if (hideOwnHeading) return content;
  return (
    <Section title={t("inspector.group.text")} icon={<Type size={15} />}>
      {content}
    </Section>
  );
}

export { StyleSections } from "./propertyPanelStyleSections";
