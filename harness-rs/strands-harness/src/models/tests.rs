//! These assert the [`ModelPlan`] the provider is built from. Cases for the providers this crate
//! does not support (`google`, `ollama`, `litellm`) assert the unsupported-provider error.

use std::sync::Arc;

use serde_json::{Value, json};
use strands::ModelSource;
use strands::models::routing::{ModelRouter, ModelRouterOptions, RoutingCandidate};
use strands::models::{BaseModelConfig, Model};
use strands::testing::MockModel;

use super::*;
use crate::test_support::{env, offline_env, record_logs};

const DEFAULT: &str = "bedrock/global.anthropic.claude-opus-4-8";

fn request(effort: Effort, web_search: bool, caching: bool, caching_explicit: bool) -> ModelRequest {
    ModelRequest {
        effort,
        web_search,
        caching,
        caching_explicit,
    }
}

fn plan_with(
    spec: &str,
    effort: Effort,
    web_search: bool,
    caching: bool,
    explicit: bool,
) -> strands::Result<ModelPlan> {
    plan_model(spec, request(effort, web_search, caching, explicit), &offline_env())
}

fn plan(spec: &str, effort: Effort) -> ModelPlan {
    plan_with(spec, effort, false, false, false).unwrap()
}

fn error(spec: &str, effort: Effort) -> String {
    plan_with(spec, effort, false, false, false).unwrap_err().to_string()
}

fn mock(model_id: &str) -> Arc<dyn Model> {
    let model = MockModel::new();
    model
        .update_config(BaseModelConfig {
            model_id: Some(model_id.to_owned()),
            ..Default::default()
        })
        .unwrap();
    Arc::new(model)
}

fn router(models: &[&str]) -> ModelRouter {
    let candidates: Vec<RoutingCandidate> = models.iter().map(|model_id| mock(model_id).into()).collect();
    ModelRouter::new(candidates, ModelRouterOptions::default()).unwrap()
}

fn adaptive(effort: &str) -> Value {
    json!({
        "thinking": { "type": "adaptive", "display": "summarized" },
        "output_config": { "effort": effort },
    })
}

fn extended(budget: u64) -> Value {
    json!({ "thinking": { "type": "enabled", "budget_tokens": budget } })
}

mod resolve_model {
    use super::*;

    #[test]
    fn does_not_send_automatic_cache_points_to_claude_3_haiku() {
        for id in [
            "anthropic.claude-3-haiku-20240307-v1:0",
            "us.anthropic.claude-3-haiku-20240307-v1:0",
        ] {
            let spec = format!("bedrock/{id}");
            assert!(!plan_with(&spec, Effort::Auto, false, true, false).unwrap().caching);
            let error = plan_with(&spec, Effort::Auto, false, true, true).unwrap_err();
            assert!(error.to_string().contains("does not support prompt caching"));
        }
    }

    #[test]
    fn uses_aws_default_region_when_aws_region_is_absent_and_gives_aws_region_precedence() {
        let fallback = plan_model(
            DEFAULT,
            ModelRequest::default(),
            &env(&[("AWS_DEFAULT_REGION", "us-east-2")]),
        );
        assert_eq!(fallback.unwrap().region.as_deref(), Some("us-east-2"));
        let both = env(&[("AWS_DEFAULT_REGION", "us-east-2"), ("AWS_REGION", "us-west-2")]);
        assert_eq!(
            plan_model(DEFAULT, ModelRequest::default(), &both)
                .unwrap()
                .region
                .as_deref(),
            Some("us-west-2")
        );
    }

    #[test]
    fn resolves_undefined_to_the_default_with_thinking() {
        let resolved = plan(DEFAULT, Effort::Auto);
        assert_eq!(resolved.provider, Provider::Bedrock);
        assert_eq!(resolved.model_id, "global.anthropic.claude-opus-4-8");
        assert_eq!(resolved.additional_request_fields, Some(adaptive("high")));
    }

    #[test]
    fn treats_a_bare_string_as_a_bedrock_model_id() {
        let resolved = plan("my.custom.model-id", Effort::Auto);
        assert_eq!(resolved.provider, Provider::Bedrock);
        assert_eq!(resolved.model_id, "my.custom.model-id");
    }

    #[test]
    fn passes_a_model_instance_through_untouched() {
        let instance = mock("anything");
        let resolved = resolve_model(
            Some(&ModelSource::Model(Arc::clone(&instance))),
            DEFAULT,
            ModelRequest::default(),
            &offline_env(),
        )
        .unwrap();
        let ModelSource::Model(model) = resolved.source else {
            panic!("expected the instance")
        };
        assert!(Arc::ptr_eq(&model, &instance));
        assert!(resolved.plan.is_none());
    }

    #[test]
    fn passes_a_model_router_through_untouched() {
        let router = router(&["fast", "deep"]);
        let resolved = resolve_model(Some(&router.into()), DEFAULT, ModelRequest::default(), &offline_env()).unwrap();
        assert!(matches!(resolved.source, ModelSource::Router(_)));
    }

    #[test]
    fn uses_the_bedrock_model_id_directly() {
        assert_eq!(
            plan("bedrock/global.anthropic.claude-opus-4-8", Effort::Auto).model_id,
            "global.anthropic.claude-opus-4-8"
        );
    }

    #[test]
    fn passes_a_bedrock_name_through() {
        assert_eq!(
            plan("bedrock/some.other.model", Effort::Auto).model_id,
            "some.other.model"
        );
    }

    #[test]
    fn enables_prompt_caching_for_bedrock_when_requested() {
        assert!(plan_with(DEFAULT, Effort::Auto, false, true, false).unwrap().caching);
    }

