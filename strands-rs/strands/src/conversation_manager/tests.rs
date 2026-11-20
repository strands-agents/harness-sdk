//! Tests for the conversation managers, context compression, message pinning and the token-usage
//! middleware.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::compression::context_compression::{
    DEFAULT_SUMMARIZATION_PROMPT, MessageTypeFilter, adjust_split_point_for_tool_pairs, as_user_summary,
    find_valid_trim_point, generate_summary, matches_message_type,
};
use super::compression::pin_message::{is_pinned, partition_pinned, pin_message, unpin_message};
use super::compression::token_usage::add_token_usage;
use super::sliding_window_conversation_manager::test_access::{
    find_oldest_message_with_tool_results, truncate_tool_results,
};
use super::*;
use crate::agent::{Agent, AgentConfig, InvocationState, InvokeLimits};
use crate::hooks::{AfterModelCallEvent, BeforeModelCallEvent};
use crate::middleware::InvokeModelContext;
use crate::models::BaseModelConfig;
use crate::models::streaming::Usage;
use crate::plugins::Plugin;
use crate::testing::{MockModel, MockTurn, test_agent};
use crate::types::{
    Citation, CitationGeneratedContent, CitationsBlock, ContentBlock, DocumentBlock, DocumentFormat, DocumentSource,
    ImageBlock, ImageFormat, ImageSource, JsonBlock, Message, MessageMetadata, ReasoningBlock, Role, S3Location,
    StopReason, SystemPrompt, TextBlock, ToolResultBlock, ToolResultContent, ToolResultStatus, ToolUseBlock,
    VideoBlock, VideoFormat, VideoSource,
};

// --- fixtures -----------------------------------------------------------------------------------

fn text(role: Role, text: &str) -> Message {
    Message::new(role, vec![ContentBlock::text(text)])
}

fn user(value: &str) -> Message {
    text(Role::User, value)
}

fn assistant(value: &str) -> Message {
    text(Role::Assistant, value)
}

fn tool_use(name: &str, id: &str) -> Message {
    Message::new(Role::Assistant, vec![ToolUseBlock::new(name, id, json!({})).into()])
}

fn tool_result(id: &str, value: &str) -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            id,
            vec![ToolResultContent::text(value)],
        ))],
    )
}

fn result_with(content: Vec<ToolResultContent>) -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success("tool-1", content))],
    )
}

fn alternating(count: usize) -> Vec<Message> {
    (0..count)
        .map(|index| {
            let role = if index % 2 == 0 { Role::User } else { Role::Assistant };
            text(role, &format!("Message {}", index + 1))
        })
        .collect()
}

fn tool_heavy_history() -> Vec<Message> {
    vec![
        user("Review this PR"),
        tool_use("getDiff", "id-1"),
        tool_result("id-1", "Diff"),
        tool_use("getFile", "id-2"),
        tool_result("id-2", "File"),
        tool_use("getTree", "id-3"),
        tool_result("id-3", "Tree"),
        assistant("Review complete"),
    ]
}

fn texts(messages: &[Message]) -> Vec<String> {
    messages.iter().map(Message::text).collect()
}

fn roles(messages: &[Message]) -> Vec<Role> {
    messages.iter().map(|message| message.role).collect()
}

fn agent_with(messages: Vec<Message>) -> Agent {
    let mut agent = test_agent(MockModel::new());
    *agent.messages_mut() = messages;
    agent
}

fn model() -> Arc<dyn Model> {
    Arc::new(MockModel::new())
}

fn model_with_limit(limit: u64) -> Arc<dyn Model> {
    let model = MockModel::new();
    model
        .update_config(BaseModelConfig {
            context_window_limit: Some(limit),
            ..Default::default()
        })
        .unwrap();
    Arc::new(model)
}

fn overflow() -> ContextWindowOverflowError {
    ContextWindowOverflowError::new("Context overflow")
}

fn sliding(config: SlidingWindowConversationManagerConfig) -> SlidingWindowConversationManager {
    SlidingWindowConversationManager::new(config).unwrap()
}

fn window(size: usize, truncate: bool) -> SlidingWindowConversationManager {
    sliding(SlidingWindowConversationManagerConfig {
        window_size: Some(size),
        should_truncate_results: Some(truncate),
        ..Default::default()
    })
}

async fn reduce(
    manager: &dyn ConversationManager,
    agent: &mut Agent,
    error: Option<ContextWindowOverflowError>,
) -> bool {
    let mut options = ConversationManagerReduceOptions::new(agent.local_mut(), model());
    options.error = error;
    manager.reduce(options).await.unwrap()
}

/// A manager that drops the first message and counts its calls.
#[derive(Default)]
struct CountingManager {
    calls: AtomicUsize,
    keep: bool,
    threshold: Option<f64>,
    errors: Mutex<Vec<Option<String>>>,
    fail_proactive: bool,
}

#[async_trait::async_trait]
impl ConversationManager for CountingManager {
    fn name(&self) -> &str {
        "test:counting"
    }

    async fn reduce(&self, options: ConversationManagerReduceOptions<'_>) -> Result<bool> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.errors
            .lock()
            .unwrap()
            .push(options.error.as_ref().map(ToString::to_string));
        if self.fail_proactive && options.error.is_none() {
            return Err(Error::other("proactive compression exploded"));
        }
        if self.keep {
            return Ok(false);
        }
        options.agent.messages_mut().remove(0);
        Ok(true)
    }

    fn compression_threshold(&self) -> Option<f64> {
        self.threshold
    }
}

async fn installed(manager: Arc<dyn ConversationManager>, messages: Vec<Message>) -> Agent {
    let mut agent = agent_with(messages);
    ConversationManagerPlugin::new(manager)
        .init_agent(agent.local_mut())
        .await
        .unwrap();
    agent
}

/// Fires `AfterModelCallEvent` with `error` and returns whether a hook asked to retry, and the
/// error left on the event.
async fn fire_after_model_call(agent: &mut Agent, error: Error) -> (bool, Option<Error>) {
    let hooks = agent.local.hooks().clone();
    let mut event = AfterModelCallEvent::new(&mut agent.local, InvocationState::new(), model(), 1).with_error(error);
    hooks.invoke(&mut event).await.unwrap();
    (event.retry(), event.take_error())
}

async fn fire_before_model_call(agent: &mut Agent, model: Arc<dyn Model>, projected: Option<u64>) {
    let hooks = agent.local.hooks().clone();
    let mut event = BeforeModelCallEvent::new(&mut agent.local, InvocationState::new(), model);
    if let Some(projected) = projected {
        event = event.with_projected_input_tokens(projected);
    }
    hooks.invoke(&mut event).await.unwrap();
}

// --- ConversationManager ------------------------------------------------------------------------

#[tokio::test]
async fn registers_both_after_model_call_event_and_before_model_call_event_hooks() {
    let agent = installed(Arc::new(CountingManager::default()), Vec::new()).await;
    assert_eq!(agent.local.hooks().len(), 2);
}

#[tokio::test]
async fn calls_reduce_and_sets_retry_true_on_context_window_overflow_error_when_reduce_returns_true() {
    let manager = Arc::new(CountingManager::default());
    let mut agent = installed(manager.clone(), vec![user("Message 1"), assistant("Response 1")]).await;
    let (retry, _) = fire_after_model_call(&mut agent, ContextWindowOverflowError::new("overflow").into()).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 1);
    assert!(retry);
    assert_eq!(agent.messages().len(), 1);
}

#[tokio::test]
async fn does_not_set_retry_when_reduce_returns_false() {
    let manager = Arc::new(CountingManager {
        keep: true,
        ..Default::default()
    });
    let mut agent = installed(manager.clone(), Vec::new()).await;
    let (retry, _) = fire_after_model_call(&mut agent, ContextWindowOverflowError::new("overflow").into()).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 1);
    assert!(!retry);
}

#[tokio::test]
async fn does_not_call_reduce_for_non_overflow_errors() {
    let manager = Arc::new(CountingManager::default());
    let mut agent = installed(manager.clone(), Vec::new()).await;
    let (retry, _) = fire_after_model_call(&mut agent, Error::other("some other error")).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 0);
    assert!(!retry);
}

#[tokio::test]
async fn passes_error_to_reduce_when_called_due_to_overflow() {
    let manager = Arc::new(CountingManager {
        keep: true,
        ..Default::default()
    });
    let mut agent = installed(manager.clone(), Vec::new()).await;
    fire_after_model_call(&mut agent, ContextWindowOverflowError::new("overflow").into()).await;
    assert_eq!(*manager.errors.lock().unwrap(), [Some("overflow".to_owned())]);
}

struct ContextCapturing(Mutex<Option<Option<InvocationContext>>>);

#[async_trait::async_trait]
impl ConversationManager for ContextCapturing {
    fn name(&self) -> &str {
        "test:capturing"
    }

    async fn reduce(&self, options: ConversationManagerReduceOptions<'_>) -> Result<bool> {
        *self.0.lock().unwrap() = Some(options.invocation_context);
        Ok(false)
    }
}

#[tokio::test]
async fn passes_reduce_a_handle_that_counts_toward_the_request_usage_without_its_limits() {
    let manager = Arc::new(ContextCapturing(Mutex::new(None)));
    let mut agent = installed(manager.clone(), Vec::new()).await;
    let request = InvocationContext::new(Some(InvokeLimits {
        turns: Some(1),
        ..Default::default()
    }));
    request.record_turn();
    let hooks = agent.local.hooks().clone();
    let mut event = AfterModelCallEvent::new(&mut agent.local, InvocationState::new(), model(), 1)
        .with_error(ContextWindowOverflowError::new("overflow").into())
        .with_invocation_context(Some(request.clone()));
    hooks.invoke(&mut event).await.unwrap();
    drop(event);

    let handed = manager.0.lock().unwrap().take().flatten().unwrap();
    handed.record_usage(&Usage::new(1, 2, 3));
    assert!(handed.limits().is_none());
    let usage = request.usage();
    assert_eq!((usage.turns_taken, usage.usage), (1, Usage::new(1, 2, 3)));
}

