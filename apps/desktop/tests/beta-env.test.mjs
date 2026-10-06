/* The beta flag the dev Studio server gets (scripts/beta-env.mjs): on for a dev build unless forced off, always
   exactly "1" or "0" — the Studio server and the agent runtime read only "1" as on. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { devBetaFeatures } from "../scripts/beta-env.mjs";

test("a dev build is beta unless the user forced it off", () => {
  for (const unset of [undefined, "", "  ", "maybe"]) {
    assert.equal(devBetaFeatures(unset), "1", JSON.stringify(unset));
  }
  for (const on of ["1", "true", "yes", " 1 "]) assert.equal(devBetaFeatures(on), "1", on);
  for (const off of ["0", "false", "no", " 0 "]) assert.equal(devBetaFeatures(off), "0", off);
});
