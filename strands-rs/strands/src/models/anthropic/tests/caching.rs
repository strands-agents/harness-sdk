//! Prompt caching tests. Anthropic accepts at most 4 cache breakpoints per request and `ephemeral` is
//! the only cache type.

use serde_json::json;

use super::*;
use crate::models::{CacheKey, CacheSectionSetting, CacheStrategy};
use crate::types::{
    CachePointBlock, ImageBlock, ImageFormat, ImageSource, ReasoningBlock, Role, S3Location, SystemContentBlock,
    SystemPrompt, ToolResultBlock, ToolResultContent,
};

const MAX_BREAKPOINTS: usize = 4;

fn ephemeral() -> JsonValue {
    json!({"type": "ephemeral"})
}

fn ephemeral_ttl(ttl: &str) -> JsonValue {
    json!({"type": "ephemeral", "ttl": ttl})
}

/// Every `cache_control` in a request, across tools, system and messages.
fn breakpoints(request: &JsonValue) -> Vec<JsonValue> {
    let mut found = Vec::new();
    for tool in request["tools"].as_array().into_iter().flatten() {
        if let Some(control) = tool.get("cache_control") {
            found.push(json!(["tools", tool["name"], control]));
        }
    }
    for block in request["system"].as_array().into_iter().flatten() {
        if let Some(control) = block.get("cache_control") {
            found.push(json!(["system", block["type"], control]));
        }
    }
    for (index, message) in request["messages"].as_array().into_iter().flatten().enumerate() {
        for block in message["content"].as_array().into_iter().flatten() {
            if let Some(control) = block.get("cache_control") {
                found.push(json!(["messages", index, control]));
            }
        }
    }
    found
}

fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec::new("t1", "tool one").with_input_schema(json!({"type": "object"})),
        ToolSpec::new("t2", "tool two").with_input_schema(json!({"type": "object"})),
    ]
}

fn with_tools(messages: Vec<Message>) -> ModelRequest {
    ModelRequest {
        tool_specs: tool_specs(),
        ..request(messages)
    }
}

fn user(content: Vec<ContentBlock>) -> Message {
    Message::new(Role::User, content)
}

fn point() -> ContentBlock {
    CachePointBlock::new().into()
}

fn s3_image() -> ContentBlock {
    ImageBlock::new(
        ImageFormat::Png,
        ImageSource::Location(S3Location::new("s3://bucket/a.png")),
    )
    .into()
}

fn reasoning() -> ContentBlock {
    ReasoningBlock::new().with_text("thinking").with_signature("sig").into()
}

fn cached(cache_config: CacheConfig) -> AnthropicModelConfig {
    config().cache_config(cache_config).build()
}

fn auto() -> CacheConfig {
    CacheConfig::builder().strategy(CacheStrategy::Auto).build()
}

async fn sent(config: AnthropicModelConfig, request: ModelRequest) -> JsonValue {
    let client = MockClient::capture();
    collect(&model(&client, config), request).await.unwrap();
    client.last()
}

fn unsupported_caching() -> ModelInfo {
    ModelInfo {
        capabilities: ModelCapabilities {
            prompt_caching: Some(crate::models::PromptCaching::Unsupported),
            ..Default::default()
        },
        ..Default::default()
    }
}

#[tokio::test]
async fn is_off_when_unset() {
    let request = sent(AnthropicModelConfig::default(), with_tools(vec![Message::user("Hi")])).await;
    assert_eq!(breakpoints(&request), Vec::<JsonValue>::new());
}

#[tokio::test]
async fn is_off_under_auto_when_the_model_info_override_says_caching_is_unsupported() {
    let config = config()
        .cache_config(CacheConfig::builder().ttl("1h").build())
        .model_info(unsupported_caching())
        .build();
    let request = sent(config, with_tools(vec![Message::user("Hi")])).await;
    assert!(breakpoints(&request).is_empty());
}

#[tokio::test]
async fn caches_regardless_of_the_override_when_the_anthropic_strategy_is_explicit() {
    let config = config()
        .cache_config(
            CacheConfig::builder()
                .strategy(CacheStrategy::Anthropic)
                .ttl("1h")
                .build(),
        )
        .model_info(unsupported_caching())
        .build();
    let request = sent(config, with_tools(vec![Message::user("Hi")])).await;
    assert!(!breakpoints(&request).is_empty());
}

