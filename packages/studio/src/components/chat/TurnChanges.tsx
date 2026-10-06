import type { TurnSummary } from "@hyperframes/agent-protocol";
import { useTranslation, type TranslationKey } from "../../i18n";
import { Badge } from "../ui/Status";

/**
 * What a turn's tools applied, by kind — the runtime's vocabulary (`TurnSummary.changes`). The count is the number of
 * successful operations of that kind, so the label names the kind, not the number of clips or files.
 */
const CHANGE_LABELS: Record<string, TranslationKey> = {
  add_clip: "chat.turn.change.add_clip",
  remove_clip: "chat.turn.change.remove_clip",
  move_clip: "chat.turn.change.move_clip",
  trim_clip: "chat.turn.change.trim_clip",
  update_clip: "chat.turn.change.update_clip",
  captions: "chat.turn.change.captions",
  audio: "chat.turn.change.audio",
  canvas: "chat.turn.change.canvas",
  story_edit: "chat.turn.change.story_edit",
  story_build: "chat.turn.change.story_build",
  rough_cut: "chat.turn.change.rough_cut",
  import: "chat.turn.change.import",
  web_save: "chat.turn.change.web_save",
  file_edit: "chat.turn.change.file_edit",
  render: "chat.turn.change.render",
  design_attach: "studio.design.chat.change.attach",
};

/**
 * "Clips added: 3 · Captions: 1" under a revertible turn, so the user knows what Revert would undo without opening
 * files. A kind this build does not know reads "Other changes".
 */
export function TurnChanges({ turn }: { turn: TurnSummary }) {
  const { t } = useTranslation();
  const changes = turn.changes ?? [];
  if (changes.length === 0) return null;
  return (
    <ul
      aria-label={t("chat.turn.changesLabel")}
      data-testid="turn-changes"
      className="flex basis-full flex-wrap gap-1"
    >
      {changes.map(({ kind, count }) => (
        <li key={kind} data-change-kind={kind}>
          <Badge size="sm" tone="neutral" className="tabular-nums">
            {t("chat.turn.changeBadge", {
              label: t(CHANGE_LABELS[kind] ?? "chat.turn.change.other"),
              count,
            })}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
