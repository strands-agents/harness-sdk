//! System prompt formatting tests: system prompt shapes, cache sections, caller-placed cache
//! points, per-call trailing blocks and the document rule.

use serde_json::{Value, json};

use super::*;
use crate::models::{CacheConfig, CacheSectionSetting, CacheStrategy};
use crate::types::{
    CachePointBlock, DocumentBlock, DocumentFormat, DocumentSource, GuardContentImage, GuardContentText,
    GuardImageFormat, GuardQualifier, SystemContentBlock,
};

fn cached(cache_config: CacheConfig) -> BedrockModelConfig {
    BedrockModelConfig {
        cache_config: Some(cache_config),
        ..BedrockModelConfig::default()
    }
}

fn auto() -> CacheConfig {
    CacheConfig {
        strategy: Some(CacheStrategy::Auto),
        ..CacheConfig::default()
    }
}

fn ttl(value: &str) -> Option<CacheSectionSetting> {
    Some(CacheSectionSetting::from(value))
}

fn off() -> Option<CacheSectionSetting> {
    Some(CacheSectionSetting::Enabled(false))
}

async fn sent(config: BedrockModelConfig, messages: Vec<Message>, options: Options) -> Value {
    let (model, transport) = provider(config);
    run(&model, request(messages, options)).await;
    transport.last()
}

async fn first_content(config: BedrockModelConfig, content: Vec<ContentBlock>, options: Options) -> Value {
    sent(config, vec![user(content)], options).await["messages"][0]["content"].clone()
}

fn text(value: &str) -> ContentBlock {
    ContentBlock::text(value)
}

fn point() -> ContentBlock {
    ContentBlock::CachePoint(CachePointBlock::new())
}

fn point_ttl(value: &str) -> ContentBlock {
    ContentBlock::CachePoint(CachePointBlock::new().with_ttl(value))
}

fn document(name: &str, format: DocumentFormat, byte: u8) -> ContentBlock {
    ContentBlock::Document(DocumentBlock::new(name, format, DocumentSource::Bytes(vec![byte])))
}

fn document_json(name: &str, format: &str, byte: u8) -> Value {
    let bytes = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [byte]);
    json!({"document": {"name": name, "format": format, "source": {"bytes": bytes}}})
}

fn system(system_prompt: impl Into<SystemPrompt>) -> Options {
    Options {
        system_prompt: Some(system_prompt.into()),
        ..Options::default()
    }
}

fn system_blocks(blocks: Vec<SystemContentBlock>) -> Options {
    system(SystemPrompt::Blocks(blocks))
}

fn calculator() -> Vec<ToolSpec> {
    vec![ToolSpec::new("calculator", "Calculate").with_input_schema(json!({"type": "object"}))]
}

fn with_tools(options: Options) -> Options {
    Options {
        tool_specs: calculator(),
        ..options
    }
}

fn tools_only() -> Options {
    with_tools(Options::default())
}

fn cache_point(ttl: Option<&str>) -> Value {
    match ttl {
        Some(ttl) => json!({"type": "default", "ttl": ttl}),
        None => json!({"type": "default"}),
    }
}

/// The auto-injected cache points as `[tools, last user message]`.
fn cache_points(request: &Value) -> [Value; 2] {
    let tools_last = request["toolConfig"]["tools"]
        .as_array()
        .and_then(|tools| tools.last())
        .cloned();
    let message_last = request["messages"][0]["content"]
        .as_array()
        .and_then(|content| content.last())
        .cloned();
    let point = |block: Option<Value>| {
        block
            .and_then(|block| block.get("cachePoint").cloned())
            .unwrap_or(Value::Null)
    };
    [point(tools_last), point(message_last)]
}

/// The cache points in `system`, in order.
fn system_cache_points(request: &Value) -> Vec<Value> {
    request["system"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| block.get("cachePoint").cloned())
        .collect()
}

fn system_prompt_with(ttl: Option<&str>) -> Options {
    let point = match ttl {
        Some(ttl) => CachePointBlock::new().with_ttl(ttl),
        None => CachePointBlock::new(),
    };
    system_blocks(vec![
        SystemContentBlock::text("durable system prompt"),
        SystemContentBlock::CachePoint(point),
    ])
}

#[tokio::test]
async fn appends_a_cache_point_to_a_string_system_prompt_with_cache_config() {
    assert_eq!(
        sent(cached(auto()), hello(), system("You are a helpful assistant")).await,
        json!({
            "inferenceConfig": {"maxTokens": 128_000},
            "modelId": "global.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": [{"text": "Hello"}, {"cachePoint": {"type": "default"}}]}],
            "system": [{"text": "You are a helpful assistant"}, {"cachePoint": {"type": "default"}}]
        })
    );
}

#[tokio::test]
async fn formats_array_system_prompt_with_text_blocks_only() {
    let options = system_blocks(vec![
        SystemContentBlock::text("You are a helpful assistant"),
        SystemContentBlock::text("Additional context here"),
    ]);
    assert_eq!(
        sent(BedrockModelConfig::default(), hello(), options).await["system"],
        json!([{"text": "You are a helpful assistant"}, {"text": "Additional context here"}])
    );
}

#[tokio::test]
async fn formats_array_system_prompt_with_cache_points() {
    let options = system_blocks(vec![
        SystemContentBlock::text("You are a helpful assistant"),
        SystemContentBlock::text("Large context document"),
        SystemContentBlock::CachePoint(CachePointBlock::new()),
    ]);
    let request = sent(BedrockModelConfig::default(), hello(), options).await;
    assert_eq!(
        request["system"],
        json!([{"text": "You are a helpful assistant"}, {"text": "Large context document"}, {"cachePoint": {"type": "default"}}])
    );
    assert_eq!(
        request["messages"],
        json!([{"role": "user", "content": [{"text": "Hello"}]}])
    );
}

#[tokio::test]
async fn does_not_warn_when_array_system_prompt_is_provided_without_cache_config() {
    let (logs, _guard) = crate::test_support::record_logs();
    let options = system_blocks(vec![
        SystemContentBlock::text("You are a helpful assistant"),
        SystemContentBlock::CachePoint(CachePointBlock::new()),
    ]);
    let request = sent(with_model_id("global.anthropic.claude-sonnet-4-6"), hello(), options).await;
    assert!(!logs.text().contains("WARN"), "{}", logs.text());
    assert_eq!(
        request["system"],
        json!([{"text": "You are a helpful assistant"}, {"cachePoint": {"type": "default"}}])
    );
}

#[tokio::test]
async fn adds_cache_point_after_tools_when_cache_config_enabled() {
    assert_eq!(
        sent(cached(auto()), hello(), tools_only()).await,
        json!({
            "inferenceConfig": {"maxTokens": 128_000},
            "modelId": "global.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": [{"text": "Hello"}, {"cachePoint": {"type": "default"}}]}],
            "toolConfig": {"tools": [
                {"toolSpec": {"name": "calculator", "description": "Calculate", "inputSchema": {"json": {"type": "object"}}}},
                {"cachePoint": {"type": "default"}}
            ]}
        })
    );
}

