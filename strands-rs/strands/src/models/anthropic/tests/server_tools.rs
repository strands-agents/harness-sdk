//! Server tool tests: server tools, the native `web_search`, paused turns and citations.

use serde_json::json;

use super::*;
use crate::types::{Citation, CitationGeneratedContent, CitationsBlock, WebLocation};

fn web_search_tool() -> JsonValue {
    json!({"type": "web_search_20260318", "name": "web_search", "max_uses": 3})
}

fn function_tool_spec() -> ToolSpec {
    ToolSpec::new("calc", "calculate").with_input_schema(json!({"type": "object", "properties": {}}))
}

fn function_tool() -> JsonValue {
    json!({"name": "calc", "description": "calculate", "input_schema": {"type": "object", "properties": {}}})
}

fn with_function_tool(tool_choice: Option<ToolChoice>) -> ModelRequest {
    ModelRequest {
        tool_specs: vec![function_tool_spec()],
        tool_choice,
        ..hi()
    }
}

fn params_tools() -> JsonValue {
    json!({"tools": [web_search_tool()]})
}

fn web_search_stream() -> Vec<JsonValue> {
    let [delta, stop] = message_end("end_turn", 5);
    vec![
        message_start(10),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {}}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{"}}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "content_block_start", "index": 1, "content_block": {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": []}}),
        json!({"type": "content_block_stop", "index": 1}),
        json!({"type": "content_block_start", "index": 2, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": 2, "delta": {"type": "text_delta", "text": "Agents are autonomous."}}),
        json!({"type": "content_block_delta", "index": 2, "delta": {"type": "citations_delta", "citation": {
            "type": "web_search_result_location",
            "url": "https://docs.example.com/agents",
            "title": "Agents guide",
            "cited_text": "Agents are autonomous programs."
        }}}),
        json!({"type": "content_block_stop", "index": 2}),
        delta,
        stop,
    ]
}

