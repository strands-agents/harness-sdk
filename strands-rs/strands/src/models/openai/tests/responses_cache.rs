//! Durable prompt-cache checkpoints on models that take cache points. Table cases loop in one test.

use serde_json::json;

use super::super::responses::format_responses_request;
use super::*;
use crate::models::{CacheKey, CacheSectionSetting, CacheStrategy, PromptCaching};
use crate::types::{ContentBlock, ImageBlock, ImageFormat, ImageSource, Role, ToolResultBlock, ToolUseBlock};

fn marker() -> JsonValue {
    json!({"mode": "explicit"})
}

fn user(texts: &[&str]) -> Message {
    Message::new(Role::User, texts.iter().map(|text| ContentBlock::text(*text)).collect())
}

fn config(model_id: &str, cache_config: Option<CacheConfig>) -> OpenAIModelConfig {
    OpenAIModelConfig {
        model_id: Some(model_id.to_owned()),
        cache_config,
        ..Default::default()
    }
}

/// The request formatted with the model info the provider resolves for `config`.
#[allow(clippy::needless_pass_by_value, reason = "tests pass freshly built configs")]
fn format(config: OpenAIModelConfig, messages: Vec<Message>, dynamic_trailing_blocks: Option<usize>) -> JsonValue {
    let model = model_with(
        &idle(),
        OpenAIModelOptions {
            api: OpenAIApi::Responses,
            model_id: config.model_id.clone(),
            model_info: config.model_info.clone(),
            ..Default::default()
        },
    );
    let request = ModelRequest {
        messages,
        dynamic_trailing_blocks,
        ..Default::default()
    };
    JsonValue::Object(format_responses_request(&config, &request, false, &model.model_info()))
}

fn default_config() -> OpenAIModelConfig {
    config("gpt-6-sol", Some(CacheConfig::default()))
}

fn request_for(messages: Vec<Message>, dynamic_trailing_blocks: Option<usize>) -> JsonValue {
    format(default_config(), messages, dynamic_trailing_blocks)
}

fn input(messages: Vec<Message>, dynamic_trailing_blocks: Option<usize>) -> JsonValue {
    request_for(messages, dynamic_trailing_blocks)["input"].clone()
}

/// The input for a one-text user message, with `checkpoint` as its breakpoint when given.
fn text_input(text: &str, checkpoint: Option<JsonValue>) -> JsonValue {
    let mut part = json!({"type": "input_text", "text": text});
    if let Some(checkpoint) = checkpoint {
        part["prompt_cache_breakpoint"] = checkpoint;
    }
    json!([{"role": "user", "content": [part]}])
}

fn png() -> ImageBlock {
    ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3]))
}

#[test]
fn checkpoints_stable_user_content_before_the_injected_tail_without_mutating_history() {
    let messages = vec![user(&["question", "temporary"])];
    let before = serde_json::to_value(&messages).unwrap();
    assert_eq!(
        format(default_config(), messages.clone(), Some(1)),
        json!({
            "model": "gpt-6-sol",
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "question", "prompt_cache_breakpoint": marker()},
                {"type": "input_text", "text": "temporary"}
            ]}],
            "stream": true,
            "store": false,
            "prompt_cache_options": {"mode": "explicit"}
        })
    );
    assert_eq!(serde_json::to_value(&messages).unwrap(), before);
}

#[test]
fn retains_the_previous_checkpoint_after_the_old_injection_disappears_and_history_grows() {
    let previous = input(vec![user(&["first", "old context"])], Some(1));
    let next = input(
        vec![
            user(&["first"]),
            Message::assistant("answer"),
            user(&["second", "new context"]),
        ],
        Some(1),
    );
    assert_eq!(
        previous,
        json!([{"role": "user", "content": [
            {"type": "input_text", "text": "first", "prompt_cache_breakpoint": marker()},
            {"type": "input_text", "text": "old context"}
        ]}])
    );
    assert_eq!(
        next,
        json!([
            {"role": "user", "content": [{"type": "input_text", "text": "first", "prompt_cache_breakpoint": marker()}]},
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": [
                {"type": "input_text", "text": "second", "prompt_cache_breakpoint": marker()},
                {"type": "input_text", "text": "new context"}
            ]}
        ])
    );
}

