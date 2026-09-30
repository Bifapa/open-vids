import type { AssetConnector } from "../types.js";
import { searchThroughWeb } from "./site.js";

const WEB_PAGES = 4;

/** The open web: any public page the web search returns (used in the `any` mode only). */
export const webConnector: AssetConnector = {
  id: "web",
  search(query, kind, limit, ctx) {
    return searchThroughWeb({ query, kind, limit, ctx, domains: null, pages: WEB_PAGES });
  },
};