    #[test]
    fn enables_bedrock_caching_even_with_effort_off() {
        assert!(plan_with(DEFAULT, Effort::Off, false, true, false).unwrap().caching);
    }

    #[test]
    fn does_not_set_cache_config_when_caching_is_off() {
        assert!(!plan(DEFAULT, Effort::Auto).caching);
    }

    #[test]
    fn leaves_provider_defaults_when_effort_is_off() {
        assert_eq!(plan(DEFAULT, Effort::Off).additional_request_fields, None);
    }

    #[test]
    fn applies_an_explicit_thinking_level() {
        assert_eq!(
            plan(DEFAULT, Effort::Low).additional_request_fields,
            Some(adaptive("low"))
        );
    }

    #[test]
    fn accepts_a_provider_specific_level() {
        assert_eq!(
            plan(DEFAULT, Effort::Max).additional_request_fields,
            Some(adaptive("max"))
        );
    }

    #[test]
    fn maps_openai_on_bedrock_thinking_to_reasoning_effort() {
        let resolved = plan("bedrock/us.openai.gpt-5.6-luna", Effort::Max);
        assert_eq!(
            resolved.additional_request_fields,
            Some(json!({ "reasoning": { "effort": "max" } }))
        );
    }

    #[test]
    fn uses_the_gpt_oss_bedrock_reasoning_field_and_levels() {
        let resolved = plan("bedrock/openai.gpt-oss-120b-1:0", Effort::Medium);
        assert_eq!(
            resolved.additional_request_fields,
            Some(json!({ "reasoning_effort": "medium" }))
        );
        assert!(
            error("bedrock/openai.gpt-oss-120b-1:0", Effort::Max)
                .contains("not supported by Bedrock model openai.gpt-oss-120b-1:0")
        );
    }

    #[test]
    fn resolves_astra_and_6_1_sol_effort_without_none() {
        for model_id in [
            "openai.gpt-6-astra",
            "global.openai.gpt-6-astra",
            "us.openai.gpt-6-astra",
            "us.openai.gpt-6.1-sol",
        ] {
            let spec = format!("bedrock/{model_id}");
            for (effort, level) in [(Effort::Auto, "high"), (Effort::Low, "low"), (Effort::Max, "max")] {
                assert_eq!(
                    plan(&spec, effort).additional_request_fields,
                    Some(json!({ "reasoning": { "effort": level } }))
                );
            }
            assert_eq!(plan(&spec, Effort::Off).additional_request_fields, None);
            assert!(
                error(&spec, Effort::Minimal)
                    .contains("Supported levels: low, medium, high, xhigh, max (or 'auto', 'off').")
            );
        }
    }

    #[test]
    fn resolves_gpt_5_4_and_5_5_effort_without_max() {
        for model_id in [
            "openai.gpt-5.4",
            "us.openai.gpt-5.4",
            "openai.gpt-5.5",
            "us.openai.gpt-5.5",
            "global.openai.gpt-5.5",
        ] {
            let spec = format!("bedrock/{model_id}");
            for (effort, level) in [
                (Effort::Auto, "high"),
                (Effort::Low, "low"),
                (Effort::Xhigh, "xhigh"),
                (Effort::Off, "none"),
            ] {
                assert_eq!(
                    plan(&spec, effort).additional_request_fields,
                    Some(json!({ "reasoning": { "effort": level } }))
                );
            }
            for effort in [Effort::Minimal, Effort::Max] {
                assert!(
                    error(&spec, effort).contains("Supported levels: low, medium, high, xhigh (or 'auto', 'off').")
                );
            }
        }
    }

    #[test]
    fn resolves_every_gpt_5_6_gpt_6_and_daybreak_effort() {
        for model_id in [
            "openai.gpt-5.6-cyber",
            "us.openai.gpt-6-sol",
            "us.openai.gpt-6.1-terra",
            "openai.gpt-daybreak-blue-5.6-sol",
            "us.openai.gpt-daybreak-blue-5.6-sol",
        ] {
            let spec = format!("bedrock/{model_id}");
            for (effort, level) in [
                (Effort::Auto, "high"),
                (Effort::Low, "low"),
                (Effort::Max, "max"),
                (Effort::Off, "none"),
            ] {
                assert_eq!(
                    plan(&spec, effort).additional_request_fields,
                    Some(json!({ "reasoning": { "effort": level } }))
                );
            }
            assert!(
                error(&spec, Effort::Minimal)
                    .contains("Supported levels: low, medium, high, xhigh, max (or 'auto', 'off').")
            );
        }
    }

    #[test]
    fn uses_the_qwen_bedrock_reasoning_field_and_levels() {
        assert_eq!(
            plan("bedrock/qwen.qwen3-32b-v1:0", Effort::Minimal).additional_request_fields,
            Some(json!({ "reasoning_effort": "minimal" }))
        );
        assert_eq!(
            plan("bedrock/us.qwen.qwen3-32b-v1:0", Effort::High).additional_request_fields,
            Some(json!({ "reasoning_effort": "high" }))
        );
        assert_eq!(
            plan("bedrock/qwen.qwen3-32b-v1:0", Effort::Off).additional_request_fields,
            Some(json!({ "reasoning_effort": "none" }))
        );
    }

    #[test]
    fn uses_the_xai_grok_bedrock_reasoning_field_and_levels() {
        assert_eq!(
            plan("bedrock/us.xai.grok-4.6", Effort::Xhigh).additional_request_fields,
            Some(json!({ "reasoning_effort": "xhigh" }))
        );
        assert_eq!(
            plan("bedrock/us.xai.grok-4.6", Effort::Auto).additional_request_fields,
            Some(json!({ "reasoning_effort": "high" }))
        );
        assert!(
            error("bedrock/us.xai.grok-4.6", Effort::Max).contains("not supported by Bedrock model us.xai.grok-4.6")
        );
    }

