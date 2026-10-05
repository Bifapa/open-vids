/** The `keyCode` browsers give a key press that an input method (IME) is handling ("Process"). */
const IME_PROCESS_KEY_CODE = 229;

/**
 * True when an input method owns this key press: a CJK or other IME is composing, or is committing with it. WebKit
 * (Studio's WKWebView) ends the composition *before* it delivers the Enter that committed it, so `isComposing` is
 * already false on that keydown and only `keyCode` 229 still says the key was the IME's. An Enter-to-submit field
 * has to ignore both, or it sends the half-written text.
 */
export function isImeKeyEvent(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === IME_PROCESS_KEY_CODE;
}
