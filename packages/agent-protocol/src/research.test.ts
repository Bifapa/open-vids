import { describe, expect, it } from "vitest";
import { normalizeLicense } from "./research.js";

const high = (input: { name?: string; url?: string }) =>
  normalizeLicense({ ...input, confidence: "high", basis: "test" });

describe("normalizeLicense", () => {
  it("reads a stock site's own license from its license page as free to use", () => {
    expect(high({ name: "Pexels License", url: "https://www.pexels.com/license/" })).toMatchObject({
      id: "free_stock",
      name: "Pexels License",
      status: "clear",
    });
    expect(high({ url: "https://pixabay.com/service/license-summary/" })).toMatchObject({
      id: "free_stock",
      name: "Pixabay Content License",
      status: "clear",
    });
    // A name alone is not enough: any site can call its terms a "license".
    expect(high({ name: "Pexels License" })).toMatchObject({ id: "other", status: "restricted" });
  });

  it("reads permissive open-source licenses by SPDX id or name as needing a credit", () => {
    for (const name of [
      "MIT",
      "Apache-2.0",
      "Apache License 2.0",
      "ISC",
      "BSD-3-Clause",
      "OFL-1.1",
      "Unlicense",
    ]) {
      expect(high({ name }), name).toMatchObject({ id: "permissive", status: "attribution" });
    }
    for (const name of ["GPL-3.0", "LGPL-2.1", "MIT-like terms of the artist"]) {
      expect(high({ name }), name).toMatchObject({ id: "other", status: "restricted" });
    }
    // A Creative Commons URL still wins over the name.
    expect(
      high({ name: "MIT", url: "https://creativecommons.org/licenses/by/4.0/" }),
    ).toMatchObject({ id: "cc_by" });
  });

  it("reads the no-copyright rights statements as public domain and leaves the others unclassified", () => {
    expect(high({ url: "http://rightsstatements.org/vocab/NKC/1.0/" })).toMatchObject({
      id: "public_domain",
      name: "No known copyright",
      status: "clear",
    });
    expect(high({ url: "https://rightsstatements.org/page/NoC-US/1.0/" })).toMatchObject({
      id: "public_domain",
      status: "clear",
    });
    // Out of copyright, but other legal restrictions apply: the user has to read them.
    for (const url of [
      "http://rightsstatements.org/vocab/NoC-OKLR/1.0/",
      "http://rightsstatements.org/vocab/InC/1.0/",
    ]) {
      expect(high({ url }), url).toMatchObject({ id: "other", status: "restricted" });
    }
    expect(
      normalizeLicense({
        url: "http://rightsstatements.org/vocab/NKC/1.0/",
        confidence: "low",
        basis: "test",
      }),
    ).toMatchObject({ id: "public_domain", status: "unknown" });
  });
});
