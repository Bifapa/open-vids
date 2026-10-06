// @vitest-environment node
import { describe, expect, it } from "vitest";
import { svgRefusal } from "./logoSvg.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const wrap = (inner: string, attrs = "") => `<svg ${NS} ${attrs}>${inner}</svg>`;

describe("svgRefusal", () => {
  it.each([
    [
      "a plain shape logo",
      wrap('<rect width="10" height="10" fill="#f60"/>', 'viewBox="0 0 10 10"'),
    ],
    [
      "gradients, defs and local url() references",
      wrap(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect fill="url(#g)" width="4" height="4"/>',
      ),
    ],
    [
      "a title, a description and a plain stylesheet",
      wrap(
        '<title>Acme &amp; Co</title><desc>The logo</desc><style>.a{fill:#f60}</style><g class="a"/>',
      ),
    ],
    ["an XML prolog", `<?xml version="1.0" encoding="UTF-8"?>\n${wrap('<path d="M0 0h4v4z"/>')}`],
    ["a local use reference", wrap('<defs><path id="p" d="M0 0h1v1z"/></defs><use href="#p"/>')],
  ])("accepts %s", (_name, svg) => {
    expect(svgRefusal(svg)).toBeNull();
  });

  it.each([
    ["a script", wrap("<script>alert(1)</script>")],
    [
      "a script hidden in a title (raw text for an HTML parser)",
      wrap("<title><script>alert(1)</script></title>"),
    ],
    ["a script hidden in a style", wrap("<style><script>alert(1)</script></style>")],
    [
      "an img with a handler hidden in a style",
      wrap("<style><img src=x onerror=alert(1)></style>"),
    ],
    ["an iframe hidden in a desc", wrap("<desc><iframe src=//evil.test></iframe></desc>")],
    ["a textarea around a script", wrap("<textarea><script>alert(1)</script></textarea>")],
    ["an xmp around a script", wrap("<xmp><script>alert(1)</script></xmp>")],
    ["a script in a CDATA section", wrap("<style><![CDATA[<script>alert(1)</script>]]></style>")],
    ["a script in a comment", wrap("<!-- <script>alert(1)</script> --><rect/>")],
    ["an upper-case SCRIPT", wrap("<SCRIPT>alert(1)</SCRIPT>")],
    ["a spaced closing tag", wrap("<g></ script ><rect/>")],
    [
      "a foreignObject",
      wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>'),
    ],
    ["an event handler", wrap('<rect onload="x()"/>')],
    ["an event handler on the root", `<svg ${NS} onload="alert(1)"/>`],
    ["an event handler hidden in text", wrap("<title>x onclick=alert(1)</title>")],
    ["an external href", wrap('<use href="https://evil.test/a.svg#x"/>')],
    [
      "an xlink href",
      wrap('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="//evil.test/a.svg#x"/>'),
    ],
    ["an external url()", wrap('<rect fill="url(https://evil.test/x)"/>')],
    ["an @import", wrap('<style>@import "https://evil.test/a.css";</style>')],
    ["a stylesheet url()", wrap("<style>rect{fill:url(//evil.test/x)}</style>")],
    ["a javascript: URL", wrap('<g style="x: javascript:alert(1)"/>')],
    ["a link", wrap('<link rel="stylesheet" href="https://evil.test/a.css"/>')],
    ["an anchor", wrap('<a href="#x"><rect/></a>')],
    ["an animate on a link", wrap('<animate attributeName="href" values="javascript:alert(1)"/>')],
    ["a set", wrap('<set attributeName="onmouseover" to="alert(1)"/>')],
    ["an entity declaration", `<!DOCTYPE svg [<!ENTITY x "y">]>${wrap("<rect/>")}`],
    ["markup in a title", wrap("<title>a<b>b</b></title>")],
    ["a '<' in a style", wrap("<style>a &lt; b</style><style>/*<*/</style>")],
    ["a root that is not svg", '<html><body><img src="x"></body></html>'],
    ["text that is not XML at all", "garbage"],
  ])("refuses %s", (_name, svg) => {
    expect(svgRefusal(svg)).not.toBeNull();
  });
});
