import { useId, useState, type FormEvent } from "react";
import {
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  type AddTrustedSourceRequest,
  type ResearchMediaKind,
} from "@hyperframes/agent-protocol";
import { Button, cn, fieldBase, fieldText } from "../components/ui";
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
  const [name, setName] = useState("");
  const [domainsText, setDomainsText] = useState("");
  const [kinds, setKinds] = useState<ResearchMediaKind[]>([...RESEARCH_MEDIA_KINDS]);
  const [problem, setProblem] = useState<string | null>(null);
  const nameId = useId();
  const domainsId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const domains = parseDomains(domainsText);
    if (!name.trim()) return setProblem("Give the source a name.");
    if (domains.length === 0) return setProblem("Add at least one domain, like example.com.");
    if (domains.length > RESEARCH_LIMITS.domainsPerSource) {
      return setProblem(`A source can have at most ${RESEARCH_LIMITS.domainsPerSource} domains.`);
    }
    if (kinds.length === 0) return setProblem("Choose what the source offers.");
    setProblem(null);
    setProblem(await onAdd({ name: name.trim(), domains, kinds }));
  };

  const toggleKind = (kind: ResearchMediaKind, on: boolean) =>
    setKinds((current) =>
      RESEARCH_MEDIA_KINDS.filter((known) => (known === kind ? on : current.includes(known))),
    );

  return (
    <form
      aria-label="Add trusted source"
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-2 rounded-md border border-border-input bg-bg-2 p-2.5"
    >
      <label htmlFor={nameId} className="text-step-10 font-medium text-text-2">
        Name
      </label>
      <div className={fieldBase}>
        <input
          id={nameId}
          value={name}
          maxLength={RESEARCH_LIMITS.nameChars}
          placeholder="City archive"
          onChange={(event) => setName(event.target.value)}
          className={fieldText}
        />
      </div>
      <label htmlFor={domainsId} className="text-step-10 font-medium text-text-2">
        Domains
      </label>
      <textarea
        id={domainsId}
        value={domainsText}
        rows={2}
        placeholder={"archive.example.org, media.example.org"}
        onChange={(event) => setDomainsText(event.target.value)}
        className={cn(fieldBase, "h-auto min-h-12 resize-y py-1.5 leading-snug", fieldText)}
      />
      <span className="text-step-10 text-text-4">
        Separate with commas or new lines. A domain covers its subdomains.
      </span>
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="mb-1 text-step-10 font-medium text-text-2">Offers</legend>
        {RESEARCH_MEDIA_KINDS.map((kind) => (
          <label key={kind} className="flex items-center gap-1.5 text-step-11 text-text-1">
            <input
              type="checkbox"
              checked={kinds.includes(kind)}
              onChange={(event) => toggleKind(kind, event.target.checked)}
              className="accent-accent"
            />
            {MEDIA_KIND_LABELS[kind]}
          </label>
        ))}
      </fieldset>
      {problem && (
        <p role="alert" className="text-step-10 text-danger">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          Add source
        </Button>
      </div>
    </form>
  );
}
