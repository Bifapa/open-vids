//! The updater's channel selection, end to end against local HTTP manifests:
//! a mock Tauri app with the real updater plugin, a tiny server standing in
//! for `latest.json` (stable) and `beta.json` (beta), `find_update` in between.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

use super::*;

fn v(text: &str) -> semver::Version {
    semver::Version::parse(text).expect("test version parses")
}

/// A manifest announcing `version` for this machine's target.
fn manifest(version: &str) -> String {
    let target = update_target().expect("the test platform is supported by the updater");
    json!({
        "version": version,
        "notes": format!("Notes of {version}"),
        "pub_date": "2026-10-06T10:00:00Z",
        "platforms": {
            target: {
                "url": format!("https://example.invalid/OpenVids_{version}.bin"),
                "signature": "c2lnbmF0dXJl"
            }
        }
    })
    .to_string()
}

/// A local server: `GET /latest.json` and `GET /beta.json` answer the given
/// bodies (`None` → 404); every request path is recorded.
struct Manifests {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
}

impl Manifests {
    fn serve(stable: Option<String>, beta: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut line = String::new();
                if BufReader::new(&stream).read_line(&mut line).is_err() {
                    continue;
                }
                let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                seen.lock().unwrap_or_else(|e| e.into_inner()).push(path.clone());
                let body = match path.as_str() {
                    "/latest.json" => stable.clone(),
                    "/beta.json" => beta.clone(),
                    _ => None,
                };
                let answer = match body {
                    Some(body) => format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                    None => "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        .to_string(),
                };
                let _ = stream.write_all(answer.as_bytes());
            }
        });
        Self { base, requests }
    }

    fn stable_url(&self) -> String {
        format!("{}/latest.json", self.base)
    }

    fn beta_url(&self) -> String {
        format!("{}/beta.json", self.base)
    }

    fn requested(&self, path: &str) -> usize {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|seen| seen.as_str() == path)
            .count()
    }
}

/// A mock app running `current`, whose configured (stable) endpoint is `stable_url`.
fn app_running(current: &str, stable_url: &str) -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = v(current);
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({ "pubkey": "dGVzdA==", "endpoints": [stable_url] }),
    );
    mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .expect("the mock app builds")
}

/// The version `find_update` offers a build running `current` on `channel`,
/// `None` when it is up to date.
fn offered(
    current: &str,
    channel: Channel,
    stable: Option<&str>,
    beta: Option<&str>,
) -> (Result<Option<String>, String>, Manifests) {
    let manifests = Manifests::serve(stable.map(manifest), beta.map(manifest));
    let app = app_running(current, &manifests.stable_url());
    let outcome = tauri::async_runtime::block_on(find_update(
        app.handle(),
        channel,
        &manifests.beta_url(),
    ));
    let answer = outcome
        .map(|found| found.map(|(_, release)| release.version))
        .map_err(|err| err.message);
    (answer, manifests)
}

#[test]
fn versions_order_beta_one_before_beta_two_before_the_release() {
    assert!(is_newer(&v("0.5.0-beta.1"), &v("0.5.0-beta.2")));
    assert!(is_newer(&v("0.5.0-beta.2"), &v("0.5.0")));
    assert!(is_newer(&v("0.5.0-beta.1"), &v("0.5.0")));
    assert!(is_newer(&v("0.5.0-beta.9"), &v("0.5.0-beta.10")), "numeric, not lexical");
    assert!(!is_newer(&v("0.5.0-beta.2"), &v("0.5.0-beta.1")));
    assert!(!is_newer(&v("0.5.0"), &v("0.5.0-beta.2")), "a release never goes back to its beta");
    assert!(!is_newer(&v("0.5.0-beta.2"), &v("0.5.0-beta.2")));
    assert!(is_newer(&v("0.4.4"), &v("0.5.0-beta.1")), "a beta is newer than the older stable");
    assert!(!is_newer(&v("0.5.0-beta.1"), &v("0.4.9")));
}