#[tokio::test]
async fn adds_a_breakpoint_to_the_last_user_message() {
    let request = sent(
        cached(auto()),
        request(vec![Message::user("one"), Message::user("two")]),
    )
    .await;
    assert_eq!(breakpoints(&request), [json!(["messages", 1, ephemeral()])]);
}

#[tokio::test]
async fn caches_every_section_when_no_strategy_is_given() {
    let request = sent(cached(CacheConfig::default()), with_tools(vec![Message::user("Hi")])).await;
    assert_eq!(
        breakpoints(&request),
        [json!(["tools", "t2", ephemeral()]), json!(["messages", 0, ephemeral()])]
    );
}

#[tokio::test]
async fn treats_auto_and_anthropic_strategies_the_same() {
    let auto_request = sent(cached(auto()), with_tools(vec![Message::user("Hi")])).await;
    let explicit = CacheConfig::builder().strategy(CacheStrategy::Anthropic).build();
    let explicit_request = sent(cached(explicit), with_tools(vec![Message::user("Hi")])).await;
    assert_eq!(auto_request, explicit_request);
}

#[tokio::test]
async fn ignores_cache_key_it_does_not_change_the_request_shape() {
    let without_key = sent(cached(CacheConfig::default()), with_tools(vec![Message::user("Hi")])).await;
    let keyed = CacheConfig::builder().cache_key(CacheKey::from("tenant-42")).build();
    let with_key = sent(cached(keyed), with_tools(vec![Message::user("Hi")])).await;
    assert_eq!(with_key, without_key);
}

#[tokio::test]
async fn carries_cache_config_ttl_onto_cache_control() {
    let cache = CacheConfig::builder().strategy(CacheStrategy::Auto).ttl("1h").build();
    let request = sent(cached(cache), hi()).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral_ttl("1h")])]);
}

#[tokio::test]
async fn caches_only_the_last_tool_definition() {
    let cache = CacheConfig::builder().messages_ttl(false).build();
    let request = sent(cached(cache), with_tools(vec![Message::user("Hi")])).await;
    assert_eq!(breakpoints(&request), [json!(["tools", "t2", ephemeral()])]);
    assert!(request["tools"][0].get("cache_control").is_none());
}

#[tokio::test]
async fn carries_a_tools_ttl_onto_cache_control() {
    let cache = CacheConfig::builder().tools_ttl("1h").messages_ttl(false).build();
    let request = sent(cached(cache), with_tools(vec![Message::user("Hi")])).await;
    assert_eq!(breakpoints(&request), [json!(["tools", "t2", ephemeral_ttl("1h")])]);
}

#[tokio::test]
async fn lets_a_per_section_ttl_override_the_shared_ttl() {
    let cache = CacheConfig::builder().ttl("5m").tools_ttl("1h").build();
    let request = sent(cached(cache), with_tools(vec![Message::user("Hi")])).await;
    assert_eq!(
        breakpoints(&request),
        [
            json!(["tools", "t2", ephemeral_ttl("1h")]),
            json!(["messages", 0, ephemeral_ttl("5m")])
        ]
    );
}

#[tokio::test]
async fn normalizes_a_bedrock_cache_point_type_to_ephemeral() {
    let request = sent(
        AnthropicModelConfig::default(),
        request(vec![user(vec![ContentBlock::text("hi"), point()])]),
    )
    .await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
}

#[tokio::test]
async fn is_a_no_op_for_the_tools_section_when_there_are_no_tools() {
    let request = sent(cached(CacheConfig::builder().messages_ttl(false).build()), hi()).await;
    assert!(request.get("tools").is_none());
    assert!(breakpoints(&request).is_empty());
}

#[tokio::test]
async fn caches_only_the_conversation_when_tools_ttl_is_false() {
    let request = sent(
        cached(CacheConfig::builder().tools_ttl(false).build()),
        with_tools(vec![Message::user("Hi")]),
    )
    .await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
}

#[tokio::test]
async fn produces_two_breakpoints_when_both_sections_are_on() {
    let request = sent(cached(auto()), with_tools(vec![Message::user("Hi")])).await;
    let found = breakpoints(&request);
    assert_eq!(
        found,
        [json!(["tools", "t2", ephemeral()]), json!(["messages", 0, ephemeral()])]
    );
    assert!(found.len() <= MAX_BREAKPOINTS);
}

