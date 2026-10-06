import { create } from "zustand";
import { usePlayerStore } from "../player/store/playerStore";

/**
 * Where voice sounds play. Studio keeps one voice sound at a time (a sample in the setup window, the chat's pilot
 * line, a preset in Settings): starting one stops the one before, in every surface. `playingKey` names what is
 * sounding so the right button shows Stop; `failedKey` the last one that could not be played.
 */
interface VoiceSoundState {
  playingKey: string | null;
  failedKey: string | null;
  /** The sample is playing together with the composition ("Listen with video"). */
  listening: boolean;
}

export const useVoiceSound = create<VoiceSoundState>(() => ({
  playingKey: null,
  failedKey: null,
  listening: false,
}));

/** A stretch of a longer file (a take is a range of a scene's file). */
export interface SoundRange {
  start: number;
  end: number;
}

let sound: HTMLAudioElement | null = null;
let rangeTimer: number | undefined;
let stopListening: (() => void) | null = null;

function settle(next: Partial<VoiceSoundState>): void {
  useVoiceSound.setState(next);
}

/** Resolves once the element can play from `from`, or rejects when its file cannot be loaded. */
function ready(audio: HTMLAudioElement, from: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      if (from > 0) audio.currentTime = from;
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("audio failed to load"));
    };
    const cleanup = () => {
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("canplay", onReady);
    audio.addEventListener("error", onError);
    audio.preload = "auto";
    audio.load();
  });
}

/** Stops whatever voice sound is playing, including a "Listen with video" (which also stops the composition). */
export function stopVoiceSound(): void {
  const pausedByUs = stopListening;
  stopListening = null;
  pausedByUs?.();
  window.clearInterval(rangeTimer);
  rangeTimer = undefined;
  if (sound) {
    sound.onended = null;
    sound.pause();
    sound = null;
  }
  settle({ playingKey: null, listening: false });
}

/** Plays `url` (or `range` of it) as sound `key`; resolves once it started, false when it could not be played. */
export async function playVoiceSound(
  key: string,
  url: string,
  range?: SoundRange,
): Promise<boolean> {
  stopVoiceSound();
  const audio = new Audio(url);
  sound = audio;
  settle({ playingKey: key, failedKey: null });
  try {
    await ready(audio, range?.start ?? 0);
    if (sound !== audio) return false;
    audio.onended = () => {
      if (sound === audio) stopVoiceSound();
    };
    await audio.play();
    if (sound !== audio) return false;
    if (range) {
      rangeTimer = window.setInterval(() => {
        if (audio.currentTime >= range.end && sound === audio) stopVoiceSound();
      }, 40);
    }
    return true;
  } catch {
    if (sound === audio) {
      stopVoiceSound();
      settle({ failedKey: key });
    }
    return false;
  }
}

/**
 * Plays `url` from the playhead together with the composition, and stops both together: when the sample ends, when
 * the composition stops (the user paused it, or it reached its end) or when {@link stopVoiceSound} is called. The
 * transport goes back where it was if this started it; a transport that was already running is left running.
 * Nothing is written to the timeline.
 */
export async function listenWithVideo(key: string, url: string): Promise<boolean> {
  stopVoiceSound();
  const audio = new Audio(url);
  sound = audio;
  settle({ playingKey: key, failedKey: null, listening: true });
  try {
    await ready(audio, 0);
  } catch {
    if (sound === audio) {
      stopVoiceSound();
      settle({ failedKey: key });
    }
    return false;
  }
  if (sound !== audio) return false;

  const player = usePlayerStore.getState();
  const startedTransport = !player.isPlaying;
  const returnTo = player.currentTime;
  let seenPlaying = player.isPlaying;
  const unsubscribe = usePlayerStore.subscribe((state, previous) => {
    if (state.isPlaying && !previous.isPlaying) seenPlaying = true;
    // The composition stopped on its own (paused by the user, or at its end): the sample stops with it.
    if (seenPlaying && !state.isPlaying && previous.isPlaying) {
      stopListening = null;
      stopVoiceSound();
    }
  });
  stopListening = () => {
    unsubscribe();
    if (startedTransport) usePlayerStore.getState().requestPlayback(false, returnTo);
  };
  audio.onended = () => {
    if (sound === audio) stopVoiceSound();
  };
  // Both start in the same turn, the sample already loaded, so they stay together.
  if (startedTransport) usePlayerStore.getState().requestPlayback(true);
  try {
    await audio.play();
  } catch {
    stopVoiceSound();
    settle({ failedKey: key });
    return false;
  }
  return true;
}
