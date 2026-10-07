import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import { useTranslation } from "../../i18n";
import { readStudioUiPreferences } from "../../utils/studioUiPreferences";
import { installDockAccessibility } from "./dockAccessibility";
import { DockStripActions } from "./DockStripActions";
import { DockTab } from "./DockTab";
import { DockWindowMenu } from "./DockWindowMenu";
import { installTabFill } from "./dockTabFill";
import {
  addRegisteredPanel,
  applySideMinimums,
  buildEditLayout,
  withChatFirst,
} from "./dockLayout";
import { DOCK_PANEL_COMPONENT } from "./dockLayoutSchema";
import { createDockArrangement, type DockArrangement } from "./dockArrangement";
import { isStoryPanel, storyPlacement, type Arrangement } from "./dockWorkspace";
import { useDockLayoutStore, type DockController, type DockSnapshot } from "./dockLayoutStore";
import {
  PANEL_DEFINITIONS,
  isPanelAvailable,
  isPanelId,
  panelsInZone,
  type PanelDefinition,
  type PanelId,
} from "./panelRegistry";
import "./dock.css";

const PERSIST_DEBOUNCE_MS = 250;

type Slots = Partial<Record<PanelId, HTMLElement>>;

interface SlotsContextValue {
  slots: Slots;
  registerSlot: (id: PanelId, element: HTMLElement | null) => void;
}

const SlotsContext = createContext<SlotsContextValue | null>(null);

function useSlots(): SlotsContextValue {
  const value = useContext(SlotsContext);
  if (!value) throw new Error("Dock.Panel must be rendered inside Dock.Root");
  return value;
}

/** The element dockview mounts for a panel; Dock.Panel portals the real content into it. */
function PanelSlot({ api }: IDockviewPanelProps) {
  const { registerSlot } = useSlots();
  const id = api.id;
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (isPanelId(id)) registerSlot(id, element);
    },
    [id, registerSlot],
  );
  return <div ref={ref} className="h-full w-full min-h-0 min-w-0 overflow-hidden" />;
}

const COMPONENTS = { [DOCK_PANEL_COMPONENT]: PanelSlot };

function snapshot(api: DockviewApi, arrangement: Arrangement): DockSnapshot {
  const openPanels = new Set<PanelId>();
  const visiblePanels = new Set<PanelId>();
  for (const panel of api.panels) {
    if (!isPanelId(panel.id)) continue;
    // Story keeps the Edit panels in hidden groups for the way back; to the rest of Studio they are closed.
    if (arrangement === "story" && !isStoryPanel(panel.id)) continue;
    openPanels.add(panel.id);
    if (panel.api.isVisible && panel.group.api.isVisible) visiblePanels.add(panel.id);
  }
  const groupActivePanels = api.groups.flatMap((group) => {
    const id = group.activePanel?.id;
    return isPanelId(id) ? [id] : [];
  });
  const active = api.activePanel?.id;
  return {
    arrangement,
    openPanels,
    visiblePanels,
    activePanel: isPanelId(active) ? active : null,
    groupActivePanels,
  };
}

function openPanel(api: DockviewApi, id: PanelId, arrangement: Arrangement) {
  if (api.getPanel(id)) return;
  const story = arrangement === "story" ? storyPlacement(api, id) : undefined;
  if (story) {
    addRegisteredPanel(api, id, story);
    return;
  }
  const { zone, reopen } = PANEL_DEFINITIONS[id];
  // Side columns are tab groups; preview and timeline are separate groups in the centre.
  const sibling =
    zone === "center"
      ? undefined
      : panelsInZone(zone).find((other) => other !== id && api.getPanel(other));
  if (sibling) {
    // Slot the tab in registry order (Chat, Compositions, Assets, ...) among the group's panels.
    const order = panelsInZone(zone);
    const group = api.getPanel(sibling)?.group;
    const at = group?.panels.findIndex(
      (panel) => isPanelId(panel.id) && order.indexOf(panel.id) > order.indexOf(id),
    );
    addRegisteredPanel(api, id, {
      referencePanel: sibling,
      direction: "within",
      ...(at !== undefined && at >= 0 ? { index: at } : {}),
    });
    return;
  }
  const hasAnchor = api.getPanel(reopen.near) !== undefined;
  const position = { referencePanel: reopen.near, direction: reopen.direction };
  addRegisteredPanel(api, id, hasAnchor ? position : undefined);
}