#[tokio::test]
async fn emits_nothing_when_every_section_is_disabled() {
    let cache = CacheConfig::builder().tools_ttl(false).messages_ttl(false).build();
    let request = sent(cached(cache), with_tools(vec![Message::user("Hi")])).await;
    assert!(breakpoints(&request).is_empty());
}

#[tokio::test]
async fn does_not_accumulate_breakpoints_across_turns() {
    let mut messages = Vec::new();
    for turn in 0..25 {
        messages.push(user(vec![ContentBlock::text(format!("question {turn}")), point()]));
        let result = ToolResultBlock::success(
            format!("t{turn}"),
            vec![ToolResultContent::text(format!("result {turn}"))],
        );
        messages.push(user(vec![result.into(), point()]));
    }
    let last = messages.len() - 1;
    let request = sent(cached(auto()), with_tools(messages)).await;
    let found = breakpoints(&request);
    assert!(found.len() <= MAX_BREAKPOINTS);
    let message_breakpoints: Vec<&JsonValue> = found.iter().filter(|point| point[0] == "messages").collect();
    assert_eq!(message_breakpoints, [&json!(["messages", last, ephemeral()])]);
}

#[tokio::test]
async fn strips_a_cache_point_in_an_earlier_message() {
    let messages = vec![
        user(vec![ContentBlock::text("one"), point()]),
        Message::assistant("two"),
        Message::user("three"),
    ];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 2, ephemeral()])]);
    assert_eq!(
        request["messages"][0]["content"],
        json!([{"type": "text", "text": "one"}])
    );
}

#[tokio::test]
async fn places_the_breakpoint_after_the_last_cacheable_block() {
    let request = sent(
        cached(auto()),
        request(vec![user(vec![ContentBlock::text("question"), reasoning()])]),
    )
    .await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    assert_eq!(
        request["messages"][0]["content"][0],
        json!({"type": "text", "text": "question", "cache_control": ephemeral()})
    );
    assert!(request["messages"][0]["content"][1].get("cache_control").is_none());
}

#[tokio::test]
async fn skips_a_history_with_no_cacheable_user_content() {
    let request = sent(cached(auto()), request(vec![Message::assistant("hello")])).await;
    assert!(breakpoints(&request).is_empty());
}

#[tokio::test]
async fn strips_hand_placed_cache_points_even_when_there_is_nothing_to_cache() {
    let messages = vec![Message::new(
        Role::Assistant,
        vec![ContentBlock::text("hello"), point()],
    )];
    let request = sent(cached(auto()), request(messages)).await;
    assert!(breakpoints(&request).is_empty());
}

#[tokio::test]
async fn honors_the_ttl_on_a_hand_placed_cache_point() {
    let messages = vec![user(vec![
        ContentBlock::text("one"),
        CachePointBlock::new().with_ttl("1h").into(),
    ])];
    let request = sent(AnthropicModelConfig::default(), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral_ttl("1h")])]);
}

#[tokio::test]
async fn honors_the_ttl_on_a_system_prompt_cache_point() {
    let request = ModelRequest {
        system_prompt: Some(SystemPrompt::Blocks(vec![
            SystemContentBlock::text("Heavy context"),
            CachePointBlock::new().with_ttl("1h").into(),
        ])),
        ..hi()
    };
    let request = sent(AnthropicModelConfig::default(), request).await;
    assert_eq!(request["system"][0]["cache_control"], ephemeral_ttl("1h"));
}

fn with_system(system_prompt: SystemPrompt) -> ModelRequest {
    ModelRequest {
        system_prompt: Some(system_prompt),
        ..hi()
    }
}

#[tokio::test]
async fn caches_a_string_system_prompt_by_promoting_it_to_a_block() {
    let request = sent(cached(auto()), with_system("static prompt".into())).await;
    assert_eq!(
        request["system"],
        json!([{"type": "text", "text": "static prompt", "cache_control": ephemeral()}])
    );
}

