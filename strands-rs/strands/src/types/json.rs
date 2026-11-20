//! JSON aliases.

use serde::{Deserialize, Deserializer};

/// Any JSON value.
pub type JsonValue = serde_json::Value;

/// A JSON object with string keys, in insertion order.
pub type JsonObject = serde_json::Map<String, JsonValue>;

/// A JSON Schema document kept as raw JSON.
///
/// Not re-exported at the crate root: `use strands::*` or `use strands::JsonSchema` next to
/// `schemars::JsonSchema` would clash with the derive that structured output and `#[tool]` inputs
/// use. Name it as `strands::types::JsonSchema`.
pub type JsonSchema = JsonValue;

/// Deserializes an optional JSON field so that a present `null` is `Some(JsonValue::Null)`.
///
/// An explicit `null` is a value, not an absent field, so `{"response": null}` must survive a
/// round trip. Use with `#[serde(default, deserialize_with = "...")]`.
pub(crate) fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<JsonValue>, D::Error> {
    JsonValue::deserialize(deserializer).map(Some)
}