#[tokio::test]
async fn always_registers_a_before_model_call_event_hook_regardless_of_proactive_compression_setting() {
    let agent = installed(Arc::new(CountingManager::default()), Vec::new()).await;
    assert_eq!(agent.local.hooks().len(), 2);
}

#[tokio::test]
async fn before_model_call_event_handler_is_a_no_op_when_proactive_compression_is_not_set() {
    let manager = Arc::new(CountingManager::default());
    let mut agent = installed(manager.clone(), vec![user("a"), assistant("b")]).await;
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(900)).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 0);
}

fn threshold_manager(compression: ProactiveCompression) -> Arc<CountingManager> {
    Arc::new(CountingManager {
        threshold: compression.threshold().unwrap(),
        ..Default::default()
    })
}

#[tokio::test]
async fn uses_default_threshold_of_0_7_when_proactive_compression_is_true() {
    let manager = threshold_manager(true.into());
    let mut agent = installed(manager.clone(), vec![user("a"), assistant("b")]).await;
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(690)).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 0);
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(700)).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 1);
    assert_eq!(*manager.errors.lock().unwrap(), [None]);
}

#[tokio::test]
async fn calls_reduce_without_error_when_projected_tokens_exceed_custom_threshold() {
    let manager = threshold_manager(ProactiveCompression::Threshold(0.5));
    let mut agent = installed(manager.clone(), vec![user("a"), assistant("b")]).await;
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(600)).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 1);
    assert_eq!(*manager.errors.lock().unwrap(), [None]);
    assert_eq!(agent.messages().len(), 1);
}

