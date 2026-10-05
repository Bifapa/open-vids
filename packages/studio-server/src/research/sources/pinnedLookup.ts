import type { LookupFunction } from "node:net";
import { isPrivateAddress } from "./address.js";

/**
 * A `lookup` that never asks DNS: it hands the socket the vetted addresses, re-checking each one so that a pinned
 * private address (a bug upstream, not a rebinding answer) still cannot be connected to.
 */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const safe = addresses.filter((address) => !isPrivateAddress(address));
    const first = safe[0];
    if (first === undefined) {
      callback(new Error("No vetted public address to connect to"), "", 4);
      return;
    }
    const family = (address: string) => (address.includes(":") ? 6 : 4);
    if (options.all) {
      callback(
        null,
        safe.map((address) => ({ address, family: family(address) })),
      );
      return;
    }
    callback(null, first, family(first));
  };
}