    #[test]
    fn does_not_attach_claude_thinking_fields_to_an_unknown_bedrock_family() {
        assert_eq!(
            plan("bedrock/amazon.nova-pro-v1:0", Effort::Auto).additional_request_fields,
            None
        );
    }

    #[test]
    fn rejects_explicit_thinking_for_an_unknown_bedrock_family() {
        assert!(error("bedrock/amazon.nova-pro-v1:0", Effort::High).contains("not supported by Bedrock model"));
    }

    #[test]
    fn rejects_a_level_the_provider_does_not_support() {
        assert!(error("openai/gpt-5.6-sol", Effort::Max).contains("not supported by model gpt-5.6-sol"));
    }

    #[test]
    fn rejects_a_level_the_model_does_not_support() {
        assert!(
            error(DEFAULT, Effort::Minimal).contains("not supported by Bedrock model global.anthropic.claude-opus-4-8")
        );
    }

    #[test]
    fn rejects_an_unknown_provider() {
        assert_eq!(
            error("mistral/whatever", Effort::Auto),
            "Unknown model provider \"mistral\" in \"mistral/whatever\". Supported providers: anthropic, bedrock, bedrock-mantle, openai. Pass a Model instance for anything else."
        );
    }

    #[test]
    fn does_not_treat_a_gemini_prefix_as_a_provider() {
        assert!(error("gemini/gemini-3.5-flash", Effort::Auto).contains("Unknown model provider"));
    }

    #[test]
    fn rejects_the_providers_rust_does_not_support_yet() {
        for provider in ["google", "ollama", "litellm"] {
            assert_eq!(
                error(&format!("{provider}/x"), Effort::Auto),
                format!("model provider \"{provider}\" is not supported in Rust yet")
            );
        }
    }

    #[test]
    fn resolves_the_per_model_levels_for_gemma_on_mantle() {
        let spec = "bedrock-mantle/google.gemma-4-31b";
        assert_eq!(
            plan(spec, Effort::Auto).params,
            Some(json!({ "reasoning": { "effort": "high" } }))
        );
        assert_eq!(
            plan(spec, Effort::Off).params,
            Some(json!({ "reasoning": { "effort": "none" } }))
        );
        assert!(error(spec, Effort::Low).contains("not supported by model google.gemma-4-31b. Supported levels: high"));
    }

    #[test]
    fn maps_openai_to_reasoning_effort() {
        let resolved = plan("openai/gpt-5.6-sol", Effort::Auto);
        assert_eq!(resolved.provider, Provider::OpenAI);
        assert_eq!(resolved.params, Some(json!({ "reasoning": { "effort": "high" } })));
    }

    #[test]
    fn maps_anthropic_to_thinking_and_max_tokens() {
        let resolved = plan("anthropic/claude-opus-4-8", Effort::Auto);
        assert_eq!(resolved.model_id, "claude-opus-4-8");
        assert_eq!(resolved.max_tokens, Some(128_000));
        assert_eq!(
            resolved.params.unwrap()["thinking"],
            json!({ "type": "adaptive", "display": "summarized" })
        );
    }

    #[test]
    fn gives_anthropic_haiku_its_own_tier_max_tokens() {
        assert_eq!(
            plan("anthropic/claude-haiku-4-5-20251001", Effort::Auto).max_tokens,
            Some(64_000)
        );
    }

    #[test]
    fn falls_back_to_a_flat_max_tokens_for_an_unrecognized_anthropic_tier() {
        assert_eq!(plan("anthropic/claude-mythos-1", Effort::Auto).max_tokens, Some(32_000));
    }

    #[test]
    fn gives_a_bedrock_claude_model_tier_max_tokens() {
        assert_eq!(plan(DEFAULT, Effort::Auto).max_tokens, Some(128_000));
    }

    #[test]
    fn gives_a_bedrock_claude_haiku_model_its_own_tier_max_tokens() {
        assert_eq!(
            plan("bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0", Effort::Auto).max_tokens,
            Some(64_000)
        );
    }

    const EXTENDED_CLAUDE: [&str; 5] = [
        "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "anthropic.claude-haiku-4-5-20251001-v1:0",
        "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "global.anthropic.claude-opus-4-5-20251101-v1:0",
    ];

    const NO_THINKING_CLAUDE: [&str; 8] = [
        "us.anthropic.claude-opus-4-1-20250805-v1:0",
        "global.anthropic.claude-sonnet-4-20250514-v1:0",
        "anthropic.claude-opus-4-20250514-v1:0",
        "us.anthropic.claude-3-haiku-20240307-v1:0",
        "us.anthropic.claude-3-sonnet-20240229-v1:0",
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
        "anthropic.claude-3.5-sonnet-20241022-v2:0",
        "anthropic.claude-3-7-sonnet-20250219-v1:0",
    ];

    const ADAPTIVE_CLAUDE: [&str; 14] = [
        "global.anthropic.claude-opus-4-6-v1",
        "global.anthropic.claude-sonnet-4-6",
        "global.anthropic.claude-opus-4-7",
        "global.anthropic.claude-opus-4-8",
        "global.anthropic.claude-opus-5",
        "global.anthropic.claude-sonnet-5",
        "global.anthropic.claude-haiku-5-5",
        "au.anthropic.claude-haiku-5-5",
        "anthropic.claude-haiku-5-5",
        "global.anthropic.claude-haiku-6",
        "global.anthropic.claude-fable-5",
        "global.anthropic.claude-fable-5-1",
        "anthropic.claude-mythos-preview",
        "anthropic.claude-mythos-5-1",
    ];

