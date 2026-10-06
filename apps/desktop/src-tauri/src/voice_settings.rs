//! Voiceover settings on disk, for the Projects page (Settings › Voice, beta).
//!
//! Studio's server owns synthesis, key checks and the voice catalog
//! (`packages/studio-server/src/voice/`); this shell makes no network call. It only reads and writes the files
//! both sides share, byte-compatible with the Studio server's store, in `$OPENVIDS_VOICE_DIR` (default
//! `~/.openvids/voice`):
//!
//! - `providers.json` `{ schema: "openvids.voice-providers/1", providers: { <id>: { model?, baseUrl?, voice?,
//!   agentRules? } } }` — mode 0644; a missing entry is the defaults, a file that cannot be read as such is the
//!   defaults (and is copied to `providers.json.bak` before the first write replaces it); keys this code does not
//!   know (top level and per provider) are kept on write;
//! - `api-keys.json` `{ schema: "openvids.voice-keys/1", keys: { <id>: "<key>" } }` — mode 0600 in a 0700
//!   directory, atomic, a file that cannot be read as such holds no keys. A key never leaves this module: no view
//!   and no error message carries it (`hasKey` only);
//! - `presets.json` `{ schema: "openvids.voice-presets/1", presets: [VoicePreset] }` — listed, renamed and
//!   deleted here (a preset is made in Studio, where a voice can be tried); everything else in the file is kept;
//! - `cache/<hash>.wav|.mp3` + `cache/<hash>.json` — the sample audio of a preset, served by [`VoiceStore::audio`];
//!   an entry counts only when both files exist.
//!
//! The provider table below is a DUPLICATE of `VOICE_PROVIDERS` in
//! `packages/studio-server/src/voice/providers.ts` (the Studio server cannot run here and this crate cannot import
//! it): when a provider, its name, address or default model changes, change both.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Number, Value};

use super::research_policy::{is_js_whitespace, write_atomic};

const PROVIDERS_SCHEMA: &str = "openvids.voice-providers/1";
const KEYS_SCHEMA: &str = "openvids.voice-keys/1";
const PRESETS_SCHEMA: &str = "openvids.voice-presets/1";
const PROVIDERS_FILE: &str = "providers.json";
const KEYS_FILE: &str = "api-keys.json";
const PRESETS_FILE: &str = "presets.json";
const CACHE_DIR: &str = "cache";

/// `VOICE_LIMITS` of `packages/agent-protocol/src/voice.ts`.
const API_KEY_CHARS: usize = 4_096;
const BASE_URL_CHARS: usize = 2_048;
const MODEL_CHARS: usize = 200;
const VOICE_ID_CHARS: usize = 200;
const AGENT_RULES_CHARS: usize = 4_000;
const PRESET_NAME_CHARS: usize = 80;
/// A cache entry larger than this is not served (a sample is a few hundred KB).
const AUDIO_BYTES_MAX: u64 = 64 * 1024 * 1024;

/// Serializes read-modify-write cycles within this process (the home server answers each connection on its own
/// thread). Studio's server is another process; like its store, nothing coordinates with it.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

// ── Errors ──────────────────────────────────────────────────────────────────

/// A refused request: the wire error `{ code, message }` (a `VoiceErrorCode` where one fits) and its status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceError {
    pub code: &'static str,
    pub message: String,
}

impl VoiceError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_request", message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }

    pub fn status(&self) -> u16 {
        match self.code {
            "invalid_request" => 400,
            "not_found" => 404,
            _ => 500,
        }
    }
}

// ── Providers ───────────────────────────────────────────────────────────────

struct ProviderDef {
    id: &'static str,
    connector: &'static str,
    name: &'static str,
    /// Fixed for a built-in provider; the user's for `custom` (empty until set).
    base_url: &'static str,
    /// The model used unless the user names another (empty for `custom`).
    model: &'static str,
    key_required: bool,
}

/// In display order. See the module comment: a duplicate of the Studio server's table.
const PROVIDERS: [ProviderDef; 5] = [
    ProviderDef {
        id: "gemini",
        connector: "gemini",
        name: "Google Gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta",
        model: "gemini-3.8-flash-tts",
        key_required: true,
    },
    ProviderDef {
        id: "openai",
        connector: "openai_compatible",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        key_required: true,
    },
    ProviderDef {
        id: "openrouter",
        connector: "openai_compatible",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        model: "google/gemini-3.8-flash-tts",
        key_required: true,
    },
    ProviderDef {
        id: "elevenlabs",
        connector: "elevenlabs",
        name: "ElevenLabs",
        base_url: "https://api.elevenlabs.io",
        model: "eleven_v4",
        key_required: true,
    },
    ProviderDef {
        id: "custom",
        connector: "openai_compatible",
        name: "Custom server",
        base_url: "",
        model: "",
        key_required: false,
    },
];