fn paused_content() -> JsonValue {
    json!({"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {}})
}

fn paused_stream() -> Vec<JsonValue> {
    let [delta, stop] = message_end("pause_turn", 5);
    vec![
        message_start(10),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Searching. "}}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "content_block_start", "index": 1, "content_block": paused_content()}),
        json!({"type": "content_block_stop", "index": 1}),
        delta,
        stop,
    ]
}

fn ok(events: Vec<JsonValue>) -> Events {
    events.into_iter().map(Ok).collect()
}

#[tokio::test]
async fn appends_anthropic_tools_alongside_function_tools() {
    let client = MockClient::capture();
    let provider = model(&client, config().anthropic_tools(vec![web_search_tool()]).build());
    collect(&provider, with_function_tool(None)).await.unwrap();
    assert_eq!(client.last()["tools"], json!([function_tool(), web_search_tool()]));
}

#[tokio::test]
async fn appends_params_tools_alongside_function_tools() {
    let client = MockClient::capture();
    let provider = model(&client, config().params(params_tools()).build());
    collect(&provider, with_function_tool(None)).await.unwrap();
    assert_eq!(client.last()["tools"], json!([function_tool(), web_search_tool()]));
}

#[tokio::test]
async fn caches_on_the_last_server_tool_without_mutating_the_configured_tools() {
    let client = MockClient::capture();
    let provider = model(
        &client,
        config()
            .anthropic_tools(vec![web_search_tool()])
            .cache_config(CacheConfig::builder().tools_ttl(true).build())
            .build(),
    );

    collect(&provider, with_function_tool(None)).await.unwrap();

    let mut cached_tool = web_search_tool();
    cached_tool["cache_control"] = json!({"type": "ephemeral"});
    assert_eq!(client.last()["tools"], json!([function_tool(), cached_tool]));
    assert_eq!(provider.config().anthropic_tools, Some(vec![web_search_tool()]));

    provider
        .update_config(
            config()
                .cache_config(CacheConfig::builder().tools_ttl(false).build())
                .build(),
        )
        .unwrap();
    collect(&provider, with_function_tool(None)).await.unwrap();

    assert_eq!(client.last()["tools"], json!([function_tool(), web_search_tool()]));
}

#[tokio::test]
async fn omits_server_tools_when_a_tool_is_forced() {
    for (choice, name) in [(ToolChoice::Any, "any"), (ToolChoice::tool("calc"), "tool")] {
        let (logs, _guard) = record_logs();
        let client = MockClient::capture();
        let provider = model(
            &client,
            config()
                .anthropic_tools(vec![web_search_tool()])
                .params(params_tools())
                .build(),
        );

        collect(&provider, with_function_tool(Some(choice))).await.unwrap();

        assert_eq!(client.last()["tools"], json!([function_tool()]));
        assert_eq!(client.last()["tool_choice"]["type"], name);
        assert!(
            logs.text()
                .contains("server_tools=<web_search,web_search> | forced tool call, omitting server tools")
        );
    }
}

#[tokio::test]
async fn names_a_toolset_by_its_type_when_a_forced_turn_omits_it() {
    let (logs, _guard) = record_logs();
    let toolset = json!({"type": "browser_toolset_20260801"});
    let provider = model(&MockClient::capture(), config().anthropic_tools(vec![toolset]).build());

    collect(&provider, with_function_tool(Some(ToolChoice::Any)))
        .await
        .unwrap();

    assert!(logs.text().contains("server_tools=<browser_toolset_20260801>"));
}

#[tokio::test]
async fn does_not_let_params_tools_reach_a_forced_turn_that_has_no_function_tools() {
    let client = MockClient::capture();
    let provider = model(&client, config().params(params_tools()).build());

    let request = ModelRequest {
        tool_choice: Some(ToolChoice::Any),
        ..hi()
    };
    collect(&provider, request).await.unwrap();

    assert!(client.last().get("tools").is_none());
    assert!(client.last().get("tool_choice").is_none());
}

#[tokio::test]
async fn applies_tool_choice_when_only_server_tools_are_configured() {
    let client = MockClient::capture();
    let provider = model(&client, config().anthropic_tools(vec![web_search_tool()]).build());

    let request = ModelRequest {
        tool_choice: Some(ToolChoice::Auto),
        ..hi()
    };
    collect(&provider, request).await.unwrap();

    assert_eq!(client.last()["tools"], json!([web_search_tool()]));
    assert_eq!(client.last()["tool_choice"], json!({"type": "auto"}));
}

#[tokio::test]
async fn skips_server_side_tool_blocks_and_aggregates_web_search_citations_with_their_text() {
    let provider = model(
        &MockClient::replying(web_search_stream()),
        AnthropicModelConfig::default(),
    );

    let (items, result) = aggregate(&provider, hi()).await.unwrap();

    let kinds: Vec<String> = items
        .iter()
        .map(|item| match item {
            AggregatedEvent::ModelStreamEvent(ModelStreamEvent::ContentBlockDelta(delta)) => {
                format!(
                    "delta:{}",
                    serde_json::to_value(&delta.delta).unwrap()["type"].as_str().unwrap()
                )
            }
            AggregatedEvent::ModelStreamEvent(event) => serde_json::to_value(event).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned(),
            AggregatedEvent::ContentBlock(ContentBlock::Citations(_)) => "citationsBlock".to_owned(),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "modelMessageStartEvent",
            "modelContentBlockStartEvent",
            "delta:textDelta",
            "delta:citationsDelta",
            "modelContentBlockStopEvent",
            "citationsBlock",
            "modelMetadataEvent",
            "modelMessageStopEvent",
        ]
    );
    assert_eq!(result.stop_reason, StopReason::EndTurn);
    let citation = Citation::new(
        WebLocation::new("https://docs.example.com/agents").with_domain("docs.example.com"),
        "https://docs.example.com/agents",
        vec![crate::types::CitationSourceContent::new(
            "Agents are autonomous programs.",
        )],
        "Agents guide",
    );
    assert_eq!(
        result.message.content,
        [ContentBlock::Citations(CitationsBlock::new(
            vec![citation],
            vec![CitationGeneratedContent::new("Agents are autonomous.")]
        ))]
    );
}

#[tokio::test]
async fn resumes_a_paused_server_side_tool_turn_and_surfaces_it_as_one_stream() {
    let client = MockClient::new(|call| match call {
        0 => ok(paused_stream()),
        _ => ok(web_search_stream()),
    });
    let provider = model(&client, config().anthropic_tools(vec![web_search_tool()]).build());

    let request = ModelRequest {
        tool_specs: vec![function_tool_spec()],
        ..hi()
    };
    let (items, result) = aggregate(&provider, request).await.unwrap();

    let kinds: Vec<String> = items
        .iter()
        .filter_map(|item| match item {
            AggregatedEvent::ModelStreamEvent(
                ModelStreamEvent::ContentBlockStart(_)
                | ModelStreamEvent::ContentBlockDelta(_)
                | ModelStreamEvent::ContentBlockStop(_),
            ) => None,
            AggregatedEvent::ModelStreamEvent(event) => Some(
                serde_json::to_value(event).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            ),
            AggregatedEvent::ContentBlock(ContentBlock::Text(_)) => Some("textBlock".to_owned()),
            AggregatedEvent::ContentBlock(ContentBlock::Citations(_)) => Some("citationsBlock".to_owned()),
            other => Some(format!("{other:?}")),
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "modelMessageStartEvent",
            "textBlock",
            "citationsBlock",
            "modelMetadataEvent",
            "modelMessageStopEvent",
        ]
    );
    assert_eq!(result.stop_reason, StopReason::EndTurn);
    assert_eq!(result.message.content[0], ContentBlock::text("Searching. "));
    assert!(matches!(result.message.content[1], ContentBlock::Citations(_)));
    assert_eq!(
        result.metadata.unwrap().usage,
        Some(crate::models::streaming::Usage::new(20, 10, 30))
    );

    let requests = client.requests();
    assert_eq!(requests.len(), 2);
    let (first, second) = (&requests[0].body, &requests[1].body);
    let mut resumed = first["messages"].as_array().unwrap().clone();
    // The paused message is resent as the API returned it, which the provider accumulates from the
    // events.
    resumed.push(json!({
        "role": "assistant",
        "content": [{"type": "text", "text": "Searching. "}, paused_content()]
    }));
    assert_eq!(second["messages"], JsonValue::Array(resumed));
    assert_eq!(second["tools"], first["tools"]);
    assert_eq!(first["tools"], json!([function_tool(), web_search_tool()]));
}

#[tokio::test]
async fn throws_once_a_paused_turn_exceeds_the_continuation_limit() {
    let client = MockClient::replying(paused_stream());

    let error = collect(&model(&client, AnthropicModelConfig::default()), hi())
        .await
        .unwrap_err();

    assert!(matches!(error, Error::Model(_)), "{error:?}");
    assert_eq!(
        error.to_string(),
        "server-side tool turn did not complete after 10 continuations"
    );
    assert_eq!(client.calls(), 11);
}

#[tokio::test]
async fn treats_message_delta_usage_as_cumulative_within_a_response_and_sums_across_continuations() {
    let paused = vec![
        message_start(10),
        json!({"type": "content_block_start", "index": 0, "content_block": paused_content()}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "message_delta", "delta": {}, "usage": {"output_tokens": 3}}),
        json!({"type": "message_delta", "delta": {"stop_reason": "pause_turn"}, "usage": {"output_tokens": 5}}),
        json!({"type": "message_stop"}),
    ];
    let resumed = vec![
        message_start(20),
        json!({"type": "message_delta", "delta": {}, "usage": {"output_tokens": 4}}),
        json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 7}}),
        json!({"type": "message_stop"}),
    ];
    let client = MockClient::new(move |call| {
        if call == 0 {
            ok(paused.clone())
        } else {
            ok(resumed.clone())
        }
    });

    let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
        .await
        .unwrap();

    assert!(events.contains(
        &json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 30, "outputTokens": 12, "totalTokens": 42}})
    ));
}

