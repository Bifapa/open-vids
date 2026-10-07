import { useMemo, type ReactNode } from "react";
import { ArrowsClockwise, Check, LinkSimple, Palette } from "@phosphor-icons/react";
import type { ChatState, TurnSummary } from "@hyperframes/agent-protocol";
import { useDesignStore, useDesignStoreApi } from "../../design/designContext";
import { savedDesignsOfTurn, type SavedDesign } from "../../design/designSaved";
import { useTranslation } from "../../i18n";
import { Badge, Button, cn } from "../ui";
import { chatMeasureWide, noteBox } from "./chatStyles";

/** «Design system · create» beside «You» on a prompt that started a design action (like the Story tag). */
export function DesignTurnTag({ turn }: { turn: TurnSummary | undefined }) {
  const { t } = useTranslation();
  if (!turn?.designAction) return null;
  return (
    <Badge size="sm" data-testid="design-turn-tag">
      {t(
        turn.designAction === "create"
          ? "studio.design.chat.tag.create"
          : "studio.design.chat.tag.edit",
      )}
    </Badge>
  );
}

/**
 * Under the reply of a finished design turn: the system it saved to the library, and one click to put it on this
 * project — «Attach to this project», or, for a system the project already carries in an older version, an explicit
 * update. Nothing is attached or updated by itself.
 */
export function DesignSavedCards({ chat, turn }: { chat: ChatState; turn: TurnSummary }) {
  const saved = useMemo(
    () => (turn.status === "completed" ? savedDesignsOfTurn(chat, turn) : []),
    [chat, turn],
  );
  if (saved.length === 0) return null;
  return (
    <>
      {saved.map((design) => (
        <DesignSavedCard key={design.id} design={design} />
      ))}
    </>
  );
}

function DesignSavedCard({ design }: { design: SavedDesign }) {
  const { t } = useTranslation();
  const store = useDesignStoreApi();
  const state = useDesignStore((s) => s.project.state);
  const mutation = useDesignStore((s) => s.mutation);
  const notice = useDesignStore((s) => s.notice);

  const attached = state?.attached?.id === design.id ? state.attached : null;
  const library = state?.updateAvailable === true ? state.library : null;
  const busy = mutation !== null;
  // A failure belongs to the button that was pressed: the popover's own Detach or another card's Attach is not this card's.
  let failure: string | null = null;
  if (notice) {
    const failed = notice.mutation;
    const mine =
      attached === null
        ? failed.kind === "attach" && failed.id === design.id
        : library !== null && failed.kind === "update";
    if (mine) failure = notice.message;
  }

  let note: string;
  let action: ReactNode;
  if (attached === null) {
    note = t("studio.design.chat.saved.attachNote");
    action = (
      <Button
        size="sm"
        variant="primary"
        data-testid="design-saved-attach"
        disabled={state === null || busy}
        loading={mutation?.kind === "attach" && mutation.id === design.id}
        icon={<LinkSimple size={12} aria-hidden />}
        onClick={() => void store.getState().attach(design.id)}
      >
        {t("studio.design.chat.attach")}
      </Button>
    );
  } else if (library !== null) {
    const newer = library.version > attached.version;
    note = newer
      ? t("studio.design.chat.saved.stale", { current: attached.version, latest: library.version })
      : t("studio.design.update.recreated", {
          name: library.name,
          current: attached.version,
          latest: library.version,
        });
    action = (
      <Button
        size="sm"
        variant="secondary"
        data-testid="design-saved-update"
        disabled={busy}
        loading={mutation?.kind === "update"}
        icon={<ArrowsClockwise size={12} aria-hidden />}
        onClick={() => void store.getState().update()}
      >
        {newer
          ? t("studio.design.update.button", { version: library.version })
          : t("studio.design.update.replace", { version: library.version })}
      </Button>
    );
  } else {
    note = t("studio.design.chat.saved.attached", { version: attached.version });
    action = (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-2">
        <Check size={12} weight="bold" aria-hidden />
        {t("studio.design.library.attached")}
      </span>
    );
  }

  return (
    <section
      aria-label={t("studio.design.chat.saved.label", { name: design.name })}
      data-testid="design-saved-card"
      className={cn(noteBox, chatMeasureWide, "gap-2")}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Palette size={14} aria-hidden className="mt-px shrink-0 text-fg-3" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-fg [overflow-wrap:anywhere]">
            {t("studio.design.chat.saved.title", { name: design.name })}
          </span>
          <span className="text-xs text-fg-3">{note}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {action}
        {failure ? (
          <span role="alert" className="text-xs text-error">
            {failure}
          </span>
        ) : null}
      </div>
    </section>
  );
}