#[tokio::test]
async fn adds_cache_points_to_tools_and_messages_when_cache_config_enabled() {
    let messages = vec![Message::user("Hello"), Message::assistant("Hi")];
    let request = sent(
        cached(auto()),
        messages,
        with_tools(system("You are a helpful assistant")),
    )
    .await;
    assert_eq!(
        request["system"],
        json!([{"text": "You are a helpful assistant"}, {"cachePoint": {"type": "default"}}])
    );
    assert_eq!(
        request["toolConfig"]["tools"][1],
        json!({"cachePoint": {"type": "default"}})
    );
    assert_eq!(
        request["messages"][0]["content"][1],
        json!({"cachePoint": {"type": "default"}})
    );
    assert_eq!(request["messages"][1]["content"], json!([{"text": "Hi"}]));
}

#[tokio::test]
async fn propagates_cache_config_ttls_independently_to_tools_and_last_user_message() {
    let config = cached(CacheConfig {
        tools_ttl: ttl("1h"),
        messages_ttl: ttl("5m"),
        ..auto()
    });
    let request = sent(config, hello(), tools_only()).await;
    assert_eq!(
        cache_points(&request),
        [cache_point(Some("1h")), cache_point(Some("5m"))]
    );
}

#[tokio::test]
async fn propagates_only_tools_ttl_when_messages_ttl_is_not_set() {
    let request = sent(
        cached(CacheConfig {
            tools_ttl: ttl("1h"),
            ..auto()
        }),
        hello(),
        tools_only(),
    )
    .await;
    assert_eq!(cache_points(&request), [cache_point(Some("1h")), cache_point(None)]);
}

#[tokio::test]
async fn propagates_only_messages_ttl_when_tools_ttl_is_not_set() {
    let request = sent(
        cached(CacheConfig {
            messages_ttl: ttl("1h"),
            ..auto()
        }),
        hello(),
        tools_only(),
    )
    .await;
    assert_eq!(cache_points(&request), [cache_point(None), cache_point(Some("1h"))]);
}

#[tokio::test]
async fn omits_ttl_on_auto_injected_cache_points_when_no_ttl_is_set() {
    let request = sent(cached(auto()), hello(), tools_only()).await;
    assert_eq!(cache_points(&request), [cache_point(None), cache_point(None)]);
}

#[tokio::test]
async fn replaces_a_leading_caller_placed_cache_point_with_automatic_placement() {
    let content = first_content(cached(auto()), vec![point(), text("durable ask")], Options::default()).await;
    assert_eq!(
        content,
        json!([{"text": "durable ask"}, {"cachePoint": {"type": "default"}}])
    );
}

#[tokio::test]
async fn leaves_a_message_that_was_only_a_cache_point_empty() {
    let content = first_content(cached(auto()), vec![point()], Options::default()).await;
    assert_eq!(content, json!([]));
}

#[tokio::test]
async fn honors_a_cache_point_the_caller_placed_in_the_last_user_message() {
    let content = first_content(
        cached(auto()),
        vec![
            text("durable ask"),
            point(),
            text("<context-status>rebuilt each call</context-status>"),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([
            {"text": "durable ask"},
            {"cachePoint": {"type": "default"}},
            {"text": "<context-status>rebuilt each call</context-status>"}
        ])
    );
}

#[tokio::test]
async fn keeps_only_the_first_of_three_cache_points_and_gives_it_the_configured_ttl() {
    let content = first_content(
        cached(CacheConfig {
            messages_ttl: ttl("1h"),
            ..auto()
        }),
        vec![
            text("durable ask"),
            point(),
            text("per-call"),
            point(),
            text("more per-call"),
            point(),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([
            {"text": "durable ask"},
            {"cachePoint": {"type": "default", "ttl": "1h"}},
            {"text": "per-call"},
            {"text": "more per-call"}
        ])
    );
}

#[tokio::test]
async fn relocates_an_honored_cache_point_over_the_adjacent_document_run_only() {
    let content = first_content(
        cached(auto()),
        vec![
            text("analyze these"),
            document("earlier", DocumentFormat::Md, 1),
            text("notes"),
            document("adjacent", DocumentFormat::Md, 2),
            point(),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([
            {"text": "analyze these"},
            document_json("earlier", "md", 1),
            {"text": "notes"},
            {"cachePoint": {"type": "default"}},
            document_json("adjacent", "md", 2)
        ])
    );
}

#[tokio::test]
async fn still_strips_cache_points_in_earlier_messages() {
    let messages = vec![
        user(vec![text("old ask"), point()]),
        Message::assistant("reply"),
        user(vec![text("new ask"), point()]),
    ];
    let request = sent(cached(auto()), messages, Options::default()).await;
    let contents: Vec<Value> = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["content"].clone())
        .collect();
    assert_eq!(
        contents,
        [
            json!([{"text": "old ask"}]),
            json!([{"text": "reply"}]),
            json!([{"text": "new ask"}, {"cachePoint": {"type": "default"}}])
        ]
    );
}

#[tokio::test]
async fn applies_the_configured_messages_ttl_to_an_honored_cache_point_without_one() {
    let content = first_content(
        cached(CacheConfig {
            messages_ttl: ttl("1h"),
            ..auto()
        }),
        vec![text("durable ask"), point(), text("per-call")],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "durable ask"}, {"cachePoint": {"type": "default", "ttl": "1h"}}, {"text": "per-call"}])
    );
}

#[tokio::test]
async fn applies_the_configured_messages_ttl_over_a_null_ttl_on_the_caller_point() {
    let content = first_content(
        cached(CacheConfig {
            messages_ttl: ttl("1h"),
            ..auto()
        }),
        vec![text("durable ask"), point_ttl("")],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "durable ask"}, {"cachePoint": {"type": "default", "ttl": "1h"}}])
    );
}

#[tokio::test]
async fn does_not_forward_an_empty_configured_messages_ttl() {
    let content = first_content(
        cached(CacheConfig {
            messages_ttl: ttl(""),
            ..auto()
        }),
        vec![text("durable ask"), point_ttl("1h"), text("per-call")],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "durable ask"}, {"cachePoint": {"type": "default"}}, {"text": "per-call"}])
    );
}

#[tokio::test]
async fn normalizes_the_ttl_of_a_relocated_cache_point() {
    let content = first_content(
        cached(CacheConfig {
            messages_ttl: ttl("5m"),
            ..auto()
        }),
        vec![
            text("analyze"),
            document("d", DocumentFormat::Md, 1),
            point_ttl("1h"),
            text("per-call"),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([
            {"text": "analyze"},
            {"cachePoint": {"type": "default", "ttl": "5m"}},
            document_json("d", "md", 1),
            {"text": "per-call"}
        ])
    );
}

#[tokio::test]
async fn normalizes_a_hand_placed_ttl_to_the_configured_one() {
    let content = first_content(
        cached(CacheConfig {
            messages_ttl: ttl("1h"),
            ..auto()
        }),
        vec![text("durable ask"), point_ttl("5m"), text("per-call")],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "durable ask"}, {"cachePoint": {"type": "default", "ttl": "1h"}}, {"text": "per-call"}])
    );
}

#[tokio::test]
async fn drops_a_hand_placed_ttl_when_no_messages_ttl_is_configured() {
    let content = first_content(
        cached(auto()),
        vec![text("durable ask"), point_ttl("1h"), text("per-call")],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "durable ask"}, {"cachePoint": {"type": "default"}}, {"text": "per-call"}])
    );
}

