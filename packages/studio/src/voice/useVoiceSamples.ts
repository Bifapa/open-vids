import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceSampleResult } from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import type { VoiceClient } from "./voiceClient";
import { presetDraftOf, sampleKey, type VoiceDraft } from "./voiceDraft";

/** One sample of the setup window: asked, heard, or failed. */
export interface SampleEntry {
  status: "loading" | "ready" | "failed";
  result: VoiceSampleResult | null;
  message: string | null;
}

export interface VoiceSamples {
  /** Every sample asked in this window, by `sampleKey`. */
  entries: Readonly<Record<string, SampleEntry>>;
  /**
   * The sample of `draft` speaking `text`: the one already made, or a new `POST /voice/sample` (the same request a
   * take makes; the server's cache answers an identical one for free). Null when no voice is chosen.
   */
  ensure(draft: VoiceDraft, text: string): Promise<SampleEntry | null>;
}

/** The samples of one setup window. They are kept for its lifetime, so listening again costs nothing. */
export function useVoiceSamples(client: VoiceClient): VoiceSamples {
  const [entries, setEntries] = useState<Record<string, SampleEntry>>({});
  const known = useRef<Record<string, SampleEntry>>({});
  const pending = useRef(new Map<string, Promise<SampleEntry | null>>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const store = useCallback((key: string, entry: SampleEntry) => {
    known.current = { ...known.current, [key]: entry };
    if (alive.current) setEntries(known.current);
  }, []);

  const ensure = useCallback(
    (draft: VoiceDraft, text: string): Promise<SampleEntry | null> => {
      const preset = presetDraftOf(draft, "");
      const phrase = text.trim();
      if (preset === null || phrase === "") return Promise.resolve(null);
      const key = sampleKey(draft, phrase);
      const existing = known.current[key];
      if (existing?.status === "ready") return Promise.resolve(existing);
      const running = pending.current.get(key);
      if (running) return running;
      store(key, { status: "loading", result: null, message: null });
      const request = client
        .sample({ preset, text: phrase })
        .then((result): SampleEntry => ({ status: "ready", result, message: null }))
        .catch(
          (error: unknown): SampleEntry => ({
            status: "failed",
            result: null,
            message: error instanceof Error ? error.message : t("voice.error.notChecked"),
          }),
        )
        .then((entry) => {
          pending.current.delete(key);
          store(key, entry);
          return entry;
        });
      pending.current.set(key, request);
      return request;
    },
    [client, store],
  );

  return { entries, ensure };
}
