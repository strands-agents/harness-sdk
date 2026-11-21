use super::*;
use crate::types::Effort;

#[test]
fn reads_data_equal_to_the_shared_file() {
    let shared = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../shared/model-info.json")).unwrap();
    assert_eq!(MODEL_INFO_JSON, shared);
}

#[test]
fn resolves_each_id_form_to_its_entry() {
    for model_id in [
        "claude-opus-5-5",
        "global.anthropic.claude-opus-5-5",
        "us.anthropic.claude-opus-5-5-20260401-v1:0",
        "arn:aws:bedrock:us-west-2:123:inference-profile/global.anthropic.claude-opus-5-5",
    ] {
        let entry = lookup_model(model_id);
        assert!(std::ptr::eq(entry, lookup_model("claude-opus-5-5")), "{model_id}");
        assert_eq!(entry.limits.max_output_tokens, Some(128_000), "{model_id}");
        assert_eq!(
            entry.capabilities.default_effort.as_deref(),
            Some("medium"),
            "{model_id}"
        );
    }
}

#[test]
fn has_an_empty_entry_for_an_unknown_model() {
    assert_eq!(lookup_model("unknown-model"), &ModelEntry::default());
    assert_eq!(lookup_model("toString"), &ModelEntry::default());
}

#[test]
fn gives_every_default_effort_as_an_effort_level() {
    for (id, entry) in MODELS.iter() {
        let Some(level) = &entry.capabilities.default_effort else {
            continue;
        };
        let effort: Effort = level.parse().unwrap_or_else(|_| panic!("{id}: {level}"));
        assert!(!matches!(effort, Effort::Auto | Effort::Off), "{id}: {level}");
    }
}

#[cfg(feature = "anthropic")]
#[test]
fn matches_each_id_to_the_same_entry_as_the_sdk() {
    use strands::models::{AnthropicModel, AnthropicModelOptions, Model};

    for model_id in [
        "claude-opus-5-5",
        "us.anthropic.claude-opus-5-5-20260401-v1:0",
        "arn:aws:bedrock:us-west-2:123:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "claude-haiku-4-5@20251001",
        "anthropic.claude-3-5-haiku-20241022-v2:0",
        "openai.gpt-6.1-sol",
        "global.openai.gpt-6-astra",
        "amazon.nova-pro-v1:0",
        "gemini-3.5-flash",
        "unknown-model",
    ] {
        let sdk = AnthropicModel::new(AnthropicModelOptions {
            model_id: Some(model_id.to_owned()),
            api_key: Some("test".to_owned()),
            ..Default::default()
        })
        .unwrap()
        .model_info();
        assert_eq!(
            lookup_model(model_id).limits.max_output_tokens,
            sdk.limits.max_output_tokens,
            "{model_id}"
        );
    }
}