#[tokio::test]
async fn reports_the_cumulative_usage_from_message_delta_and_keeps_message_start_values_it_omits() {
    let client = MockClient::replying(vec![
        json!({"type": "message_start", "message": {"role": "assistant", "usage": {"input_tokens": 2230, "output_tokens": 25, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 7}}}),
        json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"input_tokens": 11768, "output_tokens": 115, "cache_read_input_tokens": null, "cache_creation_input_tokens": null}}),
        json!({"type": "message_stop"}),
    ]);

    let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
        .await
        .unwrap();

    assert!(events.contains(&json!({"type": "modelMetadataEvent", "usage": {
        "inputTokens": 11768,
        "outputTokens": 115,
        "totalTokens": 11990,
        "cacheReadInputTokens": 100,
        "cacheWriteInputTokens": 7
    }})));
}

#[tokio::test]
async fn does_not_synthesize_a_stop_event_when_the_stream_ends_without_message_stop() {
    let client = MockClient::replying(vec![
        message_start(1),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "half of the"}}),
    ]);
    let provider = model(&client, AnthropicModelConfig::default());

    let events = collect(&provider, hi()).await.unwrap();

    let types: Vec<&str> = events.iter().map(|event| event["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        [
            "modelMessageStartEvent",
            "modelContentBlockStartEvent",
            "modelContentBlockDeltaEvent"
        ]
    );
    let error = aggregate(&provider, hi()).await.unwrap_err();
    assert_eq!(error.to_string(), "Stream ended without completing a message");
}

