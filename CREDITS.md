# Credits

OpenVids is licensed under the [Apache License 2.0](LICENSE); see also [NOTICE](NOTICE).
This file records what OpenVids is built on and the licenses of the third-party
material it contains.

## Built on HyperFrames

OpenVids started from a snapshot of **[HyperFrames](https://github.com/heygen-com/hyperframes)**
by HeyGen, Inc. (Apache-2.0). The composition contract, the render pipeline, the
Studio editor, the CLI, the registry of blocks and components and the agent
skills come from that project and have been modified here. OpenVids is an
independent project and is not affiliated with or endorsed by HeyGen.

## Prior art

HyperFrames, and through it OpenVids, owes ideas to earlier work on rendering
web pages to video:

- **[Remotion](https://www.remotion.dev)** pioneered the approach of using a
  headless browser + FFmpeg `image2pipe` pipeline to turn web primitives into
  deterministic video in the JavaScript ecosystem. Several architectural ideas
  in the render pipeline — ordered async barriers for parallel frame capture,
  multi-host port availability probing for dev servers, and the broader shape
  of a "render HTML to video" CLI — were informed by studying how Remotion
  approaches these problems. The code is independently implemented. OpenVids is
  not affiliated with Remotion.

## What OpenVids is built with

Thanks to the authors and maintainers of the open-source projects OpenVids
depends on, in particular:

- **[Tauri](https://tauri.app)** — the desktop shell. Apache-2.0 OR MIT.
- **[oh-my-pi](https://github.com/can1357/oh-my-pi)** (OMP SDK) — the agent
  sessions, providers and model catalog behind Agent Chat. MIT.
- **[Bun](https://bun.sh)** — package manager and the JavaScript runtime shipped
  inside the app. Bun is MIT-licensed and statically links LGPL-2 JavaScriptCore; its license text, with the
  relink instructions, is the app's `licenses/bun-LICENSE.md` (the app also carries this file, NOTICE and a list of the
  third-party packages it ships in `licenses/`).
- **[Puppeteer](https://pptr.dev)** (Apache-2.0) and **[FFmpeg](https://ffmpeg.org)**
  — frame capture and encoding. OpenVids does not ship Chrome or FFmpeg; it uses
  the ones installed on the machine.
- **[Hono](https://hono.dev)** — the local HTTP servers. MIT.
- **[React Flow](https://reactflow.dev)** (`@xyflow/react`) — the Story graph canvas. MIT.
- **[sharp](https://sharp.pixelplumbing.com)** (Apache-2.0) with
  **[libvips](https://www.libvips.org)** (LGPL-3.0-or-later, shipped as a
  separate dynamic library) — thumbnails and image processing.
- **[GSAP](https://gsap.com)** — the animation runtime of compositions, under the
  [GSAP Standard License](https://gsap.com/standard-license) (not an OSI
  open-source licence).

The complete dependency set is in `bun.lock` and
`apps/desktop/src-tauri/Cargo.lock`.

## Third-party licenses

- **[mediabunny](https://github.com/Vanilagy/mediabunny)** — media toolkit used
  in the studio for fast metadata extraction from file headers. Licensed under
  the [Mozilla Public License 2.0 (MPL-2.0)](https://mozilla.org/MPL/2.0/).
- **[Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** by NVIDIA — the
  speech recognition model `hyperframes models install parakeet` downloads, in the int8 ONNX export
  from [csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8).
  Licensed under [Creative Commons Attribution 4.0 (CC-BY-4.0)](https://creativecommons.org/licenses/by/4.0/).
  It runs on **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)**, Apache-2.0.
- The five 3D-motion catalog pieces (`canopy-part-title`, `code-slice-hero`, `cuboid-carousel`,
  `orbit-card`, `wireframe-portal-title`) were contributed to HyperFrames with their author's
  permission under the Apache-2.0 license. What they vendor or load, by upstream:
  - **[three.js](https://threejs.org)**, MIT. Vendored as r185 in `cuboid-carousel` and `orbit-card`
    (`Three-LICENSE.txt` beside the copy); loaded from the jsDelivr CDN by `canopy-part-title`
    (0.170.0) and `wireframe-portal-title` (0.181.2).
  - **[GSAP](https://gsap.com)** 3.14.2, under the [GSAP Standard License](https://gsap.com/standard-license)
    (not an OSI open-source licence). Vendored in `code-slice-hero`, `cuboid-carousel` and
    `orbit-card` with `GSAP-NOTICE.txt`; loaded from the CDN by `canopy-part-title` and
    `wireframe-portal-title`.
  - **[Clipper](https://sourceforge.net/projects/jsclipper/)** 6.4.2 (JavaScript port of Angus
    Johnson's Clipper), Boost Software License 1.0: loaded from the CDN as `clipper-lib` by
    `wireframe-portal-title`.
  - **[Geist](https://github.com/vercel/geist-font)** and **[Archivo](https://github.com/Omnibus-Type/Archivo)**,
    SIL Open Font License 1.1,
    vendored with their licence text; `canopy-part-title` (Gelasio) and `cuboid-carousel` (Inter) load
    their fonts from Google Fonts at run time.
  - Origin to be confirmed with the author: `canopy-part-title/assets/leaf-surface-color.webp` and
    `leaf-surface-normal.webp`.
- Fonts vendored in registry items, each with its licence text beside it: **[Caveat](https://github.com/googlefonts/caveat)**
  (the `hw-*` handwriting items), **[Barlow Condensed](https://github.com/jpt/barlow)** (`lower-third-bild`) and
  **[Courier Prime](https://github.com/quoteunquoteapps/CourierPrime)** (`notes-reveal`, `marker-checklist-card`), SIL Open Font
  License 1.1; **[Permanent Marker](https://github.com/googlefonts/permanent-marker)** (`notes-reveal`,
  `marker-checklist-card`), Apache-2.0.
- The map blocks (`us-map`, `us-map-bubble`, `us-map-flow`, `world-map`, `spain-map`) bundle their
  TopoJSON, each with the package licence text beside it:
  - **[us-atlas](https://github.com/topojson/us-atlas)** 3.0.1 (`states-10m.json`, derived from the U.S. Census
    Bureau cartographic boundary files) and **[world-atlas](https://github.com/topojson/world-atlas)** 2.0.2
    (`countries-110m.json`, derived from Natural Earth), ISC licence.
  - **[es-atlas](https://github.com/martgnz/es-atlas)** 0.6.0 (`autonomous_regions.json`), MIT licence. Its data is the
    Instituto Geográfico Nacional de España vector data, [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).
