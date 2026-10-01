//! Failures the home server reports to the Projects page.
//!
//! The English sentence stays in `error` (it is what a log or a client that knows nothing else shows). `code`
//! is a stable snake_case id of that sentence and `params` holds the names and paths it mentions, so the page
//! can translate the message (`OV.describeError` looks up `home.error.<code>` in the locale catalog and fills
//! the params in). A failure that carries text from outside OpenVids (a tool's stderr, an OS error) has no
//! code, or keeps that text in a param.

use serde_json::{json, Value};

/// A failure with a message and, when the page can translate it, a code and params.
#[derive(Debug, Clone, PartialEq)]
pub struct CodedError {
    pub code: Option<&'static str>,
    pub message: String,
    pub params: Value,
}

impl CodedError {
    pub fn new(code: &'static str, message: impl Into<String>, params: Value) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
            params,
        }
    }

    /// A coded failure whose sentence mentions nothing.
    pub fn plain(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message, json!({}))
    }

    /// A failure with text the page shows as it is (a tool's own output).
    pub fn uncoded(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
            params: json!({}),
        }
    }

    /// The JSON body of an error response: `{ error, code?, params? }`.
    pub fn body(&self) -> Value {
        match self.code {
            Some(code) => error_body(code, &self.message, self.params.clone()),
            None => json!({ "error": self.message }),
        }
    }
}

impl std::fmt::Display for CodedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CodedError {}

/// `{ "error": message, "code": code, "params": params }`.
pub fn error_body(code: &str, message: &str, params: Value) -> Value {
    json!({ "error": message, "code": code, "params": params })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_coded_error_keeps_its_sentence_and_adds_code_and_params() {
        let err = CodedError::new("folder_missing", "/x no longer exists", json!({ "path": "/x" }));
        assert_eq!(
            err.body(),
            json!({ "error": "/x no longer exists", "code": "folder_missing", "params": { "path": "/x" } })
        );
    }

    #[test]
    fn an_uncoded_error_is_just_its_text() {
        assert_eq!(CodedError::uncoded("boom").body(), json!({ "error": "boom" }));
    }
}
