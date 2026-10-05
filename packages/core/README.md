# @hyperframes/core

Types, parsers, generators, compiler, linter, runtime, and frame adapters for the Hyperframes video framework.

## Use

This package is private to the OpenVids workspace and is not published to npm. Other workspace packages depend on it as `@hyperframes/core` (`bun install` at the repository root links it).

> Most users don't need to use core directly — the [CLI](../cli), [producer](../producer), and [studio](../studio) packages depend on it internally.

## What's inside

| Module             | Description                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Types**          | `TimelineElement`, `CompositionSpec`, `Asset`, canvas dimensions, defaults                                                    |
| **Parsers**        | `parseHtml` — extract timeline elements from HTML (re-exported from `@hyperframes/parsers`, which also has `parseGsapScript`) |
| **Generators**     | `generateHyperframesHtml` — produce valid Hyperframes HTML from timeline elements                                             |
| **Compiler**       | `compileTimingAttrs` — resolve `data-start` / `data-duration` into absolute times                                             |
| **Linter**         | `lintHyperframeHtml` (`@hyperframes/core/lint`, async) — validate Hyperframes HTML                                            |
| **Runtime**        | IIFE script injected into the browser — manages seek, media playback, and the `window.__hf` protocol                          |
| **Frame Adapters** | `FrameAdapter` interface for animation drivers, and `createGSAPFrameAdapter` for GSAP timelines                               |

## Generated composition trust

Composition generators require trusted authors for code-bearing inputs. `styles` and
`generateHyperframesStyles` preserve authored CSS, which can load external resources.
`animations` may contain `__raw:` values that are emitted as JavaScript;
`includeScripts: true` includes executable timeline code. `serializeGsapAnimations`
also accepts raw `preamble`, `postamble`, and a code-bearing `timelineVar`. Never fill
these inputs with untrusted data. Attribute encoding and closing-tag containment
are not a sandbox; render untrusted compositions in an appropriately isolated
execution environment and never serve them on a privileged origin.

Text content retains the supported inline-formatting sanitizer contract. The clip
parser intentionally flattens inner formatting to text, so parse/generate is not
a lossless replacement for editing the source HTML.

## Frame Adapters

A frame adapter tells the engine how to seek your animation to a specific frame:

```typescript
import { createGSAPFrameAdapter } from "@hyperframes/core";

const adapter = createGSAPFrameAdapter({
  fps: 30,
  timeline: gsap.timeline({ paused: true }),
  // id?: string — defaults to "gsap"
});
```

Implement `FrameAdapter` for custom animation runtimes:

```typescript
import type { FrameAdapter } from "@hyperframes/core";

const myAdapter: FrameAdapter = {
  id: "my-adapter",
  getDurationFrames: () => 300,
  seekFrame: (frame) => {
    /* seek your animation */
  },
  // optional: init(ctx), destroy()
};
```

## Parsing and generating HTML

```typescript
import { parseHtml, extractCompositionMetadata, generateHyperframesHtml } from "@hyperframes/core";

// parseHtml uses DOMParser: run it in a browser or provide a DOM (for example linkedom).
const { elements, gsapScript, styles, resolution } = parseHtml(htmlString);
const metadata = extractCompositionMetadata(htmlString);
// elements: TimelineElement[]; the second argument is the total duration in seconds.
const html = generateHyperframesHtml(elements, 10, { resolution });
```

## Linting

```typescript
import { lintHyperframeHtml } from "@hyperframes/core/lint";

const result = await lintHyperframeHtml(htmlString);
// result.ok, result.errorCount / warningCount / infoCount
// result.findings: { code, severity, message, elementId?, selector?, line?, fixHint? }[]
```

## Documentation

Full documentation: see `packages/core` in this repo (no hosted docs site).

## Related packages

- [`@hyperframes/engine`](../engine) — rendering engine that drives the browser
- [`@hyperframes/producer`](../producer) — full render pipeline (capture + encode)
- [`hyperframes`](../cli) — CLI
