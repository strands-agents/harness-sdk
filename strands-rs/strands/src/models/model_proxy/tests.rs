use std::sync::Arc;

use futures::StreamExt;

use super::ModelProxy;
use crate::agent::{InvocationContext, InvocationContextUsage};
use crate::error::{Error, Result};
use crate::models::streaming::{ModelStreamEvent, Usage};
use crate::models::{
    AggregatedEvent, BaseModelConfig, CountTokensOptions, Model, ModelCapabilities, ModelInfo, ModelRequest,
    StreamAggregatedResult,
};
use crate::testing::{MockModel, MockTurn};
use crate::types::{
    ContentBlock, InjectedBlock, JsonObject, Message, MessageMetadata, Role, SummaryBlock, ToolResultBlock,
    ToolResultContent, UnknownBlock,
};

fn user(text: &str) -> Message {
    Message::user(text)
}

fn injected(text: &str) -> ContentBlock {
    ContentBlock::Injected(InjectedBlock::new(text, "test"))
}

fn text(text: &str) -> ContentBlock {
    ContentBlock::text(text)
}

fn with_capabilities(model: &MockModel, capabilities: ModelCapabilities) {
    model
        .update_config(BaseModelConfig {
            model_info: Some(ModelInfo {
                capabilities,
                ..ModelInfo::default()
            }),
            ..BaseModelConfig::default()
        })
        .unwrap();
}

/// Streams a request through the proxy the way the agent loop does.
async fn drain(
    model: &MockModel,
    request: ModelRequest,
    invocation_context: Option<&InvocationContext>,
) -> Result<(Vec<AggregatedEvent>, StreamAggregatedResult)> {
    let model: Arc<dyn Model> = Arc::new(model.clone());
    let request = ModelProxy::new(model.clone()).prepare_request(request);
    let mut stream = model.stream_aggregated(request);
    let mut events = Vec::new();
    while let Some(item) = stream.next().await {
        match item? {
            AggregatedEvent::Done(result) => {
                if let Some(context) = invocation_context {
                    ModelProxy::record(
                        result.metadata.as_ref().and_then(|metadata| metadata.usage.as_ref()),
                        context,
                    );
                }
                return Ok((events, result));
            }
            event => events.push(event),
        }
    }
    Err(Error::other("stream ended without a result"))
}

fn request(messages: Vec<Message>) -> ModelRequest {
    ModelRequest {
        messages,
        ..ModelRequest::default()
    }
}

/// The messages the model received for a request through the proxy.
async fn sent(messages: Vec<Message>) -> Vec<Message> {
    let model = MockModel::new().with_turn("ok");
    drain(&model, request(messages), None).await.unwrap();
    model.requests()[0].messages.clone()
}

fn turn_with_usage(reply: &str, usage: Usage) -> MockTurn {
    MockTurn::text(reply).with_usage(usage)
}

fn usage_of(context: &InvocationContext) -> InvocationContextUsage {
    context.usage()
}

#[tokio::test]
async fn accumulates_a_clean_call_usage_into_the_invocation_context_total() {
    let model = MockModel::new().with_turn(turn_with_usage("hi", Usage::new(10, 5, 15)));
    let context = InvocationContext::new(None);
    drain(&model, request(vec![user("go")]), Some(&context)).await.unwrap();
    let usage = usage_of(&context);
    assert_eq!(usage.turns_taken, 0);
    assert_eq!(usage.usage, Usage::new(10, 5, 15));
}

#[tokio::test]
async fn accumulates_across_calls_that_share_one_invocation_context() {
    let context = InvocationContext::new(None);
    let first = MockModel::new().with_turn(turn_with_usage("one", Usage::new(10, 5, 15)));
    let second = MockModel::new().with_turn(turn_with_usage("two", Usage::new(20, 10, 30)));
    drain(&first, request(vec![user("go")]), Some(&context)).await.unwrap();
    drain(&second, request(vec![user("again")]), Some(&context))
        .await
        .unwrap();
    let usage = usage_of(&context);
    assert_eq!(usage.turns_taken, 0);
    assert_eq!(usage.usage, Usage::new(30, 15, 45));
}

#[tokio::test]
async fn records_nothing_when_the_model_call_throws() {
    let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("boom")));
    let context = InvocationContext::new(None);
    let error = drain(&model, request(vec![user("go")]), Some(&context))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("boom"), "{error}");
    assert_eq!(usage_of(&context), InvocationContextUsage::default());
}

