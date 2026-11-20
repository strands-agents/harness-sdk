//! Recovery for replayed thinking blocks that a history edit invalidated.
//!
//! Preserved-thinking Claude models bind each thinking block to the content before it. When that
//! content changes, enforcing accounts reject the request unless it asks the API to drop the stale
//! blocks.

#![cfg_attr(
    not(any(feature = "bedrock", feature = "anthropic")),
    allow(dead_code, reason = "the providers that replay thinking use these helpers")
)]

use crate::types::{JsonObject, JsonValue};

/// Beta that lets a request drop thinking blocks invalidated by an edit to the history before
/// them (`THINKING_BINDING_BETA`).
pub(crate) const THINKING_BINDING_BETA: &str = "thinking-binding-controls-2026-08-01";

const THINKING_BINDING_ERROR: &str = "bound to a different conversation";

/// Whether the provider rejected a replayed thinking block because history before it changed.
pub(crate) fn is_thinking_binding_error(message: &str) -> bool {
    message.contains(THINKING_BINDING_ERROR)
}

/// The thinking config with stale blocks dropped, or `None` if it cannot or should not change.
/// A caller-set `block_binding` is left as written.
pub(crate) fn thinking_with_drop_block(thinking: Option<&JsonValue>) -> Option<JsonObject> {
    let thinking = thinking?.as_object()?;
    if thinking.contains_key("block_binding") {
        return None;
    }
    let mut thinking = thinking.clone();
    thinking.insert(
        "block_binding".to_owned(),
        serde_json::json!({"prefix_mismatch_behavior": "drop_block"}),
    );
    Some(thinking)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn adds_drop_block_to_a_thinking_object() {
        let thinking = json!({"type": "enabled", "budget_tokens": 1024});
        assert_eq!(
            JsonValue::Object(thinking_with_drop_block(Some(&thinking)).unwrap()),
            json!({
                "type": "enabled",
                "budget_tokens": 1024,
                "block_binding": {"prefix_mismatch_behavior": "drop_block"}
            })
        );
    }

    #[test]
    fn leaves_a_caller_set_block_binding_and_non_objects_unchanged() {
        let bound = json!({"type": "enabled", "block_binding": {"prefix_mismatch_behavior": "error"}});
        assert_eq!(thinking_with_drop_block(Some(&bound)), None);
        assert_eq!(thinking_with_drop_block(Some(&json!("enabled"))), None);
        assert_eq!(thinking_with_drop_block(Some(&json!([1]))), None);
        assert_eq!(thinking_with_drop_block(None), None);
    }

    #[test]
    fn detects_the_binding_error_text() {
        assert!(is_thinking_binding_error(
            "thinking block is bound to a different conversation prefix"
        ));
        assert!(!is_thinking_binding_error("some other validation error"));
    }
}
