import { useRef, useState } from "react";
import { Button, Dialog } from "../components/ui";
import type { ActionResult } from "../agent/agentSettingsSlice";
import type { DesignTurnSpec } from "../agent/designTurn";
import { useTranslation } from "../i18n";
import { TextAreaField } from "./DesignFields";

/**
 * "Edit with the agent": the change to make to one library system. The turn saves a new version of it; projects that
 * use the system keep their copy until their user updates them.
 */
export function EditDesignDialog({
  systemId,
  name,
  blocker,
  onStart,
  onClose,
}: {
  systemId: string;
  name: string;
  /** Why the agent cannot take the turn now, or null when it can. */
  blocker: string | null;
  onStart(spec: DesignTurnSpec): Promise<ActionResult>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [instruction, setInstruction] = useState("");
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const canStart = instruction.trim().length > 0 && blocker === null && !starting;
  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    setFailure(null);
    const result = await onStart({ action: "edit", systemId, instruction });
    setStarting(false);
    if (!result.ok) setFailure(result.message);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("studio.design.edit.title", { name })}
      description={t("studio.design.edit.description")}
      initialFocus={textRef}
      className="w-[min(460px,calc(100vw-2rem))]"
      footer={
        <>
          {blocker ? (
            <span className="mr-auto text-xs text-fg-3" role="status">
              {blocker}
            </span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="design-edit-start"
            disabled={!canStart}
            loading={starting}
            onClick={() => void start()}
          >
            {t("studio.design.edit.start")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextAreaField
          label={t("studio.design.edit.label")}
          hint={t("studio.design.edit.hint")}
          placeholder={t("studio.design.edit.placeholder")}
          value={instruction}
          rows={4}
          textareaRef={textRef}
          onChange={setInstruction}
          onSubmit={() => void start()}
        />
        {failure ? (
          <p role="alert" className="m-0 text-xs text-error">
            {failure}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