    #[test]
    fn sends_no_thinking_block_to_claude_below_the_floor() {
        for model_id in NO_THINKING_CLAUDE {
            assert_eq!(
                plan(&format!("bedrock/{model_id}"), Effort::Auto).additional_request_fields,
                None,
                "{model_id}"
            );
        }
    }

    #[test]
    fn sends_the_extended_block_to_extended_thinking_claude() {
        for model_id in EXTENDED_CLAUDE {
            assert_eq!(
                plan(&format!("bedrock/{model_id}"), Effort::Auto).additional_request_fields,
                Some(extended(16_384)),
                "{model_id}"
            );
        }
    }

    #[test]
    fn maps_each_level_to_a_budget_that_the_api_accepts() {
        for (effort, budget) in [
            (Effort::Low, 2_048),
            (Effort::Medium, 8_192),
            (Effort::High, 16_384),
            (Effort::Xhigh, 32_768),
            (Effort::Max, 49_152),
        ] {
            let resolved = plan("bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0", effort);
            assert_eq!(resolved.additional_request_fields, Some(extended(budget)));
            assert!(budget < resolved.max_tokens.unwrap());
        }
    }

    #[test]
    fn gives_each_claude_its_max_tokens_ceiling() {
        for (model_id, max_tokens) in [
            ("claude-sonnet-4-5-20250929-v1:0", 64_000),
            ("claude-sonnet-4.5", 64_000),
            ("claude-sonnet-4-6", 128_000),
            ("claude-sonnet-4.6", 128_000),
            ("claude-sonnet-5", 128_000),
            ("claude-opus-4-5-20251101-v1:0", 64_000),
            ("claude-opus-4.5", 64_000),
            ("claude-opus-4-8", 128_000),
            ("claude-opus-5", 128_000),
            ("claude-haiku-4-5-20251001-v1:0", 64_000),
            ("claude-haiku-4.5", 64_000),
            ("claude-haiku-5-5", 128_000),
        ] {
            assert_eq!(
                plan(&format!("bedrock/global.anthropic.{model_id}"), Effort::Auto).max_tokens,
                Some(max_tokens),
                "{model_id}"
            );
        }
    }

    #[test]
    fn clamps_a_version_led_id_against_the_anthropic_direct_fallback() {
        let resolved = plan("anthropic/claude-4-5-haiku", Effort::Max);
        assert_eq!(resolved.max_tokens, Some(32_000));
        assert_eq!(resolved.params, Some(extended(31_999)));
    }

    #[test]
    fn sends_the_adaptive_block_to_adaptive_claude() {
        for model_id in ADAPTIVE_CLAUDE {
            assert_eq!(
                plan(&format!("bedrock/{model_id}"), Effort::Auto).additional_request_fields,
                Some(adaptive("high")),
                "{model_id}"
            );
        }
    }

    #[test]
    fn rejects_an_explicit_thinking_level_on_a_claude_below_the_thinking_floor() {
        assert!(
            error("bedrock/us.anthropic.claude-3-haiku-20240307-v1:0", Effort::High)
                .contains("not supported by Bedrock model")
        );
    }

    #[test]
    fn sends_extended_thinking_params_to_an_anthropic_direct_haiku_model() {
        assert_eq!(
            plan("anthropic/claude-haiku-4-5-20251001", Effort::Auto).params,
            Some(extended(16_384))
        );
    }

    #[test]
    fn sends_no_thinking_params_to_an_anthropic_direct_claude_below_the_floor() {
        assert_eq!(plan("anthropic/claude-3-haiku-20240307", Effort::Auto).params, None);
    }

    #[test]
    fn gives_bedrock_claude_sonnet_and_fable_models_tier_max_tokens() {
        assert_eq!(
            plan("bedrock/global.anthropic.claude-sonnet-5", Effort::Auto).max_tokens,
            Some(128_000)
        );
        assert_eq!(
            plan("bedrock/global.anthropic.claude-fable-5", Effort::Auto).max_tokens,
            Some(128_000)
        );
    }

    #[test]
    fn does_not_force_max_tokens_on_a_non_claude_bedrock_model() {
        assert_eq!(plan("bedrock/amazon.nova-pro-v1:0", Effort::Auto).max_tokens, None);
    }

    #[test]
    fn does_not_force_max_tokens_on_a_legacy_claude_3_bedrock_id() {
        assert_eq!(
            plan("bedrock/anthropic.claude-3-haiku-20240307-v1:0", Effort::Auto).max_tokens,
            None
        );
    }

    #[test]
    fn builds_bedrock_mantle_via_the_openai_provider() {
        let resolved = plan("bedrock-mantle/openai.gpt-oss-120b", Effort::Auto);
        assert_eq!(resolved.provider, Provider::BedrockMantle);
        assert_eq!(resolved.model_id, "openai.gpt-oss-120b");
        assert_eq!(resolved.params, Some(json!({ "reasoning": { "effort": "high" } })));
    }

    #[test]
    fn rejects_an_unsupported_thinking_level_for_bedrock_mantle() {
        assert!(
            error("bedrock-mantle/openai.gpt-oss-120b", Effort::Max)
                .contains("not supported by model openai.gpt-oss-120b")
        );
    }

    #[test]
    fn adds_the_bedrock_web_search_tool_for_bedrock_mantle_web_search() {
        let resolved = plan_with("bedrock-mantle/openai.gpt-5.6-luna", Effort::Auto, true, false, false).unwrap();
        assert_eq!(
            resolved.params,
            Some(
                json!({ "reasoning": { "effort": "high" }, "tools": [{ "type": "web_search", "external_web_access": true }] })
            )
        );
    }

