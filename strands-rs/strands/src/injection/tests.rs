use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::agent::InvocationState;
use crate::models::Model;
use crate::test_support::{record_logs, tool_agent};
use crate::testing::MockModel;
use crate::types::{MessageMetadata, ToolResultBlock, ToolResultContent};

fn user(text: &str) -> Message {
    Message::user(text)
}

fn assistant(text: &str) -> Message {
    Message::assistant(text)
}

fn tool_result() -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "t1",
            vec![ToolResultContent::text("done")],
        ))],
    )
}

fn contents(messages: &[Message]) -> Vec<JsonValueContent> {
    messages
        .iter()
        .map(|message| serde_json::to_value(&message.content).unwrap())
        .collect()
}

type JsonValueContent = serde_json::Value;

pub(crate) fn model_context(messages: Vec<Message>) -> InvokeModelContext {
    let model: Arc<dyn Model> = Arc::new(MockModel::new());
    InvokeModelContext {
        agent: tool_agent(),
        model,
        messages,
        system_prompt: None,
        tool_specs: Vec::new(),
        tool_choice: None,
        invocation_state: InvocationState::new(),
        projected_input_tokens: None,
        dynamic_trailing_blocks: None,
        structured_output_schema: None,
        deferred_tools: std::collections::HashSet::new(),
        invocation_context: None,
    }
}

fn injection_context(messages: Vec<Message>) -> InjectionContext {
    InjectionContext::from_model_context(&model_context(messages))
}

async fn run(context: InvokeModelContext, trigger: &InjectionTrigger, text: Option<&str>) -> InvokeModelContext {
    let text = text.map(str::to_owned);
    inject(context, trigger, |_| async move { text }).await
}

// --- foldIntoLastUserMessage -------------------------------------------------------------------

#[test]
fn appends_the_text_as_a_trailing_text_block_on_the_last_user_message_behind_its_content() {
    let messages = vec![user("original task"), assistant("prior step"), user("next ask")];
    let (result, appended) = fold_into_last_user_message(messages, "INJECTED");
    assert_eq!(
        contents(&result),
        [
            json!([{"text": "original task"}]),
            json!([{"text": "prior step"}]),
            json!([{"text": "next ask"}, {"text": "\n\nINJECTED"}]),
        ]
    );
    assert_eq!(appended, 1);
}

#[test]
fn preserves_the_folded_into_message_tracking_id() {
    let target = user("ask").with_tracking_id("durable-1");
    let (result, _) = fold_into_last_user_message(vec![assistant("prior"), target], "INJECTED");
    assert_eq!(result[1].tracking_id(), "durable-1");
}

#[test]
fn returns_a_new_array_and_does_not_mutate_the_input_or_its_messages() {
    let original = user("ask");
    let messages = vec![assistant("prior"), original.clone()];
    let (result, _) = fold_into_last_user_message(messages.clone(), "INJECTED");
    assert_eq!(messages[1], original);
    assert_eq!(messages[1].content.len(), 1);
    assert_ne!(result[1], original);
}

#[test]
fn appends_after_the_tool_result_block_when_the_target_is_a_tool_result_turn() {
    let result_turn = tool_result();
    let (result, _) = fold_into_last_user_message(
        vec![user("task"), assistant("thinking"), result_turn.clone()],
        "INJECTED",
    );
    let first = serde_json::to_value(&result_turn.content[0]).unwrap();
    assert_eq!(contents(&result)[2], json!([first, {"text": "\n\nINJECTED"}]));
}

#[test]
fn targets_the_most_recent_user_message_when_several_exist() {
    let (result, _) = fold_into_last_user_message(vec![user("first"), assistant("a"), user("second")], "INJECTED");
    assert_eq!(
        contents(&result),
        [
            json!([{"text": "first"}]),
            json!([{"text": "a"}]),
            json!([{"text": "second"}, {"text": "\n\nINJECTED"}]),
        ]
    );
}

#[test]
fn preserves_message_metadata_on_the_folded_message() {
    let metadata: MessageMetadata = serde_json::from_value(json!({"custom": {"keep": "me"}})).unwrap();
    let tagged = user("ask").with_metadata(metadata.clone());
    let (result, _) = fold_into_last_user_message(vec![tagged], "INJECTED");
    assert_eq!(result[0].metadata, Some(metadata));
}

#[test]
fn returns_the_input_unchanged_when_there_is_no_user_message() {
    let messages = vec![assistant("only assistant")];
    let (result, appended) = fold_into_last_user_message(messages.clone(), "INJECTED");
    assert_eq!(result, messages);
    assert_eq!(appended, 0);
}

