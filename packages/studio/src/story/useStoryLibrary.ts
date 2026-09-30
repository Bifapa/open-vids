import { useCallback, useEffect, useRef, useState } from "react";
import type { PresetInfo, ProjectAsset } from "@hyperframes/agent-protocol";
import type { StoryClient } from "./storyClient";

/** What the add menu and the inspector pick from: the project's media and the motion presets. */
export interface StoryLibrary {
  assets: ProjectAsset[];
  presets: PresetInfo[];
  status: "loading" | "ready" | "failed";
  refresh(): void;
}

export function useStoryLibrary(client: StoryClient, projectId: string): StoryLibrary {
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [status, setStatus] = useState<StoryLibrary["status"]>("loading");
  const request = useRef(0);

  const refresh = useCallback(() => {
    request.current += 1;
    const mine = request.current;
    void Promise.allSettled([
      client.inventory(projectId),
      client.presets(projectId, "block"),
      client.presets(projectId, "component"),
    ]).then(([inventory, blocks, components]) => {
      if (mine !== request.current) return;
      if (inventory.status === "fulfilled") setAssets(inventory.value.assets);
      setPresets([
        ...(blocks.status === "fulfilled" ? blocks.value : []),
        ...(components.status === "fulfilled" ? components.value : []),
      ]);
      setStatus(inventory.status === "fulfilled" ? "ready" : "failed");
    });
  }, [client, projectId]);

  useEffect(() => {
    refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);

  return { assets, presets, status, refresh };
}
