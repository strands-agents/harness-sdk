//! The no-op tool spec.

use std::sync::LazyLock;

use serde_json::json;

use crate::types::ToolSpec;

/// A tool spec that tells the model to ignore it (`NOOP_TOOL_SPEC`).
///
/// Some providers (Bedrock) require a tool configuration whenever messages contain tool use or
/// tool result blocks; providers add this spec to satisfy that without changing behaviour.
#[allow(
    dead_code,
    reason = "only the Bedrock provider adds it; unused without the bedrock feature"
)]
pub(crate) static NOOP_TOOL_SPEC: LazyLock<ToolSpec> = LazyLock::new(|| {
    ToolSpec::new("noop", "This is a fake tool that MUST be completely ignored.")
        .with_input_schema(json!({"type": "object", "properties": {}}))
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_ts_spec() {
        assert_eq!(
            serde_json::to_value(&*NOOP_TOOL_SPEC).unwrap(),
            json!({
                "name": "noop",
                "description": "This is a fake tool that MUST be completely ignored.",
                "inputSchema": {"type": "object", "properties": {}}
            })
        );
    }
}
