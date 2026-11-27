//! Construction, model info, the `max_tokens` default, and config update and read tests.

use serde_json::json;

use super::*;
use crate::models::bedrock::{BedrockModelOptions, construction_warnings};

use crate::models::{
    BaseModelConfig, CacheConfig, CacheStrategy, ModelCapabilities, ModelInfo, ModelLimits, PromptCaching,
};
use crate::types::InjectedBlock;

fn config(model_id: &str, max_tokens: Option<u64>, context_window_limit: Option<u64>) -> BedrockModelConfig {
    BedrockModelConfig {
        model_id: Some(model_id.to_owned()),
        max_tokens,
        context_window_limit,
        ..BedrockModelConfig::default()
    }
}

fn limits(context_window: Option<u64>, max_output_tokens: Option<u64>) -> ModelInfo {
    ModelInfo {
        limits: ModelLimits {
            context_window,
            max_output_tokens,
        },
        ..ModelInfo::default()
    }
}

fn caching(prompt_caching: PromptCaching) -> ModelInfo {
    ModelInfo {
        capabilities: ModelCapabilities {
            prompt_caching: Some(prompt_caching),
            ..ModelCapabilities::default()
        },
        ..ModelInfo::default()
    }
}

fn auto_cache() -> Option<CacheConfig> {
    Some(CacheConfig {
        strategy: Some(CacheStrategy::Auto),
        ..CacheConfig::default()
    })
}

fn helpful() -> Options {
    Options {
        system_prompt: Some("Be helpful".into()),
        ..Options::default()
    }
}

#[test]
fn creates_an_instance_with_default_configuration() {
    let (model, _) = provider(BedrockModelConfig::default());
    assert!(model.config().model_id.is_some());
}

#[test]
fn warns_when_model_id_is_not_explicitly_set() {
    let warnings = construction_warnings(&BedrockModelConfig::default());
    assert!(
        warnings.iter().any(|warning| warning.contains("using default modelId")),
        "{warnings:?}"
    );
}

#[test]
fn does_not_warn_when_model_id_is_explicitly_set() {
    let warnings = construction_warnings(&with_model_id("us.anthropic.claude-3-5-sonnet-20241022-v2:0"));
    assert!(
        !warnings.iter().any(|warning| warning.contains("using default modelId")),
        "{warnings:?}"
    );
}

#[test]
fn uses_provided_model_id() {
    let (model, _) = provider(with_model_id("us.anthropic.claude-3-5-sonnet-20241022-v2:0"));
    assert_eq!(
        model.config(),
        config(
            "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
            Some(8192),
            Some(200_000)
        )
    );
}

#[test]
fn does_not_include_api_key_in_model_config() {
    let model = BedrockModel::builder()
        .temperature(0.5)
        .region("us-east-1")
        .api_key("br-test-key")
        .build();
    let mut expected = config("global.anthropic.claude-sonnet-4-6", Some(128_000), Some(1_000_000));
    expected.temperature = Some(0.5);
    assert_eq!(model.config(), expected);
    assert!(!format!("{model:?}").contains("br-test-key"));
}

#[test]
fn includes_context_window_limit_in_config_when_provided() {
    let (model, _) = provider(config("anthropic.claude-sonnet-4-6", None, Some(200_000)));
    assert_eq!(
        model.config(),
        config("anthropic.claude-sonnet-4-6", Some(128_000), Some(200_000))
    );
}

#[test]
fn auto_populates_context_window_limit_from_model_id_lookup() {
    let (model, _) = provider(with_model_id("anthropic.claude-sonnet-4-6"));
    assert_eq!(
        model.config(),
        config("anthropic.claude-sonnet-4-6", Some(128_000), Some(1_000_000))
    );
}

#[test]
fn auto_populates_context_window_limit_for_cross_region_model_ids() {
    let (model, _) = provider(with_model_id("us.anthropic.claude-sonnet-4-6"));
    assert_eq!(
        model.config(),
        config("us.anthropic.claude-sonnet-4-6", Some(128_000), Some(1_000_000))
    );
}

