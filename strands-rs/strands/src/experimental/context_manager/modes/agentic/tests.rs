//! Each case calls a tool's callback on a messages array; the agent cases at the end run the tools
//! inside an agent loop.

use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::conversation_manager::compression::pin_message::pin_message;
use crate::experimental::context_manager::ContextManagerStrategy;
use crate::testing::{MockModel, MockTurn};
use crate::types::{ToolResultBlock, ToolResultContent, ToolUseBlock};

fn text_message(role: Role, text: &str) -> Message {
    Message::new(role, vec![ContentBlock::text(text)])
}

fn make_messages(count: usize) -> Vec<Message> {
    (0..count)
        .map(|index| {
            let role = if index % 2 == 0 { Role::User } else { Role::Assistant };
            text_message(role, &format!("Message {}", index + 1))
        })
        .collect()
}

fn tool_use(id: &str, name: &str) -> Message {
    Message::new(
        Role::Assistant,
        vec![ContentBlock::ToolUse(ToolUseBlock::new(name, id, json!({})))],
    )
}

fn tool_result(id: &str, text: &str) -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            id,
            vec![ToolResultContent::text(text)],
        ))],
    )
}

fn summary_model(text: &str) -> Arc<dyn Model> {
    Arc::new(MockModel::new().with_turn(text))
}

fn is_pinned_flag(message: &Message) -> bool {
    message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.custom.as_ref())
        .and_then(|custom| custom.get("pinned"))
        == Some(&JsonValue::Bool(true))
}

fn first_text(message: &Message) -> &str {
    message.content[0].as_text().unwrap_or_default()
}

async fn summarize(messages: &mut Vec<Message>, model: &Arc<dyn Model>, input: JsonValue) -> String {
    summarize_context(messages, model, serde_json::from_value(input).unwrap(), None).await
}

fn truncate(messages: &mut Vec<Message>, input: JsonValue) -> String {
    truncate_context(messages, &serde_json::from_value(input).unwrap())
}

fn pin(messages: &mut [Message], input: JsonValue) -> String {
    pin_context(messages, &serde_json::from_value(input).unwrap())
}

// --- summarize_context --------------------------------------------------------------------------

#[tokio::test]
async fn returns_message_when_not_enough_messages_to_summarize() {
    let mut messages = make_messages(4);
    let result = summarize(&mut messages, &summary_model("Summary"), json!({"keepRecent": 10})).await;
    assert!(result.contains("No summarization performed"));
    assert!(result.contains("not enough eligible messages"));
    assert_eq!(messages.len(), 4);
}

#[tokio::test]
async fn summarizes_eligible_messages_and_splices_the_array() {
    let mut messages = make_messages(20);
    let result = summarize(
        &mut messages,
        &summary_model("Summary"),
        json!({"keepRecent": 10, "summaryRatio": 0.5}),
    )
    .await;
    assert!(result.contains("Summarized"));
    assert!(result.contains("message(s)"));
    assert!(messages.len() < 20);
    assert_eq!(messages[0].role, Role::User);
}

#[tokio::test]
async fn summarizes_with_agent_aux_model() {
    let main = MockModel::new().with_turn("Main");
    let aux = MockModel::new().with_turn("Summary");
    let mut local = crate::agent::LocalAgent::new("agent", Arc::new(main.clone()));
    local.set_aux_model(Some(Arc::new(aux.clone())));
    *local.messages_mut() = make_messages(20);
    let tool = AgenticContext::default().tools().remove(0);
    let context = ToolContext::new(
        crate::types::ToolUse::new(
            "summarize_context",
            "call-1",
            json!({"keepRecent": 10, "summaryRatio": 0.5}),
        ),
        local.tool_agent(),
        crate::agent::InvocationState::new(),
    );
    let mut stream = tool.stream(context);
    let mut text = String::new();
    while let Some(item) = futures::StreamExt::next(&mut stream).await {
        if let crate::tools::ToolStreamItem::Outcome(ToolOutcome::Result(result)) = item {
            text = format!("{:?}", result.content);
        }
    }
    assert!(text.contains("Summarized"));
    assert_eq!(aux.requests().len(), 1);
    assert!(main.requests().is_empty());
}