#[tokio::test]
async fn maps_citations() {
    let cases = [
        (
            json!({"type": "search_result_location", "search_result_index": 1, "start_block_index": 2, "end_block_index": 3, "source": "s"}),
            json!({"type": "searchResult", "searchResultIndex": 1, "start": 2, "end": 3}),
        ),
        (
            json!({"type": "char_location", "document_index": 0, "start_char_index": 1, "end_char_index": 2}),
            json!({"type": "documentChar", "documentIndex": 0, "start": 1, "end": 2}),
        ),
        (
            json!({"type": "page_location", "document_index": 0, "start_page_number": 1, "end_page_number": 2}),
            json!({"type": "documentPage", "documentIndex": 0, "start": 1, "end": 2}),
        ),
        (
            json!({"type": "content_block_location", "document_index": 0, "start_block_index": 1, "end_block_index": 2}),
            json!({"type": "documentChunk", "documentIndex": 0, "start": 1, "end": 2}),
        ),
    ];
    for (citation, location) in cases {
        let client = MockClient::replying(vec![
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "citations_delta", "citation": citation}}),
            json!({"type": "content_block_stop", "index": 0}),
        ]);

        let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
            .await
            .unwrap();

        let deltas: Vec<&JsonValue> = events
            .iter()
            .filter(|event| event["type"] == "modelContentBlockDeltaEvent")
            .collect();
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0]["delta"]["citations"][0]["location"], location);
    }
}

#[tokio::test]
async fn skips_an_unsupported_citation_location_with_a_warning() {
    let (logs, _guard) = record_logs();
    let client = MockClient::replying(vec![
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "citations_delta", "citation": {"type": "future_location"}}}),
    ]);

    let events = collect(&model(&client, AnthropicModelConfig::default()), hi())
        .await
        .unwrap();

    assert_eq!(events.len(), 1);
    assert!(
        logs.text()
            .contains("citation_type=<future_location> | unsupported citation location | skipping")
    );
}

#[tokio::test]
async fn logs_an_error_when_a_server_side_tool_fails() {
    let (logs, _guard) = record_logs();
    let client = MockClient::replying(vec![
        json!({"type": "content_block_start", "index": 0, "content_block": {
            "type": "web_search_tool_result",
            "tool_use_id": "srvtoolu_1",
            "content": {"type": "web_search_tool_result_error", "error_code": "max_uses_exceeded"}
        }}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "message_stop"}),
    ]);

    collect(&model(&client, AnthropicModelConfig::default()), hi())
        .await
        .unwrap();

    assert!(logs.text().contains("error_code=<max_uses_exceeded>"));
}

#[tokio::test]
async fn formats_a_citations_block_back_into_the_request_as_text() {
    let client = MockClient::capture();
    let cited = CitationsBlock::new(
        vec![Citation::new(
            WebLocation::new("https://x"),
            "https://x",
            Vec::new(),
            "x",
        )],
        vec![
            CitationGeneratedContent::new("Agents are "),
            CitationGeneratedContent::new("autonomous."),
        ],
    );
    let messages = vec![
        Message::user("Hi"),
        Message::new(crate::types::Role::Assistant, vec![ContentBlock::Citations(cited)]),
    ];

    collect(&model(&client, AnthropicModelConfig::default()), request(messages))
        .await
        .unwrap();

    assert_eq!(
        client.last()["messages"][1],
        json!({"role": "assistant", "content": [{"type": "text", "text": "Agents are autonomous."}]})
    );
}
