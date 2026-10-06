import { useEffect, useState } from "react";
import type { DesignSourceKind } from "@hyperframes/agent-protocol";
import { studioCrossProjectClient, type CrossProjectClient } from "../agent/crossProjectClient";
import type { DesignTurnSpec } from "../agent/designTurn";

/** Another project of the Projects page a system can be made from (only when the host reports the capability). */
export interface ExternalProjectChoice {
  key: string;
  name: string;
}

/**
 * What the host offers the design surface. `externalProjects` lists the Projects page's other projects (the Studio
 * server's `cross-project` list): null while the host reports none (no capability, or no other project), and the
 * "From another project" source is then not offered at all.
 */
export interface DesignHostCapabilities {
  externalProjects: readonly ExternalProjectChoice[] | null;
}

const NO_HOST_CAPABILITIES: DesignHostCapabilities = { externalProjects: null };

/**
 * The host's capabilities for the open project. The other projects are asked for only while `enabled` (the create
 * dialog is open), so nothing is requested when the surface is idle; any failure reads as "none".
 */
export function useDesignHostCapabilities(
  projectId: string,
  enabled: boolean,
  client: CrossProjectClient = studioCrossProjectClient,
): DesignHostCapabilities {
  const [capabilities, setCapabilities] = useState(NO_HOST_CAPABILITIES);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    client
      .projects(projectId, controller.signal)
      .then((projects) => {
        if (controller.signal.aborted) return;
        setCapabilities({
          externalProjects:
            projects.length > 0 ? projects.map(({ key, name }) => ({ key, name })) : null,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setCapabilities(NO_HOST_CAPABILITIES);
      });
    return () => controller.abort();
  }, [client, enabled, projectId]);
  return capabilities;
}

/** The sources the dialog offers, in order; "another project" only when the host lists projects. */
export function availableSources(capabilities: DesignHostCapabilities): DesignSourceKind[] {
  const sources: DesignSourceKind[] = ["scratch", "project", "video", "website"];
  if (capabilities.externalProjects !== null) sources.push("external_project");
  return sources;
}

/** A web address as the user typed it; a bare host gets `https://`. Null when it is not an http(s) site. */
export function websiteAddress(raw: string): string | null {
  const typed = raw.trim();
  if (typed.length === 0) return null;
  const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  try {
    const url = new URL(address);
    const web = url.protocol === "http:" || url.protocol === "https:";
    return web && url.hostname.includes(".") ? address : null;
  } catch {
    return null;
  }
}

/** What the user filled in; only the fields of the chosen source count. */
export interface CreateFields {
  brief: string;
  notes: string;
  video: string;
  url: string;
  projectKey: string;
}

/** The turn the dialog would start, or null while the chosen source still lacks what it needs. */
export function createSpecOf(
  source: DesignSourceKind,
  fields: CreateFields,
  capabilities: DesignHostCapabilities,
): DesignTurnSpec | null {
  const notes = fields.notes.trim() || undefined;
  switch (source) {
    case "scratch":
      return fields.brief.trim() ? { action: "create", source, brief: fields.brief } : null;
    case "project":
      return { action: "create", source, notes };
    case "video":
      return fields.video ? { action: "create", source, video: fields.video, notes } : null;
    case "website": {
      const url = websiteAddress(fields.url);
      return url ? { action: "create", source, url, notes } : null;
    }
    case "external_project": {
      const project = capabilities.externalProjects?.find(
        (candidate) => candidate.key === fields.projectKey,
      );
      return project
        ? {
            action: "create",
            source,
            projectKey: project.key,
            projectName: project.name,
            notes,
          }
        : null;
    }
  }
}
