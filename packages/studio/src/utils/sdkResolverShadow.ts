/**
 * SDK resolver-parity check.
 *
 * Checks whether the SDK session resolves the same element id the server
 * patch path would target, then optionally verifies value parity after an
 * in-memory dispatch. Pure read-only check — never writes to disk, never
 * affects the user-visible edit.
 *
 * Headline signal: `element_not_found` — the resolver divergence class that
 * caused the v0.6.110 regression. The writer-parity suite (#1533) cannot see
 * this class; this check exists specifically to catch it.
 *
 * Decoupled from `STUDIO_SDK_CUTOVER_ENABLED`.
 */

import type { Composition, JsonPatchOp } from "@hyperframes/sdk";
import type { PatchOperation } from "./sourcePatcher";
import { patchOpsToSdkEditOps } from "./sdkOpMapping";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SdkResolverMismatch {
  kind:
    | "element_not_found"
    | "value_mismatch"
    | "dispatch_error"
    | "animation_not_found"
    | "session_empty";
  hfId?: string;
  animationId?: string;
  property?: string;
  expected?: string | null;
  actual?: string | null | undefined;
  error?: string;
}

// ─── Op helpers ───────────────────────────────────────────────────────────────

// Drop studio-internal data-hf-* markers the SDK model doesn't represent.
function isShadowableOp(op: PatchOperation): boolean {
  const name =
    op.type === "attribute"
      ? op.property.startsWith("data-")
        ? op.property
        : `data-${op.property}`
      : op.type === "html-attribute"
        ? op.property
        : null;
  return name === null || !name.startsWith("data-hf-");
}

const MAPPED_OP_TYPES = new Set(["inline-style", "text-content", "attribute", "html-attribute"]);

// ─── Read-back helpers ────────────────────────────────────────────────────────

