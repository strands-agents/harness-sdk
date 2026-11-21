//! The shared model info (`shared/model-info.json`), read directly for the fields the harness
//! uses: the output-token ceiling and the vendor's default reasoning level. `build.rs` embeds it.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

const MODEL_INFO_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/model-info.json"));

/// The `limits` fields the harness reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelLimits {
    pub(crate) max_output_tokens: Option<u64>,
}

/// The `capabilities` fields the harness reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCapabilities {
    pub(crate) default_effort: Option<String>,
}

/// One model's entry (`ModelEntry`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub(crate) struct ModelEntry {
    #[serde(default)]
    pub(crate) limits: ModelLimits,
    #[serde(default)]
    pub(crate) capabilities: ModelCapabilities,
}

#[derive(Deserialize)]
struct ModelInfoData {
    models: HashMap<String, ModelEntry>,
}

static MODELS: LazyLock<HashMap<String, ModelEntry>> = LazyLock::new(|| {
    serde_json::from_str::<ModelInfoData>(MODEL_INFO_JSON).map_or_else(
        |error| {
            tracing::error!("error=<{error}> | embedded model info data is invalid | using no model info");
            HashMap::new()
        },
        |data| data.models,
    )
});

static EMPTY: LazyLock<ModelEntry> = LazyLock::new(ModelEntry::default);

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Strips a trailing Bedrock version suffix (`-v1:0`, `-v2`, `-1:0`).
fn strip_version_suffix(model_id: &str) -> &str {
    let Some((head, tail)) = model_id.rsplit_once('-') else {
        return model_id;
    };
    let is_version = match tail.strip_prefix('v') {
        Some(version) => match version.split_once(':') {
            Some((major, minor)) => all_digits(major) && all_digits(minor),
            None => all_digits(version),
        },
        None => tail
            .split_once(':')
            .is_some_and(|(major, minor)| all_digits(major) && all_digits(minor)),
    };
    if is_version { head } else { model_id }
}

/// Strips a trailing snapshot date (`-20260401`, `@20251001`).
fn strip_date_suffix(model_id: &str) -> &str {
    let bytes = model_id.as_bytes();
    let Some(start) = bytes.len().checked_sub(9) else {
        return model_id;
    };
    let dated = matches!(bytes[start], b'-' | b'@') && bytes[start + 1..].iter().all(u8::is_ascii_digit);
    if dated { &model_id[..start] } else { model_id }
}

/// The model's entry, matched by the SDK's rule (version suffix, date, leading segments); empty
/// when unknown.
pub(crate) fn lookup_model(model_id: &str) -> &'static ModelEntry {
    let mut candidate = model_id;
    loop {
        let unversioned = strip_version_suffix(candidate);
        let keys = [candidate, unversioned, strip_date_suffix(unversioned)];
        if let Some(entry) = keys.iter().find_map(|key| MODELS.get(*key)) {
            return entry;
        }
        let Some((_, rest)) = candidate.split_once('.') else {
            return &EMPTY;
        };
        candidate = rest;
    }
}

#[cfg(test)]
mod tests;
