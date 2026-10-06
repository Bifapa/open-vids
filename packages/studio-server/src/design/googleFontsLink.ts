/** Families (with the weights asked for) a Google Fonts stylesheet URL names; empty for any other URL. */
export function googleFamilies(href: string): Map<string, number[]> {
  const families = new Map<string, number[]>();
  const text = href.trim();
  let url: URL;
  try {
    url = new URL(text.startsWith("//") ? `https:${text}` : text);
  } catch {
    return families;
  }
  if (url.hostname !== "fonts.googleapis.com") return families;
  for (const param of url.searchParams.getAll("family")) {
    for (const entry of param.split("|")) {
      const [rawName = "", spec = ""] = splitFirst(entry, ":");
      const name = rawName.trim().replace(/\s+/g, " ");
      if (name === "") continue;
      families.set(name, [...new Set([...(families.get(name) ?? []), ...weightsOf(spec)])]);
    }
  }
  return families;
}

function splitFirst(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator);
  return at === -1 ? [value, ""] : [value.slice(0, at), value.slice(at + 1)];
}

/** `ital,wght@0,400;1,700` (css2) or `400,700italic` (css1) → the weights. */
function weightsOf(spec: string): number[] {
  if (spec === "") return [];
  const [axes, tuples] = splitFirst(spec, "@");
  if (!spec.includes("@")) return numbers(axes);
  const index = axes.split(",").indexOf("wght");
  if (index === -1) return [];
  return tuples
    .split(";")
    .flatMap((tuple) => numbers(tuple.split(",")[index] ?? ""))
    .sort((a, b) => a - b);
}

function numbers(text: string): number[] {
  return [...text.matchAll(/\d+/g)]
    .map((match) => Number(match[0]))
    .filter((weight) => weight >= 1 && weight <= 1000);
}