#[tokio::test]
async fn assigns_a_durable_tracking_id_to_the_generated_summary() {
    let mut messages = make_messages(20);
    summarize(
        &mut messages,
        &summary_model("Summary"),
        json!({"keepRecent": 10, "summaryRatio": 0.5}),
    )
    .await;
    let summary = messages
        .iter()
        .find(|message| first_text(message) == "Summary")
        .unwrap();
    assert!(!summary.tracking_id().is_empty());
}

#[tokio::test]
async fn preserves_pinned_messages_during_summarization() {
    let mut messages = make_messages(20);
    pin_message(&mut messages, 1);
    let pinned_text = first_text(&messages[1]).to_owned();
    summarize(
        &mut messages,
        &summary_model("Summary"),
        json!({"keepRecent": 6, "summaryRatio": 0.5}),
    )
    .await;
    assert!(messages.iter().any(|message| first_text(message) == pinned_text));
}

#[tokio::test]
async fn respects_message_type_filter() {
    let mut messages = vec![tool_use("id-1", "tool1"), tool_result("id-1", "Result")];
    messages.extend(make_messages(14));
    let result = summarize(
        &mut messages,
        &summary_model("Summary"),
        json!({"keepRecent": 10, "summaryRatio": 0.3, "messageType": "messages"}),
    )
    .await;
    assert!(result.contains("\"messages\""));
}

#[tokio::test]
async fn returns_message_when_no_eligible_messages_in_range_after_filtering() {
    let mut messages = vec![
        tool_use("id-1", "t"),
        tool_result("id-1", "R"),
        tool_use("id-2", "t"),
        tool_result("id-2", "R"),
    ];
    messages.extend(make_messages(12));
    let result = summarize(
        &mut messages,
        &summary_model("Summary"),
        json!({"keepRecent": 12, "summaryRatio": 0.3, "messageType": "messages"}),
    )
    .await;
    assert!(result.contains("No summarization performed"));
}

#[tokio::test]
async fn preserves_pinned_tool_use_when_its_tool_result_is_in_the_eligible_set() {
    let mut messages = vec![tool_use("id-1", "tool1"), tool_result("id-1", "Important result")];
    messages.extend(make_messages(14));
    pin_message(&mut messages, 0);
    summarize(
        &mut messages,
        &summary_model("Summary"),
        json!({"keepRecent": 10, "summaryRatio": 0.3}),
    )
    .await;
    assert!(messages.iter().any(|message| {
        message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse(_)))
            && is_pinned_flag(message)
    }));
}

#[tokio::test]
async fn preserves_message_order_after_summarization_with_pinned_assistant_message() {
    let mut messages = vec![
        text_message(Role::User, "First"),
        text_message(Role::Assistant, "Pinned response"),
    ];
    messages.extend(make_messages(18));
    pin_message(&mut messages, 1);
    summarize(
        &mut messages,
        &summary_model("Summary"),
        json!({"keepRecent": 10, "summaryRatio": 0.3}),
    )
    .await;
    assert_eq!(messages[0].role, Role::User);
}

#[tokio::test]
async fn returns_failure_message_when_model_throws() {
    let model: Arc<dyn Model> = Arc::new(MockModel::new().with_turn(MockTurn::error(|| Error::other("model error"))));
    let mut messages = make_messages(20);
    let result = summarize(&mut messages, &model, json!({"keepRecent": 5, "summaryRatio": 0.5})).await;
    assert!(result.contains("Summarization failed"), "{result}");
}

// --- truncate_context ---------------------------------------------------------------------------

#[test]
fn does_not_drop_messages_when_keep_recent_exceeds_conversation_length() {
    let mut messages = make_messages(6);
    assert!(truncate(&mut messages, json!({"keepRecent": 10})).contains("No messages dropped"));
    assert_eq!(messages.len(), 6);
}

