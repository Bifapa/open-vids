import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { ExternalProjectEntry, ProjectPart } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { NEW_CHAT_DRAFT } from "../../agent/agentDraftChat";
import { projectMentionAttachment } from "../../agent/composerAttachments";
import { activeMention, applyMentionToken } from "../../agent/composerMentions";
import { studioCrossProjectClient, type CrossProjectClient } from "../../agent/crossProjectClient";
import {
  PROJECT_MENU_LIMIT,
  chosenParts,
  matchMentionProjects,
  projectPartRows,
  projectSlug,
  projectSlugs,
  toggleProjectPart,
} from "../../agent/projectMentions";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";
import { isImeKeyEvent } from "../../utils/imeKey";
import type { AssetMentions } from "./AssetMentionMenu";
import { ProjectListMenu, ProjectPartsMenu, type PartsView } from "./ProjectMentionMenu";

const NO_PROJECTS: readonly ExternalProjectEntry[] = [];

/** Step 2 of a `#` mention: the checklist of the picked project's parts. */
interface PartsStep {
  /** `start:query` of the `#` token it belongs to: typing in the token (or leaving it) ends the step. */
  tokenKey: string;
  project: ExternalProjectEntry;
  slug: string;
  view: PartsView;
  selected: ReadonlySet<ProjectPart>;
  cursor: number;
}

/**
 * `#project` in the prompt: while the caret is inside a `#` token the other projects are offered;
 * picking one opens a checklist of its parts (renders, music, …), and confirming writes `#<slug> ` into the draft
 * and attaches ONE project chip. The list is fetched when the first `#` is typed and again every time a `#` opens
 * the popup anew (the cached one shows meanwhile). The popup only exists while there is something to show: while
 * the list loads, when the server cannot be reached, and when no project matches (`#ff0000`, `#1`) there is none.
 * Escape closes the popup for that token (from the checklist it steps back to the list first); it comes back
 * with a new `#` or a caret moved into another one.
 */