#[tokio::test]
async fn relocates_an_honored_cache_point_ahead_of_a_directly_preceding_non_pdf_document() {
    let content = first_content(
        cached(auto()),
        vec![
            text("analyze this"),
            document("readme", DocumentFormat::Md, 1),
            point(),
            text("per-call"),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([
            {"text": "analyze this"},
            {"cachePoint": {"type": "default"}},
            document_json("readme", "md", 1),
            {"text": "per-call"}
        ])
    );
}

#[tokio::test]
async fn does_not_relocate_an_honored_cache_point_a_document_does_not_directly_precede() {
    let content = first_content(
        cached(auto()),
        vec![
            text("analyze this"),
            document("readme", DocumentFormat::Md, 1),
            text("notes"),
            point(),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([
            {"text": "analyze this"},
            document_json("readme", "md", 1),
            {"text": "notes"},
            {"cachePoint": {"type": "default"}}
        ])
    );
}

#[tokio::test]
async fn leaves_an_honored_cache_point_after_a_pdf_document() {
    let content = first_content(
        cached(auto()),
        vec![
            text("analyze this"),
            document("report", DocumentFormat::Pdf, 1),
            point(),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "analyze this"}, document_json("report", "pdf", 1), {"cachePoint": {"type": "default"}}])
    );
}

#[tokio::test]
async fn drops_an_honored_cache_point_when_a_non_pdf_document_leads_the_message() {
    let content = first_content(
        cached(auto()),
        vec![document("readme", DocumentFormat::Md, 1), point()],
        Options::default(),
    )
    .await;
    assert_eq!(content, json!([document_json("readme", "md", 1)]));
}

#[tokio::test]
async fn caches_every_section_when_no_strategy_is_given() {
    let request = sent(cached(CacheConfig::default()), hello(), tools_only()).await;
    assert_eq!(cache_points(&request), [cache_point(None), cache_point(None)]);
}

#[tokio::test]
async fn caches_only_the_tool_definitions_when_messages_ttl_is_false() {
    let request = sent(
        cached(CacheConfig {
            messages_ttl: off(),
            ..CacheConfig::default()
        }),
        hello(),
        tools_only(),
    )
    .await;
    assert_eq!(cache_points(&request), [cache_point(None), Value::Null]);
}

#[tokio::test]
async fn caches_only_the_conversation_when_tools_ttl_is_false() {
    let request = sent(
        cached(CacheConfig {
            tools_ttl: off(),
            ..CacheConfig::default()
        }),
        hello(),
        tools_only(),
    )
    .await;
    assert_eq!(cache_points(&request), [Value::Null, cache_point(None)]);
}

#[tokio::test]
async fn emits_nothing_when_every_section_is_disabled() {
    let config = cached(CacheConfig {
        tools_ttl: off(),
        messages_ttl: off(),
        ..CacheConfig::default()
    });
    let request = sent(config, hello(), tools_only()).await;
    assert_eq!(cache_points(&request), [Value::Null, Value::Null]);
}

#[tokio::test]
async fn warns_through_warn_once_when_auto_finds_no_caching_support() {
    let warning = "model_id=<meta.llama3-70b-instruct-v1:0> | cache_config is enabled but this model does not support automatic caching";
    crate::logging::forget_warning(warning);
    let (logs, guard) = crate::test_support::record_logs();
    let config = BedrockModelConfig {
        cache_config: Some(CacheConfig::default()),
        ..with_model_id("meta.llama3-70b-instruct-v1:0")
    };
    let request = sent(config, hello(), tools_only()).await;
    drop(guard);
    assert_eq!(cache_points(&request), [Value::Null, Value::Null]);
    assert!(logs.text().contains(warning), "{}", logs.text());
}

#[tokio::test]
async fn applies_the_shared_ttl_to_both_sections() {
    let request = sent(
        cached(CacheConfig {
            ttl: Some("1h".into()),
            ..CacheConfig::default()
        }),
        hello(),
        tools_only(),
    )
    .await;
    assert_eq!(
        cache_points(&request),
        [cache_point(Some("1h")), cache_point(Some("1h"))]
    );
}

#[tokio::test]
async fn lets_a_per_section_ttl_override_the_shared_ttl() {
    let config = cached(CacheConfig {
        ttl: Some("1h".into()),
        messages_ttl: ttl("5m"),
        ..CacheConfig::default()
    });
    let request = sent(config, hello(), tools_only()).await;
    assert_eq!(
        cache_points(&request),
        [cache_point(Some("1h")), cache_point(Some("5m"))]
    );
}

#[tokio::test]
async fn treats_an_empty_ttl_as_unset_rather_than_shipping_it() {
    let config = cached(CacheConfig {
        ttl: Some(String::new()),
        messages_ttl: ttl(""),
        ..CacheConfig::default()
    });
    let request = sent(config, hello(), tools_only()).await;
    assert_eq!(cache_points(&request), [cache_point(None), cache_point(None)]);
}

#[tokio::test]
async fn falls_through_an_empty_per_section_ttl_to_the_shared_ttl() {
    let config = cached(CacheConfig {
        ttl: Some("1h".into()),
        messages_ttl: ttl(""),
        ..CacheConfig::default()
    });
    let request = sent(config, hello(), tools_only()).await;
    assert_eq!(
        cache_points(&request),
        [cache_point(Some("1h")), cache_point(Some("1h"))]
    );
}

fn shared(ttl: &str) -> CacheConfig {
    CacheConfig {
        ttl: Some(ttl.to_owned()),
        ..CacheConfig::default()
    }
}

#[tokio::test]
async fn applies_the_shared_ttl_to_a_caller_placed_system_cache_point() {
    let request = sent(cached(shared("1h")), hello(), with_tools(system_prompt_with(None))).await;
    let [tools, message] = cache_points(&request);
    assert_eq!(
        (tools, system_cache_points(&request), message),
        (
            cache_point(Some("1h")),
            vec![cache_point(Some("1h"))],
            cache_point(Some("1h"))
        )
    );
}

async fn system_points(cache_config: Option<CacheConfig>, model_id: &str, options: Options) -> (Value, Vec<Value>) {
    let config = BedrockModelConfig {
        cache_config,
        ..with_model_id(model_id)
    };
    let request = sent(config, hello(), options).await;
    let [tools, _] = cache_points(&request);
    (tools, system_cache_points(&request))
}

const CLAUDE: &str = "global.anthropic.claude-sonnet-4-6";

#[tokio::test]
async fn falls_through_an_empty_system_cache_point_ttl_to_the_shared_ttl() {
    let (_, points) = system_points(Some(shared("1h")), CLAUDE, with_tools(system_prompt_with(Some("")))).await;
    assert_eq!(points, [cache_point(Some("1h"))]);
}

#[tokio::test]
async fn leaves_a_system_cache_point_ttl_the_caller_wrote_as_written() {
    let (_, points) = system_points(Some(shared("1h")), CLAUDE, with_tools(system_prompt_with(Some("5m")))).await;
    assert_eq!(points, [cache_point(Some("5m"))]);
}

#[tokio::test]
async fn leaves_a_system_cache_point_alone_when_no_ttl_is_configured() {
    let (_, points) = system_points(
        Some(CacheConfig::default()),
        CLAUDE,
        with_tools(system_prompt_with(None)),
    )
    .await;
    assert_eq!(points, [cache_point(None)]);
}

#[tokio::test]
async fn leaves_a_system_cache_point_alone_when_the_model_does_not_support_caching() {
    let (_, points) = system_points(
        Some(shared("1h")),
        "meta.llama3-70b-instruct-v1:0",
        with_tools(system_prompt_with(None)),
    )
    .await;
    assert_eq!(points, [cache_point(None)]);
}