#[test]
fn settle_takes_the_newest_and_the_stable_one_on_a_tie() {
    let pick = |answers: Vec<Result<Option<&'static str>, &'static str>>| {
        settle(answers, |version: &&str| *version)
    };
    assert_eq!(pick(vec![Ok(Some("0.4.5")), Ok(Some("0.5.0-beta.1"))]), Ok(Some("0.5.0-beta.1")));
    assert_eq!(pick(vec![Ok(Some("0.5.0")), Ok(Some("0.5.0-beta.3"))]), Ok(Some("0.5.0")));
    assert_eq!(pick(vec![Ok(Some("0.5.0-beta.2")), Ok(Some("0.5.0-beta.10"))]), Ok(Some("0.5.0-beta.10")));
    assert_eq!(pick(vec![Ok(Some("0.5.0")), Ok(Some("0.5.0+beta"))]), Ok(Some("0.5.0")));
    assert_eq!(pick(vec![Ok(None), Ok(Some("0.5.0-beta.1"))]), Ok(Some("0.5.0-beta.1")));
    assert_eq!(pick(vec![Ok(None), Ok(None)]), Ok(None));
    assert_eq!(pick(vec![]), Ok(None));
}

#[test]
fn settle_keeps_an_update_next_to_a_failure_and_reports_a_lone_failure() {
    let pick = |answers: Vec<Result<Option<&'static str>, &'static str>>| {
        settle(answers, |version: &&str| *version)
    };
    assert_eq!(pick(vec![Err("offline"), Ok(Some("0.5.0-beta.1"))]), Ok(Some("0.5.0-beta.1")));
    assert_eq!(pick(vec![Ok(Some("0.4.5")), Err("offline")]), Ok(Some("0.4.5")));
    assert_eq!(pick(vec![Ok(None), Err("offline")]), Err("offline"));
    assert_eq!(pick(vec![Err("first"), Err("second")]), Err("first"));
}

#[test]
fn a_missing_beta_manifest_is_no_beta_but_other_failures_are_failures() {
    use tauri_plugin_updater::Error as E;
    assert!(matches!(no_beta_is_none::<()>(Err(E::ReleaseNotFound)), Ok(None)));
    assert!(matches!(
        no_beta_is_none::<()>(Err(E::TargetNotFound("darwin-aarch64".into()))),
        Ok(None)
    ));
    assert!(matches!(
        no_beta_is_none::<()>(Err(E::TargetsNotFound(vec!["a".into()]))),
        Ok(None)
    ));
    assert!(matches!(no_beta_is_none::<()>(Err(E::EmptyEndpoints)), Err(E::EmptyEndpoints)));
    assert!(matches!(no_beta_is_none(Ok(Some(1))), Ok(Some(1))));
}

#[test]
fn a_stable_build_on_the_stable_channel_never_asks_for_or_offers_the_beta() {
    let (answer, manifests) = offered(
        "0.4.4",
        Channel::Stable,
        Some("0.4.4"),
        Some("0.5.0-beta.1"),
    );
    assert_eq!(answer, Ok(None));
    assert_eq!(manifests.requested("/beta.json"), 0, "the beta manifest is not even read");

    let (answer, manifests) = offered(
        "0.4.4",
        Channel::Stable,
        Some("0.4.5"),
        Some("0.5.0-beta.1"),
    );
    assert_eq!(answer, Ok(Some("0.4.5".to_string())), "a newer beta does not outrank the stable");
    assert_eq!(manifests.requested("/beta.json"), 0);
}

#[test]
fn a_stable_build_on_the_beta_channel_is_offered_the_beta() {
    let (answer, manifests) = offered(
        "0.4.4",
        Channel::Beta,
        Some("0.4.4"),
        Some("0.5.0-beta.1"),
    );
    assert_eq!(answer, Ok(Some("0.5.0-beta.1".to_string())));
    assert_eq!(manifests.requested("/latest.json"), 1);
    assert_eq!(manifests.requested("/beta.json"), 1);
}