#[test]
fn auto_populates_context_window_limit_for_default_model_id() {
    let (model, _) = provider(BedrockModelConfig::default());
    assert_eq!(
        model.config(),
        config("global.anthropic.claude-sonnet-4-6", Some(128_000), Some(1_000_000))
    );
}

#[test]
fn auto_populates_context_window_limit_from_the_model_info_override_over_the_shared_value() {
    let (model, _) = provider(BedrockModelConfig {
        model_info: Some(limits(Some(500_000), None)),
        ..with_model_id("anthropic.claude-sonnet-4-6")
    });
    assert_eq!(model.config().context_window_limit, Some(500_000));
    assert_eq!(model.model_info().limits.context_window, Some(500_000));
}

#[test]
fn does_not_override_explicit_context_window_limit() {
    let (model, _) = provider(config("anthropic.claude-sonnet-4-6", None, Some(100_000)));
    assert_eq!(
        model.config(),
        config("anthropic.claude-sonnet-4-6", Some(128_000), Some(100_000))
    );
}

#[test]
fn leaves_context_window_limit_undefined_for_unknown_model_ids() {
    let (model, _) = provider(with_model_id("unknown.model-v1:0"));
    assert_eq!(model.config(), with_model_id("unknown.model-v1:0"));
}

#[test]
fn reads_cache_points_for_claude_model_ids_from_the_shared_model_info() {
    let (model, _) = provider(with_model_id("us.anthropic.claude-sonnet-4-6"));
    assert_eq!(
        model.model_info().capabilities.prompt_caching,
        Some(PromptCaching::CachePoints)
    );
}

#[test]
fn leaves_caching_unknown_for_other_model_ids() {
    let (model, _) = provider(with_model_id("meta.llama4-maverick-17b-instruct-v1:0"));
    assert_eq!(model.model_info().capabilities.prompt_caching, None);
}

#[tokio::test]
async fn auto_caches_an_unlisted_claude_id_by_name() {
    for model_id in [
        "anthropic.claude-future-9",
        "arn:aws:bedrock:us-east-1:123456789012:default-prompt-router/anthropic.claude:1",
        "US.ANTHROPIC.CLAUDE-SONNET-4-6",
    ] {
        let (model, transport) = provider(BedrockModelConfig {
            cache_config: auto_cache(),
            ..with_model_id(model_id)
        });
        run(&model, request(hello(), helpful())).await;
        assert_eq!(model.model_info().capabilities.prompt_caching, None, "{model_id}");
        assert_eq!(model.model_info().capabilities.server_side_summary, Some(false));
        assert_eq!(
            transport.last()["system"],
            json!([{"text": "Be helpful"}, {"cachePoint": {"type": "default"}}]),
            "{model_id}"
        );
    }
}

#[tokio::test]
async fn does_not_auto_cache_an_unlisted_id_that_is_not_claude() {
    let (model, transport) = provider(BedrockModelConfig {
        cache_config: auto_cache(),
        ..with_model_id("arn:aws:bedrock:us-east-1:123456789012:custom-model/acme.foo/abc")
    });
    run(&model, request(hello(), helpful())).await;
    assert_eq!(model.model_info().capabilities.prompt_caching, None);
    assert_eq!(model.model_info().capabilities.server_side_summary, Some(false));
    assert_eq!(transport.last()["system"], json!([{"text": "Be helpful"}]));
}

#[tokio::test]
async fn skips_an_injected_block_it_receives_with_a_warning() {
    let (model, transport) = provider(BedrockModelConfig {
        model_info: Some(ModelInfo {
            capabilities: ModelCapabilities {
                temporary_messages: Some(true),
                ..ModelCapabilities::default()
            },
            ..ModelInfo::default()
        }),
        ..with_model_id("us.anthropic.claude-opus-5-5")
    });
    let messages = vec![user(vec![
        ContentBlock::text("Hello"),
        ContentBlock::Injected(InjectedBlock::new("cwd: /repo", "env")),
    ])];
    let warning = "block_type=<injectedBlock> | bedrock does not send injected blocks | skipping it";
    crate::logging::forget_warning(warning);
    let (logs, _guard) = crate::test_support::record_logs();
    run(&model, request(messages, Options::default())).await;
    assert_eq!(transport.last()["messages"][0]["content"], json!([{"text": "Hello"}]));
    assert!(logs.text().contains(warning), "{}", logs.text());
}