#[test]
fn excludes_multiple_temporary_blocks_and_marks_an_earlier_message_when_the_latest_is_all_dynamic() {
    assert_eq!(
        input(vec![user(&["stable", "memory", "todo"])], Some(2)),
        json!([{"role": "user", "content": [
            {"type": "input_text", "text": "stable", "prompt_cache_breakpoint": marker()},
            {"type": "input_text", "text": "memory"},
            {"type": "input_text", "text": "todo"}
        ]}])
    );
    assert_eq!(
        input(vec![user(&["earlier"]), user(&["only dynamic"])], Some(1)),
        json!([
            {"role": "user", "content": [{"type": "input_text", "text": "earlier", "prompt_cache_breakpoint": marker()}]},
            {"role": "user", "content": [{"type": "input_text", "text": "only dynamic"}]}
        ])
    );
}

#[test]
fn puts_temporary_context_after_all_parallel_tool_outputs_and_keeps_replay_serialization_stable() {
    let results: Vec<ContentBlock> = vec![
        ToolResultBlock::success("a", vec!["one".into()]).into(),
        ToolResultBlock::success("b", vec!["two".into()]).into(),
    ];
    let tool_message = Message::new(Role::User, results.clone());
    let mut injected_content = results;
    injected_content.push(ContentBlock::text("temporary"));
    let injected = Message::new(Role::User, injected_content);
    let expected = json!([
        {"type": "function_call_output", "call_id": "a", "output": [{"type": "input_text", "text": "one"}]},
        {"type": "function_call_output", "call_id": "b", "output": [
            {"type": "input_text", "text": "two", "prompt_cache_breakpoint": marker()}
        ]}
    ]);
    let mut with_tail = expected.as_array().unwrap().clone();
    with_tail.push(json!({"role": "user", "content": [{"type": "input_text", "text": "temporary"}]}));
    assert_eq!(input(vec![injected], Some(1)), JsonValue::Array(with_tail));
    assert_eq!(input(vec![tool_message], None), expected);
}

#[test]
fn preserves_tool_calls_and_checkpoints_stable_input_when_injection_is_skipped_on_a_tool_continuation() {
    let call = Message::new(
        Role::Assistant,
        vec![ToolUseBlock::new("lookup", "a", json!({})).into()],
    );
    assert_eq!(
        input(vec![user(&["question"]), call], None),
        json!([
            {"role": "user", "content": [{"type": "input_text", "text": "question", "prompt_cache_breakpoint": marker()}]},
            {"type": "function_call", "call_id": "a", "name": "lookup", "arguments": "{}"}
        ])
    );
}

#[test]
fn marks_trailing_durable_media_as_the_checkpoint() {
    let message = Message::new(
        Role::User,
        vec![
            ContentBlock::text("stable"),
            png().into(),
            ContentBlock::text("temporary"),
        ],
    );
    assert_eq!(
        input(vec![message], Some(1)),
        json!([{"role": "user", "content": [
            {"type": "input_text", "text": "stable"},
            {"type": "input_image", "image_url": "data:image/png;base64,AQID", "prompt_cache_breakpoint": marker()},
            {"type": "input_text", "text": "temporary"}
        ]}])
    );
}

#[test]
fn checkpoints_durable_image_only_input() {
    let request = request_for(vec![Message::new(Role::User, vec![png().into()])], None);
    assert_eq!(request["prompt_cache_options"], json!({"mode": "explicit"}));
    assert_eq!(
        request["input"],
        json!([{"role": "user", "content": [
            {"type": "input_image", "image_url": "data:image/png;base64,AQID", "prompt_cache_breakpoint": marker()}
        ]}])
    );
}

#[test]
fn keeps_implicit_caching_when_no_durable_input_part_exists() {
    let request = request_for(vec![Message::assistant("hello")], None);
    assert!(request.get("prompt_cache_options").is_none());
    assert!(!request.to_string().contains("prompt_cache_breakpoint"));
}

#[test]
fn formats_tool_output_for_texts_and_dynamic_trailing_blocks() {
    let cases = [
        (
            vec!["one", "two"],
            0,
            json!([{"type": "input_text", "text": "one\ntwo", "prompt_cache_breakpoint": marker()}]),
        ),
        (vec!["out"], 1, json!([{"type": "input_text", "text": "out"}])),
        (vec![], 0, json!("")),
    ];
    for (texts, dynamic_trailing_blocks, output) in cases {
        let result: ContentBlock =
            ToolResultBlock::success("a", texts.iter().map(|text| (*text).into()).collect()).into();
        let blocks = if dynamic_trailing_blocks > 0 {
            vec![ContentBlock::text("durable"), result]
        } else {
            vec![result]
        };
        let items = input(vec![Message::new(Role::User, blocks)], Some(dynamic_trailing_blocks));
        assert_eq!(
            items.as_array().unwrap().last().unwrap(),
            &json!({"type": "function_call_output", "call_id": "a", "output": output}),
            "{texts:?}"
        );
    }
}

