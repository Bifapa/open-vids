// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderDesignSystem } from "./render.js";
import { renderInput } from "./testSupport.js";
import { validateDesignSystemHtml, validateTokensCss } from "./validate.js";

const rendered = renderDesignSystem(renderInput());
const clean = rendered.systemHtml;
const allFiles = () => true;
const check = (html: string) =>
  validateDesignSystemHtml(html, { expectedVersion: 3, fileExists: allFiles });

/** The clean page with `extra` inserted at the end of `<body>`'s main content. */
const withBody = (extra: string) => clean.replace("</main>", `${extra}\n</main>`);
const withStyle = (css: string) =>
  clean.replace(
    '</style>\n<style id="openvids-showcase">',
    `${css}\n</style>\n<style id="openvids-showcase">`,
  );

describe("validateDesignSystemHtml", () => {
  it("accepts what the renderer produces", () => {
    expect(check(clean)).toEqual([]);
  });

  it.each([
    ["a script tag", withBody("<script>alert(1)</script>"), /script/],
    ["an uppercase script tag", withBody("<SCRIPT>alert(1)</SCRIPT>"), /script/],
    [
      "a script with a slash instead of a space",
      withBody("<ScRiPt/src=//evil.test/x.js></ScRiPt>"),
      /script/,
    ],
    [
      "a script inside an svg",
      withBody("<svg><script>alert(1)</script></svg>"),
      /<svg> is not allowed/,
    ],
    ["an external image", withBody("<img src=https://evil.test/x.png>"), /relative file/],
    ["a protocol-relative image", withBody('<img src="//evil.test/x.png">'), /relative file/],
    [
      "an image with a tab-obfuscated javascript URL",
      withBody('<img src="java&#x09;script:alert(1)">'),
      /script or HTML URL|relative file/,
    ],
    [
      "a data:text/html image",
      withBody('<img src="data:text/html,<b>x</b>">'),
      /relative file|HTML URL/,
    ],
    [
      "an image that climbs out of the folder",
      withBody('<img src="../secret.png">'),
      /relative file/,
    ],
    ["an srcset", withBody('<img src="logo.svg" srcset="https://evil.test/x.png 2x">'), /srcset/],
    [
      "an inline event handler",
      withBody('<div onclick="alert(1)">x</div>'),
      /event handler onclick/,
    ],
    [
      "a mixed-case event handler",
      withBody("<div OnMouseOver=alert(1)>x</div>"),
      /event handler onmouseover/,
    ],
    [
      "a link element",
      withBody('<link rel="stylesheet" href="https://evil.test/a.css">'),
      /<link> is not allowed/,
    ],
    ["a base element", withBody('<base href="https://evil.test/">'), /<base> is not allowed/],
    [
      "an iframe",
      withBody('<iframe src="https://evil.test/"></iframe>'),
      /<iframe> is not allowed/,
    ],
    [
      "an object",
      withBody('<object data="https://evil.test/x"></object>'),
      /<object> is not allowed/,
    ],
    ["an anchor", withBody('<a href="javascript:alert(1)">x</a>'), /<a> is not allowed/],
    [
      "a form",
      withBody('<form action="https://evil.test/"><button>x</button></form>'),
      /<form> is not allowed/,
    ],
    [
      "a meta refresh",
      withBody('<meta http-equiv="refresh" content="0;url=https://evil.test/">'),
      /http-equiv/,
    ],
    [
      "an inline background url",
      withBody('<div style="background:url(//evil.test/x)">x</div>'),
      /loads or runs something/,
    ],
    [
      "an entity-obfuscated url()",
      withBody('<div style="background:u&#114;l(//evil.test/x)">x</div>'),
      /loads or runs something/,
    ],
    [
      "a CSS-escaped url()",
      withBody('<div style="background:\\75rl(//evil.test/x)">x</div>'),
      /escapes/,
    ],
    [
      "image-set in a style attribute",
      withBody("<div style=\"background:image-set('//evil.test/x' 1x)\">x</div>"),
      /loads or runs something/,
    ],
    [
      "a scripting property",
      withBody('<div style="behavior:url(x.htc)">x</div>'),
      /not allowed|loads or runs/,
    ],
    [
      "@import in a style block",
      withStyle("@import url(https://evil.test/a.css);"),
      /@import is not allowed/,
    ],
    [
      "an uppercase @IMPORT",
      withStyle('@IMPORT "https://evil.test/a.css";'),
      /@IMPORT is not allowed/,
    ],
    [
      "a url() in a style block",
      withStyle("body { background: url(https://evil.test/x.png); }"),
      /loads or runs something/,
    ],
    [
      "an @font-face from the network",
      withStyle('@font-face { font-family: "X"; src: url(https://evil.test/x.woff2); }'),
      /not a relative fonts\/ file/,
    ],
    [
      "an @font-face from a protocol-relative URL",
      withStyle('@font-face { font-family: "X"; src: url("//evil.test/x.woff2"); }'),
      /not a relative fonts\/ file/,
    ],
    [
      "an @font-face reading a local font",
      withStyle('@font-face { font-family: "X"; src: local("Arial"); }'),
      /may only name relative fonts/,
    ],
    [
      "an @font-face outside fonts/",
      withStyle('@font-face { font-family: "X"; src: url("logo.svg"); }'),
      /not a relative fonts\/ file/,
    ],
    [
      "a parent-folder @font-face",
      withStyle('@font-face { font-family: "X"; src: url("fonts/../../x.woff2"); }'),
      /not a relative fonts\/ file/,
    ],
    [
      "an @namespace rule",
      withStyle("@namespace url(https://evil.test/);"),
      /@namespace is not allowed/,
    ],
    [
      "a javascript: attribute on an allowed tag",
      withBody('<p title="javascript:alert(1)">x</p>'),
      /script or HTML URL/,
    ],
    ["an unknown attribute", withBody('<p formaction="https://evil.test/">x</p>'), /formaction/],
  ])("refuses %s", (_name, html, expected) => {
    const issues = check(html);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join("\n")).toMatch(expected);
  });

  it("reports every problem, not just the first", () => {
    const html = withBody("<script>1</script><iframe></iframe><div onclick=x()>x</div>");
    const issues = check(html);
    expect(issues.join("\n")).toMatch(/script/);
    expect(issues.join("\n")).toMatch(/<iframe>/);
    expect(issues.join("\n")).toMatch(/onclick/);
  });

  it("requires all 18 contract tokens in the :root block", () => {
    const html = clean
      .replace(/ {2}--brand: [^;]+;\n/, "")
      .replace(/ {2}--ease-emphasis: [^;]+;\n/, "");
    const issues = check(html);
    expect(issues).toContain("missing required token --brand");
    expect(issues).toContain("missing required token --ease-emphasis");
  });

  it("refuses a token value that breaks out of its declaration", () => {
    const html = clean.replace("--radius: 12px;", "--radius: 1<2;");
    expect(check(html).join("\n")).toMatch(/--radius does not hold a safe CSS value/);
  });

  it("requires the manifest data block, once, and as JSON", () => {
    expect(check(clean.replace(/<script[\s\S]*<\/script>/, "")).join("\n")).toMatch(
      /exactly one <script>/,
    );
    const twice = clean.replace(
      "</body>",
      '<script type="application/json" id="openvids-design-manifest">{}</script></body>',
    );
    expect(check(twice).join("\n")).toMatch(/exactly one <script>/);
    expect(
      check(clean.replace('type="application/json"', 'type="text/javascript"')).join("\n"),
    ).toMatch(/type="application\/json"/);
    expect(
      check(clean.replace(/(<script[^>]*>)[\s\S]*(<\/script>)/, "$1not json$2")).join("\n"),
    ).toMatch(/not valid JSON/);
  });

  it("requires the manifest to agree with the version and the page", () => {
    expect(validateDesignSystemHtml(clean, { expectedVersion: 4 }).join("\n")).toMatch(
      /names version 3, expected 4/,
    );
    // A font file the manifest lists but no @font-face loads.
    const unloaded = clean.replace(/@font-face \{[^}]*inter-400[^}]*\}/, "");
    expect(check(unloaded).join("\n")).toMatch(/no @font-face loads it/);
    // A font file an @font-face loads but the manifest does not list.
    const extra = withStyle(
      '@font-face { font-family: "X"; src: url("fonts/extra.woff2") format("woff2"); }',
    );
    expect(check(extra).join("\n")).toMatch(
      /fonts\/extra\.woff2, which the manifest does not list/,
    );
  });

  it("requires every stored font and the logo to exist", () => {
    const issues = validateDesignSystemHtml(clean, {
      fileExists: (path) => path !== "logo.svg" && !path.includes("inter"),
    });
    expect(issues.join("\n")).toMatch(
      /font file fonts\/inter-400-normal-latin-abcd1234\.woff2 does not exist/,
    );
    expect(issues.join("\n")).toMatch(/logo file logo\.svg does not exist/);
  });

  it("refuses a non-system font without files", () => {
    const html = clean.replace(/"portable": true/g, '"portable": false');
    expect(check(html).join("\n")).toMatch(/must resolve to files/);
  });
});

describe("validateTokensCss", () => {
  it("accepts the generated file", () => {
    expect(validateTokensCss(rendered.tokensCss)).toEqual([]);
  });

  it("refuses imports, external fonts, other rules and missing tokens", () => {
    expect(
      validateTokensCss(`@import "https://evil.test/a.css";\n${rendered.tokensCss}`).join("\n"),
    ).toMatch(/@import/);
    expect(
      validateTokensCss(
        `${rendered.tokensCss}\n@font-face { font-family: "X"; src: url(https://evil.test/x.woff2); }`,
      ).join("\n"),
    ).toMatch(/not a relative fonts\/ file/);
    expect(validateTokensCss(`${rendered.tokensCss}\nbody { color: red; }`).join("\n")).toMatch(
      /body is not allowed/,
    );
    expect(validateTokensCss(":root { --bg: #000; }")).toContain("missing required token --fg");
  });
});
