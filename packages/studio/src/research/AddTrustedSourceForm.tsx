import { useId, useState, type FormEvent } from "react";
import {
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  type AddTrustedSourceRequest,
  type ResearchMediaKind,
} from "@hyperframes/agent-protocol";
import { Button, cn, fieldBase, fieldText } from "../components/ui";
import { useTranslation } from "../i18n";
import { MEDIA_KIND_LABELS } from "./licenseLabels";

/** Domains as the user typed them: split on commas, whitespace and new lines, duplicates dropped. */
export function parseDomains(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((domain) => domain.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * A user-defined trusted website: a name, the domains its pages and media live on, and what it offers. The server
 * normalizes the domains; Research then searches the site through the web search backend and reads its pages.
 */
export function AddTrustedSourceForm({
  pending,
  onAdd,
  onCancel,
}: {
  pending: boolean;
  /** Resolves to the server's refusal (shown by the fields), or null when it accepted the source. */
  onAdd: (request: AddTrustedSourceRequest) => Promise<string | null>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [domainsText, setDomainsText] = useState("");
  const [kinds, setKinds] = useState<ResearchMediaKind[]>([...RESEARCH_MEDIA_KINDS]);
  const [problem, setProblem] = useState<string | null>(null);
  const nameId = useId();
  const domainsId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const domains = parseDomains(domainsText);
    if (!name.trim()) return setProblem(t("research.add.needName"));
    if (domains.length === 0) return setProblem(t("research.add.needDomain"));
    if (domains.length > RESEARCH_LIMITS.domainsPerSource) {
      return setProblem(
        t("research.add.tooManyDomains", { max: RESEARCH_LIMITS.domainsPerSource }),
      );
    }
    if (kinds.length === 0) return setProblem(t("research.add.needKind"));
    setProblem(null);
    setProblem(await onAdd({ name: name.trim(), domains, kinds }));
  };

  const toggleKind = (kind: ResearchMediaKind, on: boolean) =>
    setKinds((current) =>
      RESEARCH_MEDIA_KINDS.filter((known) => (known === kind ? on : current.includes(known))),
    );

  return (
    <form
      aria-label={t("research.add.formLabel")}
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-1.5"
    >
      <label htmlFor={nameId} className="text-xs text-fg-3">
        {t("research.add.name")}
      </label>
      <div className={fieldBase}>
        <input
          id={nameId}
          value={name}
          maxLength={RESEARCH_LIMITS.nameChars}
          placeholder={t("research.add.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
          className={fieldText}
        />
      </div>
      <label htmlFor={domainsId} className="mt-0.5 text-xs text-fg-3">
        {t("research.add.domains")}
      </label>
      <textarea
        id={domainsId}
        value={domainsText}
        rows={2}
        placeholder={"archive.example.org, media.example.org"}
        onChange={(event) => setDomainsText(event.target.value)}
        className={cn(
          fieldBase,
          "h-auto min-h-12 resize-y py-1.5 font-mono text-num leading-snug",
          fieldText,
        )}
      />
      <span className="text-xs text-fg-3">{t("research.add.domainsHint")}</span>
      <fieldset className="mt-0.5 flex flex-wrap items-center gap-3">
        <legend className="mb-1 text-xs text-fg-3">{t("research.add.offers")}</legend>
        {RESEARCH_MEDIA_KINDS.map((kind) => (
          <label key={kind} className="flex items-center gap-1.5 text-sm text-fg">
            <input
              type="checkbox"
              checked={kinds.includes(kind)}
              onChange={(event) => toggleKind(kind, event.target.checked)}
              className="accent-accent"
            />
            {t(MEDIA_KIND_LABELS[kind])}
          </label>
        ))}
      </fieldset>
      {problem && (
        <p role="alert" className="text-xs text-error">
          {problem}
        </p>
      )}
      <div className="mt-0.5 flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t("research.add.submit")}
        </Button>
      </div>
    </form>
  );
}