#[test]
fn avoids_implicit_writes_when_the_only_text_is_a_temporary_suffix() {
    let request = request_for(vec![user(&["temporary"])], Some(1));
    assert_eq!(request["prompt_cache_options"], json!({"mode": "explicit"}));
    assert_eq!(request["input"], text_input("temporary", None));
}

#[test]
fn retains_historical_lookup_boundaries_independently_of_the_provider_write_limit() {
    let texts: Vec<String> = (0..8).map(|turn| format!("turn {turn}")).collect();
    let messages: Vec<Message> = texts.iter().map(|text| user(&[text.as_str()])).collect();
    let formatted = input(messages, None);
    assert_eq!(formatted.to_string().matches("prompt_cache_breakpoint").count(), 8);
    let expected: Vec<JsonValue> = texts
        .iter()
        .map(|text| json!({"role": "user", "content": [{"type": "input_text", "text": text, "prompt_cache_breakpoint": marker()}]}))
        .collect();
    assert_eq!(formatted, JsonValue::Array(expected));
}

#[test]
fn follows_model_info_for_model_id_and_prompt_caching_override() {
    let cases = [
        ("gpt-5.6", None, true),
        ("gpt-6.1-terra", None, true),
        ("openai.gpt-6.1-sol", None, true),
        ("gpt-5.5", None, false),
        ("openai.gpt-6.1-terra", None, false),
        ("gpt-7-nova", None, false),
        ("gpt-6-sol", Some(PromptCaching::Auto), false),
        ("gpt-6-sol", Some(PromptCaching::Unsupported), false),
        ("my-finetune", Some(PromptCaching::CachePoints), true),
    ];
    for (model_id, prompt_caching, enabled) in cases {
        let mut config = config(model_id, Some(CacheConfig::default()));
        config.model_info = prompt_caching.map(|prompt_caching| ModelInfo {
            capabilities: ModelCapabilities {
                prompt_caching: Some(prompt_caching),
                ..Default::default()
            },
            ..Default::default()
        });
        let mut expected = json!({
            "model": model_id,
            "input": text_input("question", enabled.then(marker)),
            "stream": true,
            "store": false
        });
        if enabled {
            expected["prompt_cache_options"] = json!({"mode": "explicit"});
        }
        assert_eq!(format(config, vec![user(&["question"])], None), expected, "{model_id}");
    }
}

#[test]
fn places_checkpoints_with_cache_config() {
    let configs = [
        CacheConfig::default(),
        CacheConfig {
            strategy: Some(CacheStrategy::Anthropic),
            ..Default::default()
        },
        CacheConfig {
            messages_ttl: Some(true.into()),
            ..Default::default()
        },
        CacheConfig {
            cache_key: Some(CacheKey::Disabled),
            ..Default::default()
        },
    ];
    for cache_config in configs {
        let request = format(
            config("gpt-6-sol", Some(cache_config.clone())),
            vec![user(&["question"])],
            None,
        );
        assert_eq!(
            request["prompt_cache_options"],
            json!({"mode": "explicit"}),
            "{cache_config:?}"
        );
        assert_eq!(
            request["input"],
            text_input("question", Some(marker())),
            "{cache_config:?}"
        );
    }
}

#[test]
fn does_not_opt_in_with_cache_config() {
    let configs = [
        None,
        Some(CacheConfig {
            messages_ttl: Some(false.into()),
            ..Default::default()
        }),
    ];
    for cache_config in configs {
        assert_eq!(
            format(
                config("gpt-6-sol", cache_config.clone()),
                vec![user(&["question"])],
                None
            ),
            json!({"model": "gpt-6-sol", "input": text_input("question", None), "stream": true, "store": false}),
            "{cache_config:?}"
        );
    }
}

