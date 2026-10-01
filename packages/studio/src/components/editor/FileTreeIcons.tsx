import {
  FileHtml,
  FileCss,
  FileJs,
  FileJsx,
  FileTs,
  FileTsx,
  FileTxt,
  FileMd,
  FileSvg,
  FilePng,
  FileJpg,
  FileVideo,
  FileCode,
  File,
  Waveform,
  TextAa,
  Image as PhImage,
} from "@phosphor-icons/react";

const SZ = 12;

/** The file's kind glyph, in the prototype tree's neutral `fg-3` (shape tells the type, not colour). */
export function FileIcon({ path }: { path: string }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const c = "shrink-0 text-fg-3";
  if (ext === "html") return <FileHtml size={SZ} className={c} />;
  if (ext === "css") return <FileCss size={SZ} className={c} />;
  if (ext === "js" || ext === "mjs" || ext === "cjs") return <FileJs size={SZ} className={c} />;
  if (ext === "jsx") return <FileJsx size={SZ} className={c} />;
  if (ext === "ts" || ext === "mts") return <FileTs size={SZ} className={c} />;
  if (ext === "tsx") return <FileTsx size={SZ} className={c} />;
  if (ext === "json") return <FileCode size={SZ} className={c} />;
  if (ext === "svg") return <FileSvg size={SZ} className={c} />;
  if (ext === "md" || ext === "mdx") return <FileMd size={SZ} className={c} />;
  if (ext === "txt") return <FileTxt size={SZ} className={c} />;
  if (ext === "png") return <FilePng size={SZ} className={c} />;
  if (ext === "jpg" || ext === "jpeg") return <FileJpg size={SZ} className={c} />;
  if (ext === "webp" || ext === "gif" || ext === "ico") return <PhImage size={SZ} className={c} />;
  if (ext === "mp4" || ext === "webm" || ext === "mov")
    return <FileVideo size={SZ} className={c} />;
  if (ext === "mp3" || ext === "wav" || ext === "ogg" || ext === "m4a")
    return <Waveform size={SZ} className={c} />;
  if (ext === "woff" || ext === "woff2" || ext === "ttf" || ext === "otf")
    return <TextAa size={SZ} className={c} />;
  return <File size={SZ} className={c} />;
}

// ── Tree Types ──

export interface TreeNode {
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  targetPath: string;
  targetIsFolder: boolean;
}

export interface InlineInputState {
  /** Parent folder path (empty string for root) */
  parentPath: string;
  /** "file" or "folder" creation, or "rename" */
  mode: "new-file" | "new-folder" | "rename";
  /** For rename mode, the original full path */
  originalPath?: string;
  /** For rename mode, the original name */
  originalName?: string;
  onCommit?: (name: string) => void;
  onCancel?: () => void;
}

// ── Tree Helpers ──

export function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: "", fullPath: "", children: new Map(), isFile: false };
  for (const file of files) {
    const parts = file.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join("/");
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          fullPath,
          children: new Map(),
          isFile: isLast,
        });
      }
      current = current.children.get(part)!;
      if (isLast) current.isFile = true;
    }
  }
  return root;
}

export function sortChildren(children: Map<string, TreeNode>): TreeNode[] {
  return Array.from(children.values()).sort((a, b) => {
    // index.html always first
    if (a.name === "index.html") return -1;
    if (b.name === "index.html") return 1;
    // Directories before files
    if (!a.isFile && b.isFile) return -1;
    if (a.isFile && !b.isFile) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function isActiveInSubtree(node: TreeNode, activeFile: string | null): boolean {
  if (!activeFile) return false;
  if (node.fullPath === activeFile) return true;
  for (const child of node.children.values()) {
    if (isActiveInSubtree(child, activeFile)) return true;
  }
  return false;
}