    #[test]
    fn adds_the_bedrock_web_search_tool_with_effort_off() {
        for spec in [
            "bedrock-mantle/openai.gpt-5.6-luna",
            "bedrock-mantle/openai.gpt-6-astra",
        ] {
            let resolved = plan_with(spec, Effort::Off, true, false, false).unwrap();
            assert_eq!(
                resolved.params,
                Some(
                    json!({ "reasoning": { "effort": "none" }, "tools": [{ "type": "web_search", "external_web_access": true }] })
                )
            );
        }
    }

    #[test]
    fn omits_bedrock_mantle_tools_when_web_search_is_off() {
        assert!(
            plan("bedrock-mantle/openai.gpt-5.6-luna", Effort::Auto)
                .params
                .unwrap()
                .get("tools")
                .is_none()
        );
    }

    #[test]
    fn adds_the_openai_web_search_tool_alongside_reasoning() {
        let resolved = plan_with("openai/gpt-5.6-sol", Effort::High, true, false, false).unwrap();
        assert_eq!(
            resolved.params,
            Some(json!({ "reasoning": { "effort": "high" }, "tools": [{ "type": "web_search" }] }))
        );
    }

    #[test]
    fn adds_the_openai_web_search_tool_with_effort_off() {
        let resolved = plan_with("openai/gpt-5.6-sol", Effort::Off, true, false, false).unwrap();
        assert_eq!(
            resolved.params,
            Some(json!({ "reasoning": { "effort": "none" }, "tools": [{ "type": "web_search" }] }))
        );
    }

    #[test]
    fn omits_openai_tools_when_web_search_is_off() {
        assert!(
            plan("openai/gpt-5.6-sol", Effort::High)
                .params
                .unwrap()
                .get("tools")
                .is_none()
        );
    }

    #[test]
    fn adds_the_anthropic_web_search_server_tool_as_a_direct_call() {
        let resolved = plan_with("anthropic/claude-opus-4-8", Effort::High, true, false, false).unwrap();
        assert_eq!(
            resolved.anthropic_tools,
            Some(vec![
                json!({ "type": "web_search_20260318", "name": "web_search", "allowed_callers": ["direct"] })
            ])
        );
        assert!(resolved.params.unwrap().get("thinking").is_some());
    }

    #[test]
    fn omits_anthropic_server_tools_when_web_search_is_off() {
        assert_eq!(plan("anthropic/claude-opus-4-8", Effort::High).anthropic_tools, None);
    }

    #[test]
    fn never_adds_a_native_search_tool_where_the_model_has_none() {
        for spec in [
            "bedrock-mantle/qwen.qwen3-32b-v1:0",
            "bedrock-mantle/openai.gpt-oss-120b-1:0",
        ] {
            let resolved = plan_with(spec, Effort::High, true, false, false).unwrap();
            assert!(resolved.params.unwrap().get("tools").is_none());
        }
    }

    #[test]
    fn warns_instead_of_throwing_when_an_effort_level_is_requested_on_a_model_instance() {
        let (logs, _guard) = record_logs();
        let instance: ModelSource = mock("anything").into();
        resolve_model(
            Some(&instance),
            DEFAULT,
            request(Effort::High, false, false, false),
            &offline_env(),
        )
        .unwrap();
        assert!(
            logs.lines("WARN")
                .iter()
                .any(|line| line.contains("effort \"high\" not applied"))
        );
    }

    #[test]
    fn does_not_warn_for_a_model_instance_with_default_effort_and_no_web_search_or_caching() {
        let (logs, _guard) = record_logs();
        let instance: ModelSource = mock("anything").into();
        resolve_model(Some(&instance), DEFAULT, ModelRequest::default(), &offline_env()).unwrap();
        assert!(logs.lines("WARN").is_empty());
    }

    #[test]
    fn enables_prompt_caching_for_anthropic_direct_when_requested() {
        assert!(
            plan_with("anthropic/claude-opus-4-8", Effort::Auto, false, true, false)
                .unwrap()
                .caching
        );
        assert!(!plan("anthropic/claude-opus-4-8", Effort::Auto).caching);
    }

    #[test]
    fn configures_openai_and_mantle_caching_without_changing_reasoning_or_search() {
        for (spec, model_id, tool) in [
            ("openai/gpt-5.6-sol", "gpt-5.6-sol", json!({ "type": "web_search" })),
            (
                "bedrock-mantle/openai.gpt-6-luna",
                "openai.gpt-6-luna",
                json!({ "type": "web_search", "external_web_access": true }),
            ),
        ] {
            for caching in [true, false] {
                let resolved = plan_with(spec, Effort::High, true, caching, false).unwrap();
                assert_eq!(resolved.model_id, model_id);
                assert_eq!(resolved.caching, caching);
                assert_eq!(resolved.max_tokens, None);
                assert_eq!(
                    resolved.params,
                    Some(json!({ "reasoning": { "effort": "high" }, "tools": [tool] }))
                );
            }
        }
    }

    #[test]
    fn warns_instead_of_throwing_when_caching_is_explicitly_requested_on_a_model_instance() {
        let (logs, _guard) = record_logs();
        let instance: ModelSource = mock("anything").into();
        resolve_model(
            Some(&instance),
            DEFAULT,
            request(Effort::Auto, false, true, true),
            &offline_env(),
        )
        .unwrap();
        assert!(
            logs.lines("WARN")
                .iter()
                .any(|line| line.contains("pre-built Model instance"))
        );
    }

    #[test]
    fn does_not_warn_when_default_caching_hits_a_model_instance() {
        let (logs, _guard) = record_logs();
        let instance: ModelSource = mock("anything").into();
        resolve_model(
            Some(&instance),
            DEFAULT,
            request(Effort::Auto, false, true, false),
            &offline_env(),
        )
        .unwrap();
        assert!(logs.lines("WARN").is_empty());
    }

