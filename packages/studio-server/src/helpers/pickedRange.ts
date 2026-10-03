import type { AssetRange } from "@hyperframes/agent-protocol";

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** `42–75s of assets/music.mp3` — a picked fragment as the editing refusals and the Story/cut warnings name it. */
export function pickedFragment(source: string, pick: AssetRange): string {
  return `${round3(pick.start)}–${round3(pick.end)}s of ${source}`;
}

/** `The user picked 42–75s of assets/music.mp3 for use` — the opening of a warning that names a pick. */
export function pickedForUse(source: string, pick: AssetRange): string {
  return `The user picked ${pickedFragment(source, pick)} for use`;
}
