# Skill installation and freshness

Read this reference when installing or updating skills, diagnosing unexpected workflow behavior, or running HyperFrames setup in CI.

HyperFrames installs the core set eagerly and workflow skills lazily.

- **Core set:** `/hyperframes`, the `hyperframes-*` domain skills, and `/media-use`.
- **Workflow skills:** installed when routing selects them through `hyperframes skills update <workflow-name>`.

## What `init` does

`hyperframes init` refreshes the core set plus other skills already installed from the bundled `skills/` tree. It does not install workflows that have never been used. A current install is a no-op. Failures degrade gracefully and do not fail project scaffolding.

The `--skip-skills` CLI flag is temporarily ignored. CI and tests may opt out with `HYPERFRAMES_SKIP_SKILLS=1`.

## Diagnose and update

```bash
hyperframes skills check
hyperframes skills check --json
hyperframes skills update
hyperframes skills update <workflow-name>
hyperframes skills
```

- `skills check` exits non-zero when an installed skill is stale or the core set is incomplete. Workflows available on demand but not installed are not failures.
- Bare `skills update` refreshes the core set and everything already installed, prunes skills no longer bundled, and does not expand the workflow set.
- Named `skills update <name...>` also installs those named workflows or domain skills.
- Bare `skills` installs the full bundled set explicitly.

If the HyperFrames CLI is unavailable, install skills from the bundled `skills/` tree in a checkout: copy `skills/<workflow-name>/` into the agent's skills directory.