function kebabToCamel(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function normalizeText(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

type FlatEl = NonNullable<ReturnType<Composition["getElement"]>>;
type AttrMap = Record<string, string | null>;

/**
 * Resolve an hf-id to its snapshot the SAME way the SDK dispatch path does
 * (engine/model.ts resolveScoped), NOT via Composition.getElement.
 *
 * getElement is canonical-only for a bare id by design — it deliberately will
 * not resolve a bare id to a non-canonical (sub-composition) element, so that
 * removeElement(bareId) and getElement(bareId) agree on the same instance
 * (session.subcomp.test "ambiguous bare id" suite). But the cutover persist
 * path dispatches the studio's bare data-hf-id, and dispatch resolves it via
 * resolveScoped, which locates the leaf anywhere (canonical preferred, else
 * first match). So getElement under-resolves a bare leaf that lives inside an
 * inlined sub-composition (scopedId "host/leaf") — exactly the false
 * `element_not_found` this check used to report for inlined compositions.
 *
 * Mirror resolveScoped here: exact scoped-path match, then canonical bare
 * match, then first bare match — the resolvability dispatch actually has.
 *
 * Exported so the cutover path can distinguish its two `target_not_found` cases:
 * `Composition.getElement` is narrower (canonical-only for a bare id) than what
 * `dispatch` resolves, so an element can be genuinely dispatchable yet still
 * fail `getElement` — a resolver disagreement worth fixing, not a missing node.
 */
export function resolveSnapshot(session: Composition, id: string): FlatEl | null {
  const els = session.getElements();
  const exact = els.find((el) => el.scopedId === id);
  if (exact) return exact;
  const matches = els.filter((el) => el.id === id);
  return matches.find((el) => el.scopedId === el.id) ?? matches[0] ?? null;
}

function checkStyleOp(
  op: PatchOperation,
  el: FlatEl,
): { expected: string | null; actual: string | null } {
  return {
    expected: op.value ?? null,
    actual: el.inlineStyles[kebabToCamel(op.property)] ?? el.inlineStyles[op.property] ?? null,
  };
}

function checkTextOp(
  op: PatchOperation,
  el: FlatEl,
): { expected: string | null; actual: string | null } {
  return { expected: normalizeText(op.value), actual: normalizeText(el.text) };
}

function checkAttrOp(
  op: PatchOperation,
  el: FlatEl,
): { property: string; expected: string | null; actual: string | null } {
  const property =
    op.type === "attribute"
      ? op.property.startsWith("data-")
        ? op.property
        : `data-${op.property}`
      : op.property;
  return {
    property,
    expected: op.value ?? null,
    actual: (el.attributes as AttrMap)[property] ?? null,
  };
}

function checkOpValue(op: PatchOperation, el: FlatEl, hfId: string): SdkResolverMismatch | null {
  let property: string;
  let expected: string | null;
  let actual: string | null;

  if (op.type === "inline-style") {
    property = op.property;
    ({ expected, actual } = checkStyleOp(op, el));
  } else if (op.type === "text-content") {
    property = "text";
    ({ expected, actual } = checkTextOp(op, el));
  } else if (op.type === "attribute" || op.type === "html-attribute") {
    ({ property, expected, actual } = checkAttrOp(op, el));
  } else {
    return null;
  }

  if (actual === expected) return null;
  return { kind: "value_mismatch", hfId, property, expected, actual };
}

// ─── Core check (pure — testable without flag) ────────────────────────────────

/**
 * Run the resolver shadow check against an already-open SDK session.
 *
 * Returns an array of mismatches (empty = parity). The value-parity check
 * dispatches the ops into the session to read the result back, then UNDOES
 * those mutations via the captured inverse patches before returning — the
 * session ends exactly as it started. This is essential: the session is shared
 * with the cutover path, and a residual shadow mutation would make the
 * subsequent sdkCutoverPersist see before === after and silently fall back to
 * the server path. Read-only; the server path stays authoritative on disk.
 *
 * Exported for unit tests and for the cutover eligibility fallback check.
 */
export function sdkResolverShadowCheck(
  session: Composition,
  hfId: string,
  ops: PatchOperation[],
  sourceContent?: string,
): SdkResolverMismatch[] {
  if (!resolveSnapshot(session, hfId)) {
    // Runtime-node filter: an hf-id absent from the on-disk source the SDK
    // parsed was never in the static DOM — it belongs to an element a
    // composition <script> creates at runtime (e.g. caption word/group spans),
    // which the SDK session cannot model by design. That is NOT a resolver bug,
    // so suppress it. An hf-id PRESENT in source but missing from the session IS
    // a genuine resolver divergence (the v0.6.110 class) — keep emitting that.
    // ponytail: substring match; biases toward keeping signal on a loose hit.
    if (sourceContent !== undefined && !sourceContent.includes(hfId)) return [];

    return [{ kind: "element_not_found", hfId }];
  }

  const shadowable = ops.filter(isShadowableOp);
  if (shadowable.length === 0) return [];

  // Silently skip op batches containing unmapped types — not a resolver bug.
  if (shadowable.some((op) => !MAPPED_OP_TYPES.has(op.type))) return [];

  // Capture the inverse of the shadow dispatch so we can restore the session.
  // `batch` fires a single PatchEvent whose `inversePatches` are already in
  // reverse-apply order (session.ts reverses inside buildPatchEvent), so
  // applyPatches(inverse) undoes the dispatch with no further reordering. If a
  // future SDK refactor ever coalesces batch into a composite with no per-op
  // inverse, this restore breaks — keep batch emitting inverse patches.
  const inverse: JsonPatchOp[] = [];
  const stopCapture = session.on("patch", (e) => inverse.push(...e.inversePatches));
  // restore() runs in `finally` so the patch listener is always removed and the
  // session is always undone — even if checkOpValue throws between dispatch and
  // return. A residual mutation or leaked listener on the shared session is the
  // exact cutover-coupling failure mode this module exists to avoid.
  try {
    try {
      const editOps = patchOpsToSdkEditOps(hfId, shadowable);
      session.batch(() => {
        for (const op of editOps) session.dispatch(op);
      });
    } catch (err) {
      return [{ kind: "dispatch_error", hfId, error: String(err) }];
    }

    const el = resolveSnapshot(session, hfId);
    if (!el) return [{ kind: "element_not_found", hfId }];

    return shadowable
      .map((op) => checkOpValue(op, el, hfId))
      .filter((m): m is SdkResolverMismatch => m !== null);
  } finally {
    stopCapture();
    if (inverse.length > 0) session.applyPatches(inverse);
  }
}