#[tokio::test]
async fn auto_injects_a_system_cache_point_on_the_last_block_of_an_array_prompt() {
    let system = SystemPrompt::Blocks(vec![
        SystemContentBlock::text("Heavy context"),
        SystemContentBlock::text("More context"),
    ]);
    let request = sent(cached(auto()), with_system(system)).await;
    assert_eq!(
        breakpoints(&request),
        [
            json!(["system", "text", ephemeral()]),
            json!(["messages", 0, ephemeral()])
        ]
    );
    assert!(request["system"][0].get("cache_control").is_none());
    assert_eq!(request["system"][1]["cache_control"], ephemeral());
}

#[tokio::test]
async fn carries_system_prompt_ttl_into_the_auto_injected_system_cache_point() {
    let cache = CacheConfig::builder()
        .strategy(CacheStrategy::Auto)
        .system_prompt_ttl("1h")
        .build();
    let request = sent(cached(cache), with_system("static prompt".into())).await;
    assert_eq!(request["system"][0]["cache_control"], ephemeral_ttl("1h"));
}

#[tokio::test]
async fn does_not_auto_inject_a_system_cache_point_when_system_prompt_ttl_is_false() {
    let cache = CacheConfig::builder()
        .strategy(CacheStrategy::Auto)
        .system_prompt_ttl(CacheSectionSetting::Enabled(false))
        .build();
    let request = sent(cached(cache), with_system("static prompt".into())).await;
    assert_eq!(request["system"], "static prompt");
}

#[tokio::test]
async fn does_not_double_a_hand_placed_system_cache_point() {
    let system = SystemPrompt::Blocks(vec![
        SystemContentBlock::text("Heavy context"),
        CachePointBlock::new().into(),
        SystemContentBlock::text("Light context"),
    ]);
    let request = sent(cached(auto()), with_system(system)).await;
    assert_eq!(
        breakpoints(&request),
        [
            json!(["system", "text", ephemeral()]),
            json!(["messages", 0, ephemeral()])
        ]
    );
    assert_eq!(request["system"][0]["cache_control"], ephemeral());
    assert!(request["system"][1].get("cache_control").is_none());
}

#[tokio::test]
async fn keeps_the_breakpoint_when_the_last_cacheable_block_is_dropped_in_translation() {
    let messages = vec![user(vec![ContentBlock::text("long prefix"), s3_image()])];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    assert_eq!(
        request["messages"][0]["content"][0],
        json!({"type": "text", "text": "long prefix", "cache_control": ephemeral()})
    );
}

#[tokio::test]
async fn never_places_a_breakpoint_on_a_reasoning_block() {
    let request = sent(cached(auto()), request(vec![user(vec![reasoning(), s3_image()])])).await;
    assert!(breakpoints(&request).is_empty());
}

#[tokio::test]
async fn does_not_fall_back_to_an_earlier_turn_when_the_newest_one_has_nothing_cacheable() {
    let messages = vec![
        Message::user("turn one"),
        Message::assistant("reply"),
        user(vec![reasoning()]),
    ];
    let request = sent(cached(auto()), request(messages)).await;
    assert!(breakpoints(&request).is_empty());
}

#[tokio::test]
async fn places_the_breakpoint_on_the_last_of_several_cacheable_blocks() {
    let result = ToolResultBlock::success("x", vec![ToolResultContent::text("second")]);
    let request = sent(
        cached(auto()),
        request(vec![user(vec![ContentBlock::text("first"), result.into()])]),
    )
    .await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    assert!(request["messages"][0]["content"][0].get("cache_control").is_none());
    assert_eq!(request["messages"][0]["content"][1]["type"], "tool_result");
    assert_eq!(request["messages"][0]["content"][1]["cache_control"], ephemeral());
}

#[tokio::test]
async fn treats_an_empty_ttl_as_unset_rather_than_shipping_it() {
    let cache = CacheConfig::builder().ttl("").tools_ttl("").build();
    let request = sent(cached(cache), with_tools(vec![Message::user("Hi")])).await;
    assert_eq!(
        breakpoints(&request),
        [json!(["tools", "t2", ephemeral()]), json!(["messages", 0, ephemeral()])]
    );
}

#[tokio::test]
async fn treats_an_empty_ttl_on_a_hand_placed_cache_point_as_unset() {
    let cache = CacheConfig::builder().strategy(CacheStrategy::Auto).ttl("1h").build();
    let messages = vec![user(vec![
        ContentBlock::text("prefix"),
        CachePointBlock::new().with_ttl("").into(),
        ContentBlock::text("volatile"),
    ])];
    let request = sent(cached(cache), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral_ttl("1h")])]);
}

