import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowCounterClockwise, Pause, Play } from "@phosphor-icons/react";
import type { AssetRange } from "@hyperframes/agent-protocol";
import { Button, Input } from "../components/ui";
import { useTranslation } from "../i18n";
import {
  formatRangeTime,
  moveEnd,
  moveStart,
  parseRangeTime,
  sameRange,
  storedRange,
  wholeFileRange,
} from "./assetRange";
import { saveAssetRange } from "./assetRangesStore";
import { AssetRangeStrip, type RangeChangePhase } from "./AssetRangeStrip";
import type { MediaItem } from "./mediaLibrary";
import { Section } from "./MediaInspectorParts";

/** A run of arrow-key steps is saved once, this long after the last one. */
const KEY_SAVE_DELAY_MS = 400;

export interface AssetRangeEditorProps {
  item: MediaItem;
  projectId: string;
  /** The inspector's preview element: the playhead and "play fragment" run on it. */
  mediaRef: RefObject<HTMLVideoElement | null>;
  time: number;
  playing: boolean;
  onSeek: (time: number) => void;
  /** Starts of the video's shots (the scene map), drawn as ticks. */
  shotStarts: readonly number[];
}

/**
 * "Fragment for AI": the in and out points of a video/audio asset the AI may use. Editing is local and instant;
 * the pick is saved when a drag is released (arrow keys: after a short pause) and the server's answer, which
 * clamps, is what stays. The file itself is never touched.
 */
