import type { Composition, GsapTweenSpec } from "@hyperframes/sdk";
import { t } from "../i18n";
import type { DomEditSelection } from "../components/editor/domEditing";
import type { PatchOperation } from "./sourcePatcher";
import * as studioAvailability from "../components/editor/manualEditingAvailability";
import { patchOpsToSdkEditOps } from "./sdkOpMapping";
import {
  sdkCutoverIneligibleReason,
  shouldDeclineTextCutoverForTarget,
} from "./sdkCutoverEligibility";
import {
  declinedCutover,
  failedCutover,
  persistSdkCandidateMutation,
  type CutoverDeps,
  type CutoverOptions,
  type CutoverResult,
} from "./sdkEditTransaction";
import { isSdkFamilyEnabled, type StudioSdkOperationFamily } from "./sdkCutoverPolicy";

export { shouldUseSdkCutover } from "./sdkCutoverEligibility";
export {
  cutoverCommittedOrThrow,
  persistSdkCandidateMutation,
  persistSdkSerialize,
} from "./sdkEditTransaction";
export type {
  CutoverDeps,
  CutoverOptions,
  CutoverResult,
  PublishSdkSession,
} from "./sdkEditTransaction";

function sdkFamilyEnabled(family: StudioSdkOperationFamily): boolean {
  const configured = Object.prototype.hasOwnProperty.call(
    studioAvailability,
    "STUDIO_SDK_CUTOVER_FAMILIES",
  )
    ? studioAvailability.STUDIO_SDK_CUTOVER_FAMILIES
    : undefined;
  return isSdkFamilyEnabled(studioAvailability.STUDIO_SDK_CUTOVER_ENABLED, configured, family);
}

/** True when targetPath isn't the composition the SDK session models. */
function wrongCompositionFile(deps: CutoverDeps, targetPath: string): boolean {
  return deps.compositionPath != null && targetPath !== deps.compositionPath;
}

export async function sdkCutoverPersist(
  selection: DomEditSelection,
  ops: PatchOperation[],
  originalContent: string,
  targetPath: string,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  // Name WHICH eligibility check failed: on v0.8.47 this one string covered 26 of
  // 30 dom declines. The two below aren't properties of the batch, so they differ.
  if (!sdkFamilyEnabled("dom")) return declinedCutover("feature_disabled");
  if (!sdkSession) return declinedCutover("session_unavailable");
  const hfId = selection.hfId;
  const ineligible = sdkCutoverIneligibleReason(hfId, ops);
  // `!hfId` is already a reason; testing it again narrows the type for the rest.
  if (ineligible || !hfId) return declinedCutover(ineligible ?? "target_unaddressable");
  const target = sdkSession.getElement(hfId);
  if (!target) return declinedCutover("target_not_found");
  if (shouldDeclineTextCutoverForTarget(target, ops))
    return declinedCutover("unsupported_text_target");
  if (wrongCompositionFile(deps, targetPath)) return declinedCutover("wrong_composition_file");
  const result = await persistSdkCandidateMutation(
    sdkSession,
    targetPath,
    originalContent,
    deps,
    (session) => {
      for (const editOp of patchOpsToSdkEditOps(hfId, ops)) session.dispatch(editOp);
    },
    options,
  );
  return result;
}

export async function sdkTimingPersist(
  hfId: string,
  targetPath: string,
  timingUpdate: { start?: number; duration?: number; trackIndex?: number },
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  // Dark-launch gate: without this, timing cutover runs whenever an SDK session
  // exists (it always does, for shadow/selection) — flipping the flag OFF would
  // NOT disable it. Gate here so flag-off routes back to the legacy server path.
  if (!sdkFamilyEnabled("timing")) return declinedCutover("feature_disabled");
  if (!sdkSession) return declinedCutover("session_unavailable");
  if (!sdkSession.getElement(hfId)) return declinedCutover("target_not_found");
  if (wrongCompositionFile(deps, targetPath)) return declinedCutover("wrong_composition_file");
  try {
    const serializedBefore = sdkSession.serialize();
    const result = await persistSdkCandidateMutation(
      sdkSession,
      targetPath,
      serializedBefore,
      deps,
      (session) => session.setTiming(hfId, timingUpdate),
      options,
      serializedBefore,
    );
    return result;
  } catch (error) {
    return failedCutover(error);
  }
}

