/**
 * License material that ships inside the app as `licenses/` (a Tauri resource, see
 * `src-tauri/tauri.prod.conf.json`).
 *
 * Three groups of files land there:
 *
 *   - OpenVids' own `LICENSE`, `NOTICE` and `CREDITS.md` from the repository root. The Apache-2.0
 *     terms for the HyperFrames-derived code require the license text and the NOTICE to travel with
 *     every copy.
 *   - The hand-kept texts in `apps/desktop/licenses/`: Bun's `LICENSE.md` (the bundled Bun binary
 *     statically links LGPL-2 JavaScriptCore; it carries the relink instructions), the LGPL-3.0 and
 *     GPL-3.0 texts for `@img/sharp-libvips-*` (libvips and its libraries) and sharp-libvips' own
 *     list of the licenses of the libraries it bundles.
 *   - `THIRD_PARTY_NOTICES.txt`, generated from the staged `node_modules` trees: every shipped
 *     package with its version, SPDX license and the text of the license / notice files it carries,
 *     identical texts listed once.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|unlicense)(?:[-_.].*)?$/i;
const MAX_LICENSE_BYTES = 200_000;

/** The repository-root files every build ships. */
export const ROOT_LICENSE_FILES = ["LICENSE", "NOTICE", "CREDITS.md"];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The `license` field of a package.json as one display string. */
export function licenseLabel(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string" && license !== "") return license;
  if (license && typeof license === "object" && typeof license.type === "string") {
    return license.type;
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter((type) => typeof type === "string" && type !== "");
    if (types.length > 0) return types.join(" OR ");
  }
  return "no license declared";
}

function licenseFilesOf(packageDir) {
  const files = [];
  for (const entry of readdirSync(packageDir, { withFileTypes: true })) {
    if (!entry.isFile() || !LICENSE_FILE.test(entry.name)) continue;
    const text = readFileSync(join(packageDir, entry.name), "utf8");
    if (text.length === 0 || text.length > MAX_LICENSE_BYTES) continue;
    files.push({ name: entry.name, text: text.replace(/\r\n/g, "\n").trim() });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every package installed under `nodeModulesDir` (scoped packages and nested `node_modules` included)
 * as `{ name, version, license, files: [{ name, text }] }`, sorted by name then version.
 */
export function collectPackageLicenses(nodeModulesDir) {
  const found = [];
  const visit = (modulesDir) => {
    let entries;
    try {
      entries = readdirSync(modulesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(modulesDir, entry.name);
      if (entry.name.startsWith("@")) {
        visit(dir);
        continue;
      }
      const manifest = readJson(join(dir, "package.json"));
      if (manifest !== undefined && typeof manifest.name === "string") {
        found.push({
          name: manifest.name,
          version: typeof manifest.version === "string" ? manifest.version : "?",
          license: licenseLabel(manifest),
          files: licenseFilesOf(dir),
        });
      }
      visit(join(dir, "node_modules"));
    }
  };
  visit(nodeModulesDir);
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * The text of THIRD_PARTY_NOTICES.txt: an index of every package with its license, then each distinct
 * license / notice text once, with the packages that carry it.
 */
export function renderThirdPartyNotices(packages) {
  const unique = [];
  const seen = new Set();
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(pkg);
  }
  unique.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const out = [
    "Third-party software shipped inside OpenVids",
    "============================================",
    "",
    "OpenVids' own license is in LICENSE, and NOTICE and CREDITS.md list its origin. The JavaScript packages",
    "below are installed in the app's hyperframes/ and agent-runtime/ folders. The Bun runtime, JavaScriptCore",
    "and the native image libraries have their own files in this folder (bun-LICENSE.md,",
    "sharp-libvips-THIRD-PARTY-NOTICES.md, LGPL-3.0.txt, GPL-3.0.txt).",
    "",
    "Packages",
    "--------",
    "",
  ];
  for (const pkg of unique) out.push(`${pkg.name}@${pkg.version}  ${pkg.license}`);

  const byText = new Map();
  for (const pkg of unique) {
    for (const file of pkg.files) {
      const digest = createHash("sha256").update(file.text).digest("hex");
      const group = byText.get(digest) ?? { text: file.text, owners: [] };
      group.owners.push(`${pkg.name}@${pkg.version}`);
      byText.set(digest, group);
    }
  }
  const withoutFile = unique.filter((pkg) => pkg.files.length === 0);
  if (withoutFile.length > 0) {
    out.push("", "Packages that ship no license file", "----------------------------------", "");
    out.push(
      "The license named in the index above is declared in each package's package.json; the package",
      "carries no separate license text:",
      "",
    );
    for (const pkg of withoutFile) out.push(`${pkg.name}@${pkg.version}  ${pkg.license}`);
  }

  out.push("", "License and notice texts", "------------------------");
  const groups = [...byText.values()].sort((a, b) => a.owners[0].localeCompare(b.owners[0]));
  for (const group of groups) {
    out.push("", "=".repeat(78), `Carried by: ${group.owners.join(", ")}`, "=".repeat(78), "");
    out.push(group.text);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Write `<runtimeDir>/licenses/`. `treeDirs` are the staged directories whose `node_modules` ship.
 * Fails (throws) when a repository license file or a hand-kept text is missing, so a build never
 * ships without them.
 */
export function stageLicenses({ runtimeDir, repoRoot, keptDir, treeDirs }) {
  const target = join(runtimeDir, "licenses");
  mkdirSync(target, { recursive: true });
  for (const name of ROOT_LICENSE_FILES) {
    const source = join(repoRoot, name);
    if (!existsSync(source)) throw new Error(`${source} is missing; it ships with the app`);
    cpSync(source, join(target, name));
  }
  if (!existsSync(keptDir) || readdirSync(keptDir).length === 0) {
    throw new Error(`${keptDir} has no license texts; they ship with the app`);
  }
  cpSync(keptDir, target, { recursive: true });

  const packages = treeDirs.flatMap((dir) => collectPackageLicenses(join(dir, "node_modules")));
  writeFileSync(join(target, "THIRD_PARTY_NOTICES.txt"), renderThirdPartyNotices(packages));
  return { directory: target, packages: packages.length };
}
