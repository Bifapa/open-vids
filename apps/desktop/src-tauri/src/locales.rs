//! The locale catalog (`locales/` at the repo root), embedded at compile time.
//!
//! `build.rs` reads `locales/index.json` (the list of languages — the only
//! place the list lives) and writes `$OUT_DIR/locales.rs` with `LOCALE_CODES`,
//! `INDEX_JSON` and `locale_json`, included below. Adding a language is a new
//! `locales/<code>.json` plus one line in `locales/index.json`: no Rust
//! changes, and the build fails if the catalog is malformed or a listed file
//! is missing. The parsed helpers keep one copy of each document; the home
//! server injects them into the pages' first paint (`home_routes`), so the
//! page never shows raw keys before its async locale fetch.

include!(concat!(env!("OUT_DIR"), "/locales.rs"));

use std::sync::OnceLock;

use serde_json::Value;

struct ParsedLocales {
    index: Value,
    messages: Vec<(&'static str, Value)>,
}

static PARSED_LOCALES: OnceLock<ParsedLocales> = OnceLock::new();

fn parsed_locales() -> &'static ParsedLocales {
    PARSED_LOCALES.get_or_init(|| {
        let index = serde_json::from_str(INDEX_JSON).unwrap_or(Value::Null);
        let messages = LOCALE_CODES
            .iter()
            .map(|code| {
                let value = locale_json(code)
                    .and_then(|src| serde_json::from_str(src).ok())
                    .unwrap_or(Value::Null);
                (*code, value)
            })
            .collect();
        ParsedLocales { index, messages }
    })
}

/// The parsed `locales/index.json` (the language list).
pub fn index_value() -> &'static Value {
    &parsed_locales().index
}

/// The parsed `locales/<code>.json`, or `None` for an unknown code.
pub fn messages_value(code: &str) -> Option<&'static Value> {
    parsed_locales()
        .messages
        .iter()
        .find(|(listed, _)| *listed == code)
        .map(|(_, value)| value)
}

/// `en` plus `code` when it names a listed locale: what the pages get
/// injected so the first paint is already translated.
pub fn boot_messages(code: &str) -> serde_json::Map<String, Value> {
    let mut messages = serde_json::Map::new();
    if let Some(en) = messages_value("en") {
        messages.insert("en".into(), en.clone());
    }
    if code != "en" {
        if let Some(extra) = messages_value(code) {
            messages.insert(code.into(), extra.clone());
        }
    }
    messages
}
