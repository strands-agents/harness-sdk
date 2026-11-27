//! Default values for model providers.
//!
//! These defaults can change between versions; set values explicitly on model configurations to
//! pin behavior across upgrades.

#![allow(dead_code, reason = "the model providers read these defaults")]

/// Defaults for one provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProviderDefaults {
    /// The model id used when none is configured.
    pub(crate) model_id: &'static str,
    /// The `max_tokens` used when none is configured, for providers that require one.
    pub(crate) max_tokens: Option<u64>,
    /// The region used when none is configured, for providers that need one.
    pub(crate) region: Option<&'static str>,
}

/// Defaults per provider (`MODEL_DEFAULTS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ModelDefaults {
    pub(crate) anthropic: ProviderDefaults,
    pub(crate) bedrock: ProviderDefaults,
    pub(crate) openai: ProviderDefaults,
}

/// Defaults for the vended providers (`MODEL_DEFAULTS`).
pub(crate) const MODEL_DEFAULTS: ModelDefaults = ModelDefaults {
    anthropic: ProviderDefaults {
        model_id: "claude-sonnet-4-6",
        max_tokens: Some(64_000),
        region: None,
    },
    bedrock: ProviderDefaults {
        model_id: "global.anthropic.claude-sonnet-4-6",
        max_tokens: None,
        region: Some("us-west-2"),
    },
    openai: ProviderDefaults {
        model_id: "gpt-5.4",
        max_tokens: None,
        region: None,
    },
};

/// The warning logged when the default model id is used.
pub(crate) fn default_model_warning_message(default_model_id: &str) -> String {
    format!(
        "model_id=<{default_model_id}> | using default modelId, which is subject to change | set modelId explicitly to pin the value"
    )
}

/// The warning logged when the default max tokens value is used.
pub(crate) fn default_max_tokens_warning_message(default_max_tokens: u64) -> String {
    format!(
        "max_tokens=<{default_max_tokens}> | using default maxTokens, which is subject to change | set maxTokens explicitly to pin the value"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_ts_values() {
        assert_eq!(MODEL_DEFAULTS.anthropic.model_id, "claude-sonnet-4-6");
        assert_eq!(MODEL_DEFAULTS.anthropic.max_tokens, Some(64_000));
        assert_eq!(MODEL_DEFAULTS.bedrock.model_id, "global.anthropic.claude-sonnet-4-6");
        assert_eq!(MODEL_DEFAULTS.bedrock.region, Some("us-west-2"));
        assert_eq!(MODEL_DEFAULTS.openai.model_id, "gpt-5.4");
    }

    #[test]
    fn warning_messages_use_the_ts_text() {
        assert_eq!(
            default_model_warning_message("gpt-5.4"),
            "model_id=<gpt-5.4> | using default modelId, which is subject to change | set modelId explicitly to pin the value"
        );
        assert_eq!(
            default_max_tokens_warning_message(64_000),
            "max_tokens=<64000> | using default maxTokens, which is subject to change | set maxTokens explicitly to pin the value"
        );
    }
}
