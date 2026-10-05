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
  without a token, so any local process can reach it. Web pages are refused: both the production host
  and the dev host check the `Host` header (DNS rebinding) and refuse cross-site or foreign-`Origin`
  state-changing requests (`packages/studio-server/src/helpers/hostGuard.ts`). A way past that guard
  from a web page is in scope, please report it. The port is chosen per launch; see
  [apps/desktop/README.md](apps/desktop/README.md#known-limitation-the-studio-loopback-api-is-unauthenticated).
- **Builds are not Developer-ID signed.** macOS builds are ad-hoc signed and not notarized; Windows builds are not code-signed.

## Updates

OpenVids updates itself from GitHub Releases, and an update is authenticated only by a minisign
signature checked against OpenVids' updater key, which is embedded in the app — not by Apple code
signing or notarization (macOS builds are ad-hoc signed, Windows builds are unsigned). The updater private key lives only in this
repository's GitHub Actions secrets. An attacker who obtains that key, or who can publish releases
in this repository, could ship a malicious update that the app would accept.

## Usage statistics

Apart from the update check, the only request the desktop shell sends on its own is anonymous usage
statistics: app start, a periodic heartbeat and quit, each with the app version, OS, architecture, UI
language, whether the main window is in focus and a random installation id, plus one
`telemetry_disabled` request (without the id) when the user turns statistics off — never file or
project names, paths, content, chat text, URLs, keys or error messages. Off with Settings › General,
`DO_NOT_TRACK=1` or `OPENVIDS_TELEMETRY=0`; see [README.md](README.md#usage-statistics). The other
thing the shell sends is a bug report, only when the user presses Send in Report a Problem…; see
[README.md](README.md#bug-reports). Report anything else leaving the machine through it.

## Dependencies

Vulnerabilities in a third-party dependency are best reported to that project. If the way OpenVids
uses the dependency makes the issue exploitable here, report it to us as well.
