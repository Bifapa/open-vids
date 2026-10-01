import { useEffect, useState } from "react";
import { Tab, TabPanel, Tabs, TabsList } from "../components/ui";
import { useTranslation } from "../i18n";
import { AssetSearchPolicyView } from "./AssetSearchPolicyView";
import { ProjectSources } from "./ProjectSources";
import { useResearchServices } from "./researchContext";

type SourcesTab = "project" | "policy";

/**
 * The Sources & Licenses dock panel: the project's researched assets with their provenance and licenses, and the
 * global Asset Search policy that decides where the Research agent may look.
 */
export function SourcesPanel() {
  const { t } = useTranslation();
  const { store } = useResearchServices();
  const [tab, setTab] = useState<SourcesTab>("project");
  // Opening the panel shows the records as they are now.
  useEffect(() => {
    void store.getState().reload();
  }, [store]);
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value === "policy" ? "policy" : "project")}
      className="flex h-full min-h-0 flex-col bg-bg-0 text-fg"
      data-studio-sources=""
    >
      <div className="flex h-head shrink-0 items-center border-b border-border-subtle px-2">
        <TabsList aria-label={t("research.panel.label")}>
          <Tab value="project">{t("research.tab.project")}</Tab>
          <Tab value="policy">{t("research.tab.policy")}</Tab>
        </TabsList>
      </div>
      <TabPanel
        value="project"
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-color:var(--color-surface-3)_transparent]"
      >
        <ProjectSources onOpenPolicy={() => setTab("policy")} />
      </TabPanel>
      <TabPanel
        value="policy"
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-color:var(--color-surface-3)_transparent]"
      >
        <AssetSearchPolicyView />
      </TabPanel>
    </Tabs>
  );
}