fn provider_def(id: &str) -> Option<&'static ProviderDef> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// `VoiceProviderInfo` of `packages/agent-protocol/src/voice.ts`. The key itself is never part of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: &'static str,
    pub connector: &'static str,
    pub name: &'static str,
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
    pub key_required: bool,
    pub configured: bool,
    pub voice: String,
    pub agent_rules: String,
    pub notes: Vec<&'static str>,
}

/// What the user may change on a provider (`UpdateVoiceProviderRequest`). `Some("")` forgets the override.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ProviderUpdate {
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub voice: Option<String>,
    pub agent_rules: Option<String>,
}

fn bounded(map: &Map<String, Value>, field: &str, max: usize) -> Result<Option<String>, VoiceError> {
    let Some(value) = map.get(field) else {
        return Ok(None);
    };
    let Some(text) = value.as_str() else {
        return Err(VoiceError::invalid(format!("{field} must be a string")));
    };
    if text.chars().count() > max {
        return Err(VoiceError::invalid(format!(
            "{field} must be at most {max} characters"
        )));
    }
    Ok(Some(text.trim_matches(is_js_whitespace).to_string()))
}

/// `parseUpdateVoiceProviderRequest` of `voice.ts`: the same fields, limits and address rules (http(s) only, no
/// credentials in the address). Which provider may take which field is the store's to judge.
pub fn parse_provider_update(raw: &Value) -> Result<ProviderUpdate, VoiceError> {
    let Some(map) = raw.as_object() else {
        return Err(VoiceError::invalid("body must be an object"));
    };
    let mut update = ProviderUpdate {
        model: bounded(map, "model", MODEL_CHARS)?,
        base_url: bounded(map, "baseUrl", BASE_URL_CHARS)?,
        voice: bounded(map, "voice", VOICE_ID_CHARS)?,
        agent_rules: bounded(map, "agentRules", AGENT_RULES_CHARS)?,
    };
    if let Some(address) = update.base_url.as_deref().filter(|a| !a.is_empty()) {
        let Ok(url) = url::Url::parse(address) else {
            return Err(VoiceError::invalid("baseUrl is not a URL"));
        };
        if !matches!(url.scheme(), "http" | "https") {
            return Err(VoiceError::invalid("baseUrl must be http(s)"));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(VoiceError::invalid("baseUrl must not carry credentials"));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(VoiceError::invalid("baseUrl must not carry a query string or a fragment"));
        }
        // The Studio store keeps the address without trailing slashes too; both sides write the same bytes.
        update.base_url = Some(address.trim_end_matches('/').to_string());
    }
    Ok(update)
}

/// `{ key }` of `PUT …/api-key`: one word of printable ASCII, as the other key stores keep it.
pub fn parse_api_key(raw: &Value) -> Result<String, VoiceError> {
    let key = raw
        .as_object()
        .and_then(|map| map.get("key"))
        .and_then(Value::as_str)
        .ok_or_else(|| VoiceError::invalid("key must be a string"))?
        .trim_matches(is_js_whitespace);
    if key.is_empty() || key.len() > API_KEY_CHARS || !key.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(VoiceError::invalid(format!(
            "key must be one word of at most {API_KEY_CHARS} printable ASCII characters"
        )));
    }
    Ok(key.to_string())
}

/// `{ name }` of `PATCH …/presets/<id>`.
pub fn parse_preset_name(raw: &Value) -> Result<String, VoiceError> {
    let name = raw
        .as_object()
        .and_then(|map| map.get("name"))
        .and_then(Value::as_str)
        .ok_or_else(|| VoiceError::invalid("name must be a string"))?
        .trim_matches(is_js_whitespace);
    if name.is_empty() {
        return Err(VoiceError::invalid("name must not be empty"));
    }
    if name.chars().count() > PRESET_NAME_CHARS {
        return Err(VoiceError::invalid(format!(
            "name must be at most {PRESET_NAME_CHARS} characters"
        )));
    }
    Ok(name.to_string())
}

/// 64 lowercase hex characters: a cache entry's name (sha256 of the synthesis request).
pub fn is_cache_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// ── The store ───────────────────────────────────────────────────────────────

/// The voice directory: `OPENVIDS_VOICE_DIR`, else `~/.openvids/voice`.
pub fn voice_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPENVIDS_VOICE_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    super::prefs::home_dir().join(".openvids").join("voice")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct VoiceStore {
    dir: PathBuf,
}