#[tokio::test]
async fn does_not_mutate_the_system_prompt_blocks_the_caller_owns() {
    let options = with_tools(system_prompt_with(None));
    let original = options.system_prompt.clone();
    let (model, transport) = provider(cached(shared("1h")));
    let model_request = request(hello(), options);
    let kept = model_request.system_prompt.clone();
    run(&model, model_request).await;
    assert_eq!(system_cache_points(&transport.last()), [cache_point(Some("1h"))]);
    assert_eq!(kept, original);
}

#[tokio::test]
async fn applies_the_shared_ttl_to_every_system_cache_point() {
    let options = with_tools(system_blocks(vec![
        SystemContentBlock::text("a"),
        SystemContentBlock::CachePoint(CachePointBlock::new()),
        SystemContentBlock::text("b"),
        SystemContentBlock::CachePoint(CachePointBlock::new()),
    ]));
    let (_, points) = system_points(Some(shared("1h")), CLAUDE, options).await;
    assert_eq!(points, [cache_point(Some("1h")), cache_point(Some("1h"))]);
}

#[tokio::test]
async fn treats_an_empty_shared_ttl_as_unconfigured() {
    let (_, points) = system_points(Some(shared("")), CLAUDE, system_prompt_with(None)).await;
    assert_eq!(points, [cache_point(None)]);
}

#[tokio::test]
async fn drops_an_empty_system_cache_point_ttl_when_no_ttl_is_configured() {
    let (_, points) = system_points(None, CLAUDE, with_tools(system_prompt_with(Some("")))).await;
    assert_eq!(points, [cache_point(None)]);
}

fn short_tools() -> CacheConfig {
    CacheConfig {
        ttl: Some("1h".into()),
        tools_ttl: ttl("5m"),
        messages_ttl: off(),
        ..CacheConfig::default()
    }
}

#[tokio::test]
async fn drops_an_empty_system_cache_point_ttl_behind_a_shorter_tools_ttl() {
    let result = system_points(Some(short_tools()), CLAUDE, with_tools(system_prompt_with(Some("")))).await;
    assert_eq!(result, (cache_point(Some("5m")), vec![cache_point(None)]));
}

#[tokio::test]
async fn does_not_mutate_a_system_cache_point_whose_empty_ttl_it_drops() {
    let options = with_tools(system_prompt_with(Some("")));
    let original = options.system_prompt.clone();
    let (_, points) = system_points(None, CLAUDE, options.clone()).await;
    assert_eq!(points, [cache_point(None)]);
    assert_eq!(options.system_prompt, original);
}

#[tokio::test]
async fn leaves_a_system_cache_point_alone_when_the_tools_checkpoint_ahead_of_it_is_shorter() {
    let result = system_points(Some(short_tools()), CLAUDE, with_tools(system_prompt_with(None))).await;
    assert_eq!(result, (cache_point(Some("5m")), vec![cache_point(None)]));
}

#[tokio::test]
async fn leaves_a_system_cache_point_alone_when_the_tools_checkpoint_ahead_of_it_is_longer() {
    let config = CacheConfig {
        ttl: Some("5m".into()),
        tools_ttl: ttl("1h"),
        ..CacheConfig::default()
    };
    let result = system_points(Some(config), CLAUDE, with_tools(system_prompt_with(None))).await;
    assert_eq!(result, (cache_point(Some("1h")), vec![cache_point(None)]));
}

#[tokio::test]
async fn applies_the_shared_ttl_when_the_tools_section_carries_it_too() {
    let config = CacheConfig {
        tools_ttl: ttl("1h"),
        ..shared("1h")
    };
    let (_, points) = system_points(Some(config), CLAUDE, with_tools(system_prompt_with(None))).await;
    assert_eq!(points, [cache_point(Some("1h"))]);
}

#[tokio::test]
async fn applies_the_shared_ttl_when_the_tools_section_is_disabled() {
    let config = CacheConfig {
        tools_ttl: off(),
        ..shared("1h")
    };
    let (_, points) = system_points(Some(config), CLAUDE, with_tools(system_prompt_with(None))).await;
    assert_eq!(points, [cache_point(Some("1h"))]);
}

#[tokio::test]
async fn applies_the_shared_ttl_when_the_request_carries_no_tools_at_all() {
    let config = CacheConfig {
        tools_ttl: ttl("5m"),
        ..shared("1h")
    };
    let (_, points) = system_points(Some(config), CLAUDE, system_prompt_with(None)).await;
    assert_eq!(points, [cache_point(Some("1h"))]);
}

#[tokio::test]
async fn resolves_the_ttl_for_a_caller_placed_cache_point_too() {
    let placed = || vec![text("durable prefix"), point()];
    let enabled = cached(CacheConfig {
        messages_ttl: Some(CacheSectionSetting::Enabled(true)),
        ..CacheConfig::default()
    });
    assert_eq!(
        first_content(enabled, placed(), Options::default()).await,
        json!([{"text": "durable prefix"}, {"cachePoint": {"type": "default"}}])
    );
    assert_eq!(
        first_content(cached(shared("1h")), placed(), Options::default()).await,
        json!([{"text": "durable prefix"}, {"cachePoint": {"type": "default", "ttl": "1h"}}])
    );
}

#[tokio::test]
async fn ignores_cache_key_it_does_not_change_the_request_shape() {
    let without_key = BedrockModelConfig {
        cache_config: Some(CacheConfig::default()),
        ..with_model_id("anthropic.claude-test-model")
    };
    let with_key = BedrockModelConfig {
        cache_config: Some(CacheConfig {
            cache_key: Some("tenant-42".into()),
            ..CacheConfig::default()
        }),
        ..with_model_id("anthropic.claude-test-model")
    };
    assert_eq!(
        sent(without_key, hello(), tools_only()).await,
        sent(with_key, hello(), tools_only()).await
    );
}

fn trailing(blocks: usize) -> Options {
    Options {
        dynamic_trailing_blocks: Some(blocks),
        ..Options::default()
    }
}

#[tokio::test]
async fn places_the_cache_point_ahead_of_the_per_call_tail() {
    let content = first_content(cached(auto()), vec![text("durable ask"), text("per-call")], trailing(1)).await;
    assert_eq!(
        content,
        json!([{"text": "durable ask"}, {"cachePoint": {"type": "default"}}, {"text": "per-call"}])
    );
}

#[tokio::test]
async fn places_the_cache_point_ahead_of_every_block_of_a_multi_block_tail() {
    let content = first_content(
        cached(auto()),
        vec![text("durable ask"), text("injected"), text("status")],
        trailing(2),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "durable ask"}, {"cachePoint": {"type": "default"}}, {"text": "injected"}, {"text": "status"}])
    );
}

#[tokio::test]
async fn appends_the_cache_point_at_the_end_when_no_per_call_tail_is_marked() {
    let content = first_content(cached(auto()), vec![text("a"), text("b")], Options::default()).await;
    assert_eq!(
        content,
        json!([{"text": "a"}, {"text": "b"}, {"cachePoint": {"type": "default"}}])
    );
}

#[tokio::test]
async fn skips_the_cache_point_when_the_whole_message_is_per_call_content() {
    let content = first_content(cached(auto()), vec![text("per-call only")], trailing(1)).await;
    assert_eq!(content, json!([{"text": "per-call only"}]));
}

