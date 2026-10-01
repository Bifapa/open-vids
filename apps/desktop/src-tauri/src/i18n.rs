//! User-facing text for the native shell: menus, `rfd` dialog titles, window titles.
//!
//! The web pages translate themselves (home page `i18n.js`, Studio `src/i18n`);
//! this module is for the strings Rust itself puts in front of the user. The
//! catalog is the same one compiled in by `build.rs` (`locales.rs`): look up
//! `menu.*` / `dialog.*` keys in the active language, falling back to `en`
//! and then to the key itself — the same fallback the checker documents for
//! partial translations.
//!
//! Language resolution mirrors the pages (`resolveLanguage` in
//! `home_page/i18n.js` and Studio's resolver): an explicit listed code wins;
//! `system` (or anything unexpected) walks the OS languages, exact match
//! (case-insensitive), then the base language (`ru-RU` → `ru`), then `en`.
//!
//! Rust does no ICU plural selection: messages here take `{name}`-style
//! params only, and counts ride along as plain params (for example
//! `t_with("dialog.locate.title", &[("name", name)])`).

/// Resolve the active locale code against the compiled catalog.
///
/// `preference` is the raw `language` preference (`"system"` or a code);
/// `os_languages` is most-preferred first (BCP-47, e.g. `ru-RU`), as both
/// `navigator.languages` on the pages and `sys_locale::get_locales()` give.
pub fn resolve(preference: &str, os_languages: &[String]) -> &'static str {
    if let Some(code) = find_listed(preference) {
        return code;
    }
    if preference != "system" {
        // An explicit but unlisted code (a language added after this build,
        // a typo): fall back to `en`, exactly like the pages do — the OS
        // languages should not override an explicit choice.
        return "en";
    }
    for language in os_languages {
        if let Some(code) = find_listed(language) {
            return code;
        }
        if let Some(base) = language.split(['-', '_']).next() {
            if let Some(code) = find_listed(base) {
                return code;
            }
        }
    }
    "en"
}

fn find_listed(wanted: &str) -> Option<&'static str> {
    super::locales::LOCALE_CODES
        .iter()
        .find(|code| code.eq_ignore_ascii_case(wanted))
        .copied()
}

/// The active locale code: the stored preference resolved against the OS
/// languages. Read fresh on every call — the preference can change from
/// either page at any time — so a `t()` result is never a stale module-level
/// string.
pub fn active() -> &'static str {
    let stored = super::prefs::load(&super::prefs::prefs_path());
    let os: Vec<String> = sys_locale::get_locales().collect();
    // The returned code borrows from the compiled catalog (`LOCALE_CODES`
    // entries and `"en"` are both `'static`), never from the arguments.
    resolve_owned(super::prefs::language(&stored), &os)
}

/// The resolved code for an already-loaded preferences document: the pure,
/// testable half of [`active`]. The menu-rebuild listener calls this with
/// the fresh document instead of re-reading the file.
pub fn resolve_for_prefs(prefs: &serde_json::Value, os_languages: &[String]) -> String {
    resolve(super::prefs::language(prefs), os_languages).to_string()
}

fn resolve_owned(preference: &str, os_languages: &[String]) -> &'static str {
    resolve(preference, os_languages)
}

/// The message for `key` in the active language (`en` fallback, then the key).
pub fn t(key: &str) -> String {
    lookup(key, active())
}

fn lookup(key: &str, code: &str) -> String {
    if let Some(message) = super::locales::messages_value(code)
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_str())
    {
        return message.to_string();
    }
    if code != "en" {
        if let Some(message) = super::locales::messages_value("en")
            .and_then(|value| value.get(key))
            .and_then(|value| value.as_str())
        {
            return message.to_string();
        }
    }
    key.to_string()
}

/// The message for `key` with `{name}`-style params substituted.
///
/// Substitution is textual (`{name}` → value, no quoting): values are folder
/// names and short labels, never markup. Unknown params are left in place.
pub fn t_with(key: &str, args: &[(&str, &str)]) -> String {
    substitute(&t(key), args)
}

/// The pure substitution half of [`t_with`], so tests pin the `{name}`
/// handling without depending on the machine's active language.
pub fn substitute(message: &str, args: &[(&str, &str)]) -> String {
    let mut out = message.to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn langs(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn explicit_listed_code_wins_over_os_languages() {
        assert_eq!(resolve("ru", &langs(&["en-US"])), "ru");
        assert_eq!(resolve("en", &langs(&["ru-RU"])), "en");
        assert_eq!(resolve("RU", &langs(&["en-US"])), "ru");
    }

    #[test]
    fn system_walks_os_languages_exact_then_base_then_en() {
        assert_eq!(resolve("system", &langs(&["ru-RU", "en-US"])), "ru");
        assert_eq!(resolve("system", &langs(&["ru"])), "ru");
        assert_eq!(resolve("system", &langs(&["en-US", "ru-RU"])), "en");
        assert_eq!(resolve("system", &langs(&["de-DE", "fr"])), "en");
        assert_eq!(resolve("system", &[]), "en");
    }

    #[test]
    fn unlisted_explicit_code_falls_back_to_en() {
        assert_eq!(resolve("de", &langs(&["ru-RU"])), "en");
        assert_eq!(resolve("", &langs(&["ru-RU"])), "en");
    }

    #[test]
    fn lookup_prefers_active_over_en_and_falls_back_to_key() {
        // `menu.file.title` exists in both catalogs; the Russian one differs.
        let en = lookup("menu.file.title", "en");
        let ru = lookup("menu.file.title", "ru");
        assert_eq!(en, "File");
        assert_eq!(ru, "Файл");
        assert_eq!(lookup("menu.no.such.key", "ru"), "menu.no.such.key");
    }

    #[test]
    fn params_substitute_and_unknown_params_stay() {
        assert_eq!(lookup("menu.file.title", "en"), "File");
        assert_eq!(
            lookup("dialog.locate.title", "ru").replace("{name}", "Teaser"),
            "Найти «Teaser»"
        );
        assert_eq!(lookup("dialog.locate.title", "en"), "Locate “{name}”");
    }

    #[test]
    fn listener_resolves_language_from_a_fresh_document() {
        let ru = serde_json::json!({ "language": "ru" });
        assert_eq!(resolve_for_prefs(&ru, &[]), "ru");
        let system_ru = serde_json::json!({ "language": "system" });
        assert_eq!(resolve_for_prefs(&system_ru, &langs(&["ru-RU"])), "ru");
        assert_eq!(resolve_for_prefs(&system_ru, &langs(&["de"])), "en");
    }

    #[test]
    fn substitution_replaces_every_occurrence_and_keeps_unknowns() {
        assert_eq!(
            substitute("Locate “{name}” ({name})", &[("name", "Teaser")]),
            "Locate “Teaser” (Teaser)"
        );
        assert_eq!(
            substitute("Open Project", &[("unused", "x")]),
            "Open Project"
        );
    }
}