#[tokio::test]
async fn honors_a_cache_point_in_the_last_user_message() {
    let (logs, _guard) = record_logs();
    let messages = vec![user(vec![
        ContentBlock::text("stable prefix"),
        point(),
        ContentBlock::text("volatile per-call content"),
    ])];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    let content = request["messages"][0]["content"].as_array().unwrap();
    assert_eq!(content.len(), 2);
    assert_eq!(content[0]["cache_control"], ephemeral());
    assert!(content[1].get("cache_control").is_none());
    assert!(!logs.text().contains("stripped extra cache points"));
}

#[tokio::test]
async fn strips_extra_cache_points_in_the_last_user_message() {
    let (logs, _guard) = record_logs();
    let messages = vec![user(vec![
        ContentBlock::text("a"),
        point(),
        ContentBlock::text("b"),
        point(),
        ContentBlock::text("c"),
        point(),
    ])];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    assert_eq!(request["messages"][0]["content"][0]["cache_control"], ephemeral());
    let logs = logs.text();
    assert!(
        logs.contains("count=<2>") && logs.contains("stripped extra cache points"),
        "{logs}"
    );
}

#[tokio::test]
async fn warns_when_it_strips_cache_points_outside_the_honored_one() {
    let (logs, _guard) = record_logs();
    let messages = vec![
        user(vec![ContentBlock::text("stable"), point()]),
        Message::assistant("reply"),
        user(vec![ContentBlock::text("newest"), point()]),
    ];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 2, ephemeral()])]);
    let logs = logs.text();
    assert!(
        logs.contains("count=<1>") && logs.contains("stripped extra cache points"),
        "{logs}"
    );
}

#[tokio::test]
async fn does_not_warn_about_stripping_when_the_caller_placed_no_cache_points() {
    let (logs, _guard) = record_logs();
    sent(
        cached(auto()),
        request(vec![Message::user("no hand-placed points here")]),
    )
    .await;
    assert!(!logs.text().contains("stripped extra cache points"));
}

#[tokio::test]
async fn gives_an_honored_cache_point_the_configured_ttl() {
    let cache = CacheConfig::builder().strategy(CacheStrategy::Auto).ttl("1h").build();
    let messages = vec![user(vec![
        ContentBlock::text("stable"),
        point(),
        ContentBlock::text("volatile"),
    ])];
    let request = sent(cached(cache), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral_ttl("1h")])]);
}

#[tokio::test]
async fn lets_a_hand_placed_ttl_win_over_the_configured_one() {
    let cache = CacheConfig::builder().strategy(CacheStrategy::Auto).ttl("1h").build();
    let messages = vec![user(vec![
        ContentBlock::text("stable"),
        CachePointBlock::new().with_ttl("5m").into(),
        ContentBlock::text("volatile"),
    ])];
    let request = sent(cached(cache), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral_ttl("5m")])]);
}

#[tokio::test]
async fn honors_a_cache_point_on_the_nearest_acceptable_block_ahead_of_it() {
    let messages = vec![user(vec![
        ContentBlock::text("stable"),
        ReasoningBlock::new().with_text("r").with_signature("s").into(),
        point(),
        ContentBlock::text("volatile"),
    ])];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    let content = request["messages"][0]["content"].as_array().unwrap();
    assert_eq!(content[0]["cache_control"], ephemeral());
    assert!(content[1].get("cache_control").is_none());
    assert!(content[2].get("cache_control").is_none());
}

#[tokio::test]
async fn falls_back_to_automatic_placement_for_a_leading_cache_point() {
    let (logs, _guard) = record_logs();
    let request = sent(
        cached(auto()),
        request(vec![user(vec![point(), ContentBlock::text("one")])]),
    )
    .await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    assert!(logs.text().contains("falling back to automatic placement"));
}

#[tokio::test]
async fn falls_back_to_automatic_placement_when_everything_ahead_is_dropped_in_translation() {
    let messages = vec![user(vec![s3_image(), point(), ContentBlock::text("volatile")])];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(
        request["messages"][0]["content"],
        json!([{"type": "text", "text": "volatile", "cache_control": ephemeral()}])
    );
}

