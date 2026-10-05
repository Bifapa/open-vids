// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openBlobStore } from "./blobStore";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-blob-store-"));
  dirs.push(dir);
  return dir;
}

describe("openBlobStore", () => {
  it("keeps the replaced version of a large media file restorable", async () => {
    const dir = tempDir();
    const store = await openBlobStore(join(dir, "blobs"));
    const clip = join(dir, "clip.mp4");
    const original = Buffer.alloc(2 * 1024 * 1024, 7);
    writeFileSync(clip, original);
    const hash = await store.put(clip);

    // A re-export replaces the file whole.
    rmSync(clip);
    writeFileSync(clip, Buffer.alloc(2 * 1024 * 1024, 9));

    const restored = join(dir, "restored.mp4");
    await store.writeTo(hash, restored);
    expect(readFileSync(restored).equals(original)).toBe(true);
  });

  it("keeps the replaced version restorable when the file is rewritten in place afterwards", async () => {
    const dir = tempDir();
    const store = await openBlobStore(join(dir, "blobs"));
    const clip = join(dir, "clip.mp4");
    const original = Buffer.alloc(2 * 1024 * 1024, 7);
    writeFileSync(clip, original);
    const hash = await store.put(clip);

    // Same inode, new bytes (what `ffmpeg -y` or a truncating save does): the blob must not change with it.
    writeFileSync(clip, Buffer.alloc(2 * 1024 * 1024, 9));

    const restored = join(dir, "restored.mp4");
    await store.writeTo(hash, restored);
    expect(readFileSync(restored).equals(original)).toBe(true);
    expect((await store.read(hash)).equals(original)).toBe(true);
  });

  it("never shares an inode with the project file", async () => {
    const dir = tempDir();
    const store = await openBlobStore(join(dir, "blobs"));
    const clip = join(dir, "clip.mp4");
    writeFileSync(clip, Buffer.alloc(2 * 1024 * 1024, 7));
    const hash = await store.put(clip);

    expect(statSync(clip).nlink).toBe(1);
    expect(statSync(join(dir, "blobs", hash.slice(0, 2), hash)).ino).not.toBe(statSync(clip).ino);
  });

  it("leaves the stored file's change time alone", async () => {
    const dir = tempDir();
    const store = await openBlobStore(join(dir, "blobs"));
    const clip = join(dir, "clip.mp4");
    writeFileSync(clip, Buffer.alloc(2 * 1024 * 1024, 7));
    const before = statSync(clip).ctimeMs;
    await store.put(clip);
    expect(statSync(clip).ctimeMs).toBe(before);
  });
});