#[tokio::test]
async fn records_nothing_when_the_model_reports_no_usage() {
    let model = MockModel::new().with_turn("hi");
    let context = InvocationContext::new(None);
    drain(&model, request(vec![user("go")]), Some(&context)).await.unwrap();
    assert_eq!(usage_of(&context), InvocationContextUsage::default());
}

#[tokio::test]
async fn is_a_no_op_when_called_without_an_invocation_context() {
    let model = MockModel::new().with_turn(turn_with_usage("hi", Usage::new(10, 5, 15)));
    let (_, result) = drain(&model, request(vec![user("go")]), None).await.unwrap();
    assert_eq!(
        result.metadata.and_then(|metadata| metadata.usage),
        Some(Usage::new(10, 5, 15))
    );
}

#[tokio::test]
async fn yields_the_same_events_as_the_underlying_model() {
    let build = || MockModel::new().with_turn(turn_with_usage("hello", Usage::new(1, 2, 3)));
    let direct_model = build();
    let mut direct = direct_model.stream_aggregated(request(vec![user("go")]));
    let mut direct_events = Vec::new();
    let mut direct_result = None;
    while let Some(item) = direct.next().await {
        match item.unwrap() {
            AggregatedEvent::Done(result) => direct_result = Some(result),
            event => direct_events.push(event),
        }
    }
    let (events, result) = drain(&build(), request(vec![user("go")]), Some(&InvocationContext::new(None)))
        .await
        .unwrap();

    let as_json = |events: &[AggregatedEvent]| -> Vec<serde_json::Value> {
        events
            .iter()
            .map(|event| match event {
                AggregatedEvent::ModelStreamEvent(event) => serde_json::to_value(event).unwrap(),
                AggregatedEvent::ContentBlock(block) => serde_json::to_value(block).unwrap(),
                _ => serde_json::Value::Null,
            })
            .collect()
    };
    assert_eq!(as_json(&events), as_json(&direct_events));
    let direct_result = direct_result.unwrap();
    assert_eq!(result.stop_reason, direct_result.stop_reason);
    assert_eq!(result.message.content, direct_result.message.content);
    assert_eq!(result.metadata, direct_result.metadata);
    assert!(events.iter().all(|event| !matches!(event, AggregatedEvent::Done(_))));
}

#[tokio::test]
async fn gives_a_tool_result_whose_content_is_all_unknown_a_placeholder_text() {
    let unknown = ToolResultContent::Unknown(UnknownBlock::new(
        serde_json::json!({"futureBlock": {"name": "shell"}})
            .as_object()
            .unwrap()
            .clone(),
    ));
    let kept = ToolResultBlock::success("t-2", vec![ToolResultContent::text("done"), unknown.clone()]);
    let messages = vec![
        Message::new(
            Role::User,
            vec![
                ContentBlock::ToolResult(ToolResultBlock::success("t-1", vec![unknown.clone(), unknown.clone()])),
                ContentBlock::ToolResult(kept.clone()),
            ],
        )
        .with_tracking_id("msg-1"),
    ];
    let original = messages.clone();

    assert_eq!(
        sent(messages.clone()).await,
        vec![
            Message::new(
                Role::User,
                vec![
                    ContentBlock::ToolResult(ToolResultBlock::success(
                        "t-1",
                        vec![ToolResultContent::text("[unsupported content omitted]")],
                    )),
                    ContentBlock::ToolResult(kept),
                ],
            )
            .with_tracking_id("msg-1")
        ]
    );
    assert_eq!(messages, original);
}

#[tokio::test]
async fn sends_the_text_apart_from_the_content_before_it() {
    let cases: Vec<(&str, Vec<ContentBlock>, &str, &str)> = vec![
        (
            "a prompt",
            vec![text("Refactor the tokenizer.")],
            "reminder",
            "\n\nreminder",
        ),
        (
            "a tool result turn",
            vec![ContentBlock::ToolResult(ToolResultBlock::success(
                "tool-1",
                vec![ToolResultContent::text("done")],
            ))],
            "reminder",
            "\n\nreminder",
        ),
        ("an empty user message", vec![], "reminder", "reminder"),
        (
            "text that starts with a newline",
            vec![text("Refactor the tokenizer.")],
            "\nreminder",
            "\nreminder",
        ),
    ];
    for (name, content, injected_text, sent_text) in cases {
        let mut with_injected = content.clone();
        with_injected.push(injected(injected_text));
        let mut expected = content;
        expected.push(text(sent_text));
        assert_eq!(
            sent(vec![Message::new(Role::User, with_injected).with_tracking_id("msg-1")]).await,
            vec![Message::new(Role::User, expected).with_tracking_id("msg-1")],
            "{name}"
        );
    }
}

