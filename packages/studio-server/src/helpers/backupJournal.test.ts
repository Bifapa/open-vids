import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupPathForResponse, snapshotBeforeWrite } from "./backupJournal";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createProjectDir(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "hf-backup-journal-"));
  tempDirs.push(projectDir);
  return projectDir;
}

describe("snapshotBeforeWrite", () => {
  it("copies the current file bytes before overwrite", () => {
    const projectDir = createProjectDir();
    mkdirSync(join(projectDir, "compositions"), { recursive: true });
    const file = join(projectDir, "compositions", "scene.html");
    writeFileSync(file, "before");

    const result = snapshotBeforeWrite(projectDir, file);
    writeFileSync(file, "after");

    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    expect(readFileSync(result.backupPath!, "utf-8")).toBe("before");
    expect(backupPathForResponse(projectDir, result.backupPath)).toMatch(
      /^\.hyperframes\/backup\//,
    );
  });

  it("creates backups for zero-byte files", () => {
    const projectDir = createProjectDir();
    const file = join(projectDir, "empty.html");
    writeFileSync(file, "");

    const result = snapshotBeforeWrite(projectDir, file);

    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    expect(readFileSync(result.backupPath!, "utf-8")).toBe("");
  });

  it("prunes older backups for the same file", () => {
    const projectDir = createProjectDir();
    const file = join(projectDir, "index.html");
    writeFileSync(file, "0");

    for (let i = 1; i <= 5; i += 1) {
      writeFileSync(file, String(i));
      snapshotBeforeWrite(projectDir, file, { keepPerFile: 3 });
    }

    expect(readdirSync(join(projectDir, ".hyperframes", "backup"))).toHaveLength(3);
  });

  it("does not prune backups for paths with colliding sanitized names", () => {
    const projectDir = createProjectDir();
    const first = join(projectDir, "My File.html");
    const second = join(projectDir, "My_File.html");
    writeFileSync(first, "space");
    writeFileSync(second, "underscore");

    snapshotBeforeWrite(projectDir, first, { keepPerFile: 1 });
    snapshotBeforeWrite(projectDir, second, { keepPerFile: 1 });

    const backups = readdirSync(join(projectDir, ".hyperframes", "backup"));
    expect(backups).toHaveLength(2);
    expect(
      backups
        .map((name) => readFileSync(join(projectDir, ".hyperframes", "backup", name), "utf-8"))
        .sort(),
    ).toEqual(["space", "underscore"]);
  });

  it("saves a file whose path is far longer than a file name may be", () => {
    const projectDir = createProjectDir();
    // About 110 characters but 200 UTF-8 bytes: the old base64 name was past 255 bytes, yet the path is short enough
    // for any platform's path limit.
    const folder = join(
      "Папка с материалами проекта о путешествии",
      "Сцены первой главы ролика и титры",
    );
    const file = join(projectDir, folder, "Открывающая сцена с названием.html");
    expect(Buffer.byteLength(relative(projectDir, file))).toBeGreaterThan(172);
    mkdirSync(join(projectDir, folder), { recursive: true });
    writeFileSync(file, "before");

    const result = snapshotBeforeWrite(projectDir, file);

    expect(result.error).toBeUndefined();
    expect(readFileSync(result.backupPath!, "utf-8")).toBe("before");
    for (const name of readdirSync(join(projectDir, ".hyperframes", "backup"))) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    }
  });

  it("keeps same-named files of different folders apart, each pruned on its own", () => {
    const projectDir = createProjectDir();
    mkdirSync(join(projectDir, "a"));
    mkdirSync(join(projectDir, "b"));
    const first = join(projectDir, "a", "index.html");
    const second = join(projectDir, "b", "index.html");
    writeFileSync(first, "a");
    writeFileSync(second, "b");

    for (let i = 0; i < 3; i += 1) {
      snapshotBeforeWrite(projectDir, first, { keepPerFile: 2 });
      snapshotBeforeWrite(projectDir, second, { keepPerFile: 2 });
    }

    const dir = join(projectDir, ".hyperframes", "backup");
    const contents = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf-8"));
    expect(contents.sort()).toEqual(["a", "a", "b", "b"]);
  });

  it("prunes backups named the way earlier versions named them", () => {
    const projectDir = createProjectDir();
    const file = join(projectDir, "index.html");
    writeFileSync(file, "now");
    const dir = join(projectDir, ".hyperframes", "backup");
    mkdirSync(dir, { recursive: true });
    const legacyKey = Buffer.from("index.html", "utf-8").toString("base64url");
    writeFileSync(join(dir, `2020-01-01T00-00-00-000Z-${legacyKey}`), "old");

    snapshotBeforeWrite(projectDir, file, { keepPerFile: 1 });

    expect(readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf-8"))).toEqual(["now"]);
  });

  it("leaves a missing file and a folder unjournaled without an error", () => {
    const projectDir = createProjectDir();
    mkdirSync(join(projectDir, "folder"));
    expect(snapshotBeforeWrite(projectDir, join(projectDir, "missing.html"))).toEqual({
      backupPath: null,
    });
    expect(snapshotBeforeWrite(projectDir, join(projectDir, "folder"))).toEqual({
      backupPath: null,
    });
  });
});
