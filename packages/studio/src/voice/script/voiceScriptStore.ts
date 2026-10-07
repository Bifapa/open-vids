import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  VoiceCheckRequest,
  VoiceCheckResult,
  VoiceErrorCode,
  VoiceLine,
  VoiceLineInput,
  VoiceScriptIssue,
  VoiceScriptView,
  VoiceSynthesisResult,
  VoiceTake,
} from "@hyperframes/agent-protocol";
import { t } from "../../i18n";
import { VoiceApiError, type VoiceClient } from "../voiceClient";

/** What a change answers: the value the service now holds, or why it was refused (nothing was changed). */
export type VoiceResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      message: string;
      code: VoiceErrorCode | null;
      /** A dialect violation's findings: the script has to change before anything is paid. */
      issues: VoiceScriptIssue[];
    };

/** What a finished generation hands back: the service's answer, and the take each line played before it. */
export interface VoiceGeneration {
  result: VoiceSynthesisResult;
  previousTakeIds: Readonly<Record<string, string | null>>;
}

/** A generation in flight: what it is for and how far it has got. */
export interface VoiceJob {
  requestId: string;
  /** The lines asked for; null is every line without a current take. */
  lineIds: readonly string[] | null;
  done: number;
  total: number;
  /** The line being generated now. */
  lineId: string | null;
  /** While the provider's per-minute limit is waited out: when the request asks again (epoch ms). */
  waitingUntil: number | null;
  cancelling: boolean;
}

export interface VoiceScriptState {
  projectId: string | null;
  /** Null until the first read. */
  view: VoiceScriptView | null;
  loading: boolean;
  loadError: string | null;
  /** A script, voice or take change is on its way. */
  writing: boolean;
  job: VoiceJob | null;
  /** The dialect check of the whole script, as it last answered; null before it, or while no voice is chosen. */
  check: VoiceCheckResult | null;

  /** Points the store at a project (a no-op for the one it already holds) and reads its script. */
  open(projectId: string | null): void;
  reload(): Promise<void>;
  /**
   * Replaces the script's lines with what `change` makes of the current ones. Every line travels with its id, text,
   * speaker text and style, so its takes survive; lines the change leaves out are removed.
   */
  save(
    change: (lines: VoiceLineInput[]) => VoiceLineInput[],
    language?: string | null,
  ): Promise<VoiceResult<VoiceScriptView>>;
  setVoice(presetId: string | null): Promise<VoiceResult<VoiceScriptView>>;
  /** Picks one of the line's takes. Nothing is paid: the take already exists. */
  selectTake(lineId: string, takeId: string): Promise<VoiceResult<VoiceScriptView>>;
  /**
   * The dialect check and the estimate for `lineIds` (every line when absent). `force` asks what making a new take of
   * lines that already have a current one would cost (Regenerate). Nothing is paid or written.
   */
  estimate(
    lineIds?: readonly string[],
    options?: { force?: boolean },
  ): Promise<VoiceResult<VoiceCheckResult>>;
  /** Checks the whole script now and keeps the answer in `check`. */
  checkScript(): Promise<void>;
  /** Checks the whole script soon, once, when it changed since the last check. */
  scheduleCheck(): void;
  /**
   * Generates the lines (every line without a current take when `lineIds` is absent); `force` makes a new take of
   * lines that already have a current one (Regenerate). The service selects each new take.
   */
  generate(options: {
    lineIds?: readonly string[];
    force: boolean;
  }): Promise<VoiceResult<VoiceGeneration>>;
  cancel(): Promise<void>;
}

export type VoiceScriptStore = StoreApi<VoiceScriptState>;

const POLL_MS = 500;
const CHECK_DEBOUNCE_MS = 350;

/** The take a line plays now. */
export function selectedTakeOf(
  line: Pick<VoiceLine, "takes" | "selectedTakeId">,
): VoiceTake | null {
  return line.takes.find((take) => take.id === line.selectedTakeId) ?? null;
}

/** The lines as the service takes them back: nothing the user did not edit is lost. */
export function lineInputs(lines: readonly VoiceLine[]): VoiceLineInput[] {
  return lines.map((line) => ({
    id: line.id,
    text: line.text,
    speakerText: line.speakerText,
    style: line.style,
  }));
}

function refusal<T>(error: unknown, fallback: string): VoiceResult<T> {
  if (error instanceof VoiceApiError) {
    return {
      ok: false,
      message: error.message || fallback,
      code: error.code,
      issues: error.issues ?? [],
    };
  }
  return {
    ok: false,
    message: error instanceof Error && error.message ? error.message : fallback,
    code: null,
    issues: [],
  };
}

/** What the dialect check looks at: the voice and every line's spoken text and style. */
function checkSignature(view: VoiceScriptView): string {
  return JSON.stringify([
    view.voice?.id ?? null,
    view.voice?.model ?? null,
    view.lines.map((line) => [line.id, line.speakerText, line.style]),
  ]);
}

let requestSequence = 0;

