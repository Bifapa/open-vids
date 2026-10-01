import { Trans, useTranslation } from "../i18n";
import { StudioBanner } from "./StudioBanner";
import { Button } from "./ui/Button";
import { useDockLayoutStore } from "./dock/dockLayoutStore";

interface CompositionMissingBannerProps {
  /** The composition this tab has open, that the server can no longer find. */
  path: string;
}

/**
 * Shown when the currently open composition's file has vanished from disk
 * mid-session — the `absent` read reason (#4325): the file tree listed it and
 * the read cannot get it.
 *
 * Distinct from `ProjectUnreachableBanner`: there the whole PROJECT fails to
 * resolve; here the project is fine and this one file inside it is not. Proven
 * 2026-09-23 to be a stale tree, not a placeholder or a path-encoding gap:
 * `refreshFileTree` only ran after Studio's own file operations, so an agent
 * removing or replacing a composition updated the preview and the SDK session
 * but never the listing — the file stayed clickable, and every edit through
 * it failed silently, with nothing to tell the user why. The tree is now
 * refreshed as soon as this fires (`useSdkSession`'s `onAbsentRead`); this
 * banner is the only thing that explains the failure while that catches up.
 */
export function CompositionMissingBanner({ path }: CompositionMissingBannerProps) {
  const { t } = useTranslation();
  return (
    <StudioBanner
      tone="warn"
      actions={
        <Button
          size="sm"
          onClick={() => useDockLayoutStore.getState().activatePanel("compositions")}
        >
          {t("shell.compositionMissing.showAll")}
        </Button>
      }
    >
      <Trans
        i18nKey="shell.compositionMissing.message"
        values={{ path }}
        components={{ b: <strong /> }}
      />
    </StudioBanner>
  );
}