#[test]
fn maps_cache_lifetimes_for_cache_config_and_params() {
    let ttl = |ttl: &str| CacheConfig::builder().ttl(ttl).build();
    let messages_ttl = |messages_ttl: &str| CacheConfig {
        messages_ttl: Some(CacheSectionSetting::Ttl(messages_ttl.to_owned())),
        ..Default::default()
    };
    let cases = [
        (
            messages_ttl("12h"),
            json!({}),
            json!({"mode": "explicit", "ttl": "12h"}),
            json!({"mode": "explicit"}),
        ),
        (
            ttl("12h"),
            json!({}),
            marker(),
            json!({"mode": "explicit", "ttl": "12h"}),
        ),
        (
            CacheConfig {
                ttl: Some("12h".to_owned()),
                ..messages_ttl("30m")
            },
            json!({}),
            json!({"mode": "explicit", "ttl": "30m"}),
            json!({"mode": "explicit", "ttl": "12h"}),
        ),
        (
            ttl("12h"),
            json!({"prompt_cache_options": {"ttl": "30m"}}),
            marker(),
            json!({"mode": "explicit", "ttl": "30m"}),
        ),
    ];
    for (cache_config, params, checkpoint, options) in cases {
        let (logs, _guard) = record_logs();
        let mut model_config = config("gpt-6-sol", Some(cache_config.clone()));
        model_config.params = Some(params).filter(|params| params.as_object().is_some_and(|params| !params.is_empty()));
        let request = format(model_config, vec![user(&["question"])], None);
        assert_eq!(
            request,
            json!({
                "model": "gpt-6-sol",
                "input": text_input("question", Some(checkpoint)),
                "stream": true,
                "store": false,
                "prompt_cache_options": options
            }),
            "{cache_config:?}"
        );
        assert!(!logs.text().contains("WARN"), "{}", logs.text());
    }
}

#[test]
fn applies_a_cache_lifetime_ttl_without_checkpoints() {
    let cache_config = CacheConfig {
        ttl: Some("12h".to_owned()),
        messages_ttl: Some(false.into()),
        ..Default::default()
    };
    assert_eq!(
        format(config("gpt-6-sol", Some(cache_config)), vec![user(&["question"])], None),
        json!({
            "model": "gpt-6-sol",
            "input": text_input("question", None),
            "stream": true,
            "store": false,
            "prompt_cache_options": {"ttl": "12h"}
        })
    );
}

#[test]
fn ignores_an_invalid_messages_ttl_and_warns() {
    let warning = "messages_ttl=<1h> | cacheConfig.messagesTTL is not an openai cache lifetime, ignoring";
    forget_warning(warning);
    let (logs, _guard) = record_logs();
    let cache_config = CacheConfig {
        messages_ttl: Some("1h".into()),
        ..Default::default()
    };
    let request = format(config("gpt-6-sol", Some(cache_config)), vec![user(&["question"])], None);
    assert_eq!(request["input"], text_input("question", Some(marker())));
    assert_eq!(request["prompt_cache_options"], json!({"mode": "explicit"}));
    assert!(logs.text().contains(warning), "{}", logs.text());
}

#[test]
fn keeps_a_retention_literal_ttl_on_models_that_take_cache_points() {
    let request = format(
        config("gpt-6-sol", Some(CacheConfig::builder().ttl("24h").build())),
        vec![user(&["question"])],
        None,
    );
    assert_eq!(request["prompt_cache_retention"], "24h");
    assert_eq!(request["prompt_cache_options"], json!({"mode": "explicit"}));
}

#[test]
fn does_not_map_cache_lifetimes_on_models_without_cache_points() {
    let cache_config = CacheConfig {
        ttl: Some("12h".to_owned()),
        messages_ttl: Some("12h".into()),
        ..Default::default()
    };
    assert_eq!(
        format(config("gpt-5.5", Some(cache_config)), vec![user(&["question"])], None),
        json!({"model": "gpt-5.5", "input": text_input("question", None), "stream": true, "store": false})
    );
}

#[test]
fn lets_native_prompt_cache_options_win_over_the_explicit_default() {
    for options in [
        json!({"mode": "implicit", "ttl": "30m"}),
        json!({"mode": "explicit"}),
        json!({"ttl": "30m"}),
    ] {
        let mut model_config = default_config();
        model_config.params = Some(json!({"prompt_cache_options": options}));
        let request = format(model_config, vec![user(&["question"])], None);
        let mut expected = json!({"mode": "explicit"});
        for (key, value) in options.as_object().unwrap() {
            expected[key] = value.clone();
        }
        assert_eq!(request["prompt_cache_options"], expected, "{options}");
    }
}

#[test]
fn warns_once_that_tools_and_system_prompt_ttls_are_not_applied() {
    let warning = "openai responses caching | toolsTTL and systemPromptTTL are not applied";
    forget_warning(warning);
    let (logs, _guard) = record_logs();
    let cache_config = CacheConfig {
        tools_ttl: Some(false.into()),
        ..Default::default()
    };
    format(config("gpt-6-sol", Some(cache_config)), vec![user(&["question"])], None);
    assert!(logs.text().contains(warning), "{}", logs.text());
}
