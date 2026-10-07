// @vitest-environment happy-dom

/**
 * The titlebar's design-system popover: what it says about the attached system (name, version,
 * palette, display font, honest chips), the explicit Update button that exists only for a newer library version,
 * attaching and detaching through the right routes with the state read again, and how it closes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import { DesignButton } from "./DesignButton";
import { DesignProvider } from "./designContext";
import { DesignApiError } from "./designClient";
import { createDesignStore, type DesignStore } from "./designStore";
import {
  attachedDesign,
  attachedState,
  createFakeDesignClient,
  designSummary,
  type FakeDesign,
  type FakeDesignData,
} from "./designTestHarness";
import { byText, press, pressAndSettle, pressEscape, settle } from "./designDom.testHelpers";
import { useDesignUi } from "./designUiStore";

const MONO = designSummary({
  id: "mono",
  name: "Mono",
  version: 1,
  palette: ["#000000", "#ffffff"],
  displayFont: "Space Grotesk",
});

interface Mounted extends FakeDesign {
  host: HTMLElement;
  store: DesignStore;
}

function mountButton(data: FakeDesignData = {}): Mounted {
  const fake = createFakeDesignClient(data);
  const store = createDesignStore({ client: fake.client });
  const host = mountHost(
    <DesignProvider store={store}>
      <DesignButton projectId="demo" />
    </DesignProvider>,
  );
  return { ...fake, store, host };
}

const trigger = () => document.querySelector<HTMLElement>('[data-testid="header-design"]');
const panel = () => document.querySelector<HTMLElement>('[data-testid="design-panel"]');
const current = () => document.querySelector<HTMLElement>('[data-testid="design-current"]');
const update = () => document.querySelector<HTMLElement>('[data-testid="design-update"]');
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
  byText<HTMLButtonElement>(document, "button", label);

async function openPopover(mounted: Mounted): Promise<void> {
  await settle();
  await pressAndSettle(mounted.host.querySelector('[data-testid="header-design"]'));
  await settle();
}

beforeEach(() => {
  useDesignUi.setState({ dialog: null });
});

afterEach(() => {
  cleanupMounted();
});

describe("the button", () => {
  it("is an icon-only button named for assistive tech", async () => {
    mountButton();
    await settle();
    expect(trigger()?.getAttribute("aria-label")).toBe("Design system");
    expect(trigger()?.textContent).toBe("");
    expect(panel()).toBeNull();
  });
});

describe("the attached system", () => {
  it("shows its name, version, palette and display font as the project's own copy says", async () => {
    const mounted = mountButton({
      systems: [designSummary(), MONO],
      state: attachedState(),
    });
    await openPopover(mounted);
    const card = current();
    expect(card?.textContent).toContain("Sunset");
    expect(card?.textContent).toContain("v2");
    expect(card?.textContent).toContain("Display font: Fraunces");
    expect(card?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Palette: #0b0b0f, #f4f1ea, #ff6a3d, #ffb347, #4dd0e1",
    );
  });

  it("says plainly when no system is attached and offers the library", async () => {
    const mounted = mountButton({ systems: [designSummary(), MONO] });
    await openPopover(mounted);
    expect(current()).toBeNull();
    expect(panel()?.textContent).toContain("No design system attached");
    const rows = [...document.querySelectorAll('[data-testid="design-library"] li')];
    expect(rows.map((row) => row.getAttribute("data-design-id"))).toEqual(["sunset", "mono"]);
    expect(panel()?.textContent).toContain("doesn't change any existing composition");
  });

  it("marks an unknown license as checked before export and a system font as not portable", async () => {
    const mounted = mountButton({
      state: attachedState({
        attached: attachedDesign({
          unknownLicenses: ["font:Fraunces", "logo"],
          nonPortableFonts: ["Helvetica Neue"],
        }),
      }),
    });
    await openPopover(mounted);
    const chips = [...(current()?.querySelectorAll("li") ?? [])].map((chip) => chip.textContent);
    expect(chips).toEqual([
      "Fraunces: license unknown",
      "Logo: license unknown",
      "Helvetica Neue: system font",
    ]);
    expect(current()?.textContent).toContain("Unknown licenses are checked before export.");
    expect(current()?.textContent).toContain("System fonts are not stored with the system");
  });

  it("shows no chips for a system with nothing to warn about", async () => {
    const mounted = mountButton({ state: attachedState() });
    await openPopover(mounted);
    expect(current()?.querySelector("li")).toBeNull();
    expect(current()?.textContent).not.toContain("license");
  });

  it("warns about a damaged copy and about a system the library no longer has", async () => {
    const mounted = mountButton({
      systems: [],
      state: attachedState({ library: null, snapshotOk: false }),
    });
    await openPopover(mounted);
    expect(current()?.textContent).toContain("missing or damaged");
    expect(current()?.textContent).toContain("no longer in your library");
    expect(button("Preview")?.disabled).toBe(true);
  });
});

describe("the update", () => {
  it("offers no Update button while the project has the library's current version", async () => {
    const mounted = mountButton({ state: attachedState() });
    await openPopover(mounted);
    expect(update()).toBeNull();
    expect(byText(document, "button", /Update design system/)).toBeNull();
    expect(trigger()?.hasAttribute("data-update")).toBe(false);
  });

  it("offers it only for a newer library version, changes nothing until it is pressed, and then updates", async () => {
    const mounted = mountButton({
      systems: [designSummary({ version: 3 })],
      state: attachedState({ library: { name: "Sunset", version: 3 }, updateAvailable: true }),
    });
    await openPopover(mounted);
    expect(trigger()?.getAttribute("data-update")).toBe("true");
    expect(update()?.textContent).toContain("version 3");
    expect(update()?.textContent).toContain("version 2");
    expect(mounted.client.update).not.toHaveBeenCalled();

    await pressAndSettle(
      byText<HTMLButtonElement>(update() ?? document, "button", /Update design system to v3/),
    );

    expect(mounted.client.update).toHaveBeenCalledExactlyOnceWith("demo");
    expect(update()).toBeNull();
    expect(current()?.textContent).toContain("v3");
    expect(trigger()?.hasAttribute("data-update")).toBe(false);
  });

  it("offers Restore for a damaged copy at the library's current version, and restoring brings the preview back", async () => {
    const mounted = mountButton({ state: attachedState({ snapshotOk: false }) });
    await openPopover(mounted);
    expect(update()?.getAttribute("data-repair")).toBe("restore");
    expect(current()?.textContent).toContain("missing or damaged");
    // The old advice to attach again is gone: there is a button for it.
    expect(current()?.textContent).not.toContain("Attach the system again");
    expect(byText(document, "button", /Update design system/)).toBeNull();
    expect(button("Preview")?.disabled).toBe(true);
    expect(mounted.client.update).not.toHaveBeenCalled();

    await pressAndSettle(button("Restore design files"));

    expect(mounted.client.update).toHaveBeenCalledExactlyOnceWith("demo");
    expect(update()).toBeNull();
    expect(current()?.textContent).not.toContain("missing or damaged");
    expect(button("Preview")?.disabled).toBe(false);
  });

  it("labels the repair Update, not Restore, when the library is newer and the copy is damaged too", async () => {
    const mounted = mountButton({
      systems: [designSummary({ version: 3 })],
      state: attachedState({
        library: { name: "Sunset", version: 3 },
        updateAvailable: true,
        snapshotOk: false,
      }),
    });
    await openPopover(mounted);
    expect(update()?.getAttribute("data-repair")).toBe("update");
    expect(button("Update design system to v3")).not.toBeNull();
    expect(byText(document, "button", "Restore design files")).toBeNull();
  });

  it("offers Replace when the library's system of that name is a different one with no newer version", async () => {
    const mounted = mountButton({
      state: attachedState({
        attached: attachedDesign({ version: 3 }),
        library: { name: "Sunset", version: 1 },
        updateAvailable: true,
      }),
      systems: [designSummary({ version: 1 })],
    });
    await openPopover(mounted);
    expect(update()?.getAttribute("data-repair")).toBe("replace");
    expect(update()?.textContent).toContain("different system");
    expect(mounted.client.update).not.toHaveBeenCalled();

    await pressAndSettle(byText(update() ?? document, "button", "Replace with the library's v1"));

    expect(mounted.client.update).toHaveBeenCalledExactlyOnceWith("demo");
  });

  it("offers no repair for a damaged copy whose system left the library", async () => {
    const mounted = mountButton({
      systems: [],
      state: attachedState({ library: null, snapshotOk: false }),
    });
    await openPopover(mounted);
    expect(update()).toBeNull();
    expect(byText(document, "button", "Restore design files")).toBeNull();
    expect(current()?.textContent).toContain("can't be restored");
  });
});

describe("attaching and detaching", () => {
  it("attaches the chosen library system and shows it as the project's", async () => {
    const mounted = mountButton({ systems: [designSummary(), MONO] });
    await openPopover(mounted);
    mounted.client.getProject.mockClear();

    await pressAndSettle(button("Attach Mono to this project"));

    expect(mounted.client.attach).toHaveBeenCalledExactlyOnceWith("demo", "mono");
    expect(mounted.client.getProject).toHaveBeenCalledTimes(1);
    expect(current()?.textContent).toContain("Mono");
    expect(current()?.textContent).toContain("v1");
    // The attached row can no longer be chosen; the other one still can.
    expect(button("Attach Mono to this project")?.disabled).toBe(true);
    expect(button("Attach Sunset to this project")?.disabled).toBe(false);
    expect(document.querySelector('li[data-design-id="mono"]')?.textContent).toContain("Attached");
  });

  it("switches from one attached system to another", async () => {
    const mounted = mountButton({ systems: [designSummary(), MONO], state: attachedState() });
    await openPopover(mounted);
    expect(button("Attach Sunset to this project")?.disabled).toBe(true);

    await pressAndSettle(button("Attach Mono to this project"));

    expect(mounted.client.attach).toHaveBeenCalledWith("demo", "mono");
    expect(current()?.textContent).toContain("Mono");
  });

  it("detaches and goes back to the empty state", async () => {
    const mounted = mountButton({ state: attachedState() });
    await openPopover(mounted);
    mounted.client.getProject.mockClear();

    await pressAndSettle(button("Detach"));

    expect(mounted.client.detach).toHaveBeenCalledExactlyOnceWith("demo");
    expect(mounted.client.getProject).toHaveBeenCalledTimes(1);
    expect(current()).toBeNull();
    expect(panel()?.textContent).toContain("No design system attached");
  });

  it("shows why a change failed and lets the user dismiss it", async () => {
    const mounted = mountButton({ systems: [designSummary(), MONO] });
    await openPopover(mounted);
    mounted.client.attach.mockRejectedValueOnce(
      new DesignApiError(
        "invalid_system",
        "The design system's files don't pass the format check.",
        422,
        ["tokens.css: missing --accent-2"],
      ),
    );

    await pressAndSettle(button("Attach Mono to this project"));

    const alert = panel()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("don't pass the format check");
    expect(alert?.textContent).toContain("tokens.css: missing --accent-2");
    expect(current()).toBeNull();

    await pressAndSettle(button("Close"));
    expect(panel()?.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("loading, empty and failing states", () => {
  it("says the library is empty and offers to create a system", async () => {
    const mounted = mountButton({ systems: [] });
    await openPopover(mounted);
    expect(panel()?.textContent).toContain("Your library is empty");
    expect(byText(document, "button", "Create design system…")).not.toBeNull();
  });

  it("shows a failure with Retry, keeps what was read, and recovers on Retry", async () => {
    const mounted = mountButton({ state: attachedState() });
    mounted.client.listLibrary.mockRejectedValueOnce(
      new DesignApiError("unavailable", "The design service is unavailable."),
    );
    await openPopover(mounted);
    const error = document.querySelector('[data-testid="design-error"]');
    expect(error?.textContent).toContain("The design service is unavailable.");
    // The project's own half still shows.
    expect(current()?.textContent).toContain("Sunset");

    await pressAndSettle(byText(error ?? document, "button", "Retry"));

    expect(document.querySelector('[data-testid="design-error"]')).toBeNull();
    expect(mounted.client.listLibrary).toHaveBeenCalledTimes(3);
    expect(document.querySelector('[data-testid="design-library"]')).not.toBeNull();
  });

  it("reads the state again each time it opens", async () => {
    const mounted = mountButton({ state: attachedState() });
    await openPopover(mounted);
    const before = mounted.client.getProject.mock.calls.length;
    pressEscape();
    await settle();
    await pressAndSettle(trigger());
    expect(mounted.client.getProject.mock.calls.length).toBe(before + 1);
  });
});

describe("closing", () => {
  it("closes on a press outside it, on Esc and on a second press of its button", async () => {
    const mounted = mountButton({ state: attachedState() });
    await openPopover(mounted);
    expect(panel()).not.toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Design system"]')).not.toBeNull();

    press(document.body);
    await settle();
    expect(panel()).toBeNull();

    await pressAndSettle(trigger());
    expect(panel()).not.toBeNull();
    pressEscape();
    await settle();
    expect(panel()).toBeNull();

    await pressAndSettle(trigger());
    expect(panel()).not.toBeNull();
    await pressAndSettle(trigger());
    expect(panel()).toBeNull();
  });
});

describe("handing over to a dialog", () => {
  it("opens the project's preview, a library system's preview and its edit, and closes itself", async () => {
    const mounted = mountButton({ systems: [designSummary(), MONO], state: attachedState() });
    await openPopover(mounted);

    await pressAndSettle(button("Preview"));
    expect(useDesignUi.getState().dialog).toEqual({
      kind: "preview",
      target: { kind: "project", projectId: "demo" },
      title: "Sunset",
    });
    expect(panel()).toBeNull();

    await pressAndSettle(trigger());
    await pressAndSettle(button("Preview Mono"));
    expect(useDesignUi.getState().dialog).toEqual({
      kind: "preview",
      target: { kind: "library", id: "mono", version: 1 },
      title: "Mono",
    });

    await pressAndSettle(trigger());
    await pressAndSettle(button("Edit Mono with the agent"));
    expect(useDesignUi.getState().dialog).toEqual({ kind: "edit", systemId: "mono" });
    expect(panel()).toBeNull();
  });

  it("opens the create dialog on a brief, or on 'from this project'", async () => {
    const mounted = mountButton({ state: attachedState() });
    await openPopover(mounted);

    await pressAndSettle(byText(document, "button", "Create design system…"));
    expect(useDesignUi.getState().dialog).toEqual({ kind: "create", source: "scratch" });

    await pressAndSettle(trigger());
    await pressAndSettle(byText(document, "button", "Create from this project"));
    expect(useDesignUi.getState().dialog).toEqual({ kind: "create", source: "project" });
    expect(panel()).toBeNull();
  });
});
