import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * The Source editor's look, from Studio's tokens (prototype `.src-*` / `.t-*`):
 * a quiet near-monochrome palette — tags and functions in the primary ink,
 * attributes and punctuation dim, strings and numbers only tinted. Everything
 * reads `var(--…)`, so the light theme flips it with no second theme.
 */
const editorChrome = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--color-bg-0)",
    color: "var(--color-fg-2)",
    fontSize: "var(--text-xs)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    lineHeight: "18px",
    scrollbarColor: "var(--color-surface-3) transparent",
  },
  ".cm-content": { padding: "6px 0 24px", caretColor: "var(--color-accent)" },
  ".cm-line": { padding: "0 16px 0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--color-accent-soft)" },
  ".cm-gutters": {
    backgroundColor: "var(--color-bg-0)",
    color: "var(--color-fg-disabled)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 12px", minWidth: "36px" },
  ".cm-activeLine": { backgroundColor: "var(--color-surface-1)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--color-surface-1)",
    color: "var(--color-fg-2)",
  },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--color-fg-3)" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--color-surface-2)",
    border: "none",
    borderRadius: "var(--radius-xs)",
    color: "var(--color-fg-3)",
    padding: "0 6px",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "transparent",
    boxShadow: "inset 0 0 0 1px var(--color-fg-3)",
    color: "var(--color-fg)",
  },
  ".cm-nonmatchingBracket": { color: "var(--color-error)" },
  ".cm-selectionMatch": { backgroundColor: "var(--color-surface-2)" },
  ".cm-searchMatch": {
    backgroundColor: "var(--color-surface-3)",
    boxShadow: "inset 0 -1px var(--color-fg-3)",
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklch, var(--color-fg) 24%, transparent)",
    boxShadow: "0 0 0 1px var(--color-fg-2)",
  },
  ".cm-panels": {
    backgroundColor: "var(--color-bg-1)",
    color: "var(--color-fg)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-sm)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-border-subtle)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-border-subtle)" },
  ".cm-panel.cm-search": { padding: "4px 6px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
    fontSize: "var(--text-sm)",
  },
  ".cm-textfield": {
    height: "24px",
    padding: "0 8px",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-surface-1)",
    color: "var(--color-fg)",
  },
  ".cm-textfield:focus": { outline: "none", borderColor: "var(--color-accent)" },
  ".cm-button": {
    height: "24px",
    padding: "0 8px",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    backgroundImage: "none",
    backgroundColor: "var(--color-surface-1)",
    color: "var(--color-fg)",
  },
  ".cm-button:hover": { backgroundColor: "var(--color-surface-2)" },
  ".cm-panel.cm-search [name=close]": { color: "var(--color-fg-3)" },
  ".cm-tooltip": {
    backgroundColor: "var(--color-menu-bg)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-md)",
    color: "var(--color-fg)",
  },
});

const syntax = HighlightStyle.define([
  { tag: [t.tagName, t.className, t.typeName], color: "var(--color-fg)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--color-fg)" },
  {
    tag: [t.attributeName, t.propertyName, t.punctuation, t.angleBracket, t.operator],
    color: "var(--color-fg-3)",
  },
  {
    tag: [t.string, t.attributeValue, t.special(t.string), t.regexp],
    color: "color-mix(in oklch, var(--color-success) 55%, var(--color-fg-2))",
  },
  {
    tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color],
    color: "color-mix(in oklch, var(--color-warning) 45%, var(--color-fg-2))",
  },
  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier],
    color: "color-mix(in oklch, var(--color-warning) 60%, var(--color-fg))",
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--color-fg-disabled)",
    fontStyle: "italic",
  },
  { tag: t.heading, color: "var(--color-fg)", fontWeight: "600" },
  { tag: t.link, color: "var(--color-fg)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--color-error)" },
]);

export const sourceEditorTheme: Extension = [editorChrome, syntaxHighlighting(syntax)];