    #[test]
    fn does_not_warn_when_caching_is_supported() {
        let (logs, _guard) = record_logs();
        plan_with("bedrock-mantle/openai.gpt-oss-120b", Effort::Auto, false, true, false).unwrap();
        assert!(logs.lines("WARN").is_empty());
    }

    #[cfg(not(feature = "anthropic"))]
    #[test]
    fn rejects_a_provider_whose_feature_is_disabled() {
        let error = resolve_model(
            Some(&"anthropic/claude-opus-5".into()),
            DEFAULT,
            ModelRequest::default(),
            &offline_env(),
        )
        .err()
        .unwrap();
        assert_eq!(
            error.to_string(),
            "model 'anthropic/claude-opus-5' requires the strands-harness feature \"anthropic\""
        );
    }

    #[test]
    fn names_the_mantle_feature_for_a_bedrock_mantle_model() {
        let resolved = plan("bedrock-mantle/openai.gpt-oss-120b", Effort::Auto);
        assert_eq!(
            feature_disabled(&resolved).to_string(),
            "model 'bedrock-mantle/openai.gpt-oss-120b' requires the strands-harness feature \"mantle\""
        );
    }

    #[cfg(all(feature = "bedrock", feature = "anthropic", feature = "mantle"))]
    #[test]
    fn builds_each_provider_from_its_plan() {
        for (spec, model_id) in [
            (DEFAULT, "global.anthropic.claude-opus-4-8"),
            ("anthropic/claude-opus-4-8", "claude-opus-4-8"),
            ("openai/gpt-5.6-sol", "gpt-5.6-sol"),
            ("bedrock-mantle/openai.gpt-6-luna", "openai.gpt-6-luna"),
        ] {
            let resolved = resolve_model(Some(&spec.into()), DEFAULT, ModelRequest::default(), &offline_env()).unwrap();
            let ModelSource::Model(model) = resolved.source else {
                panic!("expected a model")
            };
            assert_eq!(model.model_id().as_deref(), Some(model_id));
        }
    }
}

mod default_effort {
    use super::*;

    #[test]
    fn is_high_on_every_reasoning_provider() {
        for (spec, field) in [
            ("bedrock/global.anthropic.claude-opus-5", "/output_config/effort"),
            ("bedrock/global.anthropic.claude-sonnet-5", "/output_config/effort"),
            ("bedrock/us.anthropic.claude-sonnet-4-6", "/output_config/effort"),
            ("bedrock/global.anthropic.claude-fable-5-1", "/output_config/effort"),
            ("bedrock/openai.gpt-5.6-sol", "/reasoning/effort"),
            ("bedrock/global.openai.gpt-6-astra", "/reasoning/effort"),
            ("bedrock/openai.gpt-oss-120b-1:0", "/reasoning_effort"),
            ("bedrock/qwen.qwen3-32b-v1:0", "/reasoning_effort"),
            ("bedrock/us.xai.grok-4", "/reasoning_effort"),
            ("anthropic/claude-opus-5", "/output_config/effort"),
            ("openai/gpt-5.6-sol", "/reasoning/effort"),
            ("bedrock-mantle/openai.gpt-5.6-sol", "/reasoning/effort"),
        ] {
            let resolved = plan(spec, Effort::Auto);
            let fields = resolved
                .additional_request_fields
                .clone()
                .or_else(|| resolved.params.clone())
                .unwrap();
            assert_eq!(fields.pointer(field), Some(&json!("high")), "{spec}");
            assert_eq!(resolved, plan(spec, Effort::High), "{spec}");
        }
    }

    #[test]
    fn is_the_high_budget_on_extended_thinking_models() {
        for spec in [
            "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
            "anthropic/claude-haiku-4-5-20251001",
        ] {
            let resolved = plan(spec, Effort::Auto);
            let block = resolved
                .additional_request_fields
                .clone()
                .or_else(|| resolved.params.clone());
            assert_eq!(block, Some(extended(16_384)));
            assert_eq!(resolved, plan(spec, Effort::High));
        }
    }

    #[test]
    fn sends_no_reasoning_field_where_high_would_be_rejected() {
        for spec in [
            "bedrock/amazon.nova-pro-v1:0",
            "bedrock/us.anthropic.claude-3-haiku-20240307-v1:0",
            "anthropic/claude-3-haiku-20240307",
        ] {
            let resolved = plan(spec, Effort::Auto);
            assert_eq!(resolved.additional_request_fields, None);
            assert_eq!(resolved.params, None);
            assert!(error(spec, Effort::High).contains("not supported"));
        }
    }
}

mod supports_thinking {
    use super::*;

    fn thinks(spec: &str) -> bool {
        supports_thinking(Some(&spec.into()))
    }

    #[test]
    fn answers_for_consumers() {
        assert!(thinks("bedrock/global.anthropic.claude-opus-4-8"));
        assert!(thinks("bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"));
        assert!(thinks("anthropic/claude-haiku-4-5-20251001"));
        assert!(!thinks("bedrock/us.anthropic.claude-3-haiku-20240307-v1:0"));
        assert!(!thinks("anthropic/claude-3-haiku-20240307"));
        assert!(!thinks("ollama/llama3"));
        assert!(supports_thinking(None));
    }

    #[test]
    fn answers_for_providers_rust_does_not_build_yet_as_harness_ts_does() {
        assert!(thinks("google/gemini-2.5-flash"));
        assert!(!thinks("ollama/llama3"));
        assert!(!thinks("litellm/gpt-4o"));
        assert!(!thinks("unknown/model"));
    }

    #[test]
    fn is_true_for_a_model_instance() {
        assert!(supports_thinking(Some(&mock("anything").into())));
    }

    #[test]
    fn is_true_for_a_model_router() {
        assert!(supports_thinking(Some(&router(&["fast"]).into())));
    }