#[test]
fn preserves_message_order_when_pinned_assistant_message_exists() {
    let mut messages = vec![
        text_message(Role::User, "First"),
        text_message(Role::Assistant, "Response"),
    ];
    messages.extend(make_messages(18));
    pin_message(&mut messages, 1);
    truncate(&mut messages, json!({"keepRecent": 5}));
    assert_eq!(messages[0].role, Role::User);
}

#[test]
fn returns_message_when_conversation_is_too_short() {
    let mut messages = make_messages(2);
    let result = truncate(&mut messages, json!({}));
    assert!(result.contains("No messages dropped"));
    assert!(result.contains("only has 2 messages"));
    assert_eq!(messages.len(), 2);
}

#[test]
fn drops_oldest_messages_respecting_window() {
    let mut messages = make_messages(20);
    let result = truncate(&mut messages, json!({"keepRecent": 5}));
    assert!(result.contains("Dropped"));
    assert!(result.contains("remaining"));
    assert!(messages.len() < 20 && messages.len() >= 4);
    assert_eq!(first_text(messages.last().unwrap()), "Message 20");
}

#[test]
fn preserves_pinned_messages_during_truncation() {
    let mut messages = make_messages(20);
    pin_message(&mut messages, 0);
    pin_message(&mut messages, 1);
    truncate(&mut messages, json!({"keepRecent": 5}));
    let texts: Vec<&str> = messages.iter().map(first_text).collect();
    assert!(texts.contains(&"Message 1"));
    assert!(texts.contains(&"Message 2"));
}

#[test]
fn truncate_respects_message_type_filter() {
    let mut messages = vec![
        text_message(Role::User, "Hello"),
        text_message(Role::Assistant, "Hi"),
        tool_use("id-1", "t"),
        tool_result("id-1", "R"),
    ];
    messages.extend(make_messages(10));
    let result = truncate(&mut messages, json!({"keepRecent": 5, "messageType": "messages"}));
    assert!(result.contains("\"messages\""));
}

#[test]
fn returns_message_when_no_valid_trim_point_found() {
    let mut messages: Vec<Message> = (0..6).map(|index| tool_result(&format!("id-{index}"), "R")).collect();
    let result = truncate(&mut messages, json!({"keepRecent": 2}));
    assert!(result.contains("No messages dropped"));
    assert!(result.contains("no valid trim boundary"));
}

// --- pin_context --------------------------------------------------------------------------------

#[test]
fn pins_the_entire_current_turn() {
    let mut messages = vec![
        text_message(Role::User, "First question"),
        text_message(Role::Assistant, "First answer"),
        text_message(Role::User, "Second question"),
        text_message(Role::Assistant, "Second answer"),
    ];
    let result = pin(&mut messages, json!({"select": "last_turn", "action": "pin"}));
    assert!(result.contains("Pinned"));
    assert!(result.contains("2 message(s)"));
    assert!(is_pinned_flag(&messages[2]) && is_pinned_flag(&messages[3]));
    assert!(messages[0].metadata.is_none());
}

#[test]
fn includes_tool_calls_in_the_current_turn() {
    let mut messages = vec![
        text_message(Role::User, "Old question"),
        text_message(Role::Assistant, "Old answer"),
        text_message(Role::User, "Check weather"),
        tool_use("id-1", "weather"),
        tool_result("id-1", "Sunny"),
        text_message(Role::Assistant, "It is sunny"),
    ];
    let result = pin(&mut messages, json!({"select": "last_turn", "action": "pin"}));
    assert!(result.contains("4 message(s)"));
    assert!((2..6).all(|index| is_pinned_flag(&messages[index])));
    assert!(messages[0].metadata.is_none());
}

#[test]
fn pins_with_filter_on_last_turn() {
    let mut messages = vec![
        text_message(Role::User, "Old"),
        text_message(Role::Assistant, "Old"),
        text_message(Role::User, "New question"),
        text_message(Role::Assistant, "New answer"),
    ];
    let result = pin(
        &mut messages,
        json!({"select": "last_turn", "filter": "user", "action": "pin"}),
    );
    assert!(result.contains("1 message(s)"));
    assert!(is_pinned_flag(&messages[2]));
    assert!(messages[3].metadata.is_none());
}