#[tokio::test]
async fn steps_a_per_call_boundary_back_over_a_directly_preceding_non_pdf_document() {
    let content = first_content(
        cached(auto()),
        vec![
            text("analyze this"),
            document("readme", DocumentFormat::Md, 1),
            text("per-call"),
        ],
        trailing(1),
    )
    .await;
    assert_eq!(
        content,
        json!([
            {"text": "analyze this"},
            {"cachePoint": {"type": "default"}},
            document_json("readme", "md", 1),
            {"text": "per-call"}
        ])
    );
}

#[tokio::test]
async fn applies_the_configured_messages_ttl_to_a_per_call_boundary() {
    let content = first_content(
        cached(CacheConfig {
            messages_ttl: ttl("1h"),
            ..auto()
        }),
        vec![text("durable ask"), text("per-call")],
        trailing(1),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "durable ask"}, {"cachePoint": {"type": "default", "ttl": "1h"}}, {"text": "per-call"}])
    );
}

#[tokio::test]
async fn emits_no_cache_point_for_a_per_call_tail_when_caching_is_not_configured() {
    let content = first_content(
        BedrockModelConfig::default(),
        vec![text("durable ask"), text("per-call")],
        trailing(1),
    )
    .await;
    assert_eq!(content, json!([{"text": "durable ask"}, {"text": "per-call"}]));
}

#[tokio::test]
async fn inserts_cache_point_before_a_non_pdf_document_block() {
    let content = first_content(
        cached(auto()),
        vec![text("Analyze this file"), document("readme", DocumentFormat::Md, 1)],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "Analyze this file"}, {"cachePoint": {"type": "default"}}, document_json("readme", "md", 1)])
    );
}

#[tokio::test]
async fn appends_cache_point_at_the_end_when_only_pdf_documents_are_present() {
    let content = first_content(
        cached(auto()),
        vec![text("Analyze this PDF"), document("report", DocumentFormat::Pdf, 1)],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([{"text": "Analyze this PDF"}, document_json("report", "pdf", 1), {"cachePoint": {"type": "default"}}])
    );
}

#[tokio::test]
async fn inserts_cache_point_before_the_first_non_pdf_document_in_mixed_content() {
    let content = first_content(
        cached(auto()),
        vec![
            text("Analyze these files"),
            document("report", DocumentFormat::Pdf, 1),
            document("data", DocumentFormat::Csv, 2),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([
            {"text": "Analyze these files"},
            document_json("report", "pdf", 1),
            {"cachePoint": {"type": "default"}},
            document_json("data", "csv", 2)
        ])
    );
}

#[tokio::test]
async fn inserts_cache_point_before_the_first_of_several_non_pdf_documents() {
    let content = first_content(
        cached(auto()),
        vec![
            text("Analyze these files"),
            document("first", DocumentFormat::Csv, 1),
            document("second", DocumentFormat::Csv, 2),
        ],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([
            {"text": "Analyze these files"},
            {"cachePoint": {"type": "default"}},
            document_json("first", "csv", 1),
            document_json("second", "csv", 2)
        ])
    );
}

#[tokio::test]
async fn skips_cache_point_when_a_non_pdf_document_is_the_first_block() {
    let content = first_content(
        cached(auto()),
        vec![document("data", DocumentFormat::Csv, 1), text("Analyze this file")],
        Options::default(),
    )
    .await;
    assert_eq!(
        content,
        json!([document_json("data", "csv", 1), {"text": "Analyze this file"}])
    );
}

#[tokio::test]
async fn does_not_mutate_the_original_messages_array() {
    let messages = vec![Message::user("Hello"), Message::assistant("Hi")];
    let before = serde_json::to_string(&messages).unwrap();
    let (model, _) = provider(cached(auto()));
    run(&model, request(messages.clone(), Options::default())).await;
    assert_eq!(serde_json::to_string(&messages).unwrap(), before);
}

#[tokio::test]
async fn logs_warning_and_disables_caching_for_non_caching_models() {
    let warning = "model_id=<amazon.titan-text-express-v1> | cache_config is enabled but this model does not support automatic caching";
    crate::logging::forget_warning(warning);
    let (logs, guard) = crate::test_support::record_logs();
    let config = BedrockModelConfig {
        cache_config: Some(auto()),
        ..with_model_id("amazon.titan-text-express-v1")
    };
    let request = sent(config, hello(), system("You are a helpful assistant")).await;
    drop(guard);
    assert!(logs.text().contains(warning), "{}", logs.text());
    assert_eq!(
        request,
        json!({
            "modelId": "amazon.titan-text-express-v1",
            "messages": [{"role": "user", "content": [{"text": "Hello"}]}],
            "system": [{"text": "You are a helpful assistant"}]
        })
    );
}

fn anthropic_strategy(model_id: &str) -> BedrockModelConfig {
    BedrockModelConfig {
        cache_config: Some(CacheConfig {
            strategy: Some(CacheStrategy::Anthropic),
            ..CacheConfig::default()
        }),
        ..with_model_id(model_id)
    }
}

#[tokio::test]
async fn enables_caching_with_anthropic_strategy_for_application_inference_profiles() {
    let config = anthropic_strategy("arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123");
    let request = sent(
        config,
        vec![Message::user("Hello"), Message::assistant("Hi")],
        Options::default(),
    )
    .await;
    assert_eq!(
        request["messages"][0]["content"][1],
        json!({"cachePoint": {"type": "default"}})
    );
}

#[tokio::test]
async fn handles_empty_array_system_prompt() {
    let request = sent(BedrockModelConfig::default(), hello(), system_blocks(Vec::new())).await;
    assert_eq!(
        request,
        json!({
            "inferenceConfig": {"maxTokens": 128_000},
            "modelId": "global.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": [{"text": "Hello"}]}]
        })
    );
}

fn guard_text(qualifiers: Vec<GuardQualifier>, text: &str) -> SystemContentBlock {
    SystemContentBlock::GuardContent(GuardContentText::new(qualifiers, text).into())
}

#[tokio::test]
async fn formats_array_system_prompt_with_guard_content() {
    let options = system_blocks(vec![
        SystemContentBlock::text("You are a helpful assistant"),
        guard_text(
            vec![GuardQualifier::GroundingSource],
            "This content should be evaluated for grounding.",
        ),
    ]);
    assert_eq!(
        sent(BedrockModelConfig::default(), hello(), options).await["system"],
        json!([
            {"text": "You are a helpful assistant"},
            {"guardContent": {"text": {"text": "This content should be evaluated for grounding.", "qualifiers": ["grounding_source"]}}}
        ])
    );
}

#[tokio::test]
async fn formats_mixed_system_prompt_with_text_guard_content_and_cache_points() {
    let options = system_blocks(vec![
        SystemContentBlock::text("You are a helpful assistant"),
        guard_text(
            vec![GuardQualifier::GroundingSource, GuardQualifier::Query],
            "Guard content",
        ),
        SystemContentBlock::text("Additional context"),
        SystemContentBlock::CachePoint(CachePointBlock::new()),
    ]);
    assert_eq!(
        sent(BedrockModelConfig::default(), hello(), options).await["system"],
        json!([
            {"text": "You are a helpful assistant"},
            {"guardContent": {"text": {"text": "Guard content", "qualifiers": ["grounding_source", "query"]}}},
            {"text": "Additional context"},
            {"cachePoint": {"type": "default"}}
        ])
    );
}