function createController(api: DockviewApi, arrangement: DockArrangement): DockController {
  const open = (id: PanelId) => openPanel(api, id, arrangement.current());
  // dockview hands a re-shown group whatever its neighbours left over, and hiding one group first
  // widens the next before it is hidden. So the first hide records every showing group's size, and
  // the last show puts the whole arrangement back; showing only some restores just those.
  const savedSizes = new Map<string, { width: number; height: number }>();
  const setGroupVisible = (id: PanelId, visible: boolean) => {
    const group = api.getPanel(id)?.group;
    if (!group || group.api.isVisible === visible) return;
    if (!visible) {
      const record = savedSizes.size === 0 ? api.groups : [group];
      for (const each of record) {
        if (each.api.isVisible && !savedSizes.has(each.id)) {
          savedSizes.set(each.id, { width: each.width, height: each.height });
        }
      }
      group.api.setVisible(false);
      return;
    }
    group.api.setVisible(true);
    if (api.groups.every((each) => each.api.isVisible)) {
      for (const [groupId, size] of savedSizes) api.getGroup(groupId)?.api.setSize(size);
      savedSizes.clear();
      return;
    }
    const size = savedSizes.get(group.id);
    if (size) group.api.setSize(size);
  };
  return {
    open,
    activate: (id) => {
      open(id);
      api.getPanel(id)?.api.setActive();
    },
    close: (id) => {
      const panel = api.getPanel(id);
      if (panel) api.removePanel(panel);
    },
    setTitle: (id, title) => api.getPanel(id)?.api.setTitle(title),
    setGroupVisible,
    enterStory: arrangement.enterStory,
    leaveStory: arrangement.leaveStory,
    reset: arrangement.reset,
  };
}

function restoreOrBuild(api: DockviewApi, projectId: string | null) {
  const stored = readStudioUiPreferences(undefined, projectId).dockLayout;
  if (stored) {
    try {
      api.fromJSON(withChatFirst(stored));
      // A tab of a beta feature this build does not have (a layout saved by a beta build) would open empty.
      for (const panel of [...api.panels]) {
        if (isPanelId(panel.id) && !isPanelAvailable(panel.id)) api.removePanel(panel);
      }
      return;
    } catch {
      /* a layout the schema accepted but dockview cannot load: start over */
    }
  }
  buildEditLayout(api, window.innerWidth);
}