    #[test]
    fn is_false_for_bedrock_families_that_take_no_level() {
        for model_id in [
            "amazon.nova-pro-v1:0",
            "us.amazon.nova-pro-v1:0",
            "meta.llama3-3-70b-instruct-v1:0",
            "deepseek.r1-v1:0",
            "mistral.mistral-large-2407-v1:0",
        ] {
            let spec = format!("bedrock/{model_id}");
            assert!(!thinks(&spec));
            assert!(error(&spec, Effort::High).contains("not supported by Bedrock model"));
        }
    }

    #[test]
    fn resolves_the_claude_family_behind_every_cross_region_prefix() {
        for prefix in ["", "global.", "apac.", "us.", "eu.", "au.", "jp."] {
            let spec = format!("bedrock/{prefix}anthropic.claude-opus-4-8");
            assert!(thinks(&spec));
            assert_eq!(
                plan(&spec, Effort::Max).additional_request_fields,
                Some(adaptive("max"))
            );
        }
    }

    #[test]
    fn reads_the_dot_separated_version() {
        for (model_id, expected) in [
            ("claude-opus-4.8", true),
            ("claude-sonnet-4.6", true),
            ("claude-opus-4.5", true),
            ("claude-haiku-4.5", true),
            ("claude-opus-4.1", false),
        ] {
            assert_eq!(
                thinks(&format!("bedrock/global.anthropic.{model_id}")),
                expected,
                "{model_id}"
            );
        }
    }

    #[test]
    fn fails_open_to_adaptive_when_the_version_does_not_parse() {
        for model_id in [
            "claude-opus-latest",
            "claude-sonnet-latest",
            "claude-haiku-latest",
            "claude-haiku",
            "claude-opus-100",
        ] {
            let spec = format!("bedrock/global.anthropic.{model_id}");
            assert!(thinks(&spec), "{model_id}");
            assert_eq!(
                plan(&spec, Effort::Auto).additional_request_fields,
                Some(adaptive("high")),
                "{model_id}"
            );
        }
    }

    #[test]
    fn is_true_for_an_unrecognized_claude_family() {
        assert!(thinks("bedrock/global.anthropic.claude-quasar-6"));
    }
}

mod supports_web_search {
    use super::*;

    fn searches(spec: &str) -> bool {
        supports_web_search(Some(&spec.into()))
    }

    #[test]
    fn is_true_for_openai_and_bedrock_mantle() {
        assert!(searches("openai/gpt-5.6-sol"));
        assert!(searches("bedrock-mantle/openai.gpt-5.6-luna"));
        assert!(searches("bedrock-mantle/openai.gpt-6-astra"));
        assert!(searches("bedrock-mantle/openai.gpt-6.1-sol"));
        assert!(searches("bedrock-mantle/openai.gpt-daybreak-blue-5.6-sol"));
        assert!(!searches("bedrock-mantle/openai.gpt-oss-120b"));
        assert!(!searches("bedrock-mantle/qwen.qwen3-32b-v1:0"));
    }

    #[test]
    fn is_false_for_bedrock_but_true_for_anthropic_direct() {
        assert!(!searches("bedrock/global.anthropic.claude-opus-4-8"));
        assert!(searches("anthropic/claude-opus-4-8"));
    }

    #[test]
    fn uses_the_default_model_provider_for_undefined() {
        assert!(!supports_web_search(None));
    }

    #[test]
    fn is_false_for_a_model_instance() {
        assert!(!supports_web_search(Some(&mock("anything").into())));
    }

    #[test]
    fn is_false_for_a_model_router() {
        assert!(!supports_web_search(Some(&router(&["fast"]).into())));
    }
}

mod resolve_web_fetch_model {
    use super::*;

    fn summarizer(main: Option<&str>, explicit: Option<&str>, env: &Env) -> ModelPlan {
        let main = main.map(ModelSource::from);
        let explicit = explicit.map(ModelSource::from);
        match plan_web_fetch_model(main.as_ref(), explicit.as_ref(), env).unwrap() {
            SummarizerPlan::Plan(plan) => plan,
            SummarizerPlan::Instance(_) => panic!("expected a plan"),
        }
    }

    #[allow(clippy::needless_pass_by_value, reason = "callers build the sources inline")]
    fn instance(main: Option<ModelSource>, explicit: Option<ModelSource>) -> Arc<dyn Model> {
        match plan_web_fetch_model(main.as_ref(), explicit.as_ref(), &offline_env()).unwrap() {
            SummarizerPlan::Instance(model) => model,
            SummarizerPlan::Plan(_) => panic!("expected an instance"),
        }
    }

    #[test]
    fn defaults_to_the_provider_small_model_with_no_thinking() {
        let resolved = summarizer(Some(DEFAULT), None, &offline_env());
        assert_eq!(resolved.provider, Provider::Bedrock);
        assert_eq!(resolved.model_id, "global.anthropic.claude-haiku-4-5-20251001-v1:0");
        assert_eq!(resolved.additional_request_fields, None);
    }

    #[test]
    fn uses_the_openai_small_model_for_an_openai_on_bedrock_main_model() {
        let resolved = summarizer(Some("bedrock/openai.gpt-5.6-luna"), None, &offline_env());
        assert_eq!(resolved.provider, Provider::Bedrock);
        assert_eq!(resolved.model_id, "openai.gpt-5.6-luna");
    }

    #[test]
    fn keeps_a_cross_region_prefix_for_openai_on_bedrock() {
        assert_eq!(
            summarizer(Some("bedrock/us.openai.gpt-5.6-sol"), None, &offline_env()).model_id,
            "us.openai.gpt-5.6-luna"
        );
        assert_eq!(
            summarizer(Some("bedrock/global.openai.gpt-5.6-sol"), None, &offline_env()).model_id,
            "global.openai.gpt-5.6-luna"
        );
    }

