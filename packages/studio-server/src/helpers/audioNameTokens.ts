/**
 * Words that mark a folder or file as holding music or sound effects. Shared by the QA checks (no speech to cut
 * through) and the cross-project parts (what counts as music).
 */

const MUSIC_TOKENS: Record<string, true> = {
  music: true,
  bgm: true,
  soundtrack: true,
  ambient: true,
  jingle: true,
};

/** Sound effects and generic sound folders: not music, though not speech either. */
const EFFECT_TOKENS: Record<string, true> = {
  sfx: true,
  sound: true,
  sounds: true,
  fx: true,
  effects: true,
};

/** The tokens of a path: split at anything but letters and digits, a trailing number (`music2`) ignored. */
function tokensOf(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.replace(/\d+$/, ""));
}

/** Whether a folder or the file name has a token such as `music` or `sfx`: audio that carries no speech. */
export function hasNonSpeechToken(path: string): boolean {
  return tokensOf(path).some(
    (token) => MUSIC_TOKENS[token] === true || EFFECT_TOKENS[token] === true,
  );
}

/** Whether the path names music (`assets/music/…`, `bgm-loop.mp3`) and not a sound-effect folder or file. */
export function hasMusicToken(path: string): boolean {
  const tokens = tokensOf(path);
  return (
    tokens.some((token) => MUSIC_TOKENS[token] === true) &&
    !tokens.some((token) => EFFECT_TOKENS[token] === true)
  );
}