#[tokio::test]
async fn formats_guard_content_with_all_qualifier_types() {
    let options = system_blocks(vec![guard_text(
        vec![
            GuardQualifier::GroundingSource,
            GuardQualifier::Query,
            GuardQualifier::GuardContent,
        ],
        "Multi-qualifier guard content",
    )]);
    assert_eq!(
        sent(BedrockModelConfig::default(), hello(), options).await["system"],
        json!([{"guardContent": {"text": {
            "text": "Multi-qualifier guard content",
            "qualifiers": ["grounding_source", "query", "guard_content"]
        }}}])
    );
}

#[tokio::test]
async fn formats_guard_content_with_image_in_system_prompt() {
    let options = system_blocks(vec![SystemContentBlock::GuardContent(
        GuardContentImage::new(GuardImageFormat::Jpeg, vec![1, 2, 3, 4]).into(),
    )]);
    assert_eq!(
        sent(BedrockModelConfig::default(), hello(), options).await["system"],
        json!([{"guardContent": {"image": {"format": "jpeg", "source": {"bytes": "AQIDBA=="}}}}])
    );
}

#[tokio::test]
async fn carries_cache_config_ttl_into_the_appended_system_cache_point() {
    let config = cached(CacheConfig {
        ttl: Some("1h".into()),
        ..auto()
    });
    assert_eq!(
        sent(config, hello(), system("static prompt")).await["system"],
        json!([{"text": "static prompt"}, {"cachePoint": {"type": "default", "ttl": "1h"}}])
    );
}

#[tokio::test]
async fn does_not_inject_a_system_cache_point_when_system_prompt_ttl_is_false() {
    let config = cached(CacheConfig {
        system_prompt_ttl: off(),
        ..auto()
    });
    assert_eq!(
        sent(config, hello(), system("static prompt")).await["system"],
        json!([{"text": "static prompt"}])
    );
}

#[tokio::test]
async fn fills_a_caller_placed_system_point_from_ttl_when_system_prompt_ttl_is_false() {
    let config = cached(CacheConfig {
        ttl: Some("1h".into()),
        system_prompt_ttl: off(),
        ..auto()
    });
    let options = system_blocks(vec![
        SystemContentBlock::text("static prompt"),
        SystemContentBlock::CachePoint(CachePointBlock::new()),
    ]);
    assert_eq!(
        sent(config, hello(), options).await["system"],
        json!([{"text": "static prompt"}, {"cachePoint": {"type": "default", "ttl": "1h"}}])
    );
}

fn calc_tool() -> Vec<ToolSpec> {
    vec![ToolSpec::new("calc", "Calculator").with_input_schema(json!({"type": "object", "properties": {}}))]
}

#[tokio::test]
async fn emits_an_explicit_system_prompt_ttl_as_written_above_a_shorter_tools_point() {
    let config = cached(CacheConfig {
        system_prompt_ttl: ttl("1h"),
        tools_ttl: ttl("5m"),
        ..auto()
    });
    let options = Options {
        tool_specs: calc_tool(),
        ..system("static prompt")
    };
    assert_eq!(
        sent(config, hello(), options).await["system"],
        json!([{"text": "static prompt"}, {"cachePoint": {"type": "default", "ttl": "1h"}}])
    );
}

#[tokio::test]
async fn carries_an_explicit_system_prompt_ttl_into_the_appended_cache_point_without_a_shared_ttl() {
    let config = cached(CacheConfig {
        system_prompt_ttl: ttl("1h"),
        ..auto()
    });
    assert_eq!(
        sent(config, hello(), system("static prompt")).await["system"],
        json!([{"text": "static prompt"}, {"cachePoint": {"type": "default", "ttl": "1h"}}])
    );
}

#[tokio::test]
async fn honors_a_caller_placed_system_cache_point_anywhere_in_the_prefix() {
    let options = system_blocks(vec![
        SystemContentBlock::text("static prompt"),
        SystemContentBlock::CachePoint(CachePointBlock::new().with_ttl("1h")),
        SystemContentBlock::text("trailing instructions"),
    ]);
    assert_eq!(
        sent(cached(auto()), hello(), options).await["system"],
        json!([
            {"text": "static prompt"},
            {"cachePoint": {"type": "default", "ttl": "1h"}},
            {"text": "trailing instructions"}
        ])
    );
}

#[tokio::test]
async fn stands_the_system_cache_point_ttl_down_when_the_tools_point_carries_a_different_ttl() {
    let config = cached(CacheConfig {
        ttl: Some("1h".into()),
        tools_ttl: ttl("5m"),
        ..auto()
    });
    let options = Options {
        tool_specs: calc_tool(),
        ..system("static prompt")
    };
    assert_eq!(
        sent(config, hello(), options).await["system"],
        json!([{"text": "static prompt"}, {"cachePoint": {"type": "default"}}])
    );
}

#[tokio::test]
async fn skips_the_system_cache_point_when_the_system_prompt_is_absent() {
    assert!(
        sent(cached(auto()), hello(), Options::default())
            .await
            .get("system")
            .is_none()
    );
}

#[tokio::test]
async fn appends_a_system_cache_point_under_explicit_anthropic_strategy_for_arn_inference_profiles() {
    let config = anthropic_strategy("arn:aws:bedrock:us-east-1:123:application-inference-profile/abc");
    assert_eq!(
        sent(config, hello(), system("static prompt")).await["system"],
        json!([{"text": "static prompt"}, {"cachePoint": {"type": "default"}}])
    );
}

