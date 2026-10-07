import type { RefObject } from "react";
import { useAssetMentions, type AssetMentions } from "./AssetMentionMenu";
import { useProjectMentions } from "./useProjectMentions";

/**
 * Every mention the composer completes, as one set of props for its textarea: `@` offers the project's files,
 * `#` the other projects. A token belongs to one trigger, so at most one popup is open at a time.
 */
export function useComposerMentions(options: {
  areaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  disabled: boolean;
  setDraft: (text: string) => void;
}): AssetMentions {
  const files = useAssetMentions(options);
  const projects = useProjectMentions(options);
  const fileField = files.fieldProps;
  const projectField = projects.fieldProps;
  return {
    menu: projects.menu ?? files.menu,
    trackChange: (area) => {
      files.trackChange(area);
      projects.trackChange(area);
    },
    handleKeyDown: (event) => projects.handleKeyDown(event) || files.handleKeyDown(event),
    fieldProps: {
      role: projectField.role ?? fileField.role,
      "aria-autocomplete": projectField["aria-autocomplete"] ?? fileField["aria-autocomplete"],
      "aria-expanded": projectField["aria-expanded"] ?? fileField["aria-expanded"],
      "aria-controls": projectField["aria-controls"] ?? fileField["aria-controls"],
      "aria-activedescendant":
        projectField["aria-activedescendant"] ?? fileField["aria-activedescendant"],
      onSelect: (event) => {
        fileField.onSelect(event);
        projectField.onSelect(event);
      },
      onKeyUp: (event) => {
        fileField.onKeyUp(event);
        projectField.onKeyUp(event);
      },
      onClick: (event) => {
        fileField.onClick(event);
        projectField.onClick(event);
      },
      onFocus: (event) => {
        fileField.onFocus(event);
        projectField.onFocus(event);
      },
      onBlur: () => {
        fileField.onBlur();
        projectField.onBlur();
      },
    },
  };
}