#[test]
fn pins_the_last_n_messages() {
    let mut messages = make_messages(6);
    let result = pin(&mut messages, json!({"select": 3, "action": "pin"}));
    assert!(result.contains("Pinned") && result.contains("3 message(s)"));
    assert!((3..6).all(|index| is_pinned_flag(&messages[index])));
    assert!(messages[0].metadata.is_none());
}

#[test]
fn clamps_to_conversation_length() {
    let mut messages = make_messages(3);
    assert!(pin(&mut messages, json!({"select": 100, "action": "pin"})).contains("3 message(s)"));
}

#[test]
fn filters_by_role_within_last_n() {
    let mut messages = make_messages(6);
    let result = pin(&mut messages, json!({"select": 6, "filter": "user", "action": "pin"}));
    assert!(result.contains("3 message(s)"));
    assert!([0, 2, 4].iter().all(|&index| is_pinned_flag(&messages[index])));
    assert!(messages[1].metadata.is_none());
}

#[test]
fn pins_messages_at_specific_indices() {
    let mut messages = make_messages(6);
    let result = pin(&mut messages, json!({"select": [0, 2, 4], "action": "pin"}));
    assert!(result.contains("Pinned") && result.contains("3 message(s)"));
    assert!([0, 2, 4].iter().all(|&index| is_pinned_flag(&messages[index])));
    assert!(messages[1].metadata.is_none());
}

#[test]
fn returns_error_when_all_indices_out_of_range() {
    let mut messages = make_messages(3);
    let result = pin(&mut messages, json!({"select": [10, 20, 30], "action": "pin"}));
    assert!(result.contains("All indices out of range"));
    assert!(result.contains("3 messages"));
}

#[test]
fn filters_out_of_range_indices_but_pins_valid_ones() {
    let mut messages = make_messages(4);
    let result = pin(&mut messages, json!({"select": [1, 99], "action": "pin"}));
    assert!(result.contains("Pinned") && result.contains("1 message(s)"));
    assert!(is_pinned_flag(&messages[1]));
}

#[test]
fn pins_only_tool_use_and_tool_result_messages() {
    let mut messages = vec![
        text_message(Role::User, "Do something"),
        tool_use("id-1", "t"),
        tool_result("id-1", "Result"),
        text_message(Role::Assistant, "Done"),
    ];
    let result = pin(&mut messages, json!({"select": 4, "filter": "tools", "action": "pin"}));
    assert!(result.contains("2 message(s)"));
    assert!(is_pinned_flag(&messages[1]) && is_pinned_flag(&messages[2]));
    assert!(messages[0].metadata.is_none() && messages[3].metadata.is_none());
}

#[test]
fn removes_pin_from_previously_pinned_messages() {
    let mut messages = make_messages(4);
    pin_message(&mut messages, 1);
    pin_message(&mut messages, 2);
    let result = pin(&mut messages, json!({"select": [1, 2], "action": "unpin"}));
    assert!(result.contains("Unpinned") && result.contains("2 message(s)"));
    assert!(messages[1].metadata.is_none() && messages[2].metadata.is_none());
}

#[test]
fn unpins_last_n_messages() {
    let mut messages = make_messages(4);
    pin_message(&mut messages, 2);
    pin_message(&mut messages, 3);
    pin(&mut messages, json!({"select": 2, "action": "unpin"}));
    assert!(messages[2].metadata.is_none() && messages[3].metadata.is_none());
}

#[test]
fn returns_appropriate_message() {
    assert_eq!(
        pin(&mut [], json!({"select": "last_turn", "action": "pin"})),
        "No messages in the conversation."
    );
}

#[test]
fn defaults_the_action_to_pin() {
    let mut messages = make_messages(2);
    assert_eq!(pin(&mut messages, json!({"select": 1})), "Pinned 1 message(s).");
}