#[tokio::test]
async fn sends_each_of_several_injected_blocks_as_its_own_text_block_in_place() {
    let mut custom = JsonObject::new();
    custom.insert("source".into(), "test".into());
    let metadata = MessageMetadata {
        custom: Some(custom),
        ..MessageMetadata::default()
    };
    let message = Message::new(
        Role::User,
        vec![text("Refactor the tokenizer."), injected("one"), injected("two")],
    )
    .with_tracking_id("msg-1")
    .with_metadata(metadata.clone());
    assert_eq!(
        sent(vec![message]).await,
        vec![
            Message::new(
                Role::User,
                vec![text("Refactor the tokenizer."), text("\n\none"), text("\n\ntwo")],
            )
            .with_tracking_id("msg-1")
            .with_metadata(metadata)
        ]
    );
}

#[tokio::test]
async fn leaves_out_the_injected_blocks_of_earlier_user_messages() {
    let answer = Message::new(Role::Assistant, vec![text("Done.")]).with_tracking_id("msg-2");
    let latest = user("Now the docs.");
    let messages = vec![
        Message::new(Role::User, vec![text("Refactor."), injected("reminder")]).with_tracking_id("msg-1"),
        answer.clone(),
        latest.clone(),
    ];
    assert_eq!(
        sent(messages).await,
        vec![
            Message::new(Role::User, vec![text("Refactor.")]).with_tracking_id("msg-1"),
            answer,
            latest
        ]
    );
}

#[tokio::test]
async fn keeps_the_cache_point_ahead_of_the_latest_injected_text_also_when_an_assistant_message_follows() {
    let model = MockModel::new().with_turn("ok");
    let messages = vec![Message::new(
        Role::User,
        vec![text("Refactor."), injected("reminder"), text("\n\nper-call text")],
    )];
    let first = ModelRequest {
        dynamic_trailing_blocks: Some(1),
        ..request(messages.clone())
    };
    drain(&model, first, None).await.unwrap();
    let mut with_answer = messages;
    with_answer.push(Message::new(Role::Assistant, vec![text("Sure")]));
    drain(&model, request(with_answer), None).await.unwrap();
    let trailing: Vec<Option<usize>> = model
        .requests()
        .iter()
        .map(|request| request.dynamic_trailing_blocks)
        .collect();
    assert_eq!(trailing, [Some(2), Some(2)]);
}

#[tokio::test]
async fn sends_text_to_a_custom_provider_serving_a_model_that_takes_temporary_messages() {
    let model = MockModel::new().with_turn("ok");
    model
        .update_config(BaseModelConfig {
            model_id: Some("claude-opus-5-5".into()),
            ..BaseModelConfig::default()
        })
        .unwrap();
    let messages =
        vec![Message::new(Role::User, vec![text("Refactor."), injected("reminder")]).with_tracking_id("msg-1")];
    drain(&model, request(messages), None).await.unwrap();
    assert_eq!(
        model.requests()[0].messages,
        vec![Message::new(Role::User, vec![text("Refactor."), text("\n\nreminder")]).with_tracking_id("msg-1")]
    );
}

#[tokio::test]
async fn passes_injected_blocks_through_to_a_model_that_takes_temporary_messages() {
    let model = MockModel::new().with_turn("ok");
    with_capabilities(
        &model,
        ModelCapabilities {
            temporary_messages: Some(true),
            ..ModelCapabilities::default()
        },
    );
    let messages = vec![
        Message::new(Role::User, vec![text("Refactor."), injected("reminder")]),
        Message::new(Role::Assistant, vec![text("Done.")]),
        user("Now the docs."),
    ];
    drain(&model, request(messages.clone()), None).await.unwrap();
    assert_eq!(model.requests()[0].messages, messages);
}

/// Records the messages and options of `count_tokens`.
#[derive(Default)]
struct CountingModel {
    inner: MockModel,
    counted: std::sync::Mutex<Vec<(Vec<Message>, CountTokensOptions)>>,
}