#[tokio::test]
async fn falls_back_to_automatic_placement_when_only_a_reasoning_block_is_ahead_of_the_point() {
    let messages = vec![user(vec![
        ReasoningBlock::new().with_text("r").with_signature("s").into(),
        point(),
        ContentBlock::text("volatile"),
    ])];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    let content = request["messages"][0]["content"].as_array().unwrap();
    assert!(content[0].get("cache_control").is_none());
    assert_eq!(content[1]["cache_control"], ephemeral());
}

#[tokio::test]
async fn does_not_treat_a_cache_point_only_last_user_message_as_the_target() {
    let (logs, _guard) = record_logs();
    let request = sent(
        cached(auto()),
        request(vec![Message::user("stable"), user(vec![point()])]),
    )
    .await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    assert!(logs.text().contains("count=<1>"));
}

#[tokio::test]
async fn never_emits_more_than_one_message_breakpoint_when_it_honors_a_point() {
    let messages = vec![user(vec![
        ContentBlock::text("a"),
        point(),
        ContentBlock::text("b"),
        ContentBlock::text("c"),
    ])];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(breakpoints(&request).len(), 1);
}

#[tokio::test]
async fn honors_a_hand_placed_cache_point_when_cache_config_is_unset() {
    let messages = vec![user(vec![
        ContentBlock::text("stable prefix"),
        point(),
        ContentBlock::text("volatile per-call content"),
    ])];
    let request = sent(AnthropicModelConfig::default(), request(messages)).await;
    let content = request["messages"][0]["content"].as_array().unwrap();
    assert_eq!(content[0]["cache_control"], ephemeral());
    assert!(content[1].get("cache_control").is_none());
}

#[tokio::test]
async fn does_not_mutate_the_callers_messages() {
    let messages = vec![user(vec![ContentBlock::text("hello"), point()])];
    let before = serde_json::to_value(&messages).unwrap();
    sent(cached(auto()), with_tools(messages.clone())).await;
    assert_eq!(serde_json::to_value(&messages).unwrap(), before);
}

#[tokio::test]
async fn attaches_a_hand_placed_cache_point_to_the_nearest_block_that_accepts_one() {
    let messages = vec![user(vec![ContentBlock::text("question"), reasoning(), point()])];
    let request = sent(AnthropicModelConfig::default(), request(messages)).await;
    assert_eq!(request["messages"][0]["content"][0]["cache_control"], ephemeral());
    assert!(request["messages"][0]["content"][1].get("cache_control").is_none());
}

// The mirror of this test is test_cross_sdk_media_request_parity in
// strands-py/tests/strands/models/test_anthropic.py.
#[tokio::test]
async fn pins_the_media_request_body_shared_with_strands_py() {
    let image = ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3]));
    let messages = vec![user(vec![ContentBlock::text("prefix"), image.into(), s3_image()])];
    let request = sent(cached(auto()), request(messages)).await;
    assert_eq!(
        request["messages"],
        json!([{
            "role": "user",
            "content": [
                {"type": "text", "text": "prefix"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AQID"}, "cache_control": ephemeral()}
            ]
        }])
    );
}

// The mirror of this test is test_cross_sdk_request_parity in
// strands-py/tests/strands/models/test_anthropic.py.
#[tokio::test]
async fn pins_the_request_body_shared_with_strands_py() {
    let cache = CacheConfig::builder().strategy(CacheStrategy::Auto).ttl("1h").build();
    let messages = vec![Message::user("hello"), Message::assistant("hi"), Message::user("again")];
    let request = sent(cached(cache), with_tools(messages)).await;
    assert_eq!(
        request["tools"],
        json!([
            {"name": "t1", "description": "tool one", "input_schema": {"type": "object"}},
            {"name": "t2", "description": "tool two", "input_schema": {"type": "object"}, "cache_control": ephemeral_ttl("1h")}
        ])
    );
    assert_eq!(
        request["messages"],
        json!([
            {"role": "user", "content": [{"type": "text", "text": "hello"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
            {"role": "user", "content": [{"type": "text", "text": "again", "cache_control": ephemeral_ttl("1h")}]}
        ])
    );
}

fn trailing(messages: Vec<Message>, dynamic_trailing_blocks: usize) -> ModelRequest {
    ModelRequest {
        dynamic_trailing_blocks: Some(dynamic_trailing_blocks),
        ..request(messages)
    }
}

#[tokio::test]
async fn keeps_the_cache_point_ahead_of_per_call_trailing_content() {
    let message = user(vec![ContentBlock::text("durable ask"), ContentBlock::text("per-call")]);
    let request = sent(cached(auto()), trailing(vec![message], 1)).await;
    assert_eq!(
        request["messages"][0]["content"],
        json!([
            {"type": "text", "text": "durable ask", "cache_control": ephemeral()},
            {"type": "text", "text": "per-call"}
        ])
    );
}

#[tokio::test]
async fn keeps_the_cache_point_ahead_of_a_multi_block_per_call_tail() {
    let message = user(vec![
        ContentBlock::text("durable ask"),
        ContentBlock::text("injected"),
        ContentBlock::text("status"),
    ]);
    let request = sent(cached(auto()), trailing(vec![message], 2)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral()])]);
    assert_eq!(request["messages"][0]["content"][0]["cache_control"], ephemeral());
}