    #[test]
    fn reuses_the_main_model_and_warns_for_a_bedrock_family_with_no_mapped_summarizer() {
        let (logs, _guard) = record_logs();
        let resolved = summarizer(Some("bedrock/amazon.nova-pro-v1:0"), None, &offline_env());
        assert_eq!(resolved.model_id, "amazon.nova-pro-v1:0");
        assert!(
            logs.lines("WARN")
                .iter()
                .any(|line| line.contains("no small web_fetch summarizer is mapped"))
        );
    }

    #[test]
    fn does_not_warn_for_a_bedrock_family_with_no_mapped_summarizer_when_given_an_explicit_override() {
        let (logs, _guard) = record_logs();
        let override_model = mock("explicit");
        let resolved = instance(
            Some("bedrock/amazon.nova-pro-v1:0".into()),
            Some(Arc::clone(&override_model).into()),
        );
        assert!(Arc::ptr_eq(&resolved, &override_model));
        assert!(logs.lines("WARN").is_empty());
    }

    #[test]
    fn reuses_a_main_model_instance_when_no_override_is_given() {
        let main = mock("whatever");
        assert!(Arc::ptr_eq(&instance(Some(Arc::clone(&main).into()), None), &main));
    }

    #[test]
    fn uses_a_main_model_router_default_when_no_override_is_given() {
        let router = router(&["fast", "deep"]);
        let resolved = instance(Some(router.clone().into()), None);
        assert!(Arc::ptr_eq(&resolved, &router.default_model()));
    }

    #[test]
    fn uses_an_explicit_model_router_default() {
        let router = router(&["fast", "deep"]);
        let resolved = instance(None, Some(router.clone().into()));
        assert!(Arc::ptr_eq(&resolved, &router.default_model()));
    }

    #[test]
    fn uses_an_explicit_model_instance_override() {
        let override_model = mock("explicit");
        assert!(Arc::ptr_eq(
            &instance(Some(DEFAULT.into()), Some(Arc::clone(&override_model).into())),
            &override_model
        ));
    }

    #[test]
    fn resolves_an_explicit_provider_name_override_string() {
        let resolved = summarizer(
            Some(DEFAULT),
            Some("anthropic/claude-haiku-4-5-20251001"),
            &offline_env(),
        );
        assert_eq!(resolved.provider, Provider::Anthropic);
        assert_eq!(resolved.model_id, "claude-haiku-4-5-20251001");
        assert_eq!(resolved.params, None);
    }

    #[test]
    fn has_a_default_fetch_model_for_bedrock_mantle() {
        assert_eq!(
            summarizer(Some("bedrock-mantle/openai.gpt-oss-120b"), None, &offline_env()).model_id,
            "openai.gpt-5.6-luna"
        );
    }
}

mod supports_media {
    use super::*;

    fn media(spec: &str) -> bool {
        supports_media(Some(&spec.into()))
    }

    #[test]
    fn is_false_for_openai_family_models_on_bedrock_converse() {
        assert!(!media("bedrock/us.openai.gpt-6-astra"));
        assert!(!media("bedrock/openai.gpt-5.6-sol"));
    }

    #[test]
    fn is_true_elsewhere() {
        assert!(media("bedrock/global.anthropic.claude-opus-4-8"));
        assert!(media("anthropic/claude-haiku-4-5-20251001"));
        assert!(media("bedrock-mantle/openai.gpt-6-astra"));
        assert!(supports_media(None));
    }

    #[test]
    fn reads_an_instance_model_id() {
        assert!(supports_media(Some(&mock("global.anthropic.claude-opus-4-8").into())));
        assert!(!supports_media(Some(&mock("us.openai.gpt-6-astra").into())));
    }

    #[test]
    fn requires_every_router_candidate_to_support_media() {
        assert!(supports_media(Some(
            &router(&["global.anthropic.claude-opus-4-8"]).into()
        )));
        let mixed = router(&["global.anthropic.claude-opus-4-8", "us.openai.gpt-6-astra"]);
        assert!(!supports_media(Some(&mixed.into())));
    }
}

mod web_fetch_summarizer_on_a_repointed_endpoint {
    use super::*;

    fn summarizer(main: &str, env: &Env) -> String {
        match plan_web_fetch_model(Some(&main.into()), None, env).unwrap() {
            SummarizerPlan::Plan(plan) => plan.model_id,
            SummarizerPlan::Instance(_) => panic!("expected a plan"),
        }
    }

    #[test]
    fn reuses_the_main_model_when_anthropic_base_url_is_set() {
        let env = env(&[(
            "ANTHROPIC_BASE_URL",
            "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1",
        )]);
        assert_eq!(
            summarizer("anthropic/anthropic.claude-fable-5", &env),
            "anthropic.claude-fable-5"
        );
    }

    #[test]
    fn reuses_the_main_model_when_openai_base_url_is_set() {
        let env = env(&[("OPENAI_BASE_URL", "https://bedrock-mantle.us-west-2.api.aws/v1")]);
        assert_eq!(summarizer("openai/gpt-oss-20b", &env), "gpt-oss-20b");
    }

    #[test]
    fn still_uses_the_small_model_on_the_first_party_endpoint() {
        assert_eq!(
            summarizer("anthropic/claude-opus-4-5-20251101", &offline_env()),
            "claude-haiku-4-5-20251001"
        );
    }

    #[test]
    fn does_not_affect_bedrock() {
        let env = env(&[("ANTHROPIC_BASE_URL", "https://example.invalid/anthropic")]);
        assert_eq!(
            summarizer(DEFAULT, &env),
            "global.anthropic.claude-haiku-4-5-20251001-v1:0"
        );
    }
}