#[async_trait::async_trait]
impl Model for CountingModel {
    fn stream(&self, request: ModelRequest) -> crate::models::BoxStream<'static, Result<ModelStreamEvent>> {
        self.inner.stream(request)
    }

    fn get_config(&self) -> BaseModelConfig {
        self.inner.get_config()
    }

    fn update_config(&self, config: BaseModelConfig) -> crate::Result<()> {
        self.inner.update_config(config)
    }

    async fn count_tokens(&self, messages: &[Message], options: CountTokensOptions) -> Result<u64> {
        self.counted.lock().unwrap().push((messages.to_vec(), options));
        Ok(0)
    }
}

#[tokio::test]
async fn counts_the_messages_it_would_send() {
    let model = Arc::new(CountingModel::default());
    let messages =
        vec![Message::new(Role::User, vec![text("Refactor."), injected("reminder")]).with_tracking_id("msg-1")];
    let options = CountTokensOptions {
        system_prompt: Some("Be brief.".into()),
        ..CountTokensOptions::default()
    };
    ModelProxy::new(model.clone())
        .count_tokens(&messages, options.clone())
        .await
        .unwrap();
    assert_eq!(
        *model.counted.lock().unwrap(),
        vec![(
            vec![Message::new(Role::User, vec![text("Refactor."), text("\n\nreminder")]).with_tracking_id("msg-1")],
            options
        )]
    );
}

#[tokio::test]
async fn leaves_out_an_injected_block_outside_a_user_message() {
    let prompt = user("go");
    let messages = vec![
        prompt.clone(),
        Message::new(Role::Assistant, vec![text("Hi"), injected("reminder"), text("Bye")]).with_tracking_id("msg-2"),
    ];
    assert_eq!(
        sent(messages).await,
        vec![
            prompt,
            Message::new(Role::Assistant, vec![text("Hi"), text("Bye")]).with_tracking_id("msg-2")
        ]
    );
}

#[tokio::test]
async fn does_not_change_the_messages_it_was_given() {
    let messages = vec![Message::new(
        Role::User,
        vec![text("Refactor the tokenizer."), injected("reminder")],
    )];
    let given = messages.clone();
    sent(given).await;
    assert_eq!(
        messages[0].content,
        vec![text("Refactor the tokenizer."), injected("reminder")]
    );
}

#[tokio::test]
async fn passes_messages_without_an_injected_block_through_as_they_are() {
    let messages = vec![user("go")];
    assert_eq!(sent(messages.clone()).await, messages);
}

fn summary_history() -> Vec<Message> {
    vec![
        Message::new(
            Role::Assistant,
            vec![
                ContentBlock::Summary(
                    SummaryBlock::new("SUMMARY")
                        .with_provider("anthropic")
                        .with_signature("SIG"),
                ),
                text("next"),
            ],
        ),
        user("go"),
    ]
}

#[tokio::test]
async fn sends_the_summary_text_to_a_model_with_server_side_summary_undefined_or_false() {
    for server_side_summary in [None, Some(false)] {
        let model = MockModel::new().with_turn("ok");
        with_capabilities(
            &model,
            ModelCapabilities {
                server_side_summary,
                ..ModelCapabilities::default()
            },
        );
        let messages = summary_history();
        drain(&model, request(messages.clone()), None).await.unwrap();
        assert_eq!(
            model.requests()[0].messages[0].content,
            vec![text("SUMMARY"), text("next")],
            "{server_side_summary:?}"
        );
        assert!(matches!(messages[0].content[0], ContentBlock::Summary(_)));
    }
}

#[tokio::test]
async fn keeps_the_summary_block_for_a_model_with_server_side_summary() {
    let model = MockModel::new().with_turn("ok");
    with_capabilities(
        &model,
        ModelCapabilities {
            server_side_summary: Some(true),
            ..ModelCapabilities::default()
        },
    );
    let messages = summary_history();
    drain(&model, request(messages.clone()), None).await.unwrap();
    assert_eq!(model.requests()[0].messages, messages);
}

#[tokio::test]
async fn client_side_summarize_sends_messages_the_way_the_proxy_renders_them() {
    let model = MockModel::new().with_turn("the summary");
    let messages = vec![
        summary_history().remove(0),
        Message::new(Role::User, vec![text("go"), injected("reminder")]),
    ];
    model
        .summarize(messages, crate::models::SummarizeOptions::default())
        .await
        .unwrap();
    let sent = &model.requests()[0].messages;
    assert_eq!(sent[0].content, vec![text("SUMMARY"), text("next")]);
    assert_eq!(sent[1].content[..2], [text("go"), text("\n\nreminder")]);
}

mod deferred_tools {
    use std::collections::HashSet;

    use serde_json::json;

