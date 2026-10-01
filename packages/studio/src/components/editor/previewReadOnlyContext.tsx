import { useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { createStableContext } from "../../utils/hmrStableContext";

interface PreviewReadOnlyValue {
  readOnly: boolean;
  /** Host-supplied reason; null means the default one. */
  reason: string | null;
}

// Real default (not a throwing required-provider context): most existing
// mounts render with no wrapper at all and must stay editable, exactly as today.
const PreviewReadOnlyContext = createStableContext<PreviewReadOnlyValue>("PreviewReadOnlyContext", {
  readOnly: false,
  reason: null,
});

export function PreviewReadOnlyProvider({
  readOnly,
  reason,
  children,
}: {
  readOnly: boolean;
  reason?: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ readOnly, reason: reason ?? null }), [readOnly, reason]);
  return <PreviewReadOnlyContext value={value}>{children}</PreviewReadOnlyContext>;
}

export function usePreviewReadOnly(): boolean {
  return useContext(PreviewReadOnlyContext).readOnly;
}

/** Short host-supplied text for why a hand-edit control is disabled. */
export function usePreviewReadOnlyReason(): string {
  const { t } = useTranslation();
  return useContext(PreviewReadOnlyContext).reason ?? t("editor.readOnly.default");
}

interface ManualEditCapabilities {
  canApplyManualOffset: boolean;
  canApplyManualSize: boolean;
  canApplyManualRotation: boolean;
}

/**
 * The manual X/Y/W/H/rotation fields' disabled state: capability, or preview read-only.
 * Call unconditionally, even with no selection — `capabilities` may be null/undefined.
 */
export function useManualEditDisabledFlags(
  capabilities: ManualEditCapabilities | null | undefined,
) {
  const { readOnly } = useContext(PreviewReadOnlyContext);
  return {
    manualOffsetEditingDisabled: !capabilities?.canApplyManualOffset || readOnly,
    manualSizeEditingDisabled: !capabilities?.canApplyManualSize || readOnly,
    manualRotationEditingDisabled: !capabilities?.canApplyManualRotation || readOnly,
  };
}
