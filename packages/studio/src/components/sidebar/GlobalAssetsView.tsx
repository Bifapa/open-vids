import { useEffect, useMemo, useState } from "react";
import { File, FilmStrip, Globe, Image, MusicNotes, type Icon } from "@phosphor-icons/react";
import { cn } from "../ui";
import { ASSET_ITEM_CLASS, ASSET_THUMB_CLASS } from "./assetHelpers";

// Cross-project asset view — the global media-use cache (~/.media), fetched from
// /api/assets/global. Self-contained (owns its fetch + state) so AssetsTab stays
// focused on the local view.

export interface GlobalAssetRecord {
  id?: string;
  type?: string;
  description?: string;
  entity?: string;
  sha?: string;
}

export interface GlobalAssetRow {
  id: string;
  type: string;
  label: string;
}

/**
 * Normalize global records into display rows, filtered by an optional query
 * (id / type / description / entity). Pure — unit-tested.
 */
export function globalAssetRows(records: GlobalAssetRecord[], query = ""): GlobalAssetRow[] {
  const q = query.trim().toLowerCase();
  return records
    .filter((r) =>
      !q
        ? true
        : [r.id, r.type, r.description, r.entity].some(
            (f) => f && String(f).toLowerCase().includes(q),
          ),
    )
    .map((r) => ({
      id: r.id ?? r.sha ?? "asset",
      type: r.type ?? "asset",
      label: r.description || r.entity || r.id || r.sha || "asset",
    }));
}

/** The cache's record types are free-form ("bgm", "sfx", "image"…); pick a kind glyph by family. */
function typeIcon(type: string): Icon {
  const t = type.toLowerCase();
  if (/video|clip|footage|broll/.test(t)) return FilmStrip;
  if (/image|picture|photo|logo|still/.test(t)) return Image;
  if (/audio|music|bgm|sfx|voice|sound/.test(t)) return MusicNotes;
  return File;
}

/** Rows grouped by record type, in first-seen order — the prototype's kind sections. */
function groupByType(rows: GlobalAssetRow[]): Array<[string, GlobalAssetRow[]]> {
  const groups = new Map<string, GlobalAssetRow[]>();
  for (const row of rows) {
    const list = groups.get(row.type);
    if (list) list.push(row);
    else groups.set(row.type, [row]);
  }
  return [...groups];
}

export function GlobalAssetsView({ searchQuery }: { searchQuery: string }) {
  const [records, setRecords] = useState<GlobalAssetRecord[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/assets/global")
      .then((r) => (r.ok ? r.json() : { assets: [] }))
      .then((d) => {
        if (!cancelled) setRecords(Array.isArray(d.assets) ? d.assets : []);
      })
      .catch(() => {
        if (!cancelled) setRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => globalAssetRows(records ?? [], searchQuery), [records, searchQuery]);
  const total = records?.length ?? 0;

  if (records === null) {
    return (
      <p role="status" className="px-3 py-[18px] text-center text-sm text-fg-3">
        Loading reusable assets…
      </p>
    );
  }
  if (total === 0) {
    return (
      <p className="px-3 py-[18px] text-center text-sm text-fg-3 [text-wrap:pretty]">
        No assets in the global cache yet. Resolved media is promoted to{" "}
        <code className="font-mono text-num text-fg-2">~/.media</code> and becomes reusable across
        projects.
      </p>
    );
  }
  return (
    <div>
      <div className="mx-3 mt-1.5 mb-0.5 flex gap-1.5 text-xs leading-[15px] text-fg-3 [text-wrap:pretty]">
        <Globe size={12} className="mt-px shrink-0" aria-hidden="true" />
        <span>
          <b className="font-medium text-fg-2">{total} reusable across all projects</b> — media
          resolved in your projects, kept in <code className="font-mono text-num">~/.media</code>.
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-[18px] text-center text-sm text-fg-3">
          No reusable assets match &ldquo;{searchQuery}&rdquo;.
        </p>
      ) : (
        groupByType(rows).map(([type, group]) => {
          const KindIcon = typeIcon(type);
          return (
            <section key={type} aria-label={type}>
              <div className="flex items-baseline gap-1.5 px-3 pt-2.5 pb-1 text-xs font-semibold text-fg-2 capitalize">
                {type}
                <span className="font-normal text-fg-3 tabular-nums">{group.length}</span>
              </div>
              <div className="flex flex-col gap-px px-2">
                {group.map((row) => (
                  <div
                    key={row.id}
                    title={`${row.id} · ${row.type}`}
                    className={cn(
                      ASSET_ITEM_CLASS,
                      "flex h-row-lg min-w-0 items-center gap-2 pr-1.5 pl-1",
                    )}
                  >
                    <div className={cn(ASSET_THUMB_CLASS, "w-11 shrink-0")}>
                      <span
                        aria-hidden="true"
                        className="absolute inset-0 flex items-center justify-center text-fg-3"
                      >
                        <KindIcon size={14} />
                      </span>
                    </div>
                    <div className="grid min-w-0 flex-1 gap-px">
                      <span className="truncate text-base text-fg">{row.id}</span>
                      {row.label !== row.id && (
                        <span className="truncate text-xs leading-[14px] text-fg-3">
                          {row.label}
                        </span>
                      )}
                    </div>
                    <span className="inline-flex h-[18px] min-w-10 shrink-0 items-center justify-center rounded-xs border border-border px-1 font-mono text-2xs leading-none font-semibold text-fg-3 uppercase">
                      {row.type}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
