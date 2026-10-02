<!--
Thanks for contributing! Keep the pull request to one topic. For a larger change, open an issue
first so the approach can be agreed. Read CONTRIBUTING.md and AGENTS.md before you start.
-->

## What changed

<!-- What the change does and why. Link the issue: "Fixes #123". -->

## How I checked it

<!--
The commands you ran and what you tried by hand (app flow, project, OS and Node versions).
For UI changes, add a screenshot or a short recording.
-->

## Checklist

- [ ] The commit subjects follow `type(scope): summary`, for example `fix(studio): keep playhead on trim`.
- [ ] I ran the checks CI runs: `bun run build`, `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test` (and `bun run desktop:check` for changes in `apps/desktop`).
- [ ] I added or updated tests next to the code I changed.
- [ ] New user-facing text is a key in `locales/en.json`, rendered through `t()`, and `bun run locales:check` passes.
- [ ] No secrets, personal media or generated output (`renders/`, `dist/`, `apps/desktop/runtime/`).
- [ ] Third-party media or assets have a license that allows redistribution and are recorded in `CREDITS.md`.
