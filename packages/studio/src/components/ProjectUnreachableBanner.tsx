import { useEffect, useState } from "react";
import { Trans, useTranslation } from "../i18n";
import { StudioBanner } from "./StudioBanner";
import { Button } from "./ui/Button";

interface ServedProject {
  id: string;
  title?: string;
}

interface ProjectUnreachableBannerProps {
  /** The project this tab was opened for and the server cannot resolve. */
  projectId: string;
}

/**
 * Shown when the running Studio cannot resolve this tab's project id.
 *
 * Why this exists: a tab whose project the server does not serve fails every
 * read with a 404, so every edit silently takes the server path and nothing
 * lands. The user sees a normal-looking editor that does not save. Under the
 * CLI-embedded host the cause is almost always that this Studio is serving
 * a *different* project: `hyperframes preview` reuses port 3002, so starting
 * it on another folder takes the port from under an open tab, and the project
 * it was pointed at is untouched on disk.
 *
 * The wording is deliberately narrower than "this project is gone". We can see
 * which project this server serves; we cannot see why it does not serve this
 * one, and nothing here is lost. See
 * `docs/hyperframes/plans/sdk/2026-09-20-stale-project-id-remaining-doors-plan.md` §C.
 */
export function ProjectUnreachableBanner({ projectId }: ProjectUnreachableBannerProps) {
  const { t } = useTranslation();
  const [served, setServed] = useState<ServedProject[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A list we could not read is not evidence of anything, so a failed fetch
    // leaves `served` empty and the banner falls back to the vague wording
    // rather than claiming this Studio serves nothing.
    fetch("/api/projects")
      .then((res) => (res.ok ? res.json() : { projects: [] }))
      .then((data: { projects?: ServedProject[] }) => {
        if (!cancelled) setServed(data.projects ?? []);
      })
      .catch(() => {
        if (!cancelled) setServed([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Withheld until the list arrives: which wording applies is a claim about
  // what this server serves, and guessing it would flash the wrong one.
  if (served === null) return null;

  // Exactly one project served, and it is not this tab's. Under the CLI host
  // that is the whole truth, and it names both sides. With several projects we
  // cannot tell a rename from a deletion, so we do not pretend to.
  const soleProject = served.length === 1 && served[0].id !== projectId ? served[0] : null;
  const servedLabel = soleProject?.title ?? soleProject?.id;

  // Reloading re-runs the mount-time hash check, which rewrites the hash to
  // the project this server actually serves. That is the same fallback a fresh
  // load performs, so the button promises nothing beyond what a reload does.
  return soleProject ? (
    <StudioBanner
      tone="warn"
      actions={
        <Button size="sm" onClick={() => window.location.reload()}>
          {t("shell.projectUnreachable.open", { project: servedLabel })}
        </Button>
      }
    >
      <Trans
        i18nKey="shell.projectUnreachable.sole"
        values={{ served: servedLabel, project: projectId }}
        components={{ b: <strong /> }}
      />
    </StudioBanner>
  ) : (
    <StudioBanner tone="warn">{t("shell.projectUnreachable.generic")}</StudioBanner>
  );
}
