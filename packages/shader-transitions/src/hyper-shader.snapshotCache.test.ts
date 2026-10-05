import { describe, expect, it } from "vitest";
import { selectSnapshotKeysToDelete, snapshotCachePrefix } from "./hyper-shader.js";

const entry = (key: string, updatedAt = 1) => ({ key, updatedAt });

describe("snapshot cache pruning", () => {
  it("scopes the key prefix by composition id and document path", () => {
    const a = snapshotCachePrefix("main", "/api/projects/a/preview");
    const b = snapshotCachePrefix("main", "/api/projects/b/preview");
    expect(a).not.toBe(b);
    expect(a).toBe(snapshotCachePrefix("main", "/api/projects/a/preview"));
    expect(a.startsWith("main:")).toBe(true);
  });

  it("drops inactive entries of the same project and keeps other projects' snapshots", () => {
    const projectA = snapshotCachePrefix("main", "/api/projects/a/preview");
    const projectB = snapshotCachePrefix("main", "/api/projects/b/preview");
    const activeB = `${projectB}0:aaaa1111`;
    const entries = [
      entry(`${projectA}0:old00000:sample:0:from`),
      entry(`${projectA}1:old11111:sample:0:to`),
      entry(`${projectB}0:aaaa1111:sample:0:from`),
      entry(`${projectB}0:bbbb2222:sample:0:from`),
    ];

    // Project B opens: only B's superseded entry goes; A's snapshots stay for when A reopens.
    expect(selectSnapshotKeysToDelete(entries, projectB, new Set([activeB]), 1200).sort()).toEqual([
      `${projectB}0:bbbb2222:sample:0:from`,
    ]);
  });

  it("evicts the least recently updated inactive entries once over budget", () => {
    const prefix = snapshotCachePrefix("main", "/p");
    const active = `${prefix}0:live0000`;
    const entries = [
      entry(`${active}:sample:0:from`, 5),
      entry("other:aaaaaaaa:0:new:sample:0:from", 4),
      entry("other:aaaaaaaa:0:old:sample:0:from", 1),
    ];
    expect(selectSnapshotKeysToDelete(entries, prefix, new Set([active]), 2)).toEqual([
      "other:aaaaaaaa:0:old:sample:0:from",
    ]);
  });
});