export function useProjectMentions({
  areaRef,
  draft,
  disabled,
  setDraft,
  client = studioCrossProjectClient,
}: {
  areaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  disabled: boolean;
  setDraft: (text: string) => void;
  client?: CrossProjectClient;
}): AssetMentions {
  const listId = useId();
  const projectId = useStudioShellContextOptional()?.projectId;
  const enabled = projectId !== undefined && projectId !== "";
  const draftKey = useAgentStore((state) => state.chatId ?? NEW_CHAT_DRAFT);
  const attachProject = useAgentStore((state) => state.attachProject);

  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // The `#` position of the token the user closed with Escape.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState({ key: "", index: 0 });
  // The other projects of the open project, null until a list has loaded; kept (and refreshed) for the life of
  // the composer, and dropped when the composer moves to another project (each list leaves its own project out).
  const [loaded, setLoaded] = useState<{
    projectId: string;
    list: readonly ExternalProjectEntry[];
  } | null>(null);
  const projects = loaded !== null && loaded.projectId === projectId ? loaded.list : null;
  const [step, setStep] = useState<PartsStep | null>(null);

  const mention = useMemo(
    () => (enabled ? activeMention(draft, caret, "#") : null),
    [enabled, draft, caret],
  );
  const key = mention ? `${mention.start}:${mention.query}` : "";
  const wantsList = !disabled && focused && mention !== null && mention.start !== dismissed;

  // The list loads when a `#` token opens and reloads when one opens again. A failure leaves what is cached.
  useEffect(() => {
    if (!wantsList || !projectId) return;
    const request = new AbortController();
    client.projects(projectId, request.signal).then(
      (list) => {
        if (!request.signal.aborted) setLoaded({ projectId, list });
      },
      () => {
        // A list that cannot be read leaves the popup closed.
      },
    );
    return () => request.abort();
  }, [wantsList, projectId, client]);

  const slugs = useMemo(() => projectSlugs(projects ?? NO_PROJECTS), [projects]);
  const matches = useMemo(
    () =>
      mention && projects
        ? matchMentionProjects(projects, slugs, mention.query, PROJECT_MENU_LIMIT)
        : NO_PROJECTS,
    [mention, projects, slugs],
  );

  const partsStep = wantsList && step !== null && step.tokenKey === key ? step : null;
  const listOpen = wantsList && partsStep === null && matches.length > 0;
  const open = partsStep !== null || listOpen;
  const highlight =
    highlighted.key === key ? Math.max(0, Math.min(highlighted.index, matches.length - 1)) : 0;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const track = (area: HTMLTextAreaElement) => {
    if (!enabled) return;
    setCaret(area.selectionStart);
    const token = activeMention(area.value, area.selectionStart, "#");
    if (token === null) setDismissed(null);
    const tokenKey = token ? `${token.start}:${token.query}` : "";
    setStep((current) => (current !== null && current.tokenKey === tokenKey ? current : null));
  };

  // A pick moves the caret after the inserted text once React has written the new value.
  const caretAfterPick = useRef<number | null>(null);
  useLayoutEffect(() => {
    const target = caretAfterPick.current;
    const area = areaRef.current;
    if (target === null || !area) return;
    caretAfterPick.current = null;
    area.setSelectionRange(target, target);
  }, [draft, areaRef]);

  const summaryRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = summaryRequest;
    return () => request.current?.abort();
  }, []);

  /** Step 1 → 2: the project is picked, its part counts are asked for. */
  const pick = (project: ExternalProjectEntry) => {
    if (!mention || !projectId) return;
    const tokenKey = key;
    summaryRequest.current?.abort();
    const request = new AbortController();
    summaryRequest.current = request;
    setStep({
      tokenKey,
      project,
      slug: slugs.get(project.key) ?? projectSlug(project.name),
      view: { status: "loading" },
      selected: new Set(),
      cursor: 0,
    });
    const show = (view: PartsView) =>
      setStep((current) =>
        current !== null && current.tokenKey === tokenKey && current.project.key === project.key
          ? { ...current, view }
          : current,
      );
    client.summary(projectId, project.key, request.signal).then(
      (summary) => {
        if (!request.signal.aborted) show({ status: "ready", rows: projectPartRows(summary) });
      },
      () => {
        if (!request.signal.aborted) show({ status: "failed" });
      },
    );
  };

  const toggle = (part: ProjectPart) =>
    setStep((current) =>
      current !== null && current.view.status === "ready"
        ? { ...current, selected: toggleProjectPart(current.selected, part, current.view.rows) }
        : current,
    );

  const moveCursor = (to: (cursor: number, count: number) => number) =>
    setStep((current) =>
      current !== null && current.view.status === "ready"
        ? { ...current, cursor: to(current.cursor, current.view.rows.length) }
        : current,
    );

  const partsReady = partsStep !== null && partsStep.view.status === "ready";
  const canConfirm = partsStep !== null && partsReady && chosenParts(partsStep.selected).length > 0;

  /** Step 2 → done: `#<slug> ` goes into the draft, and the project becomes one chip. */
  const confirm = () => {
    if (!partsStep || !partsReady || !mention) return;
    const parts = chosenParts(partsStep.selected);
    if (parts.length === 0) return;
    const token = `#${partsStep.slug}`;
    const chip = projectMentionAttachment({
      projectKey: partsStep.project.key,
      name: partsStep.project.name,
      parts,
      mentionToken: token,
    });
    // A full draft says so in a notice and keeps the popup open.
    if (!attachProject(draftKey, chip)) return;
    const next = applyMentionToken(draft, mention, caret, token);
    caretAfterPick.current = next.caret;
    setCaret(next.caret);
    setStep(null);
    setDraft(next.text);
  };

  const handlePartsKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key === "Escape") {
      event.preventDefault();
      setStep(null);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      moveCursor((cursor, count) => (cursor + delta + count) % count);
      return true;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (partsStep?.view.status === "ready") {
        const row = partsStep.view.rows[partsStep.cursor];
        if (row) toggle(row.part);
      }
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      confirm();
      return true;
    }
    return false;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || isImeKeyEvent(event.nativeEvent)) return false;
    if (partsStep) return handlePartsKey(event);
    if (event.key === "Escape") {
      event.preventDefault();
      if (mention) setDismissed(mention.start);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted({ key, index: (highlight + delta + matches.length) % matches.length });
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      const project = matches[highlight];
      if (project === undefined) return false;
      event.preventDefault();
      pick(project);
      return true;
    }
    return false;
  };

  let menu: ReactNode = null;
  if (partsStep) {
    menu = (
      <ProjectPartsMenu
        listId={listId}
        optionId={optionId}
        name={partsStep.project.name}
        view={partsStep.view}
        selected={partsStep.selected}
        cursor={partsStep.cursor}
        canConfirm={canConfirm}
        onCursor={(index) => moveCursor(() => index)}
        onToggle={toggle}
        onConfirm={confirm}
        onBack={() => setStep(null)}
      />
    );
  } else if (listOpen) {
    menu = (
      <ProjectListMenu
        listId={listId}
        optionId={optionId}
        projects={matches}
        slugs={slugs}
        highlight={highlight}
        onHighlight={(index) => setHighlighted({ key, index })}
        onPick={pick}
      />
    );
  }

  let activeOption: string | undefined;
  if (listOpen) activeOption = optionId(highlight);
  else if (partsStep?.view.status === "ready") activeOption = optionId(partsStep.cursor);

  return {
    menu,
    trackChange: track,
    handleKeyDown,
    fieldProps: {
      role: open ? "combobox" : undefined,
      "aria-autocomplete": open ? "list" : undefined,
      "aria-expanded": open ? true : undefined,
      "aria-controls": listOpen || partsStep?.view.status === "ready" ? listId : undefined,
      "aria-activedescendant": activeOption,
      onSelect: (event) => track(event.currentTarget),
      onKeyUp: (event) => track(event.currentTarget),
      onClick: (event) => track(event.currentTarget),
      onFocus: (event) => {
        if (!enabled) return;
        setFocused(true);
        track(event.currentTarget);
      },
      onBlur: () => {
        if (enabled) setFocused(false);
      },
    },
  };
}