fn auto_caching_warning(model_id: &str) -> String {
    format!("model_id=<{model_id}> | cache_config is enabled but this model does not support automatic caching")
}

#[tokio::test]
async fn reports_an_openai_gpt_or_xai_model_as_implicitly_cached_and_sends_no_cache_point() {
    for model_id in [
        "us.openai.gpt-6-luna",
        "openai.gpt-6.1-sol",
        "openai.gpt-5.6-sol",
        "us.xai.grok-4.7",
    ] {
        let (model, transport) = provider(BedrockModelConfig {
            cache_config: auto_cache(),
            ..with_model_id(model_id)
        });
        crate::logging::forget_warning(&auto_caching_warning(model_id));
        let (logs, guard) = crate::test_support::record_logs();
        run(&model, request(hello(), helpful())).await;
        drop(guard);
        assert_eq!(
            model.model_info().capabilities.prompt_caching,
            Some(PromptCaching::Auto),
            "{model_id}"
        );
        assert_eq!(
            transport.last()["system"],
            json!([{"text": "Be helpful"}]),
            "{model_id}"
        );
        assert_eq!(
            transport.last()["messages"][0]["content"],
            json!([{"text": "Hello"}]),
            "{model_id}"
        );
        assert!(
            !logs.text().contains("does not support automatic caching"),
            "{}",
            logs.text()
        );
    }
}

#[tokio::test]
async fn warns_that_gpt_oss_has_no_automatic_caching_and_sends_no_cache_point() {
    for model_id in ["openai.gpt-oss-120b-1:0", "us.openai.gpt-oss-20b-1:0"] {
        let (model, transport) = provider(BedrockModelConfig {
            cache_config: auto_cache(),
            ..with_model_id(model_id)
        });
        let warning = auto_caching_warning(model_id);
        crate::logging::forget_warning(&warning);
        let (logs, guard) = crate::test_support::record_logs();
        run(&model, request(hello(), helpful())).await;
        drop(guard);
        assert_eq!(model.model_info().capabilities.prompt_caching, None, "{model_id}");
        assert_eq!(
            transport.last()["system"],
            json!([{"text": "Be helpful"}]),
            "{model_id}"
        );
        assert_eq!(
            transport.last()["messages"][0]["content"],
            json!([{"text": "Hello"}]),
            "{model_id}"
        );
        assert!(logs.text().contains(&warning), "{}", logs.text());
    }
}

#[tokio::test]
async fn places_cache_points_on_an_implicitly_cached_openai_model_when_the_strategy_is_anthropic() {
    let (model, transport) = provider(BedrockModelConfig {
        cache_config: Some(CacheConfig {
            strategy: Some(CacheStrategy::Anthropic),
            ..CacheConfig::default()
        }),
        ..with_model_id("us.openai.gpt-6-luna")
    });
    run(&model, request(hello(), helpful())).await;
    assert_eq!(
        transport.last()["system"],
        json!([{"text": "Be helpful"}, {"cachePoint": {"type": "default"}}])
    );
}

#[test]
fn lets_a_model_info_override_win_over_implicit_caching_for_an_openai_model() {
    let (model, _) = provider(BedrockModelConfig {
        model_info: Some(caching(PromptCaching::CachePoints)),
        ..with_model_id("us.openai.gpt-6-luna")
    });
    assert_eq!(
        model.model_info().capabilities.prompt_caching,
        Some(PromptCaching::CachePoints)
    );
}