#[test]
fn reports_no_per_call_trailing_blocks_when_the_fold_target_is_not_the_last_message() {
    let (result, appended) = fold_into_last_user_message(vec![user("ask"), assistant("reply")], "INJECTED");
    assert_eq!(contents(&result)[0], json!([{"text": "ask"}, {"text": "\n\nINJECTED"}]));
    assert_eq!(appended, 0);
}

#[test]
fn omits_the_blank_line_separator_when_the_target_message_has_no_content() {
    let (result, _) = fold_into_last_user_message(vec![Message::new(Role::User, vec![])], "INJECTED");
    assert_eq!(contents(&result)[0], json!([{"text": "INJECTED"}]));
}

// --- isUserTurn ---------------------------------------------------------------------------------

#[test]
fn is_true_when_the_last_message_is_a_plain_user_ask() {
    assert!(is_user_turn(&[assistant("prior"), user("ask")]));
}

#[test]
fn is_false_when_the_last_message_is_a_user_tool_result_turn() {
    assert!(!is_user_turn(&[user("task"), assistant("a"), tool_result()]));
}

#[test]
fn is_false_when_the_last_message_is_an_assistant_message() {
    assert!(!is_user_turn(&[user("ask"), assistant("reply")]));
}

#[test]
fn is_false_for_an_empty_conversation() {
    assert!(!is_user_turn(&[]));
}

// --- resolveTrigger -----------------------------------------------------------------------------

#[test]
fn defaults_undefined_to_the_user_turn_policy() {
    let trigger = InjectionTrigger::default();
    assert!(trigger.fires(&injection_context(vec![user("ask")])));
    assert!(!trigger.fires(&injection_context(vec![tool_result()])));
}

#[test]
fn user_turn_uses_is_user_turn() {
    let trigger = InjectionTrigger::UserTurn;
    assert!(trigger.fires(&injection_context(vec![user("ask")])));
    assert!(!trigger.fires(&injection_context(vec![tool_result()])));
}

#[test]
fn every_turn_always_fires() {
    let trigger = InjectionTrigger::EveryTurn;
    assert!(trigger.fires(&injection_context(vec![])));
    assert!(trigger.fires(&injection_context(vec![tool_result()])));
}

#[test]
fn uses_a_custom_predicate_over_the_context() {
    let trigger = InjectionTrigger::predicate(|context| Ok(context.messages.len() >= 2));
    assert!(!trigger.fires(&injection_context(vec![user("a")])));
    assert!(trigger.fires(&injection_context(vec![user("a"), assistant("b")])));
}

#[test]
fn fails_open_returns_false_logs_when_a_custom_predicate_throws() {
    let (logs, _guard) = record_logs();
    let trigger = InjectionTrigger::predicate(|_| Err("boom".into()));
    assert!(!trigger.fires(&injection_context(vec![user("ask")])));
    assert!(
        logs.text()
            .contains("reason=<boom> | injection trigger threw; skipping injection")
    );
}

// --- createInjectionMiddleware ------------------------------------------------------------------

#[tokio::test]
async fn folds_render_content_text_into_the_latest_user_message_leaving_other_context_fields_intact() {
    let mut input = model_context(vec![assistant("prior"), user("ask")]);
    input.system_prompt = Some("keep".into());
    let result = run(input, &InjectionTrigger::UserTurn, Some("INJECTED")).await;
    assert_eq!(
        contents(&result.messages),
        [
            json!([{"text": "prior"}]),
            json!([{"text": "ask"}, {"text": "\n\nINJECTED"}])
        ]
    );
    assert_eq!(result.system_prompt, Some("keep".into()));
}

#[tokio::test]
async fn passes_an_injection_context_carrying_the_conversation_to_render_content() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    inject(
        model_context(vec![assistant("prior"), user("ask")]),
        &InjectionTrigger::UserTurn,
        |context| {
            record
                .lock()
                .unwrap()
                .extend(context.messages.iter().map(|message| message.role));
            async { Some("x".to_owned()) }
        },
    )
    .await;
    assert_eq!(*seen.lock().unwrap(), [Role::Assistant, Role::User]);
}

#[tokio::test]
async fn exposes_app_state_and_the_agent_on_the_injection_context() {
    let input = model_context(vec![user("ask")]);
    input.agent.app_state().set("k", "stashed").unwrap();
    let agent_id = input.agent.id().to_owned();
    let received = Arc::new(Mutex::new(None));
    let record = received.clone();
    inject(input, &InjectionTrigger::UserTurn, |context| {
        *record.lock().unwrap() = Some((context.app_state.get_value("k"), context.agent.id().to_owned()));
        async { None }
    })
    .await;
    assert_eq!(*received.lock().unwrap(), Some((Some(json!("stashed")), agent_id)));
}