#[tokio::test]
async fn skips_the_cache_point_when_nothing_durable_precedes_the_per_call_tail() {
    let request = sent(cached(auto()), trailing(vec![Message::user("per-call only")], 1)).await;
    assert!(breakpoints(&request).is_empty());
}

#[tokio::test]
async fn carries_the_configured_ttl_onto_the_per_call_tail_cache_point() {
    let cache = CacheConfig::builder().strategy(CacheStrategy::Auto).ttl("1h").build();
    let message = user(vec![ContentBlock::text("durable ask"), ContentBlock::text("per-call")]);
    let request = sent(cached(cache), trailing(vec![message], 1)).await;
    assert_eq!(breakpoints(&request), [json!(["messages", 0, ephemeral_ttl("1h")])]);
}

#[tokio::test]
async fn emits_no_cache_point_for_a_per_call_tail_without_cache_config() {
    let message = user(vec![ContentBlock::text("durable ask"), ContentBlock::text("per-call")]);
    let request = sent(AnthropicModelConfig::default(), trailing(vec![message], 1)).await;
    assert!(breakpoints(&request).is_empty());
}

/// Cache config portability: one `cache_config` means the same on every provider, compared as the
/// TTLs of the cache points per section.
#[tokio::test]
async fn agrees_on_cache_config_across_providers() {
    let ttls = |points: Vec<&JsonValue>| -> Vec<JsonValue> {
        points
            .into_iter()
            .map(|control| control.get("ttl").cloned().unwrap_or(JsonValue::Null))
            .collect()
    };
    let cases = [
        (CacheConfig::default(), json!({"tools": [null], "messages": [null]})),
        (
            CacheConfig::builder().ttl("1h").build(),
            json!({"tools": ["1h"], "messages": ["1h"]}),
        ),
        (
            CacheConfig::builder().ttl("1h").messages_ttl(false).build(),
            json!({"tools": ["1h"], "messages": []}),
        ),
        (
            CacheConfig::builder().ttl("1h").tools_ttl(false).build(),
            json!({"tools": [], "messages": ["1h"]}),
        ),
        (
            CacheConfig::builder().ttl("1h").messages_ttl("5m").build(),
            json!({"tools": ["1h"], "messages": ["5m"]}),
        ),
        (
            CacheConfig::builder().ttl("").build(),
            json!({"tools": [null], "messages": [null]}),
        ),
        (
            CacheConfig::builder().tools_ttl(false).messages_ttl(false).build(),
            json!({"tools": [], "messages": []}),
        ),
    ];
    for (cache_config, expected) in cases {
        let request = ModelRequest {
            tool_specs: vec![ToolSpec::new("calculator", "Calculate").with_input_schema(json!({"type": "object"}))],
            ..request(vec![Message::user("durable prefix")])
        };
        let sent = sent(
            config()
                .model_id("claude-sonnet-4-6")
                .cache_config(cache_config.clone())
                .build(),
            request,
        )
        .await;
        let tools: Vec<&JsonValue> = sent["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|tool| tool.get("cache_control"))
            .collect();
        let messages: Vec<&JsonValue> = sent["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|message| message["content"].as_array().into_iter().flatten())
            .filter_map(|block| block.get("cache_control"))
            .collect();
        assert_eq!(
            json!({"tools": ttls(tools), "messages": ttls(messages)}),
            expected,
            "{cache_config:?}"
        );
    }
}
