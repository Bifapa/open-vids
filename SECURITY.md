# Security Policy

## Supported versions

OpenVids is pre-1.0. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**
([direct link](https://github.com/bazodev/open-vids/security/advisories/new)). Include what you
found, how to reproduce it and which commit or build you tested.

You should get a first reply within a week. Please give us reasonable time to ship a fix before
disclosing the issue publicly.

## Scope

OpenVids is a local desktop app. It runs loopback HTTP servers on `127.0.0.1`, spawns a headless
Chrome and FFmpeg for rendering, and runs an agent runtime that edits files inside the open project.
Reports are most useful when they show one of these:

- a web page or another machine reaching the loopback servers, or getting past the Projects home
  token (`X-OpenVids-Token`) and its `Host` / `Origin` checks;
- an agent tool reading or writing outside the open project, or inside `.hyperframes/` where it
  must not;
- the Research service fetching a URL that the Asset Search policy or its SSRF rules should have
  refused;
- a project file or imported asset that executes code outside the composition iframe, or leaks
  credentials stored under `~/.openvids/`.

## Known limitations

These are documented and do not need a new report, though fixes are welcome:

- **The Studio loopback API is unauthenticated.** While a project is open, the Studio server on
  `127.0.0.1:<port>` serves project file read/write/delete, render spawning and media transcoding
  without a token. Any local process, and any web page that learns the port, can reach it. The port
  is chosen per launch. This is inherited from HyperFrames; see
  [apps/desktop/README.md](apps/desktop/README.md#known-limitation-the-studio-loopback-api-is-unauthenticated).
- **Builds are ad-hoc signed.** They are not signed with an Apple Developer ID and are not notarized.

## Dependencies

Vulnerabilities in a third-party dependency are best reported to that project. If the way OpenVids
uses the dependency makes the issue exploitable here, report it to us as well.