#[test]
fn the_newer_of_a_stable_fix_and_a_beta_wins() {
    // A stable fix released after the beta line started: the beta is still newer.
    let (answer, _) = offered("0.4.4", Channel::Beta, Some("0.4.5"), Some("0.5.0-beta.1"));
    assert_eq!(answer, Ok(Some("0.5.0-beta.1".to_string())));
    // The other way round: the stable release already overtook the stale beta manifest.
    let (answer, _) = offered("0.4.4", Channel::Beta, Some("0.5.0"), Some("0.5.0-beta.4"));
    assert_eq!(answer, Ok(Some("0.5.0".to_string())));
}

#[test]
fn a_beta_updates_to_the_next_beta_and_then_to_the_stable_release() {
    let (answer, _) = offered(
        "0.5.0-beta.1",
        Channel::Beta,
        Some("0.4.4"),
        Some("0.5.0-beta.2"),
    );
    assert_eq!(answer, Ok(Some("0.5.0-beta.2".to_string())));

    let (answer, _) = offered(
        "0.5.0-beta.2",
        Channel::Beta,
        Some("0.5.0"),
        Some("0.5.0-beta.2"),
    );
    assert_eq!(answer, Ok(Some("0.5.0".to_string())), "the release follows the last beta");
}

#[test]
fn a_beta_build_that_turned_the_toggle_off_only_moves_to_a_newer_stable() {
    // Stable channel: no next beta, and the older stable is no update.
    let (answer, manifests) = offered(
        "0.5.0-beta.1",
        Channel::Stable,
        Some("0.4.4"),
        Some("0.5.0-beta.2"),
    );
    assert_eq!(answer, Ok(None));
    assert_eq!(manifests.requested("/beta.json"), 0);

    let (answer, _) = offered(
        "0.5.0-beta.2",
        Channel::Stable,
        Some("0.5.0"),
        Some("0.5.0-beta.3"),
    );
    assert_eq!(answer, Ok(Some("0.5.0".to_string())));
}

#[test]
fn nothing_is_ever_offered_backwards() {
    let (answer, _) = offered("0.5.0", Channel::Beta, Some("0.5.0"), Some("0.5.0-beta.3"));
    assert_eq!(answer, Ok(None), "a stable build is not moved back to an older beta");
    let (answer, _) = offered("0.5.0-beta.3", Channel::Beta, Some("0.4.9"), Some("0.5.0-beta.3"));
    assert_eq!(answer, Ok(None), "the same beta is not an update");
}

#[test]
fn a_beta_channel_without_any_published_beta_is_simply_up_to_date() {
    let (answer, manifests) = offered("0.4.4", Channel::Beta, Some("0.4.4"), None);
    assert_eq!(answer, Ok(None));
    assert_eq!(manifests.requested("/beta.json"), 1);

    let (answer, _) = offered("0.4.4", Channel::Beta, Some("0.4.5"), None);
    assert_eq!(answer, Ok(Some("0.4.5".to_string())), "the stable update still shows");
}

#[test]
fn a_failing_stable_manifest_stays_an_error_unless_a_beta_is_on_offer() {
    let (answer, _) = offered("0.4.4", Channel::Stable, None, Some("0.5.0-beta.1"));
    let error = answer.expect_err("the stable manifest is missing");
    assert!(error.contains("could not check for updates"), "{error}");

    let (answer, _) = offered("0.4.4", Channel::Beta, None, None);
    assert!(answer.is_err(), "nothing answered at all");

    let (answer, _) = offered("0.4.4", Channel::Beta, None, Some("0.5.0-beta.1"));
    assert_eq!(answer, Ok(Some("0.5.0-beta.1".to_string())));
}
