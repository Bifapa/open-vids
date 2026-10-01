import { useEffect, useState } from "react";
import { Plus, X } from "../../icons/SystemIcons";
import { useTranslation, type TranslationKey } from "../../i18n";
import { INSP_ROW, INSP_ROW_LABEL, INSP_SELECT, INSP_SUBHEAD } from "./inspectorStyles";
import { isTextEditableSelection, type DomEditSelection } from "./domEditing";
import type { ImportedFontAsset } from "./fontAssets";
import { normalizeTextMetricValue } from "./propertyPanelHelpers";
import { ColorField } from "./propertyPanelColor";
import { FontFamilyField } from "./propertyPanelFont";
import { PromotableControl } from "./PromotableControl";
import { FlatRow, FlatSegmentedRow } from "./propertyPanelFlatPrimitives";
import {
  resolveValueTier,
  VALUE_TIER_LABEL_CLASS,
  VALUE_TIER_VALUE_CLASS,
} from "./propertyPanelValueTier";
import {
  detectAvailableWeights,
  formatTextFieldPreview,
  getTextFieldColor,
  getTextStyleValue,
  TextAreaField,
  weightLabel,
} from "./propertyPanelSections";

/* ------------------------------------------------------------------ */
/*  Flat text section (design_handoff_studio_inspector, #10a)          */
/* ------------------------------------------------------------------ */

const ALIGN_OPTIONS = [
  { key: "left", label: "inspector.text.align.left", node: "inspector.text.align.leftGlyph" },
  { key: "center", label: "inspector.text.align.center", node: "inspector.text.align.centerGlyph" },
  { key: "right", label: "inspector.text.align.right", node: "inspector.text.align.rightGlyph" },
  {
    key: "justify",
    label: "inspector.text.align.justify",
    node: "inspector.text.align.justifyGlyph",
  },
] as const satisfies readonly { key: string; label: TranslationKey; node: TranslationKey }[];

// The glyphs are samples of the transform, not words, so they stay as they are.
const CASE_OPTIONS = [
  { key: "none", label: "inspector.text.case.none", node: "–" },
  { key: "uppercase", label: "inspector.text.case.uppercase", node: "AG" },
  { key: "lowercase", label: "inspector.text.case.lowercase", node: "ag" },
  { key: "capitalize", label: "inspector.text.case.capitalize", node: "Ag" },
] as const satisfies readonly { key: string; label: TranslationKey; node: string }[];

