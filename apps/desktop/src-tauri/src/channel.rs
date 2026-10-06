//! The build channel and the beta features it unlocks.
//!
//! A build is on the beta channel when its version carries a semver
//! pre-release suffix (`0.5.0-beta.1`); everything else is stable. Beta
//! features (multi-project tabs, `#` project mentions, design systems) are
//! code on `main` that only a beta build turns on. A debug build turns them on
//! too, so `desktop:dev` exercises them, and `OPENVIDS_BETA_FEATURES=1` / `=0`
//! forces them on or off for any build.
//!
//! The shell tells its pages: Studio gets `openvidsChannel=beta` in its URL
//! (`sidecar::studio_url`), the Projects page `betaFeatures` in `OV_BOOT`, and the Studio server (and the agent
//! runtime it starts) `OPENVIDS_BETA_FEATURES=1|0` in its environment (`sidecar::studio_command`).

/// `beta` for a pre-release version, `stable` otherwise. Build metadata
/// (`0.5.0+build-1`) is not a pre-release; `release.yml` draws the same line.
pub fn channel_of(version: &str) -> &'static str {
    match semver::Version::parse(version) {
        Ok(parsed) if !parsed.pre.is_empty() => "beta",
        _ => "stable",
    }
}

/// This build's channel.
pub fn build_channel() -> &'static str {
    channel_of(env!("CARGO_PKG_VERSION"))
}

/// Whether beta features are on: a beta or debug build, unless
/// `OPENVIDS_BETA_FEATURES` says otherwise.
pub fn beta_features_enabled() -> bool {
    resolve(
        std::env::var("OPENVIDS_BETA_FEATURES").ok().as_deref(),
        build_channel(),
        cfg!(debug_assertions),
    )
}

fn resolve(env: Option<&str>, channel: &str, debug: bool) -> bool {
    match env.map(str::trim) {
        Some("1") | Some("true") | Some("yes") => true,
        Some("0") | Some("false") | Some("no") => false,
        _ => channel == "beta" || debug,
    }
}

/// The value of `OPENVIDS_BETA_FEATURES` the shell hands to the processes it starts: exactly `1` or `0`, however
/// the user's own value spelled it (`true`, `yes`, …), because the Studio server and the agent runtime read only
/// `1` as on.
pub fn env_value(enabled: bool) -> &'static str {
    if enabled {
        "1"
    } else {
        "0"
    }
}

#[cfg(test)]
mod tests {
    use super::{channel_of, env_value, resolve};

    #[test]
    fn pre_release_versions_are_beta() {
        assert_eq!(channel_of("0.5.0-beta.1"), "beta");
        assert_eq!(channel_of("0.5.0-rc.2+7"), "beta");
        assert_eq!(channel_of("0.5.0"), "stable");
        assert_eq!(channel_of("0.5.0+build-1"), "stable", "build metadata is not a pre-release");
    }

    #[test]
    fn env_overrides_the_build() {
        assert!(!resolve(None, "stable", false));
        assert!(resolve(None, "beta", false));
        assert!(resolve(None, "stable", true));
        assert!(resolve(Some("1"), "stable", false));
        assert!(!resolve(Some("0"), "beta", true));
        assert!(!resolve(Some("maybe"), "stable", false));
    }

    #[test]
    fn the_env_value_is_exactly_one_or_zero() {
        assert_eq!(env_value(true), "1");
        assert_eq!(env_value(false), "0");
    }
}
