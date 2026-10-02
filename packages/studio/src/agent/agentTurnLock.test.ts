import { afterEach, describe, expect, it } from "vitest";
import {
  agentTurnLockStore,
  clearAgentTurnRunning,
  isAgentTurnRunning,
  publishAgentTurnRunning,
  setAgentTurnRunning,
} from "./agentTurnLock";
import { timelineEditLockReason } from "../hooks/timelineEditPermission";
import { t } from "../i18n";

afterEach(() => {
  agentTurnLockStore.setState({ projectId: null, running: false });
});

describe("agent turn lock", () => {
  it("follows the project's published turn state", () => {
    expect(isAgentTurnRunning()).toBe(false);
    publishAgentTurnRunning("p1", true);
    expect(isAgentTurnRunning()).toBe(true);
    publishAgentTurnRunning("p1", false);
    expect(isAgentTurnRunning()).toBe(false);
  });

  it("only clears the mirror while the disposing project still owns it", () => {
    publishAgentTurnRunning("p2", true);
    clearAgentTurnRunning("p1");
    expect(isAgentTurnRunning()).toBe(true);
    clearAgentTurnRunning("p2");
    expect(isAgentTurnRunning()).toBe(false);
  });

  it("is drivable without an agent, for the dev hook and tests", () => {
    setAgentTurnRunning(true);
    expect(isAgentTurnRunning()).toBe(true);
    setAgentTurnRunning(false);
    expect(isAgentTurnRunning()).toBe(false);
  });

  it("is the timeline edit refusal reason while a turn runs, and no reason otherwise", () => {
    expect(timelineEditLockReason()).toBeNull();
    setAgentTurnRunning(true);
    expect(timelineEditLockReason()).toBe(t("timeline.toast.agentEditing"));
    setAgentTurnRunning(false);
    expect(timelineEditLockReason()).toBeNull();
  });
});