/// A JSON file as an object with the expected `schema`; anything else is `None` ("cannot be read as such").
fn read_root(path: &Path, schema: &str) -> Option<Map<String, Value>> {
    let bytes = std::fs::read(path).ok()?;
    let Value::Object(map) = serde_json::from_slice::<Value>(&bytes).ok()? else {
        return None;
    };
    (map.get("schema").and_then(Value::as_str) == Some(schema)).then_some(map)
}

fn text_of(map: &Map<String, Value>, field: &str) -> String {
    map.get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn io_error(what: &str, err: std::io::Error) -> VoiceError {
    VoiceError::new("io_error", format!("could not save {what}: {err}"))
}

fn pretty(value: &Value) -> Result<Vec<u8>, VoiceError> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|err| VoiceError::new("io_error", err.to_string()))?;
    bytes.push(b'\n');
    Ok(bytes)
}

impl VoiceStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    /// The store over the default directory.
    pub fn open() -> Self {
        Self::new(&voice_dir())
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    // ── keys ──

    /// `api-keys.json`'s `keys` object; a file that cannot be read as such holds none.
    fn load_keys(&self) -> Map<String, Value> {
        read_root(&self.file(KEYS_FILE), KEYS_SCHEMA)
            .and_then(|root| match root.get("keys") {
                Some(Value::Object(keys)) => Some(keys.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }

    fn has_key(keys: &Map<String, Value>, id: &str) -> bool {
        keys.get(id)
            .and_then(Value::as_str)
            .is_some_and(|key| !key.is_empty())
    }

    fn save_keys(&self, keys: Map<String, Value>) -> Result<(), VoiceError> {
        let mut root = Map::new();
        root.insert("schema".into(), Value::from(KEYS_SCHEMA));
        root.insert("keys".into(), Value::Object(keys));
        let bytes = pretty(&Value::Object(root))?;
        write_atomic(&self.file(KEYS_FILE), &bytes, 0o600).map_err(|err| io_error("the API key", err))
    }

    // ── providers ──

    fn load_providers_root(&self) -> Option<Map<String, Value>> {
        read_root(&self.file(PROVIDERS_FILE), PROVIDERS_SCHEMA)
            .filter(|root| matches!(root.get("providers"), Some(Value::Object(_))))
    }

    fn provider_info(
        def: &'static ProviderDef,
        root: Option<&Map<String, Value>>,
        keys: &Map<String, Value>,
    ) -> ProviderInfo {
        let entry = root
            .and_then(|root| root.get("providers"))
            .and_then(Value::as_object)
            .and_then(|providers| providers.get(def.id))
            .and_then(Value::as_object);
        let stored = |field: &str| entry.map(|e| text_of(e, field)).unwrap_or_default();
        let custom = def.id == "custom";
        let model = Some(stored("model"))
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| def.model.to_string());
        let base_url = if custom {
            stored("baseUrl")
        } else {
            def.base_url.to_string()
        };
        let has_key = Self::has_key(keys, def.id);
        let configured = if custom {
            !base_url.is_empty() && !model.is_empty()
        } else {
            !def.key_required || has_key
        };
        let mut notes = Vec::new();
        if def.id == "gemini" {
            notes.push("free_tier_terms");
        }
        if def.id == "openrouter" && model.starts_with("google/gemini") {
            notes.push("catalog_needs_google_key");
        }
        ProviderInfo {
            id: def.id,
            connector: def.connector,
            name: def.name,
            base_url,
            model,
            has_key,
            key_required: def.key_required,
            configured,
            voice: if custom { stored("voice") } else { String::new() },
            agent_rules: stored("agentRules"),
            notes,
        }
    }

    /// Every provider as Studio shows it (no key in any of them).
    pub fn providers(&self) -> Vec<ProviderInfo> {
        let root = self.load_providers_root();
        let keys = self.load_keys();
        PROVIDERS
            .iter()
            .map(|def| Self::provider_info(def, root.as_ref(), &keys))
            .collect()
    }

    fn provider(&self, id: &str) -> Result<ProviderInfo, VoiceError> {
        let def = provider_def(id).ok_or_else(|| unknown_provider(id))?;
        Ok(Self::provider_info(
            def,
            self.load_providers_root().as_ref(),
            &self.load_keys(),
        ))
    }

    pub fn update_provider(&self, id: &str, update: &ProviderUpdate) -> Result<ProviderInfo, VoiceError> {
        let def = provider_def(id).ok_or_else(|| unknown_provider(id))?;
        if def.id != "custom" && (update.base_url.is_some() || update.voice.is_some()) {
            return Err(VoiceError::invalid(
                "baseUrl and voice can only be set on the custom server",
            ));
        }
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let path = self.file(PROVIDERS_FILE);
        let mut root = match self.load_providers_root() {
            Some(root) => root,
            None => {
                if path.exists() {
                    // Best effort: the defaults are still safe.
                    let mut backup = path.clone().into_os_string();
                    backup.push(".bak");
                    let _ = std::fs::copy(&path, PathBuf::from(backup));
                }
                let mut fresh = Map::new();
                fresh.insert("schema".into(), Value::from(PROVIDERS_SCHEMA));
                fresh.insert("providers".into(), Value::Object(Map::new()));
                fresh
            }
        };
        let mut providers = match root.remove("providers") {
            Some(Value::Object(providers)) => providers,
            _ => Map::new(),
        };
        let mut entry = match providers.remove(id) {
            Some(Value::Object(entry)) => entry,
            _ => Map::new(),
        };
        for (field, value) in [
            ("model", &update.model),
            ("baseUrl", &update.base_url),
            ("voice", &update.voice),
            ("agentRules", &update.agent_rules),
        ] {
            match value {
                Some(text) if !text.is_empty() => {
                    entry.insert(field.into(), Value::from(text.as_str()));
                }
                Some(_) => {
                    entry.remove(field);
                }
                None => {}
            }
        }
        if !entry.is_empty() {
            providers.insert(id.to_string(), Value::Object(entry));
        }
        root.insert("providers".into(), Value::Object(providers));
        write_atomic(&path, &pretty(&Value::Object(root))?, 0o644)
            .map_err(|err| io_error("the voice provider", err))?;
        self.provider(id)
    }

    pub fn set_api_key(&self, id: &str, key: &str) -> Result<ProviderInfo, VoiceError> {
        provider_def(id).ok_or_else(|| unknown_provider(id))?;
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut keys = self.load_keys();
        keys.insert(id.to_string(), Value::from(key));
        self.save_keys(keys)?;
        self.provider(id)
    }

    pub fn remove_api_key(&self, id: &str) -> Result<ProviderInfo, VoiceError> {
        provider_def(id).ok_or_else(|| unknown_provider(id))?;
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut keys = self.load_keys();
        if keys.remove(id).is_some() {
            self.save_keys(keys)?;
        }
        self.provider(id)
    }

    // ── presets ──

    fn load_presets_root(&self) -> Option<Map<String, Value>> {
        read_root(&self.file(PRESETS_FILE), PRESETS_SCHEMA)
            .filter(|root| matches!(root.get("presets"), Some(Value::Array(_))))
    }

    fn preset_id(entry: &Value) -> Option<&str> {
        entry.get("id").and_then(Value::as_str)
    }

    /// The saved presets, as stored (an entry without an `id` is not listed).
    pub fn presets(&self) -> Vec<Value> {
        let Some(mut root) = self.load_presets_root() else {
            return Vec::new();
        };
        match root.remove("presets") {
            Some(Value::Array(entries)) => entries
                .into_iter()
                .filter(|e| e.is_object() && Self::preset_id(e).is_some())
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Reads, lets `change` edit the entries, writes. A file that cannot be read as presets is never overwritten.
    fn edit_presets<T>(
        &self,
        id: &str,
        change: impl FnOnce(&mut Vec<Value>, usize) -> T,
    ) -> Result<T, VoiceError> {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let missing = || VoiceError::not_found(format!("No voice preset \"{id}\""));
        let mut root = self.load_presets_root().ok_or_else(missing)?;
        let Some(Value::Array(mut entries)) = root.remove("presets") else {
            return Err(missing());
        };
        let index = entries
            .iter()
            .position(|e| Self::preset_id(e) == Some(id))
            .ok_or_else(missing)?;
        let out = change(&mut entries, index);
        root.insert("presets".into(), Value::Array(entries));
        write_atomic(&self.file(PRESETS_FILE), &pretty(&Value::Object(root))?, 0o644)
            .map_err(|err| io_error("the voice presets", err))?;
        Ok(out)
    }

    pub fn rename_preset(&self, id: &str, name: &str) -> Result<Value, VoiceError> {
        self.edit_presets(id, |entries, index| {
            if let Some(entry) = entries[index].as_object_mut() {
                entry.insert("name".into(), Value::from(name));
                entry.insert("updatedAt".into(), Value::Number(Number::from(now_ms())));
            }
            entries[index].clone()
        })
    }

    pub fn delete_preset(&self, id: &str) -> Result<(), VoiceError> {
        self.edit_presets(id, |entries, index| {
            entries.remove(index);
        })
    }

    // ── sample audio ──

    /// The cache entry `hash` names: its content type and bytes. `None` for anything but a complete entry (audio
    /// and metadata) of a well-formed hash, so no other path can be read through here.
    pub fn audio(&self, hash: &str) -> Option<(&'static str, Vec<u8>)> {
        if !is_cache_hash(hash) {
            return None;
        }
        let cache = self.file(CACHE_DIR);
        if !cache.join(format!("{hash}.json")).is_file() {
            return None;
        }
        for (ext, mime) in [("wav", "audio/wav"), ("mp3", "audio/mpeg")] {
            let path = cache.join(format!("{hash}.{ext}"));
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() || meta.len() > AUDIO_BYTES_MAX {
                continue;
            }
            if let Ok(bytes) = std::fs::read(&path) {
                return Some((mime, bytes));
            }
        }
        None
    }
}

fn unknown_provider(id: &str) -> VoiceError {
    VoiceError::not_found(format!("No voice provider \"{id}\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openvids-voice-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn info(store: &VoiceStore, id: &str) -> ProviderInfo {
        store.providers().into_iter().find(|p| p.id == id).unwrap()
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn defaults_are_the_documented_provider_table() {
        let store = VoiceStore::new(&dir("defaults"));
        let all = store.providers();
        let rows: Vec<(&str, &str, &str, &str, bool)> = all
            .iter()
            .map(|p| {
                (
                    p.id,
                    p.connector,
                    p.base_url.as_str(),
                    p.model.as_str(),
                    p.key_required,
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                (
                    "gemini",
                    "gemini",
                    "https://generativelanguage.googleapis.com/v1beta",
                    "gemini-3.8-flash-tts",
                    true
                ),
                (
                    "openai",
                    "openai_compatible",
                    "https://api.openai.com/v1",
                    "gpt-4o-mini-tts",
                    true
                ),
                (
                    "openrouter",
                    "openai_compatible",
                    "https://openrouter.ai/api/v1",
                    "google/gemini-3.8-flash-tts",
                    true
                ),
                (
                    "elevenlabs",
                    "elevenlabs",
                    "https://api.elevenlabs.io",
                    "eleven_v4",
                    true
                ),
                ("custom", "openai_compatible", "", "", false),
            ]
        );
        assert!(all
            .iter()
            .all(|p| !p.has_key && !p.configured && p.agent_rules.is_empty() && p.voice.is_empty()));
        assert_eq!(info(&store, "gemini").notes, ["free_tier_terms"]);
        assert_eq!(info(&store, "openrouter").notes, ["catalog_needs_google_key"]);
        assert!(info(&store, "openai").notes.is_empty());
        // Reading never creates a file.
        assert_eq!(std::fs::read_dir(dir("defaults")).unwrap().count(), 0);
    }

    #[test]
    fn the_wire_shape_is_the_one_studio_serves() {
        let store = VoiceStore::new(&dir("shape"));
        let value = serde_json::to_value(info(&store, "gemini")).unwrap();
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "agentRules",
                "baseUrl",
                "configured",
                "connector",
                "hasKey",
                "id",
                "keyRequired",
                "model",
                "name",
                "notes",
                "voice"
            ]
        );
    }

    #[test]
    fn a_key_is_stored_privately_and_never_answered() {
        // A directory the store has to make itself (the test helper's own is 0755).
        let dir = dir("key").join("voice");
        let store = VoiceStore::new(&dir);
        let secret = "sk-test-SECRET-0123456789";
        let view = store.set_api_key("openai", secret).unwrap();
        assert!(view.has_key && view.configured);
        // Nothing the module answers carries the key.
        let answers = [
            serde_json::to_string(&view).unwrap(),
            serde_json::to_string(&store.providers()).unwrap(),
            serde_json::to_string(
                &store
                    .update_provider(
                        "openai",
                        &ProviderUpdate {
                            model: Some("m".into()),
                            ..Default::default()
                        },
                    )
                    .unwrap(),
            )
            .unwrap(),
        ];
        for answer in answers {
            assert!(!answer.contains(secret), "{answer}");
        }
        assert_eq!(
            read_json(&dir.join("api-keys.json")),
            json!({ "schema": "openvids.voice-keys/1", "keys": { "openai": secret } })
        );
        assert!(std::fs::read_to_string(dir.join("api-keys.json"))
            .unwrap()
            .ends_with("}\n"));
        #[cfg(unix)]
        {
            assert_eq!(mode_of(&dir.join("api-keys.json")), 0o600);
            assert_eq!(mode_of(&dir), 0o700, "a directory the store made");
        }
        // A second key joins it; removing one leaves the other; another instance sees both.
        store.set_api_key("gemini", "AIza-other").unwrap();
        let removed = store.remove_api_key("openai").unwrap();
        assert!(!removed.has_key && !removed.configured);
        let again = VoiceStore::new(&dir);
        assert!(info(&again, "gemini").has_key);
        assert!(!info(&again, "openai").has_key);
        assert_eq!(
            read_json(&dir.join("api-keys.json"))["keys"],
            json!({ "gemini": "AIza-other" })
        );
        // Forgetting a key that is not there is not an error and writes nothing new.
        assert!(!store.remove_api_key("elevenlabs").unwrap().has_key);
    }

    #[test]
    fn an_unreadable_keys_file_holds_no_keys_and_a_bad_key_is_refused() {
        let dir = dir("keys-bad");
        let store = VoiceStore::new(&dir);
        for content in [
            "not json",
            "[]",
            r#"{"schema":"other/1","keys":{"openai":"k"}}"#,
            r#"{"schema":"openvids.voice-keys/1","keys":[]}"#,
        ] {
            std::fs::write(dir.join("api-keys.json"), content).unwrap();
            assert!(!info(&store, "openai").has_key, "{content}");
        }
        assert!(info(&store, "custom").has_key == false);
        for body in [
            json!({}),
            json!({ "key": 5 }),
            json!({ "key": "   " }),
            json!({ "key": "two words" }),
            json!({ "key": "ключ" }),
            json!({ "key": "a".repeat(4097) }),
            json!("k"),
        ] {
            assert_eq!(
                parse_api_key(&body).unwrap_err().code,
                "invalid_request",
                "{body}"
            );
        }
        assert_eq!(parse_api_key(&json!({ "key": " \n sk-1 \t" })).unwrap(), "sk-1");
        assert_eq!(store.set_api_key("nope", "k").unwrap_err().status(), 404);
        assert_eq!(store.remove_api_key("nope").unwrap_err().code, "not_found");
    }

    #[test]
    fn provider_settings_keep_unknown_keys_and_forget_empty_overrides() {
        let dir = dir("providers");
        std::fs::write(
            dir.join("providers.json"),
            serde_json::to_string_pretty(&json!({
                "schema": "openvids.voice-providers/1",
                "futureTopLevel": { "a": 1 },
                "providers": {
                    "openai": { "model": "tts-1", "futureField": [1, 2], "agentRules": "be calm" },
                    "elevenlabs": { "model": "eleven_v3", "note": "x" },
                    "later": { "model": "z" }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let store = VoiceStore::new(&dir);
        assert_eq!(info(&store, "openai").model, "tts-1");
        assert_eq!(info(&store, "openai").agent_rules, "be calm");
        let updated = store
            .update_provider(
                "openai",
                &ProviderUpdate {
                    agent_rules: Some("whisper at the end".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.model, "tts-1");
        assert_eq!(updated.agent_rules, "whisper at the end");
        // An empty value forgets the override: the default model is back; the unknown keys stay.
        store
            .update_provider(
                "elevenlabs",
                &ProviderUpdate {
                    model: Some(String::new()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(info(&store, "elevenlabs").model, "eleven_v4");
        let stored = read_json(&dir.join("providers.json"));
        assert_eq!(stored["futureTopLevel"], json!({ "a": 1 }));
        assert_eq!(stored["providers"]["openai"]["futureField"], json!([1, 2]));
        assert_eq!(stored["providers"]["elevenlabs"], json!({ "note": "x" }));
        assert_eq!(stored["providers"]["later"], json!({ "model": "z" }));
        // An entry with nothing left is dropped.
        store
            .update_provider(
                "gemini",
                &ProviderUpdate {
                    model: Some("m".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .update_provider(
                "gemini",
                &ProviderUpdate {
                    model: Some(String::new()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(read_json(&dir.join("providers.json"))["providers"]
            .get("gemini")
            .is_none());
        #[cfg(unix)]
        assert_eq!(mode_of(&dir.join("providers.json")), 0o644);
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn the_custom_server_needs_an_address_and_a_model_and_the_others_refuse_them() {
        let dir = dir("custom");
        let store = VoiceStore::new(&dir);
        let update = |base: Option<&str>, model: Option<&str>, voice: Option<&str>| ProviderUpdate {
            base_url: base.map(String::from),
            model: model.map(String::from),
            voice: voice.map(String::from),
            ..Default::default()
        };
        assert!(
            !store
                .update_provider("custom", &update(Some("http://127.0.0.1:8880/v1"), None, None))
                .unwrap()
                .configured
        );
        let ready = store
            .update_provider("custom", &update(None, Some("kokoro"), Some("af_heart")))
            .unwrap();
        assert!(ready.configured, "no key needed");
        assert_eq!(
            (
                ready.base_url.as_str(),
                ready.model.as_str(),
                ready.voice.as_str()
            ),
            ("http://127.0.0.1:8880/v1", "kokoro", "af_heart")
        );
        assert!(!ready.has_key && !ready.key_required);
        for id in ["gemini", "openai", "openrouter", "elevenlabs"] {
            let err = store
                .update_provider(id, &update(Some("http://127.0.0.1:1"), None, None))
                .unwrap_err();
            assert_eq!(err.code, "invalid_request", "{id} keeps its address");
            assert_eq!(
                store
                    .update_provider(id, &update(None, None, Some("v")))
                    .unwrap_err()
                    .code,
                "invalid_request"
            );
        }
        assert_eq!(
            info(&store, "gemini").base_url,
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(info(&store, "gemini").voice, "");
        // A stored address on a built-in (a hand-edited file) does not move it.
        let mut raw = read_json(&dir.join("providers.json"));
        raw["providers"]["openai"] = json!({ "baseUrl": "https://evil.example/v1" });
        std::fs::write(dir.join("providers.json"), raw.to_string()).unwrap();
        assert_eq!(info(&store, "openai").base_url, "https://api.openai.com/v1");
        // Built-ins are configured by a key alone; OpenRouter's note follows its model.
        assert!(!info(&store, "openrouter").configured);
        store.set_api_key("openrouter", "or-key").unwrap();
        assert!(info(&store, "openrouter").configured);
        let other = store
            .update_provider("openrouter", &update(None, Some("openai/gpt-4o-mini-tts"), None))
            .unwrap();
        assert!(other.notes.is_empty());
    }

    #[test]
    fn provider_update_bodies_follow_the_protocol_parser() {
        let ok = |body: Value| parse_provider_update(&body).unwrap();
        let bad = |body: Value| parse_provider_update(&body).unwrap_err().code;
        assert_eq!(ok(json!({})), ProviderUpdate::default());
        assert_eq!(
            ok(json!({ "model": "  m  ", "voice": " v " })).model.as_deref(),
            Some("m")
        );
        assert_eq!(
            ok(json!({ "baseUrl": "https://example.com/v1" }))
                .base_url
                .as_deref(),
            Some("https://example.com/v1")
        );
        assert_eq!(ok(json!({ "baseUrl": "" })).base_url.as_deref(), Some(""));
        assert_eq!(
            ok(json!({ "baseUrl": "http://localhost:1234" }))
                .base_url
                .as_deref(),
            Some("http://localhost:1234")
        );
        // Trailing slashes are dropped, as the Studio store does.
        assert_eq!(
            ok(json!({ "baseUrl": "http://127.0.0.1:8880/v1//" })).base_url.as_deref(),
            Some("http://127.0.0.1:8880/v1")
        );
        for body in [
            json!([]),
            json!(null),
            json!({ "model": 1 }),
            json!({ "model": "m".repeat(201) }),
            json!({ "agentRules": "r".repeat(4001) }),
            json!({ "baseUrl": "not a url" }),
            json!({ "baseUrl": "ftp://example.com" }),
            json!({ "baseUrl": "file:///etc/passwd" }),
            json!({ "baseUrl": "https://user:pw@example.com" }),
            json!({ "baseUrl": "https://user@example.com" }),
            json!({ "baseUrl": "https://example.com/v1?key=secret" }),
            json!({ "baseUrl": "https://example.com/v1#frag" }),
            json!({ "baseUrl": "http://127.0.0.1:8880/v1?" }),
        ] {
            assert_eq!(bad(body.clone()), "invalid_request", "{body}");
        }
    }

    #[test]
    fn an_unreadable_providers_file_is_the_defaults_and_is_backed_up_before_it_is_replaced() {
        let dir = dir("providers-bad");
        std::fs::write(dir.join("providers.json"), "{ broken").unwrap();
        let store = VoiceStore::new(&dir);
        assert_eq!(info(&store, "openai").model, "gpt-4o-mini-tts");
        store
            .update_provider(
                "openai",
                &ProviderUpdate {
                    model: Some("tts-1".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("providers.json.bak")).unwrap(),
            "{ broken"
        );
        assert_eq!(info(&store, "openai").model, "tts-1");
        assert_eq!(
            read_json(&dir.join("providers.json"))["schema"],
            "openvids.voice-providers/1"
        );
    }

    fn preset(id: &str, name: &str) -> Value {
        json!({
            "id": id, "name": name, "providerId": "gemini", "model": "gemini-3.8-flash-tts",
            "voice": { "id": "Kore", "name": "Kore", "kind": "prebuilt" }, "style": "", "settings": {},
            "sample": null, "createdAt": 1, "updatedAt": 1, "futurePresetField": true
        })
    }

    #[test]
    fn presets_are_listed_renamed_and_deleted_and_keep_what_this_code_does_not_know() {
        let dir = dir("presets");
        let store = VoiceStore::new(&dir);
        assert!(store.presets().is_empty());
        assert_eq!(store.rename_preset("a", "x").unwrap_err().status(), 404);
        std::fs::write(
            dir.join("presets.json"),
            serde_json::to_string_pretty(&json!({
                "schema": "openvids.voice-presets/1",
                "futureTopLevel": 7,
                "presets": [preset("a", "Narrator"), "junk", { "name": "no id" }, preset("b", "Intro")]
            }))
            .unwrap(),
        )
        .unwrap();
        let listed = store.presets();
        assert_eq!(
            listed
                .iter()
                .map(|p| p["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["Narrator", "Intro"]
        );

        let name = parse_preset_name(&json!({ "name": "  Calm narrator " })).unwrap();
        let renamed = store.rename_preset("a", &name).unwrap();
        assert_eq!(renamed["name"], "Calm narrator");
        assert!(renamed["updatedAt"].as_u64().unwrap() > 1);
        assert_eq!(renamed["futurePresetField"], true);
        let stored = read_json(&dir.join("presets.json"));
        assert_eq!(stored["futureTopLevel"], 7);
        assert_eq!(
            stored["presets"].as_array().unwrap().len(),
            4,
            "entries it does not list are kept"
        );
        assert_eq!(stored["presets"][3]["name"], "Intro");

        store.delete_preset("a").unwrap();
        assert_eq!(store.presets().len(), 1);
        assert_eq!(store.delete_preset("a").unwrap_err().code, "not_found");
        let stored = read_json(&dir.join("presets.json"));
        assert_eq!(stored["futureTopLevel"], 7);
        assert_eq!(stored["presets"].as_array().unwrap().len(), 3);
        #[cfg(unix)]
        assert_eq!(mode_of(&dir.join("presets.json")), 0o644);
    }

    #[test]
    fn an_unreadable_presets_file_is_empty_and_never_overwritten() {
        let dir = dir("presets-bad");
        let store = VoiceStore::new(&dir);
        for content in [
            "nope",
            "{}",
            r#"{"schema":"openvids.voice-presets/1","presets":{}}"#,
        ] {
            std::fs::write(dir.join("presets.json"), content).unwrap();
            assert!(store.presets().is_empty());
            assert_eq!(store.delete_preset("a").unwrap_err().code, "not_found");
            assert_eq!(store.rename_preset("a", "n").unwrap_err().code, "not_found");
            assert_eq!(
                std::fs::read_to_string(dir.join("presets.json")).unwrap(),
                content
            );
        }
    }

    #[test]
    fn preset_names_are_trimmed_and_bounded() {
        assert_eq!(
            parse_preset_name(&json!({ "name": " Voice 1 " })).unwrap(),
            "Voice 1"
        );
        assert_eq!(
            parse_preset_name(&json!({ "name": "я".repeat(80) }))
                .unwrap()
                .chars()
                .count(),
            80
        );
        for body in [
            json!({}),
            json!({ "name": 1 }),
            json!({ "name": "  " }),
            json!({ "name": "n".repeat(81) }),
            json!(null),
        ] {
            assert_eq!(
                parse_preset_name(&body).unwrap_err().code,
                "invalid_request",
                "{body}"
            );
        }
    }

    #[test]
    fn audio_is_served_only_for_a_well_formed_hash_with_a_complete_entry() {
        let dir = dir("audio");
        let store = VoiceStore::new(&dir);
        let hash = "ab".repeat(32);
        let other = "cd".repeat(32);
        let third = "ef".repeat(32);
        std::fs::create_dir_all(dir.join("cache")).unwrap();
        std::fs::write(dir.join("cache").join(format!("{hash}.wav")), b"RIFFwav").unwrap();
        // Audio without its metadata is not an entry yet.
        assert!(store.audio(&hash).is_none());
        std::fs::write(dir.join("cache").join(format!("{hash}.json")), "{}").unwrap();
        assert_eq!(store.audio(&hash), Some(("audio/wav", b"RIFFwav".to_vec())));
        std::fs::write(dir.join("cache").join(format!("{other}.mp3")), b"ID3").unwrap();
        std::fs::write(dir.join("cache").join(format!("{other}.json")), "{}").unwrap();
        assert_eq!(store.audio(&other), Some(("audio/mpeg", b"ID3".to_vec())));
        assert!(store.audio(&third).is_none());
        // Anything that is not 64 lowercase hex characters never touches the disk.
        std::fs::write(dir.join("secret.json"), "{}").unwrap();
        std::fs::write(dir.join("secret.wav"), "x").unwrap();
        for bad in [
            "",
            "secret",
            "../secret",
            &hash[..63],
            &format!("{hash}0"),
            &hash.to_uppercase(),
            &format!("{}/../../secret", &hash[..40]),
            "g".repeat(64).as_str(),
        ] {
            assert!(store.audio(bad).is_none(), "{bad}");
            assert!(!is_cache_hash(bad), "{bad}");
        }
        assert!(is_cache_hash(&hash));
    }
}
