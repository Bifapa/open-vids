// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { MarkdownLite } from "./MarkdownLite";

afterEach(cleanupMounted);

describe("MarkdownLite tables", () => {
  const SUMMARY = [
    "Per-chapter summary:",
    "",
    "| Chapter | Timeline | Length |",
    "| :--- | :---: | ---: |",
    "| Intro | 0:00 | 12 s |",
    "| Outro | 1:40 | 8 s |",
  ].join("\n");

  it("renders a pipe table as a table with a header row, not as raw pipes", () => {
    const host = mountHost(<MarkdownLite text={SUMMARY} />);

    const heads = [...host.querySelectorAll("thead th")];
    expect(heads.map((cell) => cell.textContent)).toEqual(["Chapter", "Timeline", "Length"]);
    expect(heads.every((cell) => cell.getAttribute("scope") === "col")).toBe(true);
    const rows = [...host.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["Intro", "0:00", "12 s"],
      ["Outro", "1:40", "8 s"],
    ]);
    expect(host.textContent).not.toContain("|");
  });

  it("aligns each column as its delimiter row says", () => {
    const host = mountHost(<MarkdownLite text={SUMMARY} />);

    const cells = [...host.querySelectorAll("tbody tr:first-child td")];
    expect(cells.map((cell) => /text-(start|left|center|right)/.exec(cell.className)?.[0])).toEqual(
      ["text-left", "text-center", "text-right"],
    );
  });

  it("keeps a timecode in a cell a seek point", () => {
    const host = mountHost(<MarkdownLite text={SUMMARY} />);

    expect(host.querySelector("tbody td:nth-child(2) button")?.textContent).toBe("0:00");
  });
});