export function createVoiceScriptStore(client: VoiceClient): VoiceScriptStore {
  return createStore<VoiceScriptState>()((set, get) => {
    /** Bumped when the project changes, so an answer that arrives for the old one is dropped. */
    let epoch = 0;
    let writes: Promise<unknown> = Promise.resolve();
    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    let checkedSignature: string | null = null;

    const projectOf = (): string | null => get().projectId;

    /** One write at a time: each reads the script the previous one left. */
    const write = <T>(
      task: (projectId: string, view: VoiceScriptView) => Promise<T>,
      fallback: string,
    ): Promise<VoiceResult<T>> => {
      const run = async (): Promise<VoiceResult<T>> => {
        const projectId = projectOf();
        const view = get().view;
        if (projectId === null || view === null) {
          return refusal(new Error(t("voice.panel.notLoaded")), fallback);
        }
        const mine = epoch;
        set({ writing: true });
        try {
          const value = await task(projectId, get().view ?? view);
          return { ok: true, value };
        } catch (error) {
          return refusal(error, fallback);
        } finally {
          if (mine === epoch) set({ writing: false });
        }
      };
      const queued = writes.then(run, run);
      writes = queued;
      return queued;
    };

    const adopt = (view: VoiceScriptView, mine: number): VoiceScriptView => {
      if (mine === epoch) set({ view });
      return view;
    };

    return {
      projectId: null,
      view: null,
      loading: false,
      loadError: null,
      writing: false,
      job: null,
      check: null,

      open(projectId) {
        if (get().projectId === projectId) {
          if (projectId !== null && get().view === null && !get().loading) void get().reload();
          return;
        }
        epoch += 1;
        clearTimeout(checkTimer);
        checkedSignature = null;
        set({
          projectId,
          view: null,
          loading: false,
          loadError: null,
          writing: false,
          job: null,
          check: null,
        });
        if (projectId !== null) void get().reload();
      },

      async reload() {
        const projectId = projectOf();
        if (projectId === null) return;
        const mine = epoch;
        set({ loading: true });
        try {
          const view = await client.script(projectId);
          if (mine === epoch) set({ view, loadError: null });
        } catch (error) {
          if (mine === epoch) {
            set({
              loadError: error instanceof Error ? error.message : t("voice.panel.loadFailed"),
            });
          }
        } finally {
          if (mine === epoch) set({ loading: false });
        }
      },

      save(change, language) {
        return write(async (projectId, view) => {
          const mine = epoch;
          const saved = await client.saveScript(projectId, {
            lines: change(lineInputs(view.lines)),
            ...(language !== undefined && { language }),
          });
          return adopt(saved, mine);
        }, t("voice.error.notSaved"));
      },

      setVoice(presetId) {
        return write(async (projectId) => {
          const mine = epoch;
          return adopt(await client.setProjectVoice(projectId, { presetId }), mine);
        }, t("voice.error.notSaved"));
      },

      selectTake(lineId, takeId) {
        return write(async (projectId) => {
          const mine = epoch;
          return adopt(await client.selectTake(projectId, lineId, { takeId }), mine);
        }, t("voice.error.notSaved"));
      },

      async estimate(lineIds, options) {
        const projectId = projectOf();
        if (projectId === null) return refusal(new Error(t("voice.panel.notLoaded")), "");
        try {
          const request: VoiceCheckRequest = {
            ...(lineIds !== undefined && { lineIds: [...lineIds] }),
            ...(options?.force === true && { force: true }),
          };
          return { ok: true, value: await client.check(projectId, request) };
        } catch (error) {
          return refusal(error, t("voice.panel.checkFailed"));
        }
      },

      async checkScript() {
        const view = get().view;
        if (view === null) return;
        const signature = checkSignature(view);
        checkedSignature = signature;
        if (view.lines.length === 0 || view.voice === null) {
          set({ check: null });
          return;
        }
        const mine = epoch;
        const result = await get().estimate();
        if (mine !== epoch || checkedSignature !== signature) return;
        // A failed check keeps what it showed before: the generation asks again and says why it cannot go on.
        if (result.ok) set({ check: result.value });
      },

      scheduleCheck() {
        const view = get().view;
        if (view === null || checkSignature(view) === checkedSignature) return;
        clearTimeout(checkTimer);
        checkTimer = setTimeout(() => void get().checkScript(), CHECK_DEBOUNCE_MS);
      },

      async generate({ lineIds, force }) {
        const projectId = projectOf();
        if (projectId === null || get().job !== null) {
          return refusal(new Error(t("voice.panel.busy")), "");
        }
        const mine = epoch;
        const previousTakeIds = Object.fromEntries(
          (get().view?.lines ?? []).map((line) => [line.id, line.selectedTakeId]),
        );
        requestSequence += 1;
        const requestId = `user-${requestSequence}-${Date.now().toString(36)}`;
        set({
          job: {
            requestId,
            lineIds: lineIds ?? null,
            done: 0,
            total: 0,
            lineId: null,
            waitingUntil: null,
            cancelling: false,
          },
        });
        const poll = setInterval(() => {
          client
            .progress(projectId, requestId)
            .then((progress) => {
              const job = get().job;
              if (mine !== epoch || job === null || job.requestId !== requestId) return;
              set({
                job: {
                  ...job,
                  done: progress.done,
                  total: progress.total,
                  lineId: progress.lineId,
                  waitingUntil: progress.waitingUntil ?? null,
                },
              });
            })
            // The request is registered a moment after it is sent, and the answer is only a progress bar.
            .catch(() => undefined);
        }, POLL_MS);
        try {
          const result = await client.synthesize(projectId, {
            requestId,
            ...(lineIds !== undefined && { lineIds: [...lineIds] }),
            force,
            agent: "user",
          });
          // The service selected the new takes; read the script it now holds.
          try {
            adopt(await client.script(projectId), mine);
          } catch {
            // The takes are saved; the next read shows them.
          }
          return { ok: true, value: { result, previousTakeIds } };
        } catch (error) {
          return refusal(error, t("voice.panel.generateFailed"));
        } finally {
          clearInterval(poll);
          if (mine === epoch) set({ job: null });
        }
      },

      async cancel() {
        const projectId = projectOf();
        const job = get().job;
        if (projectId === null || job === null || job.cancelling) return;
        set({ job: { ...job, cancelling: true } });
        try {
          await client.cancel(projectId, job.requestId);
        } catch {
          // The generation finishes or fails on its own; nothing more to do here.
        }
      },
    };
  });
}
