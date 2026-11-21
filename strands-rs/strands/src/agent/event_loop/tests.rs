use serde_json::json;

use super::*;
use crate::testing::{MockModel, test_agent};
use crate::types::ToolUseBlock;

const REDACT_MESSAGE: &str = "[REDACTED]";

fn agent() -> Agent {
    test_agent(MockModel::new().with_turn("Response"))
}

mod redact_last_user_message {
    use super::*;

    #[test]
    fn redacts_last_user_message_with_only_text_blocks() {
        let mut agent = agent();
        agent.messages_mut().push(Message::user("sensitive content"));
        agent.redact_last_user_message(REDACT_MESSAGE);
        let last = agent.messages().last().unwrap();
        assert_eq!(last.role, Role::User);
        assert_eq!(last.content, vec![ContentBlock::text(REDACT_MESSAGE)]);
    }

    #[test]
    fn preserves_the_durable_tracking_id_when_redacting() {
        let mut agent = agent();
        agent
            .messages_mut()
            .push(Message::user("sensitive content").with_tracking_id("durable-1"));
        agent.redact_last_user_message(REDACT_MESSAGE);
        assert_eq!(agent.messages().last().unwrap().tracking_id(), "durable-1");
    }

    #[test]
    fn preserves_tool_result_blocks_with_redacted_content() {
        let mut agent = agent();
        agent.messages_mut().push(Message::new(
            Role::User,
            vec![
                ContentBlock::text("some text"),
                ToolResultBlock::success("tool-1", vec![ToolResultContent::text("tool result content")]).into(),
                ContentBlock::text("more text"),
                ToolResultBlock::error("tool-2", vec![ToolResultContent::text("error content")]).into(),
            ],
        ));
        agent.redact_last_user_message(REDACT_MESSAGE);
        let last = agent.messages().last().unwrap();
        assert_eq!(last.role, Role::User);
        assert_eq!(
            serde_json::to_value(&last.content).unwrap(),
            json!([
                {"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"text": REDACT_MESSAGE}]}},
                {"toolResult": {"toolUseId": "tool-2", "status": "error", "content": [{"text": REDACT_MESSAGE}]}}
            ])
        );
    }

    #[test]
    fn does_not_redact_when_there_is_no_user_message() {
        let (logs, _guard) = crate::test_support::record_logs();
        let mut agent = agent();
        let assistant = Message::assistant("assistant response");
        agent.messages_mut().push(assistant.clone());
        agent.redact_last_user_message(REDACT_MESSAGE);
        assert_eq!(agent.messages(), &[assistant]);
        assert!(
            logs.text()
                .contains("received input redaction but no user message found | redaction skipped")
        );
    }

    #[test]
    fn handles_empty_messages_array_gracefully() {
        let (logs, _guard) = crate::test_support::record_logs();
        let mut agent = agent();
        agent.redact_last_user_message(REDACT_MESSAGE);
        assert!(agent.messages().is_empty());
        assert!(
            logs.text()
                .contains("received input redaction but no user message found | redaction skipped")
        );
    }

    #[tokio::test]
    async fn redacts_the_user_message_when_a_hook_appends_an_assistant_message_after_it() {
        let events: Vec<crate::models::streaming::ModelStreamEvent> = [
            json!({"type": "modelMessageStartEvent", "role": "assistant"}),
            json!({"type": "modelContentBlockStartEvent"}),
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "INPUT BLOCKED!"}}),
            json!({"type": "modelContentBlockStopEvent"}),
            json!({"type": "modelMessageStopEvent", "stopReason": "guardrailIntervened"}),
            json!({"type": "modelRedactionEvent", "inputRedaction": {"replaceContent": REDACT_MESSAGE}}),
        ]
        .into_iter()
        .map(|event| serde_json::from_value(event).unwrap())
        .collect();
        let mut agent = test_agent(MockModel::new().with_turn(crate::testing::MockTurn::events(events)));
        let context = Message::assistant("<user_context>likes cats</user_context>");
        let appended = context.clone();
        agent.add_hook(move |event: &mut crate::hooks::MessageAddedEvent<'_>| {
            if event.message().role == Role::User {
                event.agent_mut().messages_mut().push(appended.clone());
            }
        });

        agent.invoke("Tell me something bad").await.unwrap();

        let messages = agent.messages();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].role, Role::User);
        assert_eq!(messages[0].content, vec![ContentBlock::text(REDACT_MESSAGE)]);
        assert_eq!(messages[1], context);
        assert_eq!(messages[2].role, Role::Assistant);
        assert_eq!(messages[2].content, vec![ContentBlock::text("INPUT BLOCKED!")]);
    }
}

mod normalize_helpers {
    use super::*;

    #[test]
    fn replaces_only_invalid_names_on_assistant_messages() {
        let messages = vec![
            Message::new(
                Role::Assistant,
                vec![
                    ToolUseBlock::new("bad name!", "tu-1", json!({})).into(),
                    ToolUseBlock::new("good_tool-1", "tu-2", json!({})).into(),
                ],
            ),
            Message::new(
                Role::User,
                vec![ToolUseBlock::new("bad name!", "tu-3", json!({})).into()],
            ),
        ];
        let normalized = normalize_tool_use_names(messages);
        assert_eq!(
            normalized[0].content,
            vec![
                ToolUseBlock::new("INVALID_TOOL_NAME", "tu-1", json!({})).into(),
                ToolUseBlock::new("good_tool-1", "tu-2", json!({})).into(),
            ]
        );
        assert_eq!(
            normalized[1].content,
            vec![ToolUseBlock::new("bad name!", "tu-3", json!({})).into()]
        );
    }