#[tokio::test]
async fn returns_the_context_unchanged_when_the_trigger_does_not_fire() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let messages = vec![user("task"), assistant("a"), tool_result()];
    let result = inject(model_context(messages.clone()), &InjectionTrigger::UserTurn, |_| {
        counter.fetch_add(1, Ordering::Relaxed);
        async { Some("x".to_owned()) }
    })
    .await;
    assert_eq!(result.messages, messages);
    assert_eq!(result.dynamic_trailing_blocks, None);
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn every_turn_injects_on_an_autonomous_tool_result_turn_keeping_the_tool_result_first() {
    let result_turn = tool_result();
    let result = run(
        model_context(vec![user("task"), assistant("a"), result_turn.clone()]),
        &InjectionTrigger::EveryTurn,
        Some("INJECTED"),
    )
    .await;
    let first = serde_json::to_value(&result_turn.content[0]).unwrap();
    assert_eq!(contents(&result.messages)[2], json!([first, {"text": "\n\nINJECTED"}]));
}

#[tokio::test]
async fn returns_the_context_unchanged_when_render_content_yields_empty_text() {
    let messages = vec![assistant("prior"), user("ask")];
    let result = run(
        model_context(messages.clone()),
        &InjectionTrigger::UserTurn,
        Some("   "),
    )
    .await;
    assert_eq!(result.messages, messages);
    assert_eq!(result.dynamic_trailing_blocks, None);
}

#[tokio::test]
async fn fails_open_returns_the_context_unchanged_logs_when_render_content_throws() {
    let (logs, _guard) = record_logs();
    let render = RenderContent::new(|_| async { Err("boom".into()) });
    let messages = vec![assistant("prior"), user("ask")];
    let result = inject(
        model_context(messages.clone()),
        &InjectionTrigger::UserTurn,
        |context| {
            let render = render.clone();
            async move { render.render(context).await }
        },
    )
    .await;
    assert_eq!(result.messages, messages);
    assert!(
        logs.text()
            .contains("reason=<boom> | injection renderContent threw; skipping injection")
    );
}

#[tokio::test]
async fn does_not_mutate_the_original_context_messages() {
    let messages = vec![assistant("prior"), user("ask")];
    let before = messages[1].clone();
    run(model_context(messages), &InjectionTrigger::UserTurn, Some("INJECTED")).await;
    assert_eq!(before.content.len(), 1);
}

#[tokio::test]
async fn reports_one_trailing_block_as_per_call() {
    let result = run(
        model_context(vec![user("ask")]),
        &InjectionTrigger::UserTurn,
        Some("INJECTED"),
    )
    .await;
    assert_eq!(result.dynamic_trailing_blocks, Some(1));
}

#[tokio::test]
async fn accumulates_across_producers_on_one_call() {
    let first = run(
        model_context(vec![user("ask")]),
        &InjectionTrigger::UserTurn,
        Some("ONE"),
    )
    .await;
    let second = run(first, &InjectionTrigger::UserTurn, Some("TWO")).await;
    assert_eq!(second.dynamic_trailing_blocks, Some(2));
}

#[tokio::test]
async fn reports_nothing_when_injection_is_skipped() {
    let result = run(model_context(vec![user("ask")]), &InjectionTrigger::UserTurn, Some("")).await;
    assert_eq!(result.dynamic_trailing_blocks.unwrap_or(0), 0);
}

#[tokio::test]
async fn reports_nothing_when_the_fold_target_is_not_the_last_message() {
    let result = run(
        model_context(vec![user("ask"), assistant("reply")]),
        &InjectionTrigger::EveryTurn,
        Some("INJECTED"),
    )
    .await;
    assert_eq!(result.dynamic_trailing_blocks, Some(0));
}

#[tokio::test]
async fn emits_no_cache_point_into_the_messages() {
    let result = run(
        model_context(vec![user("ask")]),
        &InjectionTrigger::UserTurn,
        Some("INJECTED"),
    )
    .await;
    assert!(
        !result
            .messages
            .iter()
            .flat_map(|message| &message.content)
            .any(|block| matches!(block, ContentBlock::CachePoint(_)))
    );
}

#[tokio::test]
async fn the_middleware_form_folds_into_the_model_input() {
    let model = MockModel::new().with_turn("ok");
    let mut agent = crate::Agent::builder()
        .model(model.clone())
        .printer(false)
        .build()
        .unwrap();
    agent.add_middleware(injection_middleware(InjectionTrigger::UserTurn, |_| async {
        Some("INJECTED".to_owned())
    }));
    agent.invoke("ask").await.unwrap();
    let request = &model.requests()[0];
    assert_eq!(
        serde_json::to_value(&request.messages[0].content).unwrap(),
        json!([{"text": "ask"}, {"text": "\n\nINJECTED"}])
    );
    assert_eq!(request.dynamic_trailing_blocks, Some(1));
    assert_eq!(agent.messages()[0].content.len(), 1);
}
