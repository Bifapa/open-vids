import { buildProjectApiPath } from "../../utils/projectRouting";
import { readOpenvidsHomeOrigin } from "../../utils/openvidsHost";

/** The render file's own URL — what a plain browser opens in a new tab. */
export function renderFileUrl(projectId: string, filename: string): string {
  return buildProjectApiPath(projectId, `/renders/file/${encodeURIComponent(filename)}`);
}

/**
 * Open a finished render for the user.
 *
 * A plain browser gets the file URL in a new tab. The OpenVids desktop shell
 * cannot do that: its webview forwards only `https:` addresses to the default
 * browser and denies every other `window.open`, so opening a loopback render
 * URL silently did nothing. Inside the shell the click instead asks the Studio
 * server — the same loopback server that serves this page and owns the render
 * file — to hand the file to the OS default player
 * (`POST /api/projects/:id/renders/:filename/open`). Rejects when the server
 * could not open it, so the caller can report it instead of staying silent.
 */
export async function openRenderFile(projectId: string, filename: string): Promise<void> {
  if (!readOpenvidsHomeOrigin()) {
    window.open(renderFileUrl(projectId, filename), "_blank");
    return;
  }
  const response = await fetch(
    buildProjectApiPath(projectId, `/renders/${encodeURIComponent(filename)}/open`),
    { method: "POST" },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `open failed with ${response.status}`);
  }
}
