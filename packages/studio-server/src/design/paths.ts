import { homedir } from "node:os";
import { join } from "node:path";

/** The app-wide design-system library: `$OPENVIDS_DESIGN_SYSTEMS_DIR`, else `~/.openvids/design-systems`. */
export function designLibraryRoot(): string {
  return process.env.OPENVIDS_DESIGN_SYSTEMS_DIR || join(homedir(), ".openvids", "design-systems");
}