// --- inside an agent ----------------------------------------------------------------------------

fn tool_call(name: &str, input: JsonValue) -> MockTurn {
    MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(name, "call-1", input))])
}

fn agentic_agent(model: MockModel, messages: Vec<Message>) -> crate::Agent {
    crate::Agent::builder()
        .model(model)
        .messages(messages)
        .context_manager(ContextManagerStrategy::Agentic)
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn registers_the_agentic_tools_and_middleware() {
    let agent = agentic_agent(MockModel::new(), Vec::new());
    let mut names: Vec<String> = agent
        .local
        .tool_registry()
        .list()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["pin_context", "summarize_context", "truncate_context"]);
}

#[tokio::test]
async fn a_truncation_by_the_model_applies_to_the_history() {
    let model = MockModel::from_turns([
        tool_call("truncate_context", json!({"keepRecent": 3})),
        MockTurn::text("done"),
    ]);
    let mut agent = agentic_agent(model, make_messages(10));
    agent.invoke("go on").await.unwrap();
    let texts: Vec<String> = agent.messages().iter().map(Message::text).collect();
    assert_eq!(
        texts[..4],
        ["Message 1", "Message 9", "Message 10", "go on"],
        "{texts:?}"
    );
    assert_eq!(texts.last().map(String::as_str), Some("done"));
    assert_eq!(truncate_result(&agent), "Dropped 7 message(s). 4 remaining.");
}

fn truncate_result(agent: &crate::Agent) -> String {
    agent
        .messages()
        .iter()
        .flat_map(|message| message.content.iter())
        .find_map(|block| match block {
            ContentBlock::ToolResult(result) if result.tool_use_id == "call-1" => match &result.content[0] {
                ToolResultContent::Text(text) => Some(text.text.clone()),
                _ => None,
            },
            _ => None,
        })
        .unwrap()
}

fn old_history(count: usize) -> Vec<Message> {
    (0..count)
        .map(|index| {
            let role = if index % 2 == 0 { Role::User } else { Role::Assistant };
            text_message(role, &format!("old {index}"))
        })
        .collect()
}

/// Counts and keeps the window over the history without the calling assistant message, which
/// joins only after the batch: the kept window is `[old 0, old 28, old 29, go]`.
#[tokio::test]
async fn a_model_truncation_keeps_the_window_without_the_calling_message() {
    let model = MockModel::from_turns([
        tool_call("truncate_context", json!({"keepRecent": 3})),
        MockTurn::text("done"),
    ]);
    let mut agent = agentic_agent(model, old_history(30));
    agent.invoke("go").await.unwrap();
    let texts: Vec<String> = agent.messages().iter().map(Message::text).collect();
    assert_eq!(texts[..4], ["old 0", "old 28", "old 29", "go"], "{texts:?}");
    assert_eq!(agent.messages().len(), 7);
    assert_eq!(truncate_result(&agent), "Dropped 27 message(s). 4 remaining.");
}

/// The calling assistant message joins the history after the batch, so the last turn is the user
/// request.
#[tokio::test]
async fn pinning_the_last_turn_pins_the_request_of_the_running_turn() {
    let model = MockModel::from_turns([
        tool_call("pin_context", json!({"select": "last_turn"})),
        MockTurn::text("done"),
    ]);
    let mut agent = agentic_agent(model, Vec::new());
    agent.invoke("remember this").await.unwrap();
    let pins: Vec<bool> = agent.messages().iter().map(is_pinned_flag).collect();
    assert_eq!(pins, [true, false, false, false]);
}

struct Confirm;

impl crate::Tool for Confirm {
    fn name(&self) -> &str {
        "confirm"
    }

    fn description(&self) -> &str {
        "Asks the user to confirm."
    }