#[tokio::test]
async fn does_not_call_reduce_when_below_threshold() {
    let manager = threshold_manager(true.into());
    let mut agent = installed(manager.clone(), Vec::new()).await;
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(500)).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn does_not_call_reduce_when_projected_input_tokens_is_undefined() {
    let manager = threshold_manager(true.into());
    let mut agent = installed(manager.clone(), Vec::new()).await;
    fire_before_model_call(&mut agent, model_with_limit(1000), None).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn uses_200k_default_when_context_window_limit_is_undefined_and_logs_warning() {
    let manager = threshold_manager(ProactiveCompression::Threshold(0.7));
    let mut agent = installed(manager.clone(), vec![user("a"), assistant("b")]).await;
    fire_before_model_call(&mut agent, model(), Some(150_000)).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn does_not_trigger_with_200k_default_when_below_threshold() {
    let manager = threshold_manager(ProactiveCompression::Threshold(0.7));
    let mut agent = installed(manager.clone(), Vec::new()).await;
    fire_before_model_call(&mut agent, model(), Some(100_000)).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn swallows_errors_from_proactive_reduce_and_continues() {
    let manager = Arc::new(CountingManager {
        threshold: Some(0.7),
        fail_proactive: true,
        ..Default::default()
    });
    let mut agent = installed(manager.clone(), vec![user("a")]).await;
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(800)).await;
    assert_eq!(manager.calls.load(Ordering::Relaxed), 1);
    assert_eq!(agent.messages().len(), 1);
}

#[test]
fn throws_on_compression_threshold_less_than_or_equal_0() {
    for threshold in [0.0, -1.0] {
        let error = ProactiveCompression::Threshold(threshold).threshold().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("must be between 0 (exclusive) and 1 (inclusive)")
        );
    }
}

#[test]
fn throws_on_compression_threshold_greater_than_1() {
    let error = SlidingWindowConversationManager::new(SlidingWindowConversationManagerConfig {
        proactive_compression: Some(ProactiveCompression::Threshold(1.5)),
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "compressionThreshold must be between 0 (exclusive) and 1 (inclusive), got 1.5"
    );
}

#[test]
fn accepts_compression_threshold_of_exactly_1() {
    assert_eq!(ProactiveCompression::Threshold(1.0).threshold().unwrap(), Some(1.0));
}

#[tokio::test]
async fn propagates_context_window_overflow_error_out_of_the_agent_loop_when_reduce_returns_false() {
    let model = MockModel::new().with_turn(MockTurn::error(|| {
        ContextWindowOverflowError::new("context window exceeded").into()
    }));
    let mut agent = Agent::new(AgentConfig {
        model: Some(model.into()),
        conversation_manager: Some(Arc::new(NullConversationManager::new())),
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();
    let error = agent.invoke("hello").await.unwrap_err();
    assert!(matches!(error, Error::ContextWindowOverflow(_)));
}

#[tokio::test]
async fn the_agent_retries_the_model_call_after_the_default_manager_reduces_on_overflow() {
    let model = MockModel::from_turns([
        MockTurn::error(|| ContextWindowOverflowError::new("too long").into()),
        MockTurn::text("Recovered"),
    ]);
    let mut agent = test_agent(model.clone());
    agent
        .messages_mut()
        .extend([user("Old 1"), assistant("Old 2"), user("Old 3"), assistant("Old 4")]);
    let result = agent.invoke("New").await.unwrap();
    assert_eq!(result.to_string(), "Recovered");
    assert_eq!(model.call_count(), 2);
    assert_eq!(model.requests()[1].messages.len(), 3);
}

// --- NullConversationManager --------------------------------------------------------------------

#[tokio::test]
async fn does_not_modify_conversation_history_on_overflow() {
    let mut agent = agent_with(vec![user("Message 1"), assistant("Response 1")]);
    assert!(!reduce(&NullConversationManager::new(), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages().len(), 2);
}

#[tokio::test]
async fn does_not_set_retry_on_context_overflow() {
    let mut agent = installed(Arc::new(NullConversationManager::new()), vec![user("a")]).await;
    let (retry, error) = fire_after_model_call(&mut agent, overflow().into()).await;
    assert!(!retry);
    assert!(matches!(error, Some(Error::ContextWindowOverflow(_))));
}

#[tokio::test]
async fn registers_both_the_overflow_recovery_and_proactive_compression_hooks() {
    let agent = installed(Arc::new(NullConversationManager::new()), Vec::new()).await;
    assert_eq!(agent.local.hooks().len(), 2);
}

#[test]
fn returns_the_plugin_name() {
    assert_eq!(
        NullConversationManager::new().name(),
        "strands:null-conversation-manager"
    );
    let plugin = ConversationManagerPlugin::new(Arc::new(NullConversationManager::new()));
    assert_eq!(plugin.name(), "strands:null-conversation-manager");
}

// --- SlidingWindowConversationManager: construction and reduce ----------------------------------

#[test]
fn sets_default_window_size_to_40() {
    assert_eq!(SlidingWindowConversationManager::default().window_size(), 40);
}

#[test]
fn sets_default_should_truncate_results_to_true() {
    assert!(SlidingWindowConversationManager::default().should_truncate_results());
}

#[test]
fn accepts_custom_window_size() {
    assert_eq!(window(10, true).window_size(), 10);
}

#[test]
fn accepts_custom_should_truncate_results() {
    assert!(!window(40, false).should_truncate_results());
}

fn long_text(middle_repeats: usize) -> (String, String) {
    let middle = "MIDDLE_CONTENT_TO_REMOVE".repeat(middle_repeats);
    (format!("{}{middle}{}", "A".repeat(200), "B".repeat(200)), middle)
}

#[tokio::test]
async fn returns_true_when_tool_results_are_truncated_even_though_message_count_is_unchanged() {
    let (original, _) = long_text(10);
    let mut agent = agent_with(vec![result_with(vec![ToolResultContent::text(original)])]);
    assert!(reduce(&window(40, true), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages().len(), 1);
}

#[tokio::test]
async fn returns_true_when_messages_are_trimmed() {
    let mut agent = agent_with(alternating(6));
    assert!(reduce(&window(4, true), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages().len(), 4);
}

#[test]
fn skips_reduction_when_message_count_is_less_than_window_size() {
    let mut messages = alternating(3);
    window(5, true).apply_management(&mut messages);
    assert_eq!(messages.len(), 3);
}

#[test]
fn skips_reduction_when_message_count_equals_window_size() {
    let mut messages = alternating(5);
    window(5, true).apply_management(&mut messages);
    assert_eq!(messages.len(), 5);
}

#[test]
fn removes_all_messages_when_window_size_is_0() {
    let mut messages = alternating(3);
    window(0, true).apply_management(&mut messages);
    assert!(messages.is_empty());
}

#[tokio::test]
async fn calls_reduce_context_when_message_count_exceeds_window_size() {
    let mut agent = installed(Arc::new(window(4, true)), alternating(6)).await;
    let hooks = agent.local.hooks().clone();
    let mut event = crate::hooks::AfterInvocationEvent::new(&mut agent.local, InvocationState::new());
    hooks.invoke(&mut event).await.unwrap();
    drop(event);
    assert_eq!(
        texts(agent.messages()),
        ["Message 3", "Message 4", "Message 5", "Message 6"]
    );
}

// --- tool result truncation ---------------------------------------------------------------------

fn first_result(messages: &[Message], index: usize) -> &ToolResultBlock {
    let ContentBlock::ToolResult(result) = &messages[index].content[0] else {
        panic!("expected a tool result");
    };
    result
}

#[tokio::test]
async fn partially_truncates_large_tool_results_preserving_first_and_last_200_chars() {
    let (original, middle) = long_text(10);
    let mut agent = agent_with(vec![result_with(vec![ToolResultContent::text(original)])]);
    reduce(&window(40, true), &mut agent, Some(overflow())).await;
    let expected = format!(
        "{}\n<truncated chars=\"{}\"/>\n{}",
        "A".repeat(200),
        middle.len(),
        "B".repeat(200)
    );
    assert_eq!(
        *first_result(agent.messages(), 0),
        ToolResultBlock::success("tool-1", vec![ToolResultContent::text(expected)])
    );
}

#[test]
fn preserves_the_durable_message_id_when_truncating_tool_results() {
    let (original, _) = long_text(10);
    let mut messages = vec![result_with(vec![ToolResultContent::text(original)]).with_tracking_id("durable-1")];
    assert!(truncate_tool_results(&mut messages, 0));
    assert_eq!(messages[0].tracking_id(), "durable-1");
}

#[test]
fn leaves_small_tool_results_unchanged() {
    let mut messages = vec![result_with(vec![ToolResultContent::text("Small result")])];
    assert!(!truncate_tool_results(&mut messages, 0));
    assert_eq!(
        first_result(&messages, 0).content,
        [ToolResultContent::text("Small result")]
    );
}

#[tokio::test]
async fn finds_oldest_message_with_tool_results() {
    let (original, _) = long_text(10);
    let mut agent = agent_with(vec![
        user("Hi"),
        tool_use("t", "tool-1"),
        result_with(vec![ToolResultContent::text(original.clone())]),
        tool_use("t", "tool-2"),
        result_with(vec![ToolResultContent::text(original.clone())]),
    ]);
    reduce(&window(40, true), &mut agent, Some(overflow())).await;
    assert_ne!(
        first_result(agent.messages(), 2).content,
        [ToolResultContent::text(original.clone())]
    );
    assert_eq!(
        first_result(agent.messages(), 4).content,
        [ToolResultContent::text(original)]
    );
}

#[tokio::test]
async fn returns_after_successful_truncation_without_trimming_messages() {
    let (original, _) = long_text(10);
    let mut messages = alternating(4);
    messages.push(result_with(vec![ToolResultContent::text(original)]));
    let mut agent = agent_with(messages);
    assert!(reduce(&window(2, true), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages().len(), 5);
}

#[tokio::test]
async fn skips_truncation_when_should_truncate_results_is_false() {
    let (original, _) = long_text(10);
    let messages = vec![
        user("First"),
        assistant("Reply"),
        user("Second"),
        tool_use("t", "tool-1"),
        result_with(vec![ToolResultContent::text(original.clone())]),
        assistant("Done"),
    ];
    let mut agent = agent_with(messages);
    assert!(reduce(&window(4, false), &mut agent, Some(overflow())).await);
    assert_eq!(texts(agent.messages())[0], "Second");
    assert_eq!(
        first_result(agent.messages(), 2).content,
        [ToolResultContent::text(original)]
    );
}

#[test]
fn does_not_re_truncate_already_truncated_results() {
    let (original, _) = long_text(10);
    let mut messages = vec![result_with(vec![ToolResultContent::text(original)])];
    assert!(truncate_tool_results(&mut messages, 0));
    let once = messages.clone();
    assert!(!truncate_tool_results(&mut messages, 0));
    assert_eq!(messages, once);
}

fn truncated_content(content: Vec<ToolResultContent>) -> Vec<ToolResultContent> {
    let mut messages = vec![result_with(content)];
    assert!(truncate_tool_results(&mut messages, 0));
    first_result(&messages, 0).content.clone()
}

#[test]
fn replaces_image_blocks_nested_in_tool_results_with_descriptive_placeholders() {
    let image = ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![0; 1234]));
    assert_eq!(
        truncated_content(vec![ToolResultContent::Image(image), ToolResultContent::text("tail")]),
        [
            ToolResultContent::text("[image: png, source: bytes, 1234 bytes]"),
            ToolResultContent::text("tail")
        ]
    );
}

#[test]
fn preserves_the_error_field_on_truncated_tool_results() {
    let result = ToolResultBlock::error("tool-1", vec![ToolResultContent::text("x".repeat(500))])
        .with_error(Error::other("tool blew up"));
    let mut messages = vec![Message::new(Role::User, vec![ContentBlock::ToolResult(result)])];
    assert!(truncate_tool_results(&mut messages, 0));
    let truncated = first_result(&messages, 0);
    let expected = format!("{}\n<truncated chars=\"100\"/>\n{}", "x".repeat(200), "x".repeat(200));
    assert_eq!(truncated.status, ToolResultStatus::Error);
    assert_eq!(truncated.content, [ToolResultContent::text(expected)]);
    assert_eq!(truncated.error.as_ref().unwrap().to_string(), "tool blew up");
}

#[test]
fn image_placeholder_reflects_non_bytes_source_kinds_honestly() {
    let url = ImageBlock::new(ImageFormat::Jpeg, ImageSource::Url("https://example.com/x.jpg".into()));
    let s3 = ImageBlock::new(
        ImageFormat::Png,
        ImageSource::Location(S3Location::new("s3://bucket/key")),
    );
    assert_eq!(
        truncated_content(vec![ToolResultContent::Image(url), ToolResultContent::Image(s3)]),
        [
            ToolResultContent::text("[image: jpeg, source: url]"),
            ToolResultContent::text("[image: png, source: s3]")
        ]
    );
}

#[test]
fn replaces_video_bytes_blocks_with_a_descriptive_placeholder() {
    let video = VideoBlock::new(VideoFormat::Mp4, VideoSource::Bytes(vec![0; 4096]));
    assert_eq!(
        truncated_content(vec![ToolResultContent::Video(video)]),
        [ToolResultContent::text("[video: mp4, source: bytes, 4096 bytes]")]
    );
}

#[test]
fn replaces_video_s3_blocks_with_a_descriptive_placeholder() {
    let video = VideoBlock::new(
        VideoFormat::Mp4,
        VideoSource::Location(S3Location::new("s3://bucket/key")),
    );
    assert_eq!(
        truncated_content(vec![ToolResultContent::Video(video)]),
        [ToolResultContent::text("[video: mp4, source: s3]")]
    );
}

fn document(source: DocumentSource) -> DocumentBlock {
    DocumentBlock::new("report", DocumentFormat::Pdf, source)
}

#[test]
fn replaces_document_bytes_blocks_with_a_descriptive_placeholder() {
    let document = document(DocumentSource::Bytes(vec![0; 2048]));
    assert_eq!(
        truncated_content(vec![ToolResultContent::Document(document)]),
        [ToolResultContent::text(
            "[document: report, pdf, source: bytes, 2048 bytes]"
        )]
    );
}

#[test]
fn replaces_document_s3_blocks_with_a_descriptive_placeholder() {
    let document = document(DocumentSource::Location(S3Location::new("s3://bucket/report.pdf")));
    assert_eq!(
        truncated_content(vec![ToolResultContent::Document(document)]),
        [ToolResultContent::text("[document: report, pdf, source: s3]")]
    );
}

#[test]
fn partially_truncates_large_text_inside_a_document_text_source() {
    let mut original = document(DocumentSource::Text("y".repeat(600)));
    original.context = Some("ctx".into());
    let content = truncated_content(vec![ToolResultContent::Document(original)]);
    let ToolResultContent::Document(truncated) = &content[0] else {
        panic!("expected a document");
    };
    let expected = format!("{}\n<truncated chars=\"200\"/>\n{}", "y".repeat(200), "y".repeat(200));
    assert_eq!(truncated.source, DocumentSource::Text(expected));
    assert_eq!(truncated.context.as_deref(), Some("ctx"));
    assert_eq!(truncated.name, "report");
}

#[test]
fn leaves_small_text_inside_a_document_text_source_unchanged() {
    let mut messages = vec![result_with(vec![ToolResultContent::Document(document(
        DocumentSource::Text("short".into()),
    ))])];
    assert!(!truncate_tool_results(&mut messages, 0));
}

#[test]
fn truncates_long_nested_text_blocks_inside_a_document_content_source() {
    let source = DocumentSource::Content(vec![TextBlock::new("short"), TextBlock::new("z".repeat(500))]);
    let content = truncated_content(vec![ToolResultContent::Document(document(source))]);
    let ToolResultContent::Document(truncated) = &content[0] else {
        panic!("expected a document");
    };
    let expected = format!("{}\n<truncated chars=\"100\"/>\n{}", "z".repeat(200), "z".repeat(200));
    assert_eq!(
        truncated.source,
        DocumentSource::Content(vec![TextBlock::new("short"), TextBlock::new(expected)])
    );
}

#[test]
fn replaces_large_json_blocks_with_a_size_placeholder() {
    let json_value = json!({"data": "q".repeat(600)});
    let length = serde_json::to_string(&json_value).unwrap().len();
    assert_eq!(
        truncated_content(vec![ToolResultContent::Json(JsonBlock::new(json_value))]),
        [ToolResultContent::text(format!("[json: {length} chars]"))]
    );
}

#[test]
fn leaves_small_json_blocks_unchanged() {
    let mut messages = vec![result_with(vec![ToolResultContent::Json(JsonBlock::new(
        json!({"a": 1}),
    ))])];
    assert!(!truncate_tool_results(&mut messages, 0));
}

#[tokio::test]
async fn does_not_call_truncate_tool_results_unless_an_error_is_passed_in() {
    let (original, _) = long_text(10);
    let mut messages = alternating(4);
    messages.push(tool_use("t", "tool-1"));
    messages.push(result_with(vec![ToolResultContent::text(original.clone())]));
    let mut agent = agent_with(messages);
    reduce(&window(2, true), &mut agent, None).await;
    assert!(
        agent
            .messages()
            .iter()
            .flat_map(|message| &message.content)
            .all(|block| !matches!(block, ContentBlock::ToolResult(result) if result.content != [ToolResultContent::text(original.clone())]))
    );
}

// --- message trimming ---------------------------------------------------------------------------

#[tokio::test]
async fn trims_oldest_messages_when_tool_results_cannot_be_truncated() {
    let mut agent = agent_with(alternating(6));
    assert!(reduce(&window(4, true), &mut agent, Some(overflow())).await);
    assert_eq!(
        texts(agent.messages()),
        ["Message 3", "Message 4", "Message 5", "Message 6"]
    );
}

#[tokio::test]
async fn calculates_correct_trim_index_messages_length_minus_window_size() {
    let mut agent = agent_with(alternating(10));
    reduce(&window(6, true), &mut agent, Some(overflow())).await;
    assert_eq!(agent.messages().len(), 6);
    assert_eq!(agent.messages()[0].text(), "Message 5");
}

#[tokio::test]
async fn removes_all_messages_when_window_size_is_0_on_context_overflow() {
    let mut agent = agent_with(alternating(4));
    assert!(reduce(&window(0, true), &mut agent, Some(overflow())).await);
    assert!(agent.messages().is_empty());
}

#[tokio::test]
async fn uses_default_trim_index_of_2_when_messages_less_than_or_equal_window_size() {
    let mut agent = agent_with(alternating(4));
    assert!(reduce(&window(10, true), &mut agent, Some(overflow())).await);
    assert_eq!(texts(agent.messages()), ["Message 3", "Message 4"]);
}

#[tokio::test]
async fn removes_messages_from_start_of_array_using_splice() {
    let mut agent = agent_with(alternating(5));
    reduce(&window(3, true), &mut agent, Some(overflow())).await;
    assert_eq!(texts(agent.messages()), ["Message 3", "Message 4", "Message 5"]);
}

// --- tool pair validation -----------------------------------------------------------------------

#[tokio::test]
async fn does_not_trim_at_index_where_oldest_message_is_tool_result() {
    let mut agent = agent_with(vec![
        user("Message 1"),
        tool_use("tool1", "id-1"),
        tool_result("id-1", "Result 1"),
        assistant("Response"),
        user("Next"),
        assistant("Final"),
    ]);
    reduce(&window(4, false), &mut agent, Some(overflow())).await;
    assert_eq!(texts(agent.messages()), ["Next", "Final"]);
}

#[tokio::test]
async fn does_not_trim_at_index_where_oldest_message_is_tool_use_without_following_tool_result() {
    let mut agent = agent_with(vec![
        user("Message 1"),
        assistant("Response 1"),
        tool_use("tool1", "id-1"),
        assistant("Response 2"),
        user("Message 2"),
        assistant("Final"),
    ]);
    reduce(&window(4, false), &mut agent, Some(overflow())).await;
    assert_eq!(texts(agent.messages()), ["Message 2", "Final"]);
}

#[tokio::test]
async fn allows_trim_when_oldest_message_is_tool_use_with_following_tool_result() {
    let mut agent = agent_with(vec![
        user("Message 1"),
        assistant("Response 1"),
        user("Message 2"),
        tool_use("tool1", "id-1"),
        tool_result("id-1", "Result"),
        assistant("Final"),
    ]);
    assert!(reduce(&window(4, false), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages()[0].text(), "Message 2");
}

#[tokio::test]
async fn allows_trim_at_tool_use_when_tool_result_immediately_follows() {
    let user_tool_use = Message::new(Role::User, vec![ToolUseBlock::new("t", "id-1", json!({})).into()]);
    let mut agent = agent_with(vec![
        user("Message 1"),
        assistant("Response 1"),
        user_tool_use,
        tool_result("id-1", "Result"),
        assistant("Final"),
    ]);
    assert!(reduce(&window(3, false), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages().len(), 3);
    assert!(matches!(agent.messages()[0].content[0], ContentBlock::ToolUse(_)));
}

#[tokio::test]
async fn falls_back_to_a_complete_tool_pair_when_no_plain_user_trim_point_exists() {
    let messages = tool_heavy_history();
    let expected: Vec<Message> = std::iter::once(messages[0].clone())
        .chain(messages[5..].iter().cloned())
        .collect();
    let mut agent = agent_with(messages);
    assert!(reduce(&window(4, false), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages(), expected);
    assert_eq!(
        roles(agent.messages()),
        [Role::User, Role::Assistant, Role::User, Role::Assistant]
    );
}

#[test]
fn keeps_routine_window_management_user_first_when_it_uses_the_tool_pair_fallback() {
    let mut messages = tool_heavy_history();
    let expected: Vec<Message> = std::iter::once(messages[0].clone())
        .chain(messages[5..].iter().cloned())
        .collect();
    window(4, false).apply_management(&mut messages);
    assert_eq!(messages, expected);
}

#[tokio::test]
async fn prefers_a_plain_user_trim_point_over_a_reachable_complete_tool_pair_later_in_range() {
    let messages = vec![
        user("First"),
        assistant("Response A"),
        user("Plain user message"),
        tool_use("lookup", "id-1"),
        tool_result("id-1", "Result"),
        assistant("Final"),
    ];
    let expected = messages[2..].to_vec();
    let mut agent = agent_with(messages);
    reduce(&window(4, false), &mut agent, Some(overflow())).await;
    assert_eq!(agent.messages(), expected);
}

#[tokio::test]
async fn does_not_treat_a_user_message_containing_tool_use_as_an_assistant_tool_pair_boundary() {
    let messages = vec![
        user("Anchor"),
        assistant("Old response"),
        Message::new(
            Role::User,
            vec![
                ContentBlock::ToolResult(ToolResultBlock::success(
                    "orphan",
                    vec![ToolResultContent::text("Orphan result")],
                )),
                ToolUseBlock::new("lookup", "id-1", json!({})).into(),
            ],
        ),
        tool_result("id-1", "Result"),
        assistant("Response"),
        assistant("Final"),
    ];
    let mut agent = agent_with(messages.clone());
    assert!(!reduce(&window(4, false), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages(), messages);
}

#[tokio::test]
async fn returns_false_when_an_assistant_tool_use_is_not_followed_by_a_tool_result() {
    let messages = vec![
        user("Anchor"),
        assistant("Old response"),
        tool_use("lookup", "id-1"),
        Message::new(
            Role::User,
            vec![ToolUseBlock::new("anotherLookup", "id-2", json!({})).into()],
        ),
        assistant("Response"),
        assistant("Final"),
    ];
    let mut agent = agent_with(messages.clone());
    assert!(!reduce(&window(4, false), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages(), messages);
}

fn pinned_prefix_history(first: Message, second: Message) -> Vec<Message> {
    vec![
        first,
        second,
        user("Old request"),
        tool_use("lookup", "id-1"),
        tool_result("id-1", "Old result"),
        tool_use("lookup", "id-2"),
        tool_result("id-2", "Recent result"),
    ]
}

fn pinning(size: usize, pin_first: usize) -> SlidingWindowConversationManager {
    sliding(SlidingWindowConversationManagerConfig {
        window_size: Some(size),
        should_truncate_results: Some(false),
        pin_first: Some(pin_first),
        ..Default::default()
    })
}

#[tokio::test]
async fn uses_the_pinned_first_user_as_a_safe_fallback_anchor() {
    let mut agent = agent_with(pinned_prefix_history(user("Pinned user"), assistant("Old response")));
    assert!(reduce(&pinning(2, 1), &mut agent, Some(overflow())).await);
    assert_eq!(roles(agent.messages()), [Role::User, Role::Assistant, Role::User]);
    assert_eq!(agent.messages()[0].text(), "Pinned user");
    assert!(
        matches!(&agent.messages()[1].content[0], ContentBlock::ToolUse(tool_use) if tool_use.tool_use_id == "id-2")
    );
}

#[tokio::test]
async fn declines_fallback_when_a_pinned_prefix_ends_with_an_assistant_message() {
    let messages = pinned_prefix_history(user("Pinned user"), assistant("Pinned response"));
    let mut agent = agent_with(messages.clone());
    assert!(!reduce(&pinning(2, 2), &mut agent, Some(overflow())).await);
    assert_eq!(texts(agent.messages()), texts(&messages));
}

#[tokio::test]
async fn declines_fallback_when_non_contiguous_pinned_messages_do_not_alternate() {
    let mut messages = vec![
        user("Pinned user one"),
        assistant("Unpinned response"),
        user("Pinned user two"),
        assistant("Old response"),
        user("Old request"),
        tool_use("lookup", "id-1"),
        tool_result("id-1", "Old result"),
        tool_use("lookup", "id-2"),
        tool_result("id-2", "Recent result"),
    ];
    pin_message(&mut messages, 0);
    pin_message(&mut messages, 2);
    let mut agent = agent_with(messages.clone());
    assert!(!reduce(&window(2, false), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages(), messages);
}

#[tokio::test]
async fn declines_fallback_when_the_first_pinned_message_is_an_orphaned_tool_result() {
    let mut messages = pinned_prefix_history(tool_result("orphan", "Orphan result"), assistant("Old response"));
    pin_message(&mut messages, 0);
    let mut agent = agent_with(messages.clone());
    assert!(!reduce(&window(2, false), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages(), messages);
}

#[tokio::test]
async fn declines_fallback_when_the_last_pinned_message_carries_a_bare_tool_use_block() {
    let weird = Message::new(
        Role::User,
        vec![ToolUseBlock::new("weird", "weird-1", json!({})).into()],
    );
    let messages = pinned_prefix_history(weird, assistant("Old response"));
    let mut agent = agent_with(messages.clone());
    assert!(!reduce(&pinning(2, 1), &mut agent, Some(overflow())).await);
    assert_eq!(texts(agent.messages()), texts(&messages));
}

#[tokio::test]
async fn declines_fallback_when_no_plain_user_message_exists_before_the_tool_pair() {
    let messages = vec![
        tool_result("orphan-0", "Orphan result"),
        tool_use("lookup", "id-1"),
        tool_result("id-1", "Result 1"),
        tool_use("lookup", "id-2"),
        tool_result("id-2", "Result 2"),
    ];
    let mut agent = agent_with(messages.clone());
    assert!(!reduce(&window(2, false), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages(), messages);
}

#[tokio::test]
async fn allows_trim_when_oldest_message_is_text_or_other_non_tool_content() {
    let mut agent = agent_with(alternating(4));
    assert!(reduce(&window(2, true), &mut agent, Some(overflow())).await);
    assert_eq!(texts(agent.messages()), ["Message 3", "Message 4"]);
}

#[tokio::test]
async fn skips_assistant_message_to_ensure_trimmed_conversation_starts_with_user() {
    let mut agent = agent_with(vec![
        user("Message 1"),
        assistant("Response 1"),
        assistant("Response 2"),
        user("Message 2"),
        assistant("Response 3"),
    ]);
    reduce(&window(4, true), &mut agent, Some(overflow())).await;
    assert_eq!(agent.messages()[0].role, Role::User);
    assert_eq!(agent.messages()[0].text(), "Message 2");
}

#[tokio::test]
async fn returns_false_when_no_valid_trim_point_exists() {
    let messages = vec![user("Only user"), assistant("A1"), assistant("A2")];
    let mut agent = agent_with(messages.clone());
    assert!(!reduce(&window(2, false), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages(), messages);
}

#[tokio::test]
async fn propagates_the_original_context_window_overflow_error_when_reduce_cannot_reduce_further() {
    let model = MockModel::new().with_turn(MockTurn::error(|| {
        ContextWindowOverflowError::new("Context overflow").into()
    }));
    let mut agent = Agent::new(AgentConfig {
        model: Some(model.into()),
        conversation_manager: Some(Arc::new(window(2, false))),
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();
    let error = agent.invoke("only message").await.unwrap_err();
    assert_eq!(error.to_string(), "Context overflow");
    assert!(matches!(error, Error::ContextWindowOverflow(_)));
}

// --- helpers ------------------------------------------------------------------------------------

#[test]
fn returns_correct_index_when_tool_results_exist() {
    let messages = vec![user("Hi"), tool_use("t", "id-1"), tool_result("id-1", "r")];
    assert_eq!(find_oldest_message_with_tool_results(&messages), Some(2));
}

#[test]
fn returns_undefined_when_no_tool_results_exist() {
    assert_eq!(find_oldest_message_with_tool_results(&alternating(3)), None);
}

#[test]
fn iterates_forward_from_start() {
    let messages = vec![tool_result("a", "first"), assistant("x"), tool_result("b", "second")];
    assert_eq!(find_oldest_message_with_tool_results(&messages), Some(0));
}

#[test]
fn returns_true_when_changes_are_made() {
    let mut messages = vec![result_with(vec![ToolResultContent::text("x".repeat(500))])];
    assert!(truncate_tool_results(&mut messages, 0));
}

#[test]
fn returns_false_when_already_truncated() {
    let mut messages = vec![result_with(vec![ToolResultContent::text("x".repeat(500))])];
    truncate_tool_results(&mut messages, 0);
    assert!(!truncate_tool_results(&mut messages, 0));
}

#[test]
fn returns_false_when_no_tool_results_found() {
    let mut messages = vec![user("plain")];
    assert!(!truncate_tool_results(&mut messages, 0));
    assert!(!truncate_tool_results(&mut messages, 5));
}

#[tokio::test]
async fn trims_oldest_messages_when_compression_threshold_is_exceeded() {
    let manager = Arc::new(sliding(SlidingWindowConversationManagerConfig {
        window_size: Some(4),
        proactive_compression: Some(ProactiveCompression::Threshold(0.5)),
        ..Default::default()
    }));
    let mut agent = installed(manager, alternating(6)).await;
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(600)).await;
    assert_eq!(agent.messages().len(), 4);
}

#[tokio::test]
async fn does_not_trim_when_below_compression_threshold() {
    let manager = Arc::new(sliding(SlidingWindowConversationManagerConfig {
        window_size: Some(4),
        proactive_compression: Some(ProactiveCompression::Threshold(0.5)),
        ..Default::default()
    }));
    let mut agent = installed(manager, alternating(6)).await;
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(400)).await;
    assert_eq!(agent.messages().len(), 6);
}

#[tokio::test]
async fn protects_first_n_messages_from_trimming() {
    let mut agent = agent_with(alternating(8));
    assert!(reduce(&pinning(4, 2), &mut agent, Some(overflow())).await);
    assert_eq!(
        texts(agent.messages()),
        [
            "Message 1",
            "Message 2",
            "Message 5",
            "Message 6",
            "Message 7",
            "Message 8"
        ]
    );
}

#[test]
fn returns_false_when_all_messages_in_trim_range_are_protected() {
    let mut messages = alternating(4);
    let manager = pinning(2, 4);
    assert!(!manager.reduce_messages(&mut messages, true));
    assert_eq!(messages.len(), 4);
}

#[tokio::test]
async fn pinned_message_in_middle_of_window_survives_trimming() {
    let mut messages = alternating(8);
    pin_message(&mut messages, 2);
    let mut agent = agent_with(messages);
    reduce(&window(4, false), &mut agent, Some(overflow())).await;
    assert_eq!(
        texts(agent.messages()),
        ["Message 3", "Message 5", "Message 6", "Message 7", "Message 8"]
    );
}

// --- SummarizingConversationManager -------------------------------------------------------------

fn summarizing(config: SummarizingConversationManagerConfig) -> SummarizingConversationManager {
    SummarizingConversationManager::new(config).unwrap()
}

fn half_keep_two() -> SummarizingConversationManagerConfig {
    SummarizingConversationManagerConfig {
        summary_ratio: Some(0.5),
        preserve_recent_messages: Some(2),
        ..Default::default()
    }
}

fn agent_with_aux(messages: Vec<Message>, aux: &MockModel) -> Agent {
    let mut agent = agent_with(messages);
    agent.set_aux_model(Some(Arc::new(aux.clone())));
    agent
}

#[test]
fn clamps_summary_ratio_to_0_1_0_8() {
    let low = summarizing(SummarizingConversationManagerConfig {
        summary_ratio: Some(0.0),
        ..Default::default()
    });
    let high = summarizing(SummarizingConversationManagerConfig {
        summary_ratio: Some(1.0),
        ..Default::default()
    });
    assert!((low.summary_ratio() - 0.1).abs() < f64::EPSILON);
    assert!((high.summary_ratio() - 0.8).abs() < f64::EPSILON);
}

#[tokio::test]
async fn summarizes_oldest_messages_and_replaces_them_with_a_user_role_summary() {
    let aux = MockModel::new().with_turn("Summary of conversation");
    let messages = alternating(20);
    let last_two = messages[18..].to_vec();
    let mut agent = agent_with_aux(messages, &aux);
    assert!(reduce(&summarizing(half_keep_two()), &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages().len(), 11);
    assert_eq!(agent.messages()[0].role, Role::User);
    assert_eq!(
        agent.messages()[0].content,
        [ContentBlock::text("Summary of conversation")]
    );
    assert_eq!(agent.messages()[9..], last_two);
}

#[tokio::test]
async fn assigns_a_durable_tracking_id_to_the_generated_summary_message() {
    let aux = MockModel::new().with_turn("Summary of conversation");
    let mut agent = agent_with_aux(alternating(20), &aux);
    reduce(&summarizing(half_keep_two()), &mut agent, Some(overflow())).await;
    assert!(!agent.messages()[0].tracking_id().is_empty());
}

#[tokio::test]
async fn uses_the_config_model_over_agent_aux_model_when_provided() {
    let config_model = MockModel::new().with_turn("Config model summary");
    let aux = MockModel::new().with_turn("Aux model summary");
    let manager = summarizing(SummarizingConversationManagerConfig {
        model: Some(Arc::new(config_model)),
        ..half_keep_two()
    });
    let mut agent = agent_with_aux(alternating(20), &aux);
    reduce(&manager, &mut agent, Some(overflow())).await;
    assert_eq!(agent.messages()[0].text(), "Config model summary");
}

#[tokio::test]
async fn summarizes_with_agent_aux_model_not_the_triggering_model_when_no_config_model_is_set() {
    let aux = MockModel::new().with_turn("Aux model summary");
    let triggering = MockModel::new().with_turn("Triggering model summary");
    let mut agent = agent_with_aux(alternating(20), &aux);
    let options =
        ConversationManagerReduceOptions::new(agent.local_mut(), Arc::new(triggering.clone())).with_error(overflow());
    assert!(summarizing(half_keep_two()).reduce(options).await.unwrap());
    assert_eq!(agent.messages()[0].text(), "Aux model summary");
    assert_eq!(triggering.call_count(), 0);
}

#[tokio::test]
async fn returns_false_when_there_are_not_enough_messages_to_summarize() {
    let aux = MockModel::new();
    let manager = summarizing(SummarizingConversationManagerConfig {
        preserve_recent_messages: Some(10),
        ..Default::default()
    });
    let mut agent = agent_with_aux(alternating(8), &aux);
    assert!(!reduce(&manager, &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages().len(), 8);
}

#[tokio::test]
async fn rethrows_model_errors_with_the_overflow_error_as_cause() {
    let aux = MockModel::new().with_turn(MockTurn::error(|| Error::other("model failed")));
    let mut agent = agent_with_aux(alternating(20), &aux);
    let options = ConversationManagerReduceOptions::new(agent.local_mut(), model())
        .with_error(ContextWindowOverflowError::new("overflow"));
    let error = summarizing(half_keep_two()).reduce(options).await.unwrap_err();
    assert_eq!(error.to_string(), "model failed");
    let cause = std::error::Error::source(&error).unwrap();
    assert_eq!(cause.to_string(), "overflow");
    assert!(cause.is::<ContextWindowOverflowError>());
}

#[tokio::test]
async fn passes_the_correct_message_slice_and_system_prompt_to_the_model() {
    let aux = MockModel::new().with_turn("Summary");
    let manager = summarizing(SummarizingConversationManagerConfig {
        summarization_system_prompt: Some("Custom summarization prompt".into()),
        ..half_keep_two()
    });
    let messages = alternating(10);
    let mut agent = agent_with_aux(messages.clone(), &aux);
    reduce(&manager, &mut agent, Some(overflow())).await;
    let request = &aux.requests()[0];
    assert_eq!(
        request.system_prompt,
        Some(SystemPrompt::from("Custom summarization prompt"))
    );
    assert_eq!(texts(&request.messages[..5]), texts(&messages[..5]));
    assert_eq!(request.messages[5].text(), "Please summarize this conversation.");
    assert_eq!(request.messages.len(), 6);
}

#[tokio::test]
async fn preserve_recent_messages_dominates_when_larger_than_ratio_allows() {
    let aux = MockModel::new().with_turn("Summary");
    let manager = summarizing(SummarizingConversationManagerConfig {
        summary_ratio: Some(0.8),
        preserve_recent_messages: Some(8),
        ..Default::default()
    });
    let mut agent = agent_with_aux(alternating(10), &aux);
    assert!(reduce(&manager, &mut agent, Some(overflow())).await);
    assert_eq!(agent.messages().len(), 9);
    assert_eq!(aux.requests()[0].messages.len(), 3);
}

#[tokio::test]
async fn adds_the_summarization_usage_to_the_request_total_even_when_the_request_limit_is_used_up() {
    let aux = MockModel::new().with_turn(MockTurn::text("Summary").with_usage(Usage::new(5, 7, 12)));
    let mut agent = agent_with_aux(alternating(20), &aux);
    let request = InvocationContext::new(Some(InvokeLimits {
        total_tokens: Some(1),
        ..Default::default()
    }));
    request.record_usage(&Usage::new(1, 0, 1));
    let options = ConversationManagerReduceOptions::new(agent.local_mut(), model())
        .with_error(overflow())
        .with_invocation_context(InvocationContext::auxiliary(Some(&request)));
    assert!(summarizing(half_keep_two()).reduce(options).await.unwrap());
    assert_eq!(request.usage().usage, Usage::new(6, 7, 13));
}

#[tokio::test]
async fn advances_split_point_past_orphaned_tool_result_and_tool_use_boundaries() {
    let aux = MockModel::new().with_turn("Summary");
    let messages = vec![
        user("Message 1"),
        assistant("Response 1"),
        tool_use("t", "id-1"),
        tool_result("id-1", "Result"),
        user("Message 2"),
        assistant("Response 2"),
        user("Message 3"),
        assistant("Response 3"),
    ];
    let manager = summarizing(SummarizingConversationManagerConfig {
        summary_ratio: Some(0.4),
        preserve_recent_messages: Some(2),
        ..Default::default()
    });
    let mut agent = agent_with_aux(messages, &aux);
    assert!(reduce(&manager, &mut agent, Some(overflow())).await);
    assert_eq!(aux.requests()[0].messages.len(), 5);
    assert_eq!(
        texts(agent.messages()),
        ["Summary", "Message 2", "Response 2", "Message 3", "Response 3"]
    );
}

#[tokio::test]
async fn throws_when_no_valid_split_point_exists() {
    let aux = MockModel::new().with_turn("Summary");
    let messages = vec![
        tool_result("a", "r"),
        tool_result("b", "r"),
        tool_result("c", "r"),
        tool_result("d", "r"),
    ];
    let manager = summarizing(SummarizingConversationManagerConfig {
        summary_ratio: Some(0.5),
        preserve_recent_messages: Some(0),
        ..Default::default()
    });
    let mut agent = agent_with_aux(messages, &aux);
    let options = ConversationManagerReduceOptions::new(agent.local_mut(), model()).with_error(overflow());
    let error = manager.reduce(options).await.unwrap_err();
    assert_eq!(error.to_string(), "Unable to find valid split point for summarization");
}

#[tokio::test]
async fn async_reduce_sets_retry_true_through_the_base_class_await() {
    let aux = MockModel::new().with_turn("Summary");
    let mut agent = installed(Arc::new(summarizing(half_keep_two())), alternating(20)).await;
    agent.set_aux_model(Some(Arc::new(aux)));
    let (retry, _) = fire_after_model_call(&mut agent, overflow().into()).await;
    assert!(retry);
    assert_eq!(agent.messages().len(), 11);
}

#[tokio::test]
async fn a_failed_summary_during_overflow_recovery_fails_the_hook_with_its_error() {
    let aux = MockModel::new().with_turn(MockTurn::error(|| Error::other("model failed")));
    let mut agent = installed(Arc::new(summarizing(half_keep_two())), alternating(20)).await;
    agent.set_aux_model(Some(Arc::new(aux)));
    let hooks = agent.local.hooks().clone();
    let mut event =
        AfterModelCallEvent::new(&mut agent.local, InvocationState::new(), model(), 1).with_error(overflow().into());
    let error = hooks.invoke(&mut event).await.unwrap_err();
    assert!(!event.retry());
    assert_eq!(error.to_string(), "model failed");
}

fn proactive_summarizing() -> Arc<SummarizingConversationManager> {
    Arc::new(summarizing(SummarizingConversationManagerConfig {
        proactive_compression: Some(ProactiveCompression::Threshold(0.5)),
        ..half_keep_two()
    }))
}

#[tokio::test]
async fn summarizes_oldest_messages_when_compression_threshold_is_exceeded() {
    let aux = MockModel::new().with_turn("Summary");
    let mut agent = installed(proactive_summarizing(), alternating(20)).await;
    agent.set_aux_model(Some(Arc::new(aux)));
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(600)).await;
    assert_eq!(agent.messages().len(), 11);
}

#[tokio::test]
async fn does_not_summarize_when_below_compression_threshold() {
    let aux = MockModel::new().with_turn("Summary");
    let mut agent = installed(proactive_summarizing(), alternating(20)).await;
    agent.set_aux_model(Some(Arc::new(aux.clone())));
    fire_before_model_call(&mut agent, model_with_limit(1000), Some(400)).await;
    assert_eq!(agent.messages().len(), 20);
    assert_eq!(aux.call_count(), 0);
}

#[tokio::test]
async fn returns_false_and_does_not_throw_when_summarization_fails() {
    let aux = MockModel::new().with_turn(MockTurn::error(|| Error::other("model failed")));
    let mut agent = agent_with_aux(alternating(20), &aux);
    assert!(!reduce(&summarizing(half_keep_two()), &mut agent, None).await);
    assert_eq!(agent.messages().len(), 20);
}

#[tokio::test]
async fn protects_first_n_messages_from_summarization() {
    let aux = MockModel::new().with_turn("Summary");
    let manager = summarizing(SummarizingConversationManagerConfig {
        pin_first: Some(2),
        ..half_keep_two()
    });
    let mut agent = agent_with_aux(alternating(20), &aux);
    assert!(reduce(&manager, &mut agent, Some(overflow())).await);
    assert_eq!(texts(&agent.messages()[..3]), ["Message 1", "Message 2", "Summary"]);
    assert_eq!(agent.messages().len(), 13);
    assert_eq!(aux.requests()[0].messages.len(), 9);
}

#[tokio::test]
async fn returns_false_when_all_messages_in_summary_range_are_protected() {
    let aux = MockModel::new();
    let manager = summarizing(SummarizingConversationManagerConfig {
        pin_first: Some(10),
        ..half_keep_two()
    });
    let mut agent = agent_with_aux(alternating(10), &aux);
    assert!(!reduce(&manager, &mut agent, Some(overflow())).await);
}

#[tokio::test]
async fn pinned_message_in_middle_survives_summarization() {
    let aux = MockModel::new().with_turn("Summary");
    let mut messages = alternating(20);
    pin_message(&mut messages, 3);
    let mut agent = agent_with_aux(messages, &aux);
    reduce(&summarizing(half_keep_two()), &mut agent, Some(overflow())).await;
    assert_eq!(texts(&agent.messages()[..2]), ["Message 4", "Summary"]);
}

// --- context compression helpers ----------------------------------------------------------------

#[test]
fn returns_split_point_when_message_is_plain_text() {
    assert_eq!(adjust_split_point_for_tool_pairs(&alternating(4), 1).unwrap(), 1);
}

#[test]
fn skips_tool_result_messages() {
    let messages = vec![user("a"), tool_result("x", "r"), user("b")];
    assert_eq!(adjust_split_point_for_tool_pairs(&messages, 1).unwrap(), 2);
}

#[test]
fn skips_tool_use_without_following_tool_result() {
    let messages = vec![user("a"), tool_use("t", "x"), assistant("b")];
    assert_eq!(adjust_split_point_for_tool_pairs(&messages, 1).unwrap(), 2);
}

#[test]
fn accepts_tool_use_when_followed_by_tool_result() {
    let messages = vec![user("a"), tool_use("t", "x"), tool_result("x", "r")];
    assert_eq!(adjust_split_point_for_tool_pairs(&messages, 1).unwrap(), 1);
}

#[test]
fn skips_multiple_consecutive_tool_results() {
    let messages = vec![user("a"), tool_result("x", "r"), tool_result("y", "r"), user("b")];
    assert_eq!(adjust_split_point_for_tool_pairs(&messages, 1).unwrap(), 3);
}

#[test]
fn throws_when_no_valid_split_point_exists_in_the_helper() {
    let messages = vec![user("a"), tool_result("x", "r")];
    assert_eq!(
        adjust_split_point_for_tool_pairs(&messages, 1).unwrap_err().to_string(),
        "Unable to find valid split point for summarization"
    );
}

#[test]
fn returns_split_point_as_is_when_it_equals_messages_length() {
    assert_eq!(adjust_split_point_for_tool_pairs(&alternating(2), 2).unwrap(), 2);
}

#[test]
fn returns_split_point_as_is_when_it_exceeds_messages_length() {
    assert_eq!(adjust_split_point_for_tool_pairs(&alternating(2), 5).unwrap(), 5);
}

#[test]
fn finds_plain_user_message() {
    assert_eq!(find_valid_trim_point(&alternating(4), 0), 0);
}

#[test]
fn skips_non_user_messages() {
    assert_eq!(find_valid_trim_point(&alternating(4), 1), 2);
}

#[test]
fn skips_tool_result_user_messages() {
    let messages = vec![tool_result("x", "r"), user("b")];
    assert_eq!(find_valid_trim_point(&messages, 0), 1);
}

#[test]
fn returns_messages_length_when_no_valid_point_found() {
    let messages = vec![assistant("a"), tool_result("x", "r")];
    assert_eq!(find_valid_trim_point(&messages, 0), 2);
}

#[test]
fn respects_start_index() {
    assert_eq!(find_valid_trim_point(&alternating(6), 3), 4);
}

#[test]
fn returns_0_for_empty_messages() {
    assert_eq!(find_valid_trim_point(&[], 0), 0);
}

#[test]
fn all_always_matches() {
    assert!(matches_message_type(&user("a"), MessageTypeFilter::All));
    assert!(matches_message_type(&tool_use("t", "x"), MessageTypeFilter::All));
}

#[test]
fn tools_matches_tool_messages() {
    assert!(matches_message_type(&tool_use("t", "x"), MessageTypeFilter::Tools));
    assert!(matches_message_type(&tool_result("x", "r"), MessageTypeFilter::Tools));
}

#[test]
fn tools_does_not_match_plain_text() {
    assert!(!matches_message_type(&user("a"), MessageTypeFilter::Tools));
}

#[test]
fn messages_matches_plain_text() {
    assert!(matches_message_type(&user("a"), MessageTypeFilter::Messages));
}

#[test]
fn messages_does_not_match_tool_messages() {
    assert!(!matches_message_type(&tool_use("t", "x"), MessageTypeFilter::Messages));
}

#[test]
fn separates_pinned_and_unpinned_messages() {
    let mut messages = alternating(4);
    pin_message(&mut messages, 1);
    let (pinned, unpinned) = partition_pinned(&messages, 0, 4);
    assert_eq!(texts(&pinned), ["Message 2"]);
    assert_eq!(texts(&unpinned), ["Message 1", "Message 3", "Message 4"]);
}

#[test]
fn respects_range_end() {
    let mut messages = alternating(4);
    pin_message(&mut messages, 3);
    let (pinned, unpinned) = partition_pinned(&messages, 0, 2);
    assert!(pinned.is_empty());
    assert_eq!(unpinned.len(), 2);
}

async fn summary_with(model: &MockModel, prompt: Option<&str>) -> Result<Message> {
    let model: Arc<dyn Model> = Arc::new(model.clone());
    generate_summary(&alternating(2), &model, prompt, None).await
}

#[tokio::test]
async fn returns_a_user_role_message() {
    let model = MockModel::new().with_turn("Summary");
    let summary = summary_with(&model, None).await.unwrap();
    assert_eq!(summary.role, Role::User);
    assert_eq!(summary.text(), "Summary");
}

#[tokio::test]
async fn passes_the_default_system_prompt() {
    let model = MockModel::new().with_turn("Summary");
    summary_with(&model, None).await.unwrap();
    assert_eq!(
        model.requests()[0].system_prompt,
        Some(SystemPrompt::from(DEFAULT_SUMMARIZATION_PROMPT))
    );
    assert!(DEFAULT_SUMMARIZATION_PROMPT.starts_with(
        "You are a conversation summarizer. Provide a concise summary of the conversation history.\n\nFormat Requirements:"
    ));
}

#[tokio::test]
async fn passes_a_custom_system_prompt() {
    let model = MockModel::new().with_turn("Summary");
    summary_with(&model, Some("Custom")).await.unwrap();
    assert_eq!(model.requests()[0].system_prompt, Some(SystemPrompt::from("Custom")));
}

#[tokio::test]
async fn appends_summarization_request_message() {
    let model = MockModel::new().with_turn("Summary");
    summary_with(&model, None).await.unwrap();
    let messages = &model.requests()[0].messages;
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[2].role, Role::User);
    assert_eq!(messages[2].text(), "Please summarize this conversation.");
}

#[tokio::test]
async fn does_not_mutate_original_messages() {
    let model: Arc<dyn Model> = Arc::new(MockModel::new().with_turn("Summary"));
    let messages = alternating(2);
    generate_summary(&messages, &model, None, None).await.unwrap();
    assert_eq!(messages.len(), 2);
}

#[tokio::test]
async fn throws_if_model_returns_no_response() {
    let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("no response")));
    assert!(summary_with(&model, None).await.is_err());
}

#[tokio::test]
async fn drops_reasoning_blocks_from_the_summary() {
    let model = MockModel::new().with_turn(MockTurn::content([
        ContentBlock::Reasoning(ReasoningBlock::new().with_text("thinking")),
        ContentBlock::text("Summary"),
    ]));
    let summary = summary_with(&model, None).await.unwrap();
    assert_eq!(summary.content, [ContentBlock::text("Summary")]);
}

#[test]
fn keeps_only_text_blocks() {
    let reply = Message::new(
        Role::Assistant,
        vec![
            ContentBlock::Reasoning(ReasoningBlock::new().with_text("thinking")),
            ContentBlock::text("Part one"),
            ToolUseBlock::new("t", "x", json!({})).into(),
            ContentBlock::text("Part two"),
        ],
    );
    let summary = as_user_summary(&reply).unwrap();
    assert_eq!(summary.role, Role::User);
    assert_eq!(
        summary.content,
        [ContentBlock::text("Part one"), ContentBlock::text("Part two")]
    );
}

fn citations(texts: &[&str]) -> ContentBlock {
    ContentBlock::Citations(CitationsBlock::new(
        Vec::<Citation>::new(),
        texts.iter().map(|text| CitationGeneratedContent::new(*text)).collect(),
    ))
}

#[test]
fn unwraps_text_from_citations_blocks() {
    let reply = Message::new(Role::Assistant, vec![citations(&["Cited one", "Cited two"])]);
    assert_eq!(
        as_user_summary(&reply).unwrap().content,
        [ContentBlock::text("Cited one"), ContentBlock::text("Cited two")]
    );
}

#[test]
fn skips_blank_cited_text() {
    let reply = Message::new(Role::Assistant, vec![citations(&["", "Kept"])]);
    assert_eq!(as_user_summary(&reply).unwrap().content, [ContentBlock::text("Kept")]);
}

#[test]
fn throws_when_the_reply_has_no_text() {
    let reply = Message::new(Role::Assistant, vec![ToolUseBlock::new("t", "x", json!({})).into()]);
    assert_eq!(
        as_user_summary(&reply).unwrap_err().to_string(),
        "Failed to generate summary: model response contained no text"
    );
}

// --- pinning ------------------------------------------------------------------------------------

fn with_custom(custom: serde_json::Value) -> Message {
    let mut message = user("a");
    let mut metadata = MessageMetadata::new();
    metadata.custom = match custom {
        serde_json::Value::Object(custom) => Some(custom),
        _ => None,
    };
    message.metadata = Some(metadata);
    message
}

#[test]
fn returns_false_for_message_without_metadata() {
    assert!(!is_pinned(&[user("a")], 0));
}

#[test]
fn returns_false_for_message_with_empty_custom() {
    assert!(!is_pinned(&[with_custom(json!({}))], 0));
}

#[test]
fn returns_true_for_message_with_custom_pinned_true() {
    assert!(is_pinned(&[with_custom(json!({"pinned": true}))], 0));
}

#[test]
fn returns_false_for_message_with_custom_pinned_false() {
    assert!(!is_pinned(&[with_custom(json!({"pinned": false}))], 0));
}

#[test]
fn sets_pinned_true_in_custom_metadata() {
    let mut messages = vec![user("a")];
    pin_message(&mut messages, 0);
    assert_eq!(
        serde_json::to_value(&messages[0].metadata).unwrap(),
        json!({"custom": {"pinned": true}})
    );
}

#[test]
fn preserves_existing_metadata() {
    let mut messages = vec![user("a")];
    messages[0].metadata = Some(MessageMetadata::new().with_usage(Usage::new(1, 2, 3)));
    pin_message(&mut messages, 0);
    let metadata = messages[0].metadata.as_ref().unwrap();
    assert_eq!(metadata.usage, Some(Usage::new(1, 2, 3)));
    assert!(is_pinned(&messages, 0));
}

#[test]
fn preserves_existing_custom_fields() {
    let mut messages = vec![with_custom(json!({"source": "user"}))];
    pin_message(&mut messages, 0);
    assert_eq!(
        serde_json::to_value(&messages[0].metadata).unwrap(),
        json!({"custom": {"source": "user", "pinned": true}})
    );
}

#[test]
fn removes_pinned_from_custom_metadata() {
    let mut messages = vec![with_custom(json!({"pinned": true, "keep": 1}))];
    unpin_message(&mut messages, 0);
    assert_eq!(
        serde_json::to_value(&messages[0].metadata).unwrap(),
        json!({"custom": {"keep": 1}})
    );
}

#[test]
fn preserves_other_custom_fields() {
    let mut messages = vec![with_custom(json!({"pinned": true, "source": "user"}))];
    unpin_message(&mut messages, 0);
    assert!(!is_pinned(&messages, 0));
    assert_eq!(
        messages[0].metadata.as_ref().unwrap().custom.as_ref().unwrap()["source"],
        json!("user")
    );
}

#[test]
fn removes_metadata_entirely_when_nothing_remains() {
    let mut messages = vec![with_custom(json!({"pinned": true}))];
    unpin_message(&mut messages, 0);
    assert!(messages[0].metadata.is_none());
}

#[test]
fn preserves_non_custom_metadata_fields() {
    let mut messages = vec![with_custom(json!({"pinned": true}))];
    messages[0].metadata.as_mut().unwrap().usage = Some(Usage::new(1, 1, 2));
    unpin_message(&mut messages, 0);
    assert_eq!(
        serde_json::to_value(&messages[0].metadata).unwrap(),
        json!({"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}})
    );
}

#[test]
fn returns_false_for_unpinned_message() {
    assert!(!is_pinned(&alternating(2), 1));
}

#[test]
fn returns_true_for_pinned_message() {
    let mut messages = alternating(2);
    pin_message(&mut messages, 1);
    assert!(is_pinned(&messages, 1));
}

#[test]
fn returns_true_for_tool_result_whose_tool_use_partner_is_pinned() {
    let mut messages = vec![tool_use("t", "id-1"), tool_result("id-1", "r")];
    pin_message(&mut messages, 0);
    assert!(is_pinned(&messages, 1));
}

#[test]
fn returns_true_for_tool_use_whose_tool_result_partner_is_pinned() {
    let mut messages = vec![tool_use("t", "id-1"), tool_result("id-1", "r")];
    pin_message(&mut messages, 1);
    assert!(is_pinned(&messages, 0));
}

#[test]
fn returns_false_for_unrelated_message_next_to_pinned() {
    let mut messages = vec![tool_use("t", "id-1"), tool_result("id-2", "r")];
    pin_message(&mut messages, 0);
    assert!(!is_pinned(&messages, 1));
}

// --- token usage middleware ---------------------------------------------------------------------

fn token_context(model: Arc<dyn Model>, messages: Vec<Message>, projected: Option<u64>) -> InvokeModelContext {
    let agent = test_agent(MockModel::new());
    InvokeModelContext {
        agent: agent.local.tool_agent(),
        model,
        messages,
        system_prompt: None,
        tool_specs: Vec::new(),
        tool_choice: None,
        invocation_state: InvocationState::new(),
        projected_input_tokens: projected,
        dynamic_trailing_blocks: None,
        structured_output_schema: None,
        invocation_context: None,
    }
}

fn status_of(context: &InvokeModelContext) -> String {
    context
        .messages
        .last()
        .unwrap()
        .content
        .last()
        .unwrap()
        .as_text()
        .unwrap()
        .to_owned()
}

#[test]
fn returns_context_unchanged_when_projected_input_tokens_is_not_set() {
    let context = add_token_usage(token_context(model_with_limit(200_000), vec![user("hello")], None));
    assert_eq!(context.messages, [context.messages[0].clone()]);
    assert_eq!(context.messages[0].content.len(), 1);
}

#[test]
fn returns_context_unchanged_when_messages_are_empty() {
    let context = add_token_usage(token_context(model_with_limit(200_000), Vec::new(), Some(50_000)));
    assert!(context.messages.is_empty());
}

#[test]
fn appends_context_status_to_last_message_content() {
    let context = add_token_usage(token_context(
        model_with_limit(200_000),
        vec![user("hello")],
        Some(50_000),
    ));
    assert_eq!(context.messages.len(), 1);
    assert_eq!(context.messages[0].content.len(), 2);
    let status = status_of(&context);
    assert!(status.contains("<context-status>") && status.contains("25.0%"));
    assert!(status.contains("<remaining>") && status.contains("</context-status>"));
}

#[test]
fn uses_the_effective_context_model_limit() {
    let status = status_of(&add_token_usage(token_context(
        model_with_limit(10_000),
        vec![user("hello")],
        Some(8_000),
    )));
    assert!(status.contains("8,000 / 10,000 tokens (80.0%)"));
    assert!(status.contains("<remaining>~2,000 tokens</remaining>"));
}

#[test]
fn reports_the_status_line_as_one_per_call_block() {
    let context = add_token_usage(token_context(
        model_with_limit(200_000),
        vec![user("hello")],
        Some(50_000),
    ));
    assert_eq!(context.dynamic_trailing_blocks, Some(1));
}

#[test]
fn reports_no_per_call_trailing_blocks_when_the_status_line_lands_in_an_assistant_message() {
    let context = add_token_usage(token_context(
        model_with_limit(200_000),
        vec![user("durable ask"), assistant("reply")],
        Some(50_000),
    ));
    assert_eq!(context.messages[1].role, Role::Assistant);
    assert!(status_of(&context).contains("<context-status>"));
    assert_eq!(context.dynamic_trailing_blocks.unwrap_or(0), 0);
}

#[test]
fn reports_no_per_call_trailing_blocks_when_no_status_line_is_appended() {
    let context = add_token_usage(token_context(model_with_limit(200_000), vec![user("hello")], None));
    assert_eq!(context.dynamic_trailing_blocks.unwrap_or(0), 0);
}

#[test]
fn does_not_mutate_the_original_messages_array() {
    let original = vec![user("hello")];
    let context = add_token_usage(token_context(model_with_limit(200_000), original.clone(), Some(50_000)));
    assert_eq!(original[0].content.len(), 1);
    assert_eq!(context.messages[0].content.len(), 2);
}

#[test]
fn uses_default_context_window_limit_when_model_config_has_no_limit() {
    let status = status_of(&add_token_usage(token_context(
        model(),
        vec![user("hello")],
        Some(100_000),
    )));
    assert!(status.contains("<context-status>") && status.contains("50.0%") && status.contains("200,000"));
}

#[test]
fn formats_token_counts_the_same_regardless_of_the_host_locale() {
    let status = status_of(&add_token_usage(token_context(
        model_with_limit(200_000),
        vec![user("hello")],
        Some(100_000),
    )));
    assert!(status.contains("<used>100,000 / 200,000 tokens (50.0%)</used>"));
    assert!(status.contains("<remaining>~100,000 tokens</remaining>"));
}

#[test]
fn preserves_message_metadata() {
    let mut message = user("hello");
    message.metadata = Some(MessageMetadata::new().with_usage(Usage::new(10, 5, 15)));
    let context = add_token_usage(token_context(
        model_with_limit(200_000),
        vec![message.clone()],
        Some(50_000),
    ));
    assert_eq!(context.messages[0].metadata, message.metadata);
}

#[test]
fn reports_correct_remaining_tokens() {
    let status = status_of(&add_token_usage(token_context(
        model_with_limit(100_000),
        vec![user("hello")],
        Some(80_000),
    )));
    assert!(status.contains("80.0%") && status.contains("<remaining>~20,000 tokens</remaining>"));
}

#[tokio::test]
async fn does_not_register_middleware_when_context_manager_is_not_agentic() {
    let model = MockModel::from_turns([
        MockTurn::text("First response").with_usage(Usage::new(1000, 200, 1200)),
        MockTurn::text("Second response").with_usage(Usage::new(2000, 300, 2300)),
    ]);
    let mut agent = test_agent(model.clone());
    agent.invoke("First message").await.unwrap();
    agent.invoke("Second message").await.unwrap();
    let last = model.requests()[1].messages.last().unwrap().text();
    assert!(!last.contains("<context-status>"));
}

// --- agent configuration ------------------------------------------------------------------------

#[test]
fn the_default_conversation_manager_is_a_40_message_sliding_window() {
    let agent = test_agent(MockModel::new());
    assert_eq!(
        agent.conversation_manager.name(),
        "strands:sliding-window-conversation-manager"
    );
}

#[tokio::test]
async fn the_conversation_manager_is_registered_first_after_the_router_slot() {
    let mut agent = test_agent(MockModel::new());
    agent.initialize().await.unwrap();
    let names = agent.plugins.names();
    assert_eq!(
        names.first().map(String::as_str),
        Some("strands:sliding-window-conversation-manager")
    );
    assert_eq!(names.last().map(String::as_str), Some("strands:model"));
    let _ = StopReason::EndTurn;
}

fn stateful_model() -> MockModel {
    let model = MockModel::new();
    let mut info = crate::models::ModelInfo::default();
    info.capabilities.stateful = Some(true);
    model
        .update_config(BaseModelConfig {
            model_info: Some(info),
            ..Default::default()
        })
        .unwrap();
    model
}

#[test]
fn throws_when_a_conversation_manager_is_supplied_alongside_a_stateful_model() {
    let error = Agent::new(AgentConfig {
        model: Some(stateful_model().into()),
        conversation_manager: Some(Arc::new(window(5, true))),
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "contextManager and conversationManager cannot be used with a stateful model. The model manages conversation state server-side."
    );
}

#[test]
fn assigns_null_conversation_manager_when_the_model_is_stateful() {
    let agent = Agent::new(AgentConfig {
        model: Some(stateful_model().into()),
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(agent.conversation_manager.name(), "strands:null-conversation-manager");
}

#[test]
fn uses_the_caller_provided_conversation_manager() {
    let manager: Arc<dyn ConversationManager> = Arc::new(window(7, true));
    let agent = Agent::new(AgentConfig {
        model: Some(MockModel::new().into()),
        conversation_manager: Some(manager.clone()),
        printer: Some(false),
        ..Default::default()
    })
    .unwrap();
    assert!(Arc::ptr_eq(&agent.conversation_manager, &manager));
}