#[tokio::test]
async fn injects_auto_cache_points_on_a_model_the_info_override_says_takes_them() {
    let (model, transport) = provider(BedrockModelConfig {
        cache_config: auto_cache(),
        model_info: Some(caching(PromptCaching::CachePoints)),
        ..with_model_id("amazon.nova-pro-v1:0")
    });
    run(&model, request(hello(), helpful())).await;
    assert_eq!(
        transport.last()["system"],
        json!([{"text": "Be helpful"}, {"cachePoint": {"type": "default"}}])
    );
}

#[tokio::test]
async fn skips_auto_cache_points_on_a_claude_model_the_info_override_marks_unsupported() {
    let (model, transport) = provider(BedrockModelConfig {
        cache_config: auto_cache(),
        model_info: Some(caching(PromptCaching::Unsupported)),
        ..with_model_id("us.anthropic.claude-sonnet-4-6")
    });
    run(&model, request(hello(), helpful())).await;
    assert_eq!(transport.last()["system"], json!([{"text": "Be helpful"}]));
}

async fn sent_inference_config(config: BedrockModelConfig) -> JsonValue {
    let (model, transport) = provider(config);
    run(&model, request(hello(), Options::default())).await;
    transport
        .last()
        .get("inferenceConfig")
        .cloned()
        .unwrap_or(JsonValue::Null)
}

#[tokio::test]
async fn defaults_max_tokens_to_the_model_info_output_ceiling_for() {
    let cases = [
        (
            "a listed model id",
            with_model_id("anthropic.claude-sonnet-4-6"),
            128_000,
        ),
        (
            "a cross-region model id",
            with_model_id("us.anthropic.claude-sonnet-4-6"),
            128_000,
        ),
        (
            "GPT-6.2 Astra on Bedrock",
            with_model_id("us.openai.gpt-6.2-astra"),
            128_000,
        ),
        (
            "GPT-6.2 Sol on Bedrock",
            with_model_id("global.openai.gpt-6.2-sol"),
            128_000,
        ),
        ("the SDK default model", BedrockModelConfig::default(), 128_000),
        (
            "an older Claude model",
            with_model_id("anthropic.claude-3-5-sonnet-20241022-v2:0"),
            8192,
        ),
        (
            "an inference profile ARN",
            with_model_id("arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6"),
            128_000,
        ),
    ];
    for (name, config, max_tokens) in cases {
        assert_eq!(
            sent_inference_config(config).await,
            json!({"maxTokens": max_tokens}),
            "{name}"
        );
    }
}

#[tokio::test]
async fn defaults_max_tokens_from_the_model_info_override() {
    let config = BedrockModelConfig {
        model_info: Some(limits(None, Some(2_000))),
        ..with_model_id("m1")
    };
    assert_eq!(sent_inference_config(config).await, json!({"maxTokens": 2_000}));
}

#[tokio::test]
async fn leaves_max_tokens_unset_for_a_model_the_shared_model_info_does_not_list() {
    let (model, _) = provider(with_model_id("unknown.model-v1:0"));
    assert_eq!(model.model_info().limits.max_output_tokens, None);
    assert_eq!(
        sent_inference_config(with_model_id("unknown.model-v1:0")).await,
        JsonValue::Null
    );
}

#[tokio::test]
async fn sends_an_explicit_max_tokens_over_the_model_info_output_ceiling() {
    let config = config("anthropic.claude-sonnet-4-6", Some(1), None);
    assert_eq!(sent_inference_config(config).await, json!({"maxTokens": 1}));
}

#[tokio::test]
async fn re_resolves_the_default_max_tokens_when_model_id_changes() {
    let (model, transport) = provider(with_model_id("anthropic.claude-sonnet-4-6"));
    model
        .update_config(with_model_id("anthropic.claude-haiku-4-5-20251001-v1:0"))
        .unwrap();
    run(&model, request(hello(), Options::default())).await;
    assert_eq!(transport.last()["inferenceConfig"], json!({"maxTokens": 64_000}));
}