    #[test]
    fn fills_only_empty_assistant_messages() {
        let messages = vec![
            Message::new(Role::User, Vec::new()),
            Message::new(Role::Assistant, Vec::new()),
            Message::assistant("kept"),
        ];
        let filled = fill_empty_assistant_messages(messages);
        assert!(filled[0].content.is_empty());
        assert_eq!(filled[1].content, vec![ContentBlock::text("[blank text]")]);
        assert_eq!(filled[2].content, vec![ContentBlock::text("kept")]);
    }

    #[test]
    fn normalize_input_turns_each_input_form_into_messages() {
        assert_eq!(
            normalize_input(&"hi".into()).unwrap()[0].content,
            vec![ContentBlock::text("hi")]
        );
        assert!(normalize_input(&Vec::<ContentBlock>::new().into()).unwrap().is_empty());
        assert!(
            normalize_input(&InvokeArgs::InterruptResponses(Vec::new()))
                .unwrap()
                .is_empty()
        );
        let blank = normalize_input(&"\u{feff} \t".into()).unwrap_err();
        assert_eq!(
            blank.to_string(),
            "Input prompt is blank. Provide non-blank text or at least one non-text content block."
        );
        let assistant_only = normalize_input(&vec![Message::new(Role::Assistant, Vec::new())].into()).unwrap();
        assert_eq!(assistant_only.len(), 1);
    }
}

/// Reads the agent's local traces after a failed invocation.
mod local_traces {
    use super::*;
    use crate::models::streaming::Usage;
    use crate::test_support::MockTool;
    use crate::testing::MockTurn;
    use crate::types::{StopReason, ToolResultBlock, ToolResultContent};

    #[tokio::test]
    async fn collects_local_traces_for_completed_cycles_when_error_occurs_mid_run() {
        let model = MockModel::new()
            .with_turn(
                MockTurn::content([ContentBlock::from(ToolUseBlock::new("testTool", "tool-1", json!({})))])
                    .with_usage(Usage::new(100, 50, 150)),
            )
            .with_turn(
                MockTurn::text("Partial")
                    .with_stop_reason(StopReason::MaxTokens)
                    .with_usage(Usage::new(80, 20, 100)),
            );
        let tool = MockTool::new("testTool").with_result(|context| {
            ToolResultBlock::success(
                context.tool_use().tool_use_id.clone(),
                vec![ToolResultContent::text("Done")],
            )
            .into()
        });
        let mut agent = Agent::builder()
            .model(model)
            .tools([tool])
            .printer(false)
            .build()
            .unwrap();

        let error = agent.invoke("Test").await.unwrap_err();

        assert!(matches!(error, crate::Error::MaxTokens(_)), "{error}");
        let traces = agent.local.tracer().local_traces();
        let names: Vec<&str> = traces.iter().map(|trace| trace.name.as_str()).collect();
        assert_eq!(names, ["Cycle 1", "Cycle 2"]);
        let children: Vec<&str> = traces[0].children.iter().map(|child| child.name.as_str()).collect();
        assert_eq!(children, ["stream_messages", "Tool: testTool"]);
    }
}

#[tokio::test]
async fn passes_the_deferred_tools_to_the_model_and_records_the_tools_it_received() {
    use crate::models::{BaseModelConfig, DeferredToolLoading, ModelCapabilities, ModelInfo};

    let model = MockModel::new().with_turn("Hello");
    // A model that takes stubs would get the deferred spec as a stub.
    model
        .update_config(BaseModelConfig {
            model_info: Some(ModelInfo {
                capabilities: ModelCapabilities {
                    deferred_tool_loading: Some(DeferredToolLoading::Native),
                    ..ModelCapabilities::default()
                },
                ..ModelInfo::default()
            }),
            ..BaseModelConfig::default()
        })
        .unwrap();
    let mut agent = test_agent(model.clone());
    let shell = ToolSpec::new("shell", "Run a command").with_input_schema(json!({"type": "object"}));
    let grep = ToolSpec::new("grep", "Search files").with_input_schema(json!({"type": "object"}));
    let deferred: HashSet<String> = HashSet::from(["shell".to_owned()]);
    let (input_shell, input_deferred) = (shell.clone(), deferred.clone());
    agent.add_middleware(InvokeModelStage::input(move |mut context| {
        context.tool_specs = vec![input_shell.clone()];
        context.deferred_tools = input_deferred.clone();
        async move { Ok(context) }
    }));
    let wrap_grep = grep.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |mut context, next| {
        context.tool_specs.push(wrap_grep.clone());
        next.call(context)
    }));

    agent.invoke("Test prompt").await.unwrap();

    let request = model.requests().remove(0);
    assert_eq!(request.tool_specs, vec![shell.clone(), grep.clone()]);
    assert_eq!(request.deferred_tools, deferred);
    assert_eq!(
        agent.local().latest_call_tools(),
        Some(crate::models::model_proxy::CallTools {
            tool_specs: vec![shell, grep],
            deferred_tools: deferred,
        })
    );
}