/// Cache config portability: one `cache_config` means the same on every provider, compared as the
/// TTLs of the cache points per section.
#[tokio::test]
async fn agrees_on_cache_config_across_providers() {
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
    let ttls = |points: Vec<&Value>| -> Vec<Value> {
        points
            .into_iter()
            .map(|point| point.get("ttl").cloned().unwrap_or(Value::Null))
            .collect()
    };
    for (cache_config, expected) in cases {
        let options = Options {
            tool_specs: vec![ToolSpec::new("calculator", "Calculate").with_input_schema(json!({"type": "object"}))],
            ..Options::default()
        };
        let config = BedrockModelConfig {
            cache_config: Some(cache_config.clone()),
            ..with_model_id("global.anthropic.claude-sonnet-4-6")
        };
        let sent = sent(config, vec![Message::user("durable prefix")], options).await;
        let tools: Vec<&Value> = sent["toolConfig"]["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("cachePoint"))
            .collect();
        let messages: Vec<&Value> = sent["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|message| message["content"].as_array().into_iter().flatten())
            .filter_map(|block| block.get("cachePoint"))
            .collect();
        assert_eq!(
            json!({"tools": ttls(tools), "messages": ttls(messages)}),
            expected,
            "{cache_config:?}"
        );
    }
}

mod nova_cache_points {
    use super::*;
    use crate::models::bedrock::BedrockGuardrailConfig;
    use crate::types::{
        ImageBlock, ImageFormat, ImageSource, ToolResultBlock, ToolResultContent, ToolUseBlock, VideoBlock,
        VideoFormat, VideoSource,
    };

    const NOVA: &str = "us.amazon.nova-pro-v1:0";

    fn nova(cache_config: CacheConfig) -> BedrockModelConfig {
        BedrockModelConfig {
            cache_config: Some(cache_config),
            ..with_model_id(NOVA)
        }
    }

    fn tool_turn() -> Vec<Message> {
        vec![
            Message::user("What is 6 x 7?"),
            assistant(vec![ContentBlock::ToolUse(ToolUseBlock::new(
                "calculator",
                "id-1",
                json!({}),
            ))]),
        ]
    }

    fn tool_result(id: &str, output: &str) -> ContentBlock {
        ToolResultBlock::success(id, vec![ToolResultContent::text(output)]).into()
    }

    fn image() -> ContentBlock {
        ContentBlock::Image(ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1])))
    }

    fn last_content(request: &Value) -> Value {
        request["messages"].as_array().unwrap().last().unwrap()["content"].clone()
    }

    /// Every cache point in the request: tools, system, then messages.
    fn all_cache_points(request: &Value) -> Vec<Value> {
        let blocks = |value: &Value| value.as_array().cloned().unwrap_or_default();
        let mut all = blocks(&request["toolConfig"]["tools"]);
        all.extend(blocks(&request["system"]));
        for message in blocks(&request["messages"]) {
            all.extend(blocks(&message["content"]));
        }
        all.into_iter()
            .filter_map(|block| block.get("cachePoint").cloned())
            .collect()
    }

    fn is_tool_result(block: &Value) -> bool {
        block["toolResult"]["toolUseId"] == json!("id-1")
    }

    fn tools_without_point(request: &Value) -> bool {
        let tools = request["toolConfig"]["tools"].as_array().unwrap();
        tools.len() == 1 && tools[0]["toolSpec"]["name"] == json!("calculator")
    }

    /// Serializes the tests that emit or expect the one-time Nova warnings, since a warning emitted
    /// by one test is not emitted again in another.
    static WARNINGS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        WARNINGS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn ttl_warning() -> String {
        format!("model_id=<{NOVA}> | ttl is not supported by this model, using the default cache duration")
    }

    fn default_point() -> Value {
        json!({"type": "default"})
    }

    #[tokio::test]
    async fn caches_the_system_prompt_and_conversation_but_not_the_tool_definitions_without_a_warning() {
        let warning =
            format!("model_id=<{NOVA}> | cache_config is enabled but this model does not support automatic caching");
        crate::logging::forget_warning(&warning);
        let (logs, guard) = crate::test_support::record_logs();
        let request = sent(nova(auto()), hello(), with_tools(system("Be helpful"))).await;
        drop(guard);
        assert_eq!(
            request["system"],
            json!([{"text": "Be helpful"}, {"cachePoint": {"type": "default"}}])
        );
        assert!(tools_without_point(&request), "{request}");
        assert_eq!(
            last_content(&request),
            json!([{"text": "Hello"}, {"cachePoint": {"type": "default"}}])
        );
        assert!(!logs.text().contains(&warning), "{}", logs.text());
    }

    #[tokio::test]
    async fn drops_a_configured_ttl_from_every_cache_point_and_warns() {
        let _serial = serial();
        crate::logging::forget_warning(&ttl_warning());
        let (logs, guard) = crate::test_support::record_logs();
        let request = sent(
            nova(CacheConfig {
                ttl: Some("1h".to_owned()),
                ..auto()
            }),
            hello(),
            with_tools(system("Be helpful")),
        )
        .await;
        drop(guard);
        assert_eq!(all_cache_points(&request), [default_point(), default_point()]);
        assert!(logs.text().contains(&ttl_warning()), "{}", logs.text());
    }

    #[tokio::test]
    async fn drops_a_system_prompt_ttl_and_warns() {
        let _serial = serial();
        crate::logging::forget_warning(&ttl_warning());
        let (logs, guard) = crate::test_support::record_logs();
        let request = sent(
            nova(CacheConfig {
                system_prompt_ttl: ttl("1h"),
                ..CacheConfig::default()
            }),
            hello(),
            system("Be helpful"),
        )
        .await;
        drop(guard);
        assert_eq!(
            request["system"],
            json!([{"text": "Be helpful"}, {"cachePoint": {"type": "default"}}])
        );
        assert!(logs.text().contains(&ttl_warning()), "{}", logs.text());
    }

    #[tokio::test]
    async fn drops_the_ttl_of_a_caller_placed_system_cache_point_and_warns() {
        let _serial = serial();
        crate::logging::forget_warning(&ttl_warning());
        let (logs, guard) = crate::test_support::record_logs();
        let blocks = vec![
            SystemContentBlock::text("Be helpful"),
            SystemContentBlock::CachePoint(CachePointBlock::new().with_ttl("5m")),
        ];
        let request = sent(nova(CacheConfig::default()), hello(), system_blocks(blocks)).await;
        drop(guard);
        assert_eq!(
            request["system"],
            json!([{"text": "Be helpful"}, {"cachePoint": {"type": "default"}}])
        );
        assert!(logs.text().contains(&ttl_warning()), "{}", logs.text());
    }

    #[tokio::test]
    async fn warns_that_an_explicit_tools_ttl_has_no_effect() {
        let warning = format!(
            "model_id=<{NOVA}>, tools_ttl=<1h> | this model accepts no tool-level cache point, tool definitions are cached only as part of the system prompt prefix"
        );
        crate::logging::forget_warning(&warning);
        let (logs, guard) = crate::test_support::record_logs();
        let request = sent(
            nova(CacheConfig {
                tools_ttl: ttl("1h"),
                ..CacheConfig::default()
            }),
            hello(),
            tools_only(),
        )
        .await;
        drop(guard);
        assert!(tools_without_point(&request), "{request}");
        assert!(logs.text().contains(&warning), "{}", logs.text());
    }

    #[tokio::test]
    async fn applies_the_nova_rules_under_the_anthropic_strategy() {
        let _serial = serial();
        crate::logging::forget_warning(&ttl_warning());
        let (logs, guard) = crate::test_support::record_logs();
        let mut messages = tool_turn();
        messages.push(user(vec![tool_result("id-1", "42")]));
        let config = nova(CacheConfig {
            strategy: Some(CacheStrategy::Anthropic),
            ttl: Some("1h".to_owned()),
            ..CacheConfig::default()
        });
        let request = sent(config, messages, with_tools(system("Be helpful"))).await;
        drop(guard);
        assert!(tools_without_point(&request), "{request}");
        assert_eq!(
            request["system"],
            json!([{"text": "Be helpful"}, {"cachePoint": {"type": "default"}}])
        );
        assert_eq!(
            request["messages"][0]["content"],
            json!([{"text": "What is 6 x 7?"}, {"cachePoint": {"type": "default"}}])
        );
        let last = last_content(&request);
        assert!(
            last.as_array().unwrap().len() == 1 && is_tool_result(&last[0]),
            "{last}"
        );
        assert_eq!(all_cache_points(&request), [default_point(), default_point()]);
        assert!(logs.text().contains(&ttl_warning()), "{}", logs.text());
    }

    #[tokio::test]
    async fn keeps_the_conversation_cache_point_on_the_prompt_that_started_a_tool_loop() {
        let mut messages = tool_turn();
        messages.extend([
            user(vec![tool_result("id-1", "42")]),
            assistant(vec![ContentBlock::ToolUse(ToolUseBlock::new(
                "calculator",
                "id-2",
                json!({}),
            ))]),
            user(vec![tool_result("id-2", "84")]),
        ]);
        let request = sent(nova(auto()), messages, tools_only()).await;
        assert_eq!(
            request["messages"][0]["content"],
            json!([{"text": "What is 6 x 7?"}, {"cachePoint": {"type": "default"}}])
        );
        assert_eq!(all_cache_points(&request), [default_point()]);
    }

    #[tokio::test]
    async fn keeps_the_conversation_cache_point_on_the_prompt_when_a_per_call_tail_follows_a_tool_result() {
        let mut messages = tool_turn();
        messages.push(user(vec![tool_result("id-1", "42"), text("per-call")]));
        let options = Options {
            dynamic_trailing_blocks: Some(1),
            ..tools_only()
        };
        let request = sent(nova(auto()), messages, options).await;
        assert_eq!(
            request["messages"][0]["content"],
            json!([{"text": "What is 6 x 7?"}, {"cachePoint": {"type": "default"}}])
        );
        let last = last_content(&request);
        assert!(
            is_tool_result(&last[0]) && last[1] == json!({"text": "per-call"}),
            "{last}"
        );
        assert_eq!(all_cache_points(&request), [default_point()]);
    }

    #[tokio::test]
    async fn moves_a_caller_placed_cache_point_with_no_text_ahead_of_it_to_the_prompt_and_warns() {
        let _serial = serial();
        let warning = format!(
            "model_id=<{NOVA}> | dropped a caller-placed cache point with no text ahead of it, this model takes one only directly after text, placing it automatically instead"
        );
        crate::logging::forget_warning(&warning);
        let (logs, guard) = crate::test_support::record_logs();
        let mut messages = tool_turn();
        messages.push(user(vec![tool_result("id-1", "42"), image(), point()]));
        let request = sent(nova(CacheConfig::default()), messages, tools_only()).await;
        drop(guard);
        let last = last_content(&request);
        assert!(
            last.as_array().unwrap().len() == 2 && is_tool_result(&last[0]) && last[1].get("image").is_some(),
            "{last}"
        );
        assert_eq!(
            request["messages"][0]["content"],
            json!([{"text": "What is 6 x 7?"}, {"cachePoint": {"type": "default"}}])
        );
        assert_eq!(all_cache_points(&request), [default_point()]);
        assert!(logs.text().contains(&warning), "{}", logs.text());
    }

    #[tokio::test]
    async fn places_the_cache_point_directly_after_the_text_ahead_of_name() {
        let video = ContentBlock::Video(VideoBlock::new(VideoFormat::Mp4, VideoSource::Bytes(vec![1])));
        let cases = [
            ("an image", vec![image()]),
            ("a PDF", vec![document("order", DocumentFormat::Pdf, 1)]),
            (
                "an image then a txt document",
                vec![image(), document("notes", DocumentFormat::Txt, 1)],
            ),
            ("a video", vec![video]),
        ];
        for (name, media) in cases {
            let count = media.len();
            let mut content = vec![text("Describe")];
            content.extend(media);
            let request = sent(nova(auto()), vec![user(content)], Options::default()).await;
            let last = last_content(&request);
            let last = last.as_array().unwrap();
            assert_eq!(last.len(), count + 2, "{name}");
            assert_eq!(
                last[..2],
                [json!({"text": "Describe"}), json!({"cachePoint": {"type": "default"}})],
                "{name}"
            );
            assert_eq!(all_cache_points(&request), [default_point()], "{name}");
        }
    }

    #[tokio::test]
    async fn moves_a_caller_placed_cache_point_after_an_image_back_to_the_text() {
        let request = sent(
            nova(auto()),
            vec![user(vec![text("Describe"), image(), point()])],
            Options::default(),
        )
        .await;
        let last = last_content(&request);
        assert_eq!(last[0], json!({"text": "Describe"}));
        assert_eq!(last[1], json!({"cachePoint": {"type": "default"}}));
        assert!(
            last[2].get("image").is_some() && last.as_array().unwrap().len() == 3,
            "{last}"
        );
    }

    #[tokio::test]
    async fn keeps_the_cache_point_after_an_image_on_claude() {
        let config = BedrockModelConfig {
            cache_config: Some(auto()),
            ..with_model_id("global.anthropic.claude-sonnet-4-6")
        };
        let request = sent(config, vec![user(vec![text("Describe"), image()])], Options::default()).await;
        let last = last_content(&request);
        assert_eq!(
            last.as_array().unwrap().last().unwrap(),
            &json!({"cachePoint": {"type": "default"}})
        );
    }

    #[tokio::test]
    async fn places_no_conversation_cache_point_when_the_only_user_text_is_wrapped_in_guard_content() {
        let config = BedrockModelConfig {
            guardrail_config: Some(BedrockGuardrailConfig {
                guardrail_identifier: "g".into(),
                guardrail_version: "1".into(),
                guard_latest_user_message: Some(true),
                ..BedrockGuardrailConfig::default()
            }),
            ..nova(auto())
        };
        let request = sent(config, hello(), system("Be helpful")).await;
        assert_eq!(
            last_content(&request),
            json!([{"guardContent": {"text": {"text": "Hello"}}}])
        );
        assert_eq!(all_cache_points(&request), [default_point()]);
    }

    #[tokio::test]
    async fn moves_a_caller_placed_cache_point_off_a_tool_result_back_to_the_prompt_never_past_the_boundary() {
        let _serial = serial();
        let mut messages = tool_turn();
        messages.push(user(vec![tool_result("id-1", "42"), point(), text("next")]));
        let request = sent(nova(auto()), messages, tools_only()).await;
        let last = last_content(&request);
        assert!(is_tool_result(&last[0]) && last[1] == json!({"text": "next"}), "{last}");
        assert_eq!(last.as_array().unwrap().len(), 2);
        assert_eq!(
            request["messages"][0]["content"],
            json!([{"text": "What is 6 x 7?"}, {"cachePoint": {"type": "default"}}])
        );
        assert_eq!(all_cache_points(&request), [default_point()]);
    }

    #[tokio::test]
    async fn caches_a_plain_text_user_message_that_follows_earlier_tool_calls() {
        let mut messages = tool_turn();
        messages.extend([
            user(vec![tool_result("id-1", "42")]),
            assistant(vec![text("42")]),
            Message::user("Thanks"),
        ]);
        let request = sent(nova(auto()), messages, tools_only()).await;
        assert_eq!(
            last_content(&request),
            json!([{"text": "Thanks"}, {"cachePoint": {"type": "default"}}])
        );
        assert_eq!(all_cache_points(&request), [default_point()]);
    }

    #[tokio::test]
    async fn keeps_the_tools_cache_point_and_ttl_on_claude() {
        let (logs, guard) = crate::test_support::record_logs();
        let mut messages = tool_turn();
        messages.push(user(vec![tool_result("id-1", "42")]));
        let config = BedrockModelConfig {
            cache_config: Some(CacheConfig {
                ttl: Some("1h".to_owned()),
                ..auto()
            }),
            ..with_model_id("global.anthropic.claude-sonnet-4-6")
        };
        let request = sent(config, messages, with_tools(system("Be helpful"))).await;
        drop(guard);
        let tools = request["toolConfig"]["tools"].as_array().unwrap();
        assert_eq!(tools[1], json!({"cachePoint": {"type": "default", "ttl": "1h"}}));
        assert_eq!(
            request["system"],
            json!([{"text": "Be helpful"}, {"cachePoint": {"type": "default", "ttl": "1h"}}])
        );
        let last = last_content(&request);
        assert!(is_tool_result(&last[0]), "{last}");
        assert_eq!(last[1], json!({"cachePoint": {"type": "default", "ttl": "1h"}}));
        assert!(!logs.text().contains("ttl is not supported"), "{}", logs.text());
    }
}