#[tokio::test]
async fn does_not_cap_the_default_max_tokens_by_the_context_window_for() {
    let cases = [
        (
            "a 200k-window model",
            with_model_id("anthropic.claude-sonnet-4-5-20250929-v1:0"),
        ),
        (
            "a user-set contextWindowLimit",
            config("anthropic.claude-sonnet-4-5-20250929-v1:0", None, Some(100_000)),
        ),
    ];
    for (name, config) in cases {
        assert_eq!(
            sent_inference_config(config).await,
            json!({"maxTokens": 64_000}),
            "{name}"
        );
    }
}

#[test]
fn surfaces_the_default_max_tokens_in_get_config() {
    let (model, _) = provider(with_model_id("anthropic.claude-sonnet-4-6"));
    assert_eq!(model.config().max_tokens, Some(128_000));
    assert_eq!(model.get_config().max_tokens, Some(128_000));
}

#[test]
fn warns_once_when_max_tokens_is_defaulted() {
    let warnings = construction_warnings(&with_model_id("anthropic.claude-sonnet-4-6"));
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("max_tokens=<128000> | using default maxTokens")),
        "{warnings:?}"
    );
}

#[test]
fn does_not_warn_about_max_tokens_when() {
    let cases = [
        (
            "maxTokens is explicit",
            config("anthropic.claude-sonnet-4-6", Some(1), None),
        ),
        (
            "it is pinned through modelInfo",
            BedrockModelConfig {
                model_info: Some(limits(None, Some(2_000))),
                ..with_model_id("anthropic.claude-sonnet-4-6")
            },
        ),
        ("the model is unknown", with_model_id("unknown.model-v1:0")),
    ];
    for (name, config) in cases {
        let warnings = construction_warnings(&config);
        assert!(
            !warnings
                .iter()
                .any(|warning| warning.contains("using default maxTokens")),
            "{name}"
        );
    }
}

#[test]
fn merges_new_config_with_existing_config() {
    let (model, _) = provider(BedrockModelConfig {
        temperature: Some(0.5),
        ..BedrockModelConfig::default()
    });
    model
        .update_config(BedrockModelConfig {
            temperature: Some(0.8),
            max_tokens: Some(2048),
            ..BedrockModelConfig::default()
        })
        .unwrap();
    let mut expected = config("global.anthropic.claude-sonnet-4-6", Some(2048), Some(1_000_000));
    expected.temperature = Some(0.8);
    assert_eq!(model.config(), expected);
}

#[test]
fn preserves_fields_not_included_in_the_update() {
    let (model, _) = provider(BedrockModelConfig {
        temperature: Some(0.5),
        ..config("custom-model", Some(1024), None)
    });
    model
        .update_config(BedrockModelConfig {
            temperature: Some(0.8),
            ..BedrockModelConfig::default()
        })
        .unwrap();
    let mut expected = config("custom-model", Some(1024), None);
    expected.temperature = Some(0.8);
    assert_eq!(model.config(), expected);
}

#[test]
fn re_resolves_context_window_limit_when_model_id_changes_and_it_was_auto_resolved() {
    let (model, _) = provider(BedrockModelConfig::default());
    assert_eq!(model.config().context_window_limit, Some(1_000_000));
    model
        .update_config(BaseModelConfig {
            model_id: Some("anthropic.claude-haiku-4-5-20251001-v1:0".into()),
            ..BaseModelConfig::default()
        })
        .unwrap();
    assert_eq!(model.config().context_window_limit, Some(200_000));
}

#[test]
fn clears_context_window_limit_when_model_id_changes_to_unknown_model() {
    let (model, _) = provider(BedrockModelConfig::default());
    assert_eq!(model.config().context_window_limit, Some(1_000_000));
    model.update_config(with_model_id("my-custom-finetuned-model")).unwrap();
    assert_eq!(model.config().context_window_limit, None);
}

