import { useRef, useState } from "react";
import type { DesignSourceKind } from "@hyperframes/agent-protocol";
import { Button, Dialog, Select, cn } from "../components/ui";
import type { ActionResult } from "../agent/agentSettingsSlice";
import type { DesignTurnSpec } from "../agent/designTurn";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  availableSources,
  createSpecOf,
  effectiveFields,
  websiteAddress,
  type CreateFields,
  type DesignHostCapabilities,
} from "./designCreate";
import { TextAreaField, TextField } from "./DesignFields";

const SOURCE_COPY = {
  scratch: {
    label: "studio.design.source.scratch",
    description: "studio.design.source.scratch.description",
  },
  project: {
    label: "studio.design.source.project",
    description: "studio.design.source.project.description",
  },
  video: {
    label: "studio.design.source.video",
    description: "studio.design.source.video.description",
  },
  website: {
    label: "studio.design.source.website",
    description: "studio.design.source.website.description",
  },
  external_project: {
    label: "studio.design.source.external",
    description: "studio.design.source.external.description",
  },
} as const satisfies Record<
  DesignSourceKind,
  { label: TranslationKey; description: TranslationKey }
>;

/**
 * "Create design system": where it comes from (a brief, this project, a video, a website, and — when the host lists
 * them — another project) and what that source needs. Starting it sends a normal chat turn with the design action;
 * the agent's progress is in the chat.
 */
export function CreateDesignDialog({
  initialSource,
  videos,
  videosLoaded,
  capabilities,
  blocker,
  onStart,
  onClose,
}: {
  initialSource: DesignSourceKind;
  /** The project's video files (project-relative), for the "From a video" source. */
  videos: readonly string[];
  /** The project's file list has been read; until then an empty `videos` only means "not known yet". */
  videosLoaded: boolean;
  capabilities: DesignHostCapabilities;
  /** Why the agent cannot take the turn now, or null when it can. */
  blocker: string | null;
  onStart(spec: DesignTurnSpec): Promise<ActionResult>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const sources = availableSources(capabilities);
  const [source, setSource] = useState<DesignSourceKind>(
    sources.includes(initialSource) ? initialSource : "scratch",
  );
  const [chosen, setChosen] = useState<CreateFields>({
    brief: "",
    notes: "",
    video: "",
    url: "",
    projectKey: "",
  });
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<CreateFields>) => setChosen((current) => ({ ...current, ...patch }));
  // The lists of videos and projects arrive after the dialog opens: what is picked is worked out from what is there.
  const fields = effectiveFields(chosen, videos, capabilities);

  const spec = createSpecOf(source, fields, capabilities);
  const urlInvalid =
    source === "website" && fields.url.trim() !== "" && !websiteAddress(fields.url);
  const canStart = spec !== null && blocker === null && !starting;
  const start = async () => {
    if (!spec || !canStart) return;
    setStarting(true);
    setFailure(null);
    const result = await onStart(spec);
    setStarting(false);
    if (!result.ok) setFailure(result.message);
  };

  const notes = (
    <TextAreaField
      label={t("studio.design.notes.label")}
      hint={t("studio.design.notes.hint")}
      value={fields.notes}
      rows={3}
      onChange={(notes) => set({ notes })}
      onSubmit={() => void start()}
    />
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("studio.design.create.title")}
      description={t("studio.design.create.description")}
      initialFocus={source === "scratch" ? briefRef : undefined}
      className="w-[min(480px,calc(100vw-2rem))]"
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
            data-testid="design-create-start"
            disabled={!canStart}
            loading={starting}
            onClick={() => void start()}
          >
            {t("studio.design.create.start")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div
          role="radiogroup"
          aria-label={t("studio.design.source.label")}
          className="flex flex-col gap-px"
        >
          {sources.map((kind) => (
            <label
              key={kind}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-sm px-1.5 py-1 hover:bg-surface-1",
                kind === source && "bg-surface-1",
              )}
            >
              <input
                type="radio"
                name="design-source"
                value={kind}
                checked={kind === source}
                onChange={() => setSource(kind)}
                className="mt-0.5 size-3.5 shrink-0 accent-accent"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium text-fg">{t(SOURCE_COPY[kind].label)}</span>
                <span className="text-xs leading-[15px] text-fg-3">
                  {t(SOURCE_COPY[kind].description)}
                </span>
              </span>
            </label>
          ))}
        </div>

        {source === "scratch" ? (
          <TextAreaField
            label={t("studio.design.brief.label")}
            hint={t("studio.design.brief.hint")}
            placeholder={t("studio.design.brief.placeholder")}
            value={fields.brief}
            rows={5}
            textareaRef={briefRef}
            onChange={(brief) => set({ brief })}
            onSubmit={() => void start()}
          />
        ) : null}

        {source === "video" ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-fg-2">
              {t("studio.design.video.label")}
            </span>
            {videos.length > 0 ? (
              <Select
                label={t("studio.design.video.label")}
                value={fields.video}
                options={videos.map((path) => ({ value: path, label: path }))}
                onCommit={(video) => set({ video })}
              />
            ) : videosLoaded ? (
              <p className="m-0 text-xs text-fg-3">{t("studio.design.video.none")}</p>
            ) : (
              <p className="m-0 text-xs text-fg-3">{t("studio.design.video.loading")}</p>
            )}
            <p className="m-0 text-xs leading-[15px] text-fg-3">{t("studio.design.video.hint")}</p>
          </div>
        ) : null}

        {source === "website" ? (
          <TextField
            type="url"
            label={t("studio.design.website.label")}
            hint={t("studio.design.website.hint")}
            error={urlInvalid ? t("studio.design.website.invalid") : null}
            placeholder="https://example.com"
            value={fields.url}
            onChange={(url) => set({ url })}
            onSubmit={() => void start()}
          />
        ) : null}

        {source === "external_project" && capabilities.externalProjects ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-fg-2">
              {t("studio.design.external.label")}
            </span>
            <Select
              label={t("studio.design.external.label")}
              value={fields.projectKey}
              options={capabilities.externalProjects.map((project) => ({
                value: project.key,
                label: project.name,
              }))}
              onCommit={(projectKey) => set({ projectKey })}
            />
          </div>
        ) : null}

        {source !== "scratch" ? notes : null}

        {failure ? (
          <p role="alert" className="m-0 text-xs text-error">
            {failure}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
