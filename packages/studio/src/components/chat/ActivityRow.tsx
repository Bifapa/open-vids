import { useId, useState } from "react";
import {
  CaretRight,
  Check,
  CircleNotch,
  Eye,
  Lightning,
  MagnifyingGlass,
  PencilSimple,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";
import type { Activity, ActivityCategory } from "@hyperframes/agent-protocol";
import { cn } from "../ui/cn";

const CATEGORY_ICONS: Record<ActivityCategory, Icon> = {
  inspect: Eye,
  search: MagnifyingGlass,
  edit: PencilSimple,
  other: Lightning,
};

const STATUS_TEXT: Record<Activity["status"], string> = {
  running: "In progress",
  done: "Done",
  failed: "Failed",
};

function StatusGlyph({ status }: { status: Activity["status"] }) {
  if (status === "running") {
    return (
      <CircleNotch
        size={12}
        weight="bold"
        aria-hidden
        className="animate-spin text-text-3 motion-reduce:animate-none"
      />
    );
  }
  if (status === "failed")
    return <WarningCircle size={12} weight="fill" aria-hidden className="text-danger" />;
  return <Check size={12} weight="bold" aria-hidden className="text-accent" />;
}

/** One product-level unit of work ("Reading 3 files"). Never shows a raw tool name. */
export function ActivityRow({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const CategoryIcon = CATEGORY_ICONS[activity.category];
  const expandable = activity.targets.length > 0;

  const body = (
    <>
      <CategoryIcon size={13} aria-hidden className="shrink-0 text-text-3" />
      <span className="min-w-0 flex-1 truncate text-left text-text-2">{activity.label}</span>
      {activity.count > 1 && (
        <span
          aria-hidden
          className="shrink-0 rounded-sm bg-surface px-1 text-step-10 tabular-nums text-text-3"
        >
          {activity.count}
        </span>
      )}
      <StatusGlyph status={activity.status} />
      <span className="sr-only">{STATUS_TEXT[activity.status]}</span>
      {expandable && (
        <CaretRight
          size={10}
          weight="bold"
          aria-hidden
          className={cn(
            "shrink-0 text-text-4 transition-transform duration-expand",
            open && "rotate-90",
          )}
        />
      )}
    </>
  );

  const rowClass = "flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-step-11";
  return (
    <div className="rounded-md border border-hairline bg-bg-2">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            rowClass,
            "cursor-pointer outline-hidden transition-colors duration-hover hover:bg-hover/50",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
          )}
        >
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
      {open && expandable && (
        <ul id={listId} className="border-t border-hairline px-2 py-1">
          {activity.targets.map((target) => (
            <li
              key={target}
              className="truncate py-0.5 font-mono text-step-10 text-text-3"
              title={target}
            >
              {target}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