    fn tool_spec(&self) -> crate::types::ToolSpec {
        crate::types::ToolSpec::new("confirm", "Asks the user to confirm.")
            .with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: ToolContext) -> crate::tools::ToolStream {
        let outcome: crate::ToolOutcome = match context.interrupt(crate::InterruptParams::new("confirm")) {
            Ok(_) => ToolResultBlock::success(
                context.tool_use().tool_use_id.clone(),
                vec![ToolResultContent::text("ok")],
            )
            .into(),
            Err(interrupt) => interrupt.into(),
        };
        crate::tools::ToolStream::ready(outcome)
    }
}

#[tokio::test]
async fn a_truncation_before_an_interrupt_applies_after_the_resume() {
    let model = MockModel::from_turns([
        MockTurn::content([
            ContentBlock::ToolUse(ToolUseBlock::new(
                "truncate_context",
                "call-1",
                json!({"keepRecent": 4}),
            )),
            ContentBlock::ToolUse(ToolUseBlock::new("confirm", "call-2", json!({}))),
        ]),
        MockTurn::text("done"),
    ]);
    let mut agent = crate::Agent::builder()
        .model(model)
        .messages(make_messages(12))
        .tools(vec![crate::ToolSource::from(Arc::new(Confirm) as Arc<dyn crate::Tool>)])
        .context_manager(ContextManagerStrategy::Agentic)
        .tool_executor(crate::tools::ToolExecutorStrategy::Sequential)
        .printer(false)
        .build()
        .unwrap();

    let result = agent.invoke("go on").await.unwrap();
    assert_eq!(result.stop_reason(), crate::types::StopReason::Interrupt);
    let id = result.interrupts()[0].id.clone();
    agent
        .invoke(vec![crate::InterruptResponse::new(id, json!("yes"))])
        .await
        .unwrap();

    let texts: Vec<String> = agent.messages().iter().map(Message::text).collect();
    assert_eq!(texts[..2], ["Message 1", "Message 11"], "{texts:?}");
    assert_eq!(agent.messages().len(), 7, "{texts:?}");
    assert_eq!(texts.last().map(String::as_str), Some("done"));
}

/// The edits of a batch an interrupt stopped are in the history the session saved, so an agent
/// restored from the session resumes with them.
#[tokio::test]
async fn a_truncation_before_an_interrupt_survives_a_session_restore() {
    let storage = Arc::new(crate::storage::InMemoryStorage::new());
    let build = |model: MockModel, messages: Vec<Message>| {
        crate::Agent::builder()
            .id("agent-1")
            .model(model)
            .messages(messages)
            .tools(vec![crate::ToolSource::from(Arc::new(Confirm) as Arc<dyn crate::Tool>)])
            .context_manager(ContextManagerStrategy::Agentic)
            .tool_executor(crate::tools::ToolExecutorStrategy::Sequential)
            .session_manager(
                crate::SessionManager::builder()
                    .session_id("s1")
                    .storage(storage.clone())
                    .build()
                    .unwrap(),
            )
            .printer(false)
            .build()
            .unwrap()
    };
    let model = MockModel::from_turns([MockTurn::content([
        ContentBlock::ToolUse(ToolUseBlock::new(
            "truncate_context",
            "call-1",
            json!({"keepRecent": 4}),
        )),
        ContentBlock::ToolUse(ToolUseBlock::new("confirm", "call-2", json!({}))),
    ])]);
    let mut first = build(model, make_messages(12));
    let result = first.invoke("go on").await.unwrap();
    assert_eq!(result.stop_reason(), crate::types::StopReason::Interrupt);
    let id = result.interrupts()[0].id.clone();
    drop(first);

    let mut restored = build(MockModel::from_turns([MockTurn::text("done")]), Vec::new());
    restored.initialize().await.unwrap();
    assert_eq!(restored.messages().len(), 4);
    restored
        .invoke(vec![crate::InterruptResponse::new(id, json!("yes"))])
        .await
        .unwrap();
    let texts: Vec<String> = restored.messages().iter().map(Message::text).collect();
    assert_eq!(texts[..2], ["Message 1", "Message 11"], "{texts:?}");
    assert_eq!(restored.messages().len(), 7, "{texts:?}");
    assert_eq!(truncate_result(&restored), "Dropped 9 message(s). 4 remaining.");
}