export async function sdkTimingBatchPersist(
  changes: Array<{
    hfId: string;
    timingUpdate: { start?: number; duration?: number; trackIndex?: number };
  }>,
  targetPath: string,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  if (!sdkFamilyEnabled("timing")) return declinedCutover("feature_disabled");
  if (!sdkSession) return declinedCutover("session_unavailable");
  if (wrongCompositionFile(deps, targetPath)) return declinedCutover("wrong_composition_file");
  const unresolved = changes.find((change) => !sdkSession.getElement(change.hfId));
  if (unresolved) return declinedCutover("target_not_found");
  try {
    const serializedBefore = sdkSession.serialize();
    const result = await persistSdkCandidateMutation(
      sdkSession,
      targetPath,
      serializedBefore,
      deps,
      (session) => {
        for (const change of changes) session.setTiming(change.hfId, change.timingUpdate);
      },
      options,
      serializedBefore,
    );
    if (result.status === "failed") {
      return failedCutover(result.error);
    }
    return result;
  } catch (error) {
    return failedCutover(error);
  }
}

type SdkGsapTweenOp =
  | { kind: "add"; target: string; spec: GsapTweenSpec }
  | { kind: "set"; animationId: string; properties: Partial<GsapTweenSpec> }
  | { kind: "remove"; animationId: string };

export function sdkGsapTweenPersist(
  targetPath: string,
  op: SdkGsapTweenOp,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  // Leading dark-launch gate so flag-off does no SDK touch (getElement) at all —
  // matches the other three chokepoints' discipline.
  if (!sdkFamilyEnabled("gsap-animation"))
    return Promise.resolve(declinedCutover("feature_disabled"));
  if (op.kind === "add" && sdkSession && !sdkSession.getElement(op.target))
    return Promise.resolve(declinedCutover("target_not_found"));
  // dispatchGsapOpAndPersist declines on before===after — that catches stale
  // animationIds and unsupported shapes (e.g. from-prop on a plain tween), falling
  // back to the server path. This subsumes explicit existence guards for set/remove.
  return dispatchGsapOpAndPersist("gsap-animation", targetPath, sdkSession, deps, options, (s) => {
    s.batch(() => {
      if (op.kind === "add") {
        s.addGsapTween(op.target, op.spec);
      } else if (op.kind === "set") {
        s.setGsapTween(op.animationId, op.properties);
      } else {
        s.removeGsapTween(op.animationId);
      }
    });
  });
}

async function dispatchGsapOpAndPersist(
  family: "gsap-animation" | "gsap-keyframe",
  targetPath: string,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options: CutoverOptions | undefined,
  dispatch: (s: Composition) => void,
): Promise<CutoverResult> {
  // Dark-launch gate (shared chokepoint for every GSAP-op cutover persist):
  // flag OFF → explicit decline → caller falls back to the legacy server path.
  if (!sdkFamilyEnabled(family)) return declinedCutover("feature_disabled");
  if (!sdkSession) return declinedCutover("session_unavailable");
  if (wrongCompositionFile(deps, targetPath)) return declinedCutover("wrong_composition_file");
  const session = sdkSession;
  // persistSdkCandidateMutation owns the shared per-project/file transaction
  // coordinator used by both SDK and legacy GSAP writes.
  try {
    const serializedBefore = session.serialize();
    const result = await persistSdkCandidateMutation(
      session,
      targetPath,
      serializedBefore,
      deps,
      dispatch,
      options,
      serializedBefore,
    );
    if (result.status === "failed") {
      return failedCutover(result.error);
    }
    return result;
  } catch (error) {
    return failedCutover(error);
  }
}

export function sdkGsapKeyframePersist(
  targetPath: string,
  animationId: string,
  position: number,
  value: Record<string, unknown>,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  return dispatchGsapOpAndPersist("gsap-keyframe", targetPath, sdkSession, deps, options, (s) =>
    s.batch(() => s.dispatch({ type: "addGsapKeyframe", animationId, position, value })),
  );
}

export function sdkGsapRemoveKeyframePersist(
  targetPath: string,
  animationId: string,
  percentage: number,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  return dispatchGsapOpAndPersist("gsap-keyframe", targetPath, sdkSession, deps, options, (s) =>
    s.dispatch({ type: "removeGsapKeyframe", animationId, percentage }),
  );
}

export function sdkGsapRemovePropertyPersist(
  targetPath: string,
  animationId: string,
  property: string,
  from: boolean,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  return dispatchGsapOpAndPersist("gsap-animation", targetPath, sdkSession, deps, options, (s) =>
    s.dispatch({ type: "removeGsapProperty", animationId, property, from }),
  );
}