function Root({ projectId, children }: { projectId: string | null; children: ReactNode }) {
  const [slots, setSlots] = useState<Slots>({});
  const shownArrangement = useDockLayoutStore((state) => state.arrangement);
  const registerSlot = useCallback((id: PanelId, element: HTMLElement | null) => {
    setSlots((prev) => {
      if (prev[id] === (element ?? undefined)) return prev;
      const next = { ...prev };
      if (element) next[id] = element;
      else delete next[id];
      return next;
    });
  }, []);

  const disposeRef = useRef<() => void>(() => {});
  useEffect(() => () => disposeRef.current(), []);

  const onReady = useCallback(
    ({ api }: DockviewReadyEvent) => {
      disposeRef.current();
      restoreOrBuild(api, projectId);
      applySideMinimums(api);
      const root = api.groups[0]?.element.closest<HTMLElement>(".hf-dock");
      const disposeAccessibility = root ? installDockAccessibility(api, root) : () => {};
      const disposeTabFill = root ? installTabFill(api, root) : () => {};
      // The dock spans the window (buildEditLayout sizes against it too); its own box lags a resize.
      const resizeObserver = new ResizeObserver(() => applySideMinimums(api, window.innerWidth));
      if (root) resizeObserver.observe(root);
      const store = useDockLayoutStore.getState();
      const sync = () => useDockLayoutStore.getState().sync(snapshot(api, arrangement.current()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const persist = () => {
        clearTimeout(timer);
        timer = setTimeout(arrangement.save, PERSIST_DEBOUNCE_MS);
      };
      // dockview does not fire onDidLayoutChange for add/remove/activate,
      // so every event class is wired to the same sync+persist pair. While panels are being moved
      // between arrangements the dock is half built: only the arrangement's own switch syncs it.
      const onDockChange = () => {
        if (arrangement.moving()) return;
        sync();
        persist();
      };
      const arrangement = createDockArrangement(api, projectId, {
        openPanel: (id) => openPanel(api, id, "edit"),
        onChange: () => {
          applySideMinimums(api);
          sync();
        },
      });
      if (readStudioUiPreferences(undefined, projectId).dockWorkspace === "story") {
        arrangement.enterStory();
      }
      store.attach(createController(api, arrangement));
      sync();
      const subscriptions = [
        api.onDidAddPanel(() => {
          applySideMinimums(api);
          onDockChange();
        }),
        api.onDidMovePanel(() => {
          applySideMinimums(api);
          onDockChange();
        }),
        api.onDidRemovePanel(onDockChange),
        api.onDidActivePanelChange(onDockChange),
        api.onDidLayoutChange(onDockChange),
      ];
      // After the subscriptions, so the store syncs; through the store, so a panel the restored
      // layout lacks is opened and its group shown. Saved at once: a remount (StrictMode, HMR)
      // restores the stored layout, and must find the requested panel in front.
      const pendingWorkspace = store.takePendingWorkspace();
      if (pendingWorkspace) store.setWorkspace(pendingWorkspace);
      const pending = store.takePendingActivation();
      if (pending) store.activatePanel(pending);
      if (pendingWorkspace || pending) arrangement.save();
      disposeRef.current = () => {
        clearTimeout(timer);
        for (const subscription of subscriptions) subscription.dispose();
        disposeAccessibility();
        disposeTabFill();
        resizeObserver.disconnect();
        useDockLayoutStore.getState().detach();
      };
    },
    [projectId],
  );

  return (
    <SlotsContext.Provider value={{ slots, registerSlot }}>
      <div className="hf-dock-frame" data-arrangement={shownArrangement}>
        <DockviewReact
          key={projectId ?? ""}
          className="hf-dock min-h-0 min-w-0 flex-1"
          components={COMPONENTS}
          defaultTabComponent={DockTab}
          rightHeaderActionsComponent={DockStripActions}
          defaultRenderer="always"
          disableFloatingGroups
          disableTabsOverflowList
          onReady={onReady}
        />
      </div>
      {children}
    </SlotsContext.Provider>
  );
}

function Panel({ id, title, children }: { id: PanelId; title?: string; children: ReactNode }) {
  const { t } = useTranslation();
  const element = useSlots().slots[id];
  const visible = useDockLayoutStore((state) => state.visiblePanels.has(id));
  const controller = useDockLayoutStore((state) => state.controller);
  const open = useDockLayoutStore((state) => state.openPanels.has(id));
  const label = title ?? t(PANEL_DEFINITIONS[id].title);
  useEffect(() => {
    if (open) controller?.setTitle(id, label);
  }, [controller, id, label, open]);
  const definition: PanelDefinition = PANEL_DEFINITIONS[id];
  const shown = visible || definition.keepMounted;
  return element && shown ? createPortal(children, element) : null;
}

export const Dock = { Root, Panel, WindowMenu: DockWindowMenu };