    use super::*;
    use crate::models::DeferredToolLoading;
    use crate::types::{ToolReferenceBlock, ToolSpec};

    fn definition() -> ToolSpec {
        ToolSpec::new("shell", "Run a command")
            .with_input_schema(json!({"type": "object", "properties": {"command": {"type": "string"}}}))
    }

    fn pinned() -> ToolSpec {
        ToolSpec::new("load_tools", "Load tools.").with_input_schema(json!({"type": "object"}))
    }

    fn history() -> Vec<Message> {
        vec![
            Message::new(
                Role::User,
                vec![ToolResultBlock::success("t-1", vec![ToolReferenceBlock::new("shell").into()]).into()],
            )
            .with_tracking_id("msg-1"),
        ]
    }

    fn model_with(deferred_tool_loading: Option<DeferredToolLoading>) -> MockModel {
        let model = MockModel::new().with_turn("ok");
        with_capabilities(
            &model,
            ModelCapabilities {
                deferred_tool_loading,
                ..ModelCapabilities::default()
            },
        );
        model
    }

    /// Sends the history through the proxy and returns the tool result content the model received.
    async fn sent_content(
        deferred_tool_loading: Option<DeferredToolLoading>,
        tool_specs: Vec<ToolSpec>,
    ) -> Vec<ToolResultContent> {
        let model = model_with(deferred_tool_loading);
        let request = ModelRequest {
            tool_specs,
            ..ModelRequest::builder().messages(history()).build()
        };
        drain(&model, request, None).await.unwrap();
        let ContentBlock::ToolResult(result) = &model.requests()[0].messages[0].content[0] else {
            panic!("not a tool result");
        };
        result.content.clone()
    }

    /// Sends a call that defers `shell` and pins `load_tools`, and returns the request the model
    /// received.
    async fn sent_request(deferred_tool_loading: DeferredToolLoading) -> ModelRequest {
        let model = model_with(Some(deferred_tool_loading));
        let request = ModelRequest {
            tool_specs: vec![definition(), pinned()],
            deferred_tools: HashSet::from(["shell".to_owned()]),
            ..ModelRequest::builder().messages(vec![user("go")]).build()
        };
        drain(&model, request, None).await.unwrap();
        model.requests().remove(0)
    }

    #[tokio::test]
    async fn sends_a_deferred_spec_as_a_stub_with_an_open_schema_to_a_model_that_takes_stubs() {
        assert_eq!(
            sent_request(DeferredToolLoading::Stubs).await.tool_specs,
            vec![
                ToolSpec::new(
                    "shell",
                    "Run a command\nCall load_tools with this name for its parameters first."
                )
                .with_input_schema(json!({"type": "object"})),
                pinned(),
            ]
        );
    }

    #[tokio::test]
    async fn sends_the_deferred_spec_as_it_is_to_a_model_that_defers_natively_and_a_model_without_deferred_tools() {
        for deferred_tool_loading in [DeferredToolLoading::Native, DeferredToolLoading::Unsupported] {
            let request = sent_request(deferred_tool_loading).await;
            assert_eq!(request.tool_specs, vec![definition(), pinned()]);
            assert_eq!(request.deferred_tools, HashSet::from(["shell".to_owned()]));
        }
    }

    #[tokio::test]
    async fn passes_the_reference_to_a_model_that_defers_tools_natively_whose_provider_sends_it() {
        assert_eq!(
            sent_content(Some(DeferredToolLoading::Native), vec![definition()]).await,
            vec![ToolReferenceBlock::new("shell").into()]
        );
    }

    #[tokio::test]
    async fn sends_the_call_s_parameters_for_the_tool_as_text_to_a_model_that_takes_stubs_and_a_model_without_deferred_tools()
     {
        let changed =
            ToolSpec::new("shell", "Run a command").with_input_schema(json!({"type": "object", "properties": {}}));
        for deferred_tool_loading in [DeferredToolLoading::Stubs, DeferredToolLoading::Unsupported] {
            assert_eq!(
                sent_content(Some(deferred_tool_loading), vec![changed.clone()]).await,
                vec![ToolResultContent::text(format!(
                    "shell parameters: {}",
                    json!({"type": "object", "properties": {}})
                ))]
            );
        }
    }

    #[tokio::test]
    async fn names_the_tool_when_the_call_does_not_include_it() {
        assert_eq!(
            sent_content(None, Vec::new()).await,
            vec![ToolResultContent::text(
                "Loaded tool shell, which this request doesn't include."
            )]
        );
    }
}
