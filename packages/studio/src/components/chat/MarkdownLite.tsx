import { memo, type ReactNode } from "react";
import { usePlayerStore } from "../../player/store/playerStore";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { parseMarkdownLite, type Block, type Inline } from "./markdownParse";

function InlineRun({ nodes }: { nodes: Inline[] }) {
  const { t } = useTranslation();
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case "text":
            return node.text;
          case "code":
            return (
              <code key={index} className="font-mono text-xs text-fg">
                {node.text}
              </code>
            );
          case "strong":
            return (
              <strong key={index} className="font-semibold">
                {node.text}
              </strong>
            );
          case "link":
            return (
              <a
                key={index}
                href={node.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="rounded-xs text-fg underline decoration-border-strong underline-offset-2 hover:decoration-fg-2"
              >
                {node.text}
              </a>
            );
          case "timecode":
            return (
              <button
                key={index}
                type="button"
                data-testid="chat-timecode"
                aria-label={t("chat.markdown.showTimecode", { time: node.text })}
                onClick={() => usePlayerStore.getState().requestSeek(node.seconds)}
                className={cn(
                  "-mx-px inline rounded-xs px-0.5 font-mono text-xs text-fg tabular-nums",
                  "underline decoration-border-strong underline-offset-2 hover:bg-surface-2 hover:decoration-fg-2",
                  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                )}
              >
                {node.text}
              </button>
            );
        }
      })}
    </>
  );
}

/** A column's alignment from its delimiter row; `start` (none given) follows the reading direction. */
const ALIGN_CLASS: Record<"start" | "left" | "center" | "right", string> = {
  start: "text-start",
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="mb-1.5 whitespace-pre-wrap last:mb-0">
          <InlineRun nodes={block.inline} />
        </p>
      );
    case "heading":
      return (
        <p className="mb-1 font-semibold last:mb-0">
          <InlineRun nodes={block.inline} />
        </p>
      );
    case "code":
      return (
        <pre
          className="mb-1.5 overflow-x-auto rounded-md border border-border-subtle bg-bg-1 p-2 font-mono text-xs leading-[16px] text-fg-2 last:mb-0"
          data-language={block.language || undefined}
        >
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={cn(
            block.ordered ? "list-decimal" : "list-disc",
            "mt-0.5 mb-1.5 pl-4 last:mb-0 marker:text-fg-3 [&>li+li]:mt-0.5",
          )}
        >
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineRun nodes={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="mb-1.5 max-w-full overflow-x-auto last:mb-0" data-testid="markdown-table">
          <table className="w-full border-collapse text-xs leading-[15px]">
            <thead>
              <tr>
                {block.header.map((cell, column) => (
                  <th
                    key={column}
                    scope="col"
                    className={cn(
                      "border border-border-subtle bg-surface-1 px-1.5 py-1 font-semibold text-fg",
                      ALIGN_CLASS[block.align[column] ?? "start"],
                    )}
                  >
                    <InlineRun nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td
                      key={column}
                      className={cn(
                        "border border-border-subtle px-1.5 py-1 align-top",
                        ALIGN_CLASS[block.align[column] ?? "start"],
                      )}
                    >
                      <InlineRun nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Assistant text as React elements; the text is never interpreted as HTML. Timecodes seek the preview. */
export const MarkdownLite = memo(function MarkdownLite({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const blocks = parseMarkdownLite(text);
  return (
    <div
      className={cn(
        "min-w-0 text-base leading-[18px] text-fg [overflow-wrap:anywhere] text-pretty @min-[440px]/chat:leading-[19px]",
        className,
      )}
    >
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
});
