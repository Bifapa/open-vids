import { useMemo, useState } from "react";
import { ArrowLeft, Plus } from "@phosphor-icons/react";
import type { StoryNodeKind } from "@hyperframes/agent-protocol";
import { Button, IconButton, Popover, cn } from "../components/ui";
import type { NewMaterialInput } from "./storyGraphOps";
import { fileName, formatDuration } from "./storyFormat";
import { STORY_KIND_STYLES } from "./storyKinds";
import type { StoryLibrary } from "./useStoryLibrary";

export type NewNodeRequest = { kind: "chapter" } | NewMaterialInput;

/** Kinds that stand for a concrete file or preset, picked in a second step. */
type PickedKind = "video" | "picture" | "music" | "motion";

const ORDER: readonly StoryNodeKind[] = [
  "chapter",
  "video",
  "picture",
  "music",
  "motion",
  "missing",
];

function isPicked(kind: StoryNodeKind): kind is PickedKind {
  return kind === "video" || kind === "picture" || kind === "music" || kind === "motion";
}

interface Choice {
  key: string;
  label: string;
  detail: string;
  request: NewNodeRequest;
}

function choicesFor(kind: PickedKind, library: StoryLibrary): Choice[] {
  if (kind === "motion") {
    return library.presets.map((preset) => ({
      key: `${preset.kind}:${preset.name}`,
      label: preset.title || preset.name,
      detail:
        preset.duration !== null
          ? `${preset.kind} · ${formatDuration(preset.duration)}`
          : preset.kind,
      request: {
        kind,
        source: preset.name,
        title: preset.title || preset.name,
        duration: preset.duration,
      },
    }));
  }
  const assetKind = kind === "picture" ? "image" : kind === "music" ? "audio" : "video";
  const files: Choice[] = library.assets
    .filter((asset) => asset.kind === assetKind)
    .map((asset) => ({
      key: asset.path,
      label: fileName(asset.path),
      detail: asset.duration !== null ? formatDuration(asset.duration) : asset.path,
      request: { kind, source: asset.path, title: fileName(asset.path).replace(/\.[^.]+$/, "") },
    }));
  if (kind === "music") {
    files.unshift({
      key: "later",
      label: "Choose the track later",
      detail: "An intended choice",
      request: { kind },
    });
  }
  return files;
}

/** Toolbar "Add" menu: a chapter or material right away, or a file/preset first for media and motion. */
export function AddNodePopover({
  library,
  disabled,
  onAdd,
}: {
  library: StoryLibrary;
  disabled: boolean;
  onAdd: (request: NewNodeRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<PickedKind | null>(null);
  const [query, setQuery] = useState("");
  const choices = useMemo(() => {
    if (!picking) return [];
    const needle = query.trim().toLowerCase();
    const all = choicesFor(picking, library);
    return needle ? all.filter((choice) => choice.label.toLowerCase().includes(needle)) : all;
  }, [picking, library, query]);

  const add = (request: NewNodeRequest) => {
    onAdd(request);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setPicking(null);
          setQuery("");
          library.refresh();
        }
      }}
      side="bottom"
      align="start"
      aria-label="Add to the story"
      className="w-64 p-1.5"
      trigger={
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          icon={<Plus size={12} aria-hidden />}
        >
          Add
        </Button>
      }
    >
      {picking === null ? (
        <ul className="flex flex-col">
          {ORDER.map((kind) => {
            const style = STORY_KIND_STYLES[kind];
            const KindIcon = style.icon;
            return (
              <li key={kind}>
                <button
                  type="button"
                  onClick={() => {
                    if (isPicked(kind)) {
                      setPicking(kind);
                    } else {
                      add({ kind });
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-step-11 text-text-1 outline-hidden hover:bg-hover focus-visible:bg-hover"
                >
                  <span
                    className={cn("flex size-5 items-center justify-center rounded-sm", style.tint)}
                  >
                    <KindIcon size={12} weight="bold" className={style.text} aria-hidden />
                  </span>
                  {style.label}
                  {isPicked(kind) && <span className="ml-auto text-text-4">…</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <IconButton
              aria-label="Back"
              size="sm"
              icon={<ArrowLeft size={12} aria-hidden />}
              onClick={() => setPicking(null)}
            />
            <input
              aria-label={`Search ${STORY_KIND_STYLES[picking].label}`}
              value={query}
              autoFocus
              placeholder={picking === "motion" ? "Search presets" : "Search files"}
              onChange={(event) => setQuery(event.target.value)}
              className="h-ctl-sm min-w-0 flex-1 rounded-sm border border-border-input bg-input px-2 text-step-11 text-text-1 outline-hidden placeholder:text-text-5 focus:border-border-strong"
            />
          </div>
          <ul
            className="flex max-h-72 flex-col overflow-y-auto"
            role="listbox"
            aria-label="Choices"
          >
            {choices.length === 0 && (
              <li className="px-2 py-2 text-step-11 text-text-3">
                {library.status === "loading"
                  ? "Loading…"
                  : picking === "motion"
                    ? "No presets found."
                    : "No matching files in the project."}
              </li>
            )}
            {choices.map((choice) => (
              <li key={choice.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => add(choice.request)}
                  className="flex w-full flex-col rounded-sm px-2 py-1.5 text-left outline-hidden hover:bg-hover focus-visible:bg-hover"
                >
                  <span className="truncate text-step-11 text-text-1">{choice.label}</span>
                  <span className="truncate text-step-10 text-text-3">{choice.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}