function FlatTextFieldEditor({
  field,
  styles,
  fontAssets,
  onImportFonts,
  onSetText,
  onSetTextFieldStyle,
  onPreviewTextFieldStyle,
  autoFocus = false,
}: {
  field: DomEditSelection["textFields"][number];
  styles: Record<string, string>;
  fontAssets: ImportedFontAsset[];
  onImportFonts?: (files: FileList | File[]) => Promise<ImportedFontAsset[]>;
  onSetText: (value: string, fieldKey?: string) => void;
  onSetTextFieldStyle: (fieldKey: string, property: string, value: string) => void;
  onPreviewTextFieldStyle?: (fieldKey: string, property: string, value: string) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const weight = getTextStyleValue(field, styles, "font-weight", "400");
  const weightOptions = detectAvailableWeights(
    field.computedStyles["font-family"] || styles["font-family"] || "",
  );
  const align = getTextStyleValue(field, styles, "text-align", "start");
  const textTransform = getTextStyleValue(field, styles, "text-transform", "none");
  const fontStyle = getTextStyleValue(field, styles, "font-style", "normal");

  return (
    <>
      <PromotableControl channel={{ kind: "text" }} enabled={field.source === "self"}>
        {({ value, onCommit }) => (
          <TextAreaField
            flat
            label={t("inspector.text.content")}
            value={value ?? field.value}
            autoFocus={autoFocus}
            onCommit={onCommit ?? ((next) => onSetText(next, field.key))}
          />
        )}
      </PromotableControl>
      <PromotableControl
        channel={{ kind: "style", prop: "font-family" }}
        enabled={field.source === "self"}
      >
        {({ value, onCommit }) => (
          <FontFamilyField
            flat
            value={
              value ?? (field.computedStyles["font-family"] || styles["font-family"] || "inherit")
            }
            importedFonts={fontAssets}
            onImportFonts={onImportFonts}
            onCommit={onCommit ?? ((next) => onSetTextFieldStyle(field.key, "font-family", next))}
          />
        )}
      </PromotableControl>
      <FlatRow
        label={t("inspector.text.size")}
        value={field.computedStyles["font-size"] || styles["font-size"] || "16px"}
        tier={resolveValueTier(field.inlineStyles["font-size"], styles["font-size"] || "16px")}
        liveCommit
        onPreview={(next) => onPreviewTextFieldStyle?.(field.key, "font-size", next)}
        onCommit={(next) => onSetTextFieldStyle(field.key, "font-size", next)}
      />
      <div className={INSP_ROW}>
        <span
          className={`${INSP_ROW_LABEL} ${
            VALUE_TIER_LABEL_CLASS[resolveValueTier(field.inlineStyles["font-weight"], "400")]
          }`}
        >
          {t("inspector.text.weight")}
        </span>
        <select
          value={weight}
          aria-label={t("inspector.text.weight")}
          onChange={(e) => {
            onSetTextFieldStyle(field.key, "font-weight", e.target.value);
          }}
          className={`${INSP_SELECT} ${
            VALUE_TIER_VALUE_CLASS[resolveValueTier(field.inlineStyles["font-weight"], "400")]
          }`}
        >
          {(weightOptions.includes(weight) ? weightOptions : [weight, ...weightOptions]).map(
            (option) => (
              <option key={option} value={option}>
                {weightLabel(option)}
              </option>
            ),
          )}
        </select>
      </div>
      <FlatRow
        label={t("inspector.text.tracking")}
        value={getTextStyleValue(field, styles, "letter-spacing", "0px")}
        tier={resolveValueTier(field.inlineStyles["letter-spacing"], "0px")}
        onCommit={(next) =>
          onSetTextFieldStyle(
            field.key,
            "letter-spacing",
            normalizeTextMetricValue("letter-spacing", next),
          )
        }
        onReset={() => onSetTextFieldStyle(field.key, "letter-spacing", "")}
      />
      <FlatRow
        label={t("inspector.text.lineHeight")}
        value={getTextStyleValue(field, styles, "line-height", "normal")}
        tier={resolveValueTier(field.inlineStyles["line-height"], "normal")}
        onCommit={(next) =>
          onSetTextFieldStyle(
            field.key,
            "line-height",
            normalizeTextMetricValue("line-height", next),
          )
        }
        onReset={() => onSetTextFieldStyle(field.key, "line-height", "")}
      />
      <FlatSegmentedRow
        label={t("inspector.text.align")}
        options={ALIGN_OPTIONS.map((option) => ({
          key: option.key,
          node: t(option.node),
          label: t(option.label),
          active:
            align === option.key ||
            (option.key === "left" && align === "start") ||
            (option.key === "right" && align === "end"),
        }))}
        onChange={(next) => {
          // Re-clicking the option that's already visually active for a
          // logical value (authored "start"/"end") must not rewrite it to
          // the physical "left"/"right" — that destroys the logical
          // semantics and is wrong for RTL content. Only write when the
          // user actually picked a different alignment.
          if ((next === "left" && align === "start") || (next === "right" && align === "end")) {
            return;
          }
          onSetTextFieldStyle(field.key, "text-align", next);
        }}
      />
      <FlatSegmentedRow
        label={t("inspector.text.caseStyle")}
        options={[
          ...CASE_OPTIONS.map((option) => ({
            key: option.key,
            node: option.node,
            label: t(option.label),
            active: textTransform === option.key,
          })),
          {
            key: "normal",
            node: "A",
            label: t("inspector.text.upright"),
            active: fontStyle === "normal",
          },
          {
            key: "italic",
            node: "A",
            label: t("inspector.text.italic"),
            active: fontStyle === "italic",
          },
        ]}
        spacerAfterIndex={2}
        onChange={(next) => {
          if (next === "normal" || next === "italic") {
            onSetTextFieldStyle(field.key, "font-style", next);
          } else {
            onSetTextFieldStyle(field.key, "text-transform", next);
          }
        }}
      />
      <PromotableControl
        channel={{ kind: "style", prop: "color" }}
        enabled={field.source === "self"}
      >
        {({ value, onCommit }) => (
          <ColorField
            flat
            label={t("inspector.text.colorLabel")}
            value={value ?? getTextFieldColor(field, styles)}
            onPreview={(next) => onPreviewTextFieldStyle?.(field.key, "color", next)}
            onCommit={onCommit ?? ((next) => onSetTextFieldStyle(field.key, "color", next))}
          />
        )}
      </PromotableControl>
    </>
  );
}

export function FlatTextSection({
  element,
  styles,
  fontAssets,
  onImportFonts,
  onSetText,
  onSetTextFieldStyle,
  onPreviewTextFieldStyle,
  onAddTextField,
  onRemoveTextField,
}: {
  element: DomEditSelection;
  styles: Record<string, string>;
  fontAssets: ImportedFontAsset[];
  onImportFonts?: (files: FileList | File[]) => Promise<ImportedFontAsset[]>;
  onSetText: (value: string, fieldKey?: string) => void;
  onSetTextFieldStyle: (fieldKey: string, property: string, value: string) => void;
  onPreviewTextFieldStyle?: (fieldKey: string, property: string, value: string) => void;
  onAddTextField: (afterFieldKey?: string) => string | Promise<string | null> | null;
  onRemoveTextField: (fieldKey: string) => void;
}) {
  const { t } = useTranslation();
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(
    element.textFields[0]?.key ?? null,
  );
  // Armed by the add handler so the newly added field mounts focused. State, not
  // a ref cleared during render: Strict Mode renders twice, so the first pass
  // would eat the marker and the second would mount the field unfocused. Nothing
  // clears it on read either — `autoFocus` is a mount-only DOM prop and the
  // editor is keyed on the field, so it can only fire once per added field.
  const [autoFocusFieldKey, setAutoFocusFieldKey] = useState<string | null>(null);

  useEffect(() => {
    const nextFields = element.textFields;
    setActiveFieldKey((current) => {
      if (current && nextFields.some((field) => field.key === current)) return current;
      return nextFields[0]?.key ?? null;
    });
  }, [element.id, element.selector, element.textFields]);

  if (!isTextEditableSelection(element)) return null;
  const textFields = element.textFields;
  const activeField = textFields.find((field) => field.key === activeFieldKey) ?? textFields[0];
  if (!activeField) return null;

  const autoFocusActiveField = autoFocusFieldKey === activeField.key;

  if (textFields.length > 1) {
    return (
      <div className="grid gap-1.5">
        <FlatTextLayerList
          fields={textFields}
          activeFieldKey={activeField.key}
          styles={styles}
          onSelect={(fieldKey) => {
            setAutoFocusFieldKey(null);
            setActiveFieldKey(fieldKey);
          }}
          onAdd={() =>
            void Promise.resolve(onAddTextField(activeField.key)).then((nextKey) => {
              if (!nextKey) return;
              setAutoFocusFieldKey(nextKey);
              setActiveFieldKey(nextKey);
            })
          }
          onRemove={onRemoveTextField}
        />
        <FlatTextFieldEditor
          key={activeField.key}
          field={activeField}
          styles={styles}
          fontAssets={fontAssets}
          onImportFonts={onImportFonts}
          onSetText={onSetText}
          onSetTextFieldStyle={onSetTextFieldStyle}
          onPreviewTextFieldStyle={onPreviewTextFieldStyle}
          autoFocus={autoFocusActiveField}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <FlatTextFieldEditor
        field={activeField}
        styles={styles}
        fontAssets={fontAssets}
        onImportFonts={onImportFonts}
        onSetText={onSetText}
        onSetTextFieldStyle={onSetTextFieldStyle}
        onPreviewTextFieldStyle={onPreviewTextFieldStyle}
      />
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(onAddTextField(activeField.key)).then((nextKey) => {
            if (!nextKey) return;
            setAutoFocusFieldKey(nextKey);
            setActiveFieldKey(nextKey);
          });
        }}
        className="flex h-ctl-sm items-center gap-1.5 justify-self-start rounded-sm px-1.5 text-xs text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <Plus size={10} />
        {t("inspector.text.addTextField")}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Multi-field layer list (design_handoff_studio_inspector, #10a —     */
/*  no mock exists for this row; layout originated by this plan,        */
/*  following the "left-rule nested content" convention established     */
/*  by Text's own content block, Motion's effect cards, and Media's     */
/*  cutout block. Flag for design review.)                              */
/* ------------------------------------------------------------------ */

export function FlatTextLayerList({
  fields,
  activeFieldKey,
  styles,
  onSelect,
  onAdd,
  onRemove,
}: {
  fields: DomEditSelection["textFields"];
  activeFieldKey: string;
  styles: Record<string, string>;
  onSelect: (fieldKey: string) => void;
  onAdd: () => void;
  onRemove: (fieldKey: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1">
      <div className={INSP_SUBHEAD}>{t("inspector.text.layers")}</div>
      <div className="grid gap-0.5">
        {fields.map((field, index) => {
          const active = field.key === activeFieldKey;
          return (
            <div
              key={field.key}
              data-flat-text-layer-row="true"
              data-active={active}
              onClick={() => onSelect(field.key)}
              className={`flex h-row-sm cursor-pointer items-center gap-2 rounded-sm px-1.5 ${
                active
                  ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent-line)]"
                  : "hover:bg-surface-1"
              }`}
            >
              <span
                className="h-3 w-3 shrink-0 rounded-xs"
                style={{ backgroundColor: getTextFieldColor(field, styles) }}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">
                {formatTextFieldPreview(field.value) ||
                  t("inspector.text.layerFallback", { n: index + 1 })}
              </span>
              <span className="shrink-0 font-mono text-2xs text-fg-3">{field.tagName}</span>
              {fields.length > 1 && (
                <button
                  type="button"
                  data-flat-text-layer-remove="true"
                  aria-label={t("inspector.text.removeField")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(field.key);
                  }}
                  className="shrink-0 text-fg-3 hover:text-fg"
                >
                  <X size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        data-flat-text-layer-add="true"
        onClick={() => {
          onAdd();
        }}
        className="mt-1 flex h-ctl-sm items-center gap-1.5 justify-self-start rounded-sm px-1.5 text-xs text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <Plus size={10} />
        {t("inspector.text.addTextField")}
      </button>
    </div>
  );
}