#[test]
fn preserves_explicit_context_window_limit_when_model_id_changes() {
    let (model, _) = provider(BedrockModelConfig {
        context_window_limit: Some(50_000),
        ..BedrockModelConfig::default()
    });
    assert_eq!(model.config().context_window_limit, Some(50_000));
    model
        .update_config(with_model_id("anthropic.claude-haiku-4-5-20251001-v1:0"))
        .unwrap();
    assert_eq!(model.config().context_window_limit, Some(50_000));
}

#[test]
fn returns_the_current_configuration() {
    let (model, _) = provider(BedrockModelConfig {
        temperature: Some(0.7),
        ..config("test-model", Some(1024), None)
    });
    let mut expected = config("test-model", Some(1024), None);
    expected.temperature = Some(0.7);
    assert_eq!(model.config(), expected);
    assert_eq!(
        model.get_config(),
        BaseModelConfig {
            model_id: Some("test-model".into()),
            max_tokens: Some(1024),
            temperature: Some(0.7),
            ..BaseModelConfig::default()
        }
    );
}

#[test]
fn update_config_merges_base_fields_and_keeps_bedrock_fields() {
    let (model, _) = provider(BedrockModelConfig {
        stop_sequences: Some(vec!["STOP".into()]),
        ..with_model_id("test-model")
    });
    model
        .update_config(BaseModelConfig {
            temperature: Some(0.2),
            ..BaseModelConfig::default()
        })
        .unwrap();
    let config = model.config();
    assert_eq!(config.temperature, Some(0.2));
    assert_eq!(config.stop_sequences, Some(vec!["STOP".to_owned()]));
    assert_eq!(config.model_id.as_deref(), Some("test-model"));
}

#[test]
fn default_bedrock_model_uses_the_default_model_id() {
    let model = crate::models::bedrock::default_bedrock_model();
    assert_eq!(model.model_id().as_deref(), Some("global.anthropic.claude-sonnet-4-6"));
}

#[test]
fn options_carry_the_config_fields_and_convert_from_a_config() {
    let options = BedrockModelOptions::builder()
        .model_id("m1")
        .strict_tools(true)
        .region("eu-west-1")
        .build_options();
    assert_eq!(
        options.to_config(),
        BedrockModelConfig {
            strict_tools: Some(true),
            ..with_model_id("m1")
        }
    );
    let from_config = BedrockModelOptions::from(with_model_id("m2"));
    assert_eq!(from_config.model_id.as_deref(), Some("m2"));
    assert_eq!(from_config.region, None);
}

/// Server-side summary is off for listed models unless the model info override sets it.
#[test]
fn keeps_a_server_side_summary_override_on_top() {
    let model_id = "us.anthropic.claude-sonnet-5-5-v1:0";
    let (model, _) = provider(with_model_id(model_id));
    assert_eq!(model.model_info().capabilities.server_side_summary, Some(false));
    let (model, _) = provider(BedrockModelConfig {
        model_info: Some(ModelInfo {
            capabilities: ModelCapabilities {
                server_side_summary: Some(true),
                ..ModelCapabilities::default()
            },
            ..ModelInfo::default()
        }),
        ..with_model_id(model_id)
    });
    assert_eq!(model.model_info().capabilities.server_side_summary, Some(true));
}

#[test]
fn clones_share_the_configuration() {
    let (model, _) = provider(with_model_id("m1"));
    let clone = model.clone();
    clone.update_config(with_model_id("m2")).unwrap();
    assert_eq!(model.config().model_id.as_deref(), Some("m2"));
}

#[test]
fn creates_the_model_from_a_bare_config_or_options() {
    let from_config = BedrockModel::new(with_model_id("m1"));
    assert_eq!(from_config.config().model_id.as_deref(), Some("m1"));
    let from_options = BedrockModel::new(BedrockModelOptions::from(with_model_id("m2")));
    assert_eq!(from_options.config().model_id.as_deref(), Some("m2"));
    assert_eq!(
        BedrockModelConfig::from(BaseModelConfig::default()),
        BedrockModelConfig::default()
    );
}