export function sdkGsapDeleteAllForSelectorPersist(
  targetPath: string,
  selector: string,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  return dispatchGsapOpAndPersist("gsap-animation", targetPath, sdkSession, deps, options, (s) =>
    s.dispatch({ type: "deleteAllForSelector", selector }),
  );
}

export function sdkGsapRemoveAllKeyframesPersist(
  targetPath: string,
  animationId: string,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  return dispatchGsapOpAndPersist("gsap-keyframe", targetPath, sdkSession, deps, options, (s) =>
    s.dispatch({ type: "removeAllKeyframes", animationId }),
  );
}

export function sdkGsapConvertToKeyframesPersist(
  targetPath: string,
  animationId: string,
  resolvedFromValues: Record<string, number | string> | undefined,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  return dispatchGsapOpAndPersist("gsap-keyframe", targetPath, sdkSession, deps, options, (s) =>
    s.dispatch({ type: "convertToKeyframes", animationId, resolvedFromValues }),
  );
}

type KeyframeSpec = {
  percentage: number;
  properties: Record<string, number | string>;
  ease?: string;
  auto?: boolean;
};

type KeyframesPayload = {
  targetSelector: string;
  position: number;
  duration: number;
  keyframes: KeyframeSpec[];
  ease?: string;
};

function keyframesPayload(
  targetSelector: string,
  position: number,
  duration: number,
  keyframes: KeyframeSpec[],
  ease: string | undefined,
): KeyframesPayload {
  return { targetSelector, position, duration, keyframes, ...(ease ? { ease } : {}) };
}

/** Shared inner dispatch for addWithKeyframes / replaceWithKeyframes ops. */
function dispatchWithKeyframes(
  s: Composition,
  payload: KeyframesPayload,
  animationId?: string,
): void {
  if (animationId !== undefined) {
    s.dispatch({ type: "replaceWithKeyframes", animationId, ...payload });
  } else {
    s.dispatch({ type: "addWithKeyframes", ...payload });
  }
}

function persistKeyframesOperation(input: {
  targetPath: string;
  targetSelector: string;
  position: number;
  duration: number;
  keyframes: KeyframeSpec[];
  ease: string | undefined;
  sdkSession: Composition | null | undefined;
  deps: CutoverDeps;
  options?: CutoverOptions;
  animationId?: string;
}): Promise<CutoverResult> {
  const payload = keyframesPayload(
    input.targetSelector,
    input.position,
    input.duration,
    input.keyframes,
    input.ease,
  );
  return dispatchGsapOpAndPersist(
    "gsap-keyframe",
    input.targetPath,
    input.sdkSession,
    input.deps,
    input.options,
    (session) => dispatchWithKeyframes(session, payload, input.animationId),
  );
}

export function sdkAddWithKeyframesPersist(
  targetPath: string,
  targetSelector: string,
  position: number,
  duration: number,
  keyframes: KeyframeSpec[],
  ease: string | undefined,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  return persistKeyframesOperation({
    targetPath,
    targetSelector,
    position,
    duration,
    keyframes,
    ease,
    sdkSession,
    deps,
    options,
  });
}

export function sdkReplaceWithKeyframesPersist(
  targetPath: string,
  animationId: string,
  targetSelector: string,
  position: number,
  duration: number,
  keyframes: KeyframeSpec[],
  ease: string | undefined,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
  options?: CutoverOptions,
): Promise<CutoverResult> {
  return persistKeyframesOperation({
    targetPath,
    animationId,
    targetSelector,
    position,
    duration,
    keyframes,
    ease,
    sdkSession,
    deps,
    options,
  });
}

export async function sdkDeletePersist(
  hfId: string,
  originalContent: string,
  targetPath: string,
  sdkSession: Composition | null | undefined,
  deps: CutoverDeps,
): Promise<CutoverResult> {
  // Dark-launch gate: flag OFF → legacy server delete path.
  if (!sdkFamilyEnabled("lifecycle")) return declinedCutover("feature_disabled");
  if (!sdkSession) return declinedCutover("session_unavailable");
  if (!sdkSession.getElement(hfId)) return declinedCutover("target_not_found");
  if (wrongCompositionFile(deps, targetPath)) return declinedCutover("wrong_composition_file");
  const result = await persistSdkCandidateMutation(
    sdkSession,
    targetPath,
    originalContent,
    deps,
    (session) => session.removeElement(hfId),
    { label: t("app.history.deleteElement") },
  );
  return result;
}
