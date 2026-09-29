import { memo, type ReactNode } from "react";
import { parseMarkdownLite, type Block, type Inline } from "./markdownParse";

function InlineRun({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case "text":
            return node.text;
          case "code":
            return (
              <code
                key={index}
                className="rounded-sm bg-surface px-1 py-px font-mono text-step-11 text-text-0"
              >
                {node.text}
              </code>
            );
          case "strong":
            return (
              <strong key={index} className="font-semibold text-text-0">
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
                className="text-selection underline underline-offset-2 hover:brightness-125"
              >
                {node.text}
              </a>
            );
        }
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap break-words">
          <InlineRun nodes={block.inline} />
        </p>
      );
    case "heading":
      return (
        <p className="font-semibold text-text-0 break-words">
          <InlineRun nodes={block.inline} />
        </p>
      );
    case "code":
      return (
        <pre
          className="overflow-x-auto rounded-md border border-border bg-bg-0 p-2 font-mono text-step-11 leading-relaxed text-text-1"
          data-language={block.language || undefined}
        >
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className={`${block.ordered ? "list-decimal" : "list-disc"} space-y-0.5 pl-5`}>
          {block.items.map((item, index) => (
            <li key={index} className="break-words pl-0.5">
              <InlineRun nodes={item} />
            </li>
          ))}
        </Tag>
      );
    }
  }
}

/** Assistant text as React elements; the text is never interpreted as HTML. */
export const MarkdownLite = memo(function MarkdownLite({ text }: { text: string }) {
  const blocks = parseMarkdownLite(text);
  return (
    <div className="flex flex-col gap-2 text-step-12 leading-relaxed text-text-1">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
});