export function AssetRangeEditor({
  item,
  projectId,
  mediaRef,
  time,
  playing,
  onSeek,
  shotStarts,
}: AssetRangeEditorProps) {
  const { t } = useTranslation();
  const duration = item.duration ?? 0;
  const whole = useMemo(() => wholeFileRange(duration), [duration]);
  const stored = item.range;
  const [draft, setDraft] = useState<AssetRange>(stored ?? whole);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [inputEpoch, setInputEpoch] = useState(0);
  const [guarded, setGuarded] = useState(false);
  const [head, setHead] = useState(time);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  /** An edit is under way (dragging, waiting to save, saving): the stored value must not overwrite the draft. */
  const busy = useRef(false);
  const editSequence = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  /** "Play fragment" runs: the rAF loop stops the media at the out point. */
  const guard = useRef(false);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  // The stored pick changed under us (undo, another window, the server's clamp): show it.
  const storedKey = stored ? `${stored.start}/${stored.end}` : "none";
  useEffect(() => {
    if (!busy.current) setDraft(storedRef.current ?? whole);
  }, [storedKey, whole]);

  const flush = async (next: AssetRange) => {
    window.clearTimeout(saveTimer.current);
    const mine = editSequence.current;
    const value = storedRange(next, duration);
    if (sameRange(value, storedRef.current)) {
      busy.current = false;
      setSaving(false);
      return;
    }
    setSaving(true);
    try {
      const answer = await saveAssetRange(projectId, item.path, value);
      if (mine !== editSequence.current) return;
      busy.current = false;
      setSaving(false);
      setDraft(answer ?? whole);
    } catch (failure) {
      if (mine !== editSequence.current) return;
      busy.current = false;
      setSaving(false);
      setError(
        t("media.range.saveFailed", {
          message: failure instanceof Error ? failure.message : String(failure),
        }),
      );
    }
  };

  const change = (next: AssetRange, phase: RangeChangePhase) => {
    editSequence.current += 1;
    busy.current = true;
    setDraft(next);
    setError(null);
    if (phase === "release") void flush(next);
    else if (phase === "key") {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(next), KEY_SAVE_DELAY_MS);
    }
  };

  const playhead = () => mediaRef.current?.currentTime ?? time;

  const commitTime = (edge: "start" | "end", text: string) => {
    const parsed = parseRangeTime(text);
    setInputEpoch((epoch) => epoch + 1);
    if (parsed === null) {
      setError(t("media.range.invalidTime"));
      return;
    }
    const current = draftRef.current;
    change(
      edge === "start" ? moveStart(current, parsed, duration) : moveEnd(current, parsed, duration),
      "release",
    );
  };

  const playFragment = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (guard.current && playing) {
      media.pause();
      return;
    }
    guard.current = true;
    setGuarded(true);
    onSeek(draftRef.current.start);
    media.play().catch(() => {
      guard.current = false;
      setGuarded(false);
    });
  };

  // While the media plays: a smooth playhead, and "play fragment" stops at the out point.
  useEffect(() => {
    if (!playing) {
      guard.current = false;
      setGuarded(false);
      return;
    }
    let frame = 0;
    const tick = () => {
      const media = mediaRef.current;
      if (media) {
        setHead(media.currentTime);
        const out = draftRef.current.end;
        if (guard.current && media.currentTime >= out) {
          media.pause();
          guard.current = false;
          setGuarded(false);
          onSeekRef.current(out);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mediaRef, playing]);

  const picked = !sameRange(storedRange(draft, duration), null);
  const length = draft.end - draft.start;
  const fragmentPlaying = guarded && playing;

  return (
    <Section title={t("media.range.title")}>
      <p className="m-0 text-xs leading-[15px] text-fg-3">
        {picked ? t("media.range.hintPicked") : t("media.range.hintWhole")}
      </p>
      <AssetRangeStrip
        item={item}
        projectId={projectId}
        range={draft}
        duration={duration}
        time={playing ? head : time}
        markers={shotStarts}
        onChange={change}
        onSeek={onSeek}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-1.5">
        <label className="grid min-w-0 gap-0.5">
          <span className="text-xs text-fg-3">{t("media.range.start")}</span>
          <Input
            key={`start-${inputEpoch}`}
            value={formatRangeTime(draft.start)}
            onCommit={(text) => commitTime("start", text)}
            inputMode="decimal"
            className="tabular-nums"
          />
        </label>
        <label className="grid min-w-0 gap-0.5">
          <span className="text-xs text-fg-3">{t("media.range.end")}</span>
          <Input
            key={`end-${inputEpoch}`}
            value={formatRangeTime(draft.end)}
            onCommit={(text) => commitTime("end", text)}
            inputMode="decimal"
            className="tabular-nums"
          />
        </label>
        <div className="grid gap-0.5 text-right">
          <span className="text-xs text-fg-3">{t("media.range.length")}</span>
          <span
            className="inline-flex h-ctl-sm items-center justify-end font-mono text-sm text-fg tabular-nums"
            data-testid="media-range-length"
          >
            {formatRangeTime(length)}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          size="sm"
          className="min-w-0"
          title={t("media.range.setStartTitle")}
          onClick={() => change(moveStart(draft, playhead(), duration), "release")}
        >
          {t("media.range.setStart")}
        </Button>
        <Button
          size="sm"
          className="min-w-0"
          title={t("media.range.setEndTitle")}
          onClick={() => change(moveEnd(draft, playhead(), duration), "release")}
        >
          {t("media.range.setEnd")}
        </Button>
      </div>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="min-w-0 flex-1"
          icon={fragmentPlaying ? <Pause weight="fill" /> : <Play weight="fill" />}
          onClick={playFragment}
        >
          {fragmentPlaying ? t("media.range.stop") : t("media.range.play")}
        </Button>
        <Button
          size="sm"
          icon={<ArrowCounterClockwise />}
          title={t("media.range.resetTitle")}
          disabled={!picked}
          onClick={() => change(whole, "release")}
        >
          {t("media.range.reset")}
        </Button>
      </div>
      {saving && (
        <p role="status" className="m-0 text-xs leading-[15px] text-fg-3">
          {t("media.range.saving")}
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-xs leading-[15px] text-error">
          {error}
        </p>
      )}
    </Section>
  );
}
