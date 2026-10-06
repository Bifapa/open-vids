import {
  PROJECT_FILE_PARTS,
  expandProjectParts,
  type ChatMessage,
  type ProjectFilePart,
  type ProjectPart,
} from "@hyperframes/agent-protocol";

/**
 * Which other projects an agent may touch in a chat: exactly the ones the user attached with `#` in a message of this
 * chat (the prompt that opened a turn, later messages and steering), and of each one only the parts they ticked. The
 * decision is made here, from the user's own messages, before Studio is asked anything; a project key or name the
 * model made up, or remembered from somewhere else, is refused and never reaches the host. Assistant text, tool
 * results and file contents are never read: this module is fed the chat's messages and looks at the user's reference
 * parts only.
 */

/** A part an attachment can name once `all` is expanded: the five file kinds and the Story. */
export type AttachedPart = ProjectFilePart | "story";

/** One project attached in this chat, with every part the user attached it with (merged over all messages). */
export interface AttachedProject {
  key: string;
  /** The name when it was last attached (display and lookup only). */
  name: string;
  /** Expanded and in the protocol's order; never empty. */
  parts: AttachedPart[];
}

/**
 * The projects attached in this chat: the union over every user message's project references, merged by key (the
 * parts add up, the latest name wins), in order of first attachment. A reference that names no part attaches nothing.
 */
export function chatAttachedProjects(messages: readonly ChatMessage[]): AttachedProject[] {
  const byKey = new Map<string, { name: string; parts: Set<ProjectPart> }>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type !== "reference" || part.reference.kind !== "project") continue;
      const { projectKey, name, parts } = part.reference;
      const entry = byKey.get(projectKey) ?? { name, parts: new Set<ProjectPart>() };
      entry.name = name;
      for (const attached of parts) entry.parts.add(attached);
      byKey.set(projectKey, entry);
    }
  }
  const projects: AttachedProject[] = [];
  for (const [key, entry] of byKey) {
    const parts = expandProjectParts([...entry.parts]);
    if (parts.length > 0) projects.push({ key, name: entry.name, parts });
  }
  return projects;
}

/** Whether the user attached `part` of the project with `key` in this chat. */
export function allows(
  attached: readonly AttachedProject[],
  key: string,
  part: AttachedPart,
): boolean {
  return attached.some((project) => project.key === key && project.parts.includes(part));
}

/** The attached parts that name files (what `import_from_project` may copy). */
export function fileParts(project: AttachedProject): ProjectFilePart[] {
  return PROJECT_FILE_PARTS.filter((part) => project.parts.includes(part));
}

/** `"Summer reel" → "summer-reel"`: how a name is compared when the model passes the folder-style spelling. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** "Summer reel (key 0123…; renders, music)" — what is attached, for the model's refusals and prompts. */
export function describeAttached(project: AttachedProject): string {
  return `"${project.name}" (key ${project.key}; ${project.parts.join(", ")})`;
}

/** "The user attached in this chat: …" / "…has not attached any other project in this chat." */
export function attachedNote(attached: readonly AttachedProject[]): string {
  return attached.length > 0
    ? `The user attached in this chat: ${attached.map(describeAttached).join("; ")}.`
    : "The user has not attached any other project in this chat.";
}

export type AttachedLookup =
  | { ok: true; project: AttachedProject }
  | { ok: false; refusal: string };

/**
 * The attached project the model means by `wanted`: its key, else its name (case-insensitive) or the slug of its
 * name. Anything that is not attached in this chat — a key from another chat, a project the user never attached, a
 * guess — is refused with what IS attached; two attached projects with the same name need the key.
 */
export function findAttached(attached: readonly AttachedProject[], wanted: string): AttachedLookup {
  const text = wanted.trim();
  const byKey = attached.find((project) => project.key === text);
  if (byKey) return { ok: true, project: byKey };
  const lower = text.toLowerCase();
  const slug = slugOf(text);
  const named = attached.filter(
    (project) =>
      project.name.toLowerCase() === lower || (slug !== "" && slugOf(project.name) === slug),
  );
  if (named.length === 1 && named[0]) return { ok: true, project: named[0] };
  if (named.length > 1) {
    return {
      ok: false,
      refusal: `More than one attached project is called "${text}"; pass the key. ${attachedNote(attached)}`,
    };
  }
  return {
    ok: false,
    refusal: `"${text}" is not a project the user attached in this chat, so it is not available to you and nothing was read or copied. You can only use projects the user attaches with # in their message (and only the parts they ticked). ${attachedNote(attached)}`,
  };
}

/**
 * The project an import may copy from: attached in this chat and with at least one file part attached (the Story alone
 * has no files to copy). Refusals say what is attached.
 */
export function guardImport(attached: readonly AttachedProject[], wanted: string): AttachedLookup {
  const found = findAttached(attached, wanted);
  if (!found.ok) return found;
  if (fileParts(found.project).length === 0) {
    return {
      ok: false,
      refusal: `The user attached only the story of ${describeAttached(found.project)}: it has no files you may copy. Use the story outline in your prompt as a reference, or ask the user to attach more parts.`,
    };
  }
  return found;
}
