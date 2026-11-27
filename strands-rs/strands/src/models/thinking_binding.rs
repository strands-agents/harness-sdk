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
/// A caller-set `block_binding` is left as written. Without a config, adaptive thinking is added,
/// since these models think adaptively by default and some reject a config without a type; a
/// forced tool rules thinking out.
pub(crate) fn thinking_with_drop_block(thinking: Option<&JsonValue>, tool_forced: bool) -> Option<JsonObject> {
    let mut thinking = match thinking.filter(|thinking| !thinking.is_null()) {
        Some(thinking) => thinking.as_object()?.clone(),
        None if tool_forced => return None,
        None => serde_json::Map::from_iter([("type".to_owned(), serde_json::json!("adaptive"))]),
    };
    if thinking.contains_key("block_binding") {
        return None;
    }
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
            JsonValue::Object(thinking_with_drop_block(Some(&thinking), false).unwrap()),
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
        assert_eq!(thinking_with_drop_block(Some(&bound), false), None);
        assert_eq!(thinking_with_drop_block(Some(&json!("enabled")), false), None);
        assert_eq!(thinking_with_drop_block(Some(&json!([1])), false), None);
    }

    #[test]
    fn adds_adaptive_thinking_without_a_config_unless_a_tool_is_forced() {
        let adaptive = json!({"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}});
        assert_eq!(
            thinking_with_drop_block(None, false).map(JsonValue::Object),
            Some(adaptive.clone())
        );
        assert_eq!(
            thinking_with_drop_block(Some(&JsonValue::Null), false).map(JsonValue::Object),
            Some(adaptive)
        );
        assert_eq!(thinking_with_drop_block(None, true), None);
    }

    #[test]
    fn detects_the_binding_error_text() {
        assert!(is_thinking_binding_error(
            "thinking block is bound to a different conversation prefix"
        ));
        assert!(!is_thinking_binding_error("some other validation error"));
    }
}
