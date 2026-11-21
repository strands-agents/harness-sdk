use std::collections::HashMap;
use std::sync::Arc;

use super::*;
use crate::agent::InvocationState;
use crate::experimental::context_manager::message_trimming::{
    collect_removable_with_pair, insert_marker, repair_alternation,
};
use crate::experimental::context_manager::methods::truncate::{PreviewMode, TruncateConfig};
use crate::experimental::context_manager::placeholder::{format_dropped_messages, format_elided, offload_placeholder};
use crate::experimental::context_manager::strategies::offload::{
    ConditionValue, DropStrategy, Offload, OffloadConditions, SummarizeConfig, SummarizeStrategy, TruncateStrategy,
};
use crate::experimental::context_manager::test_support::{
    TestModel, agent_with, assistant, content_offloaded_by, conversation, offloaded_by, pinned, placeholders_in,
    provenance, summary_result, text, texts_of, tool_result_message, tool_use_message, user,
};
use crate::models::Model;
use crate::models::streaming::Usage;
use crate::test_support::record_logs;
use crate::testing::MockModel;
use crate::types::{
    ImageBlock, ImageFormat, ImageSource, InjectedBlock, JsonObject, JsonValue, MessageMetadata, ToolReferenceBlock,
    ToolResultContent, ToolResultStatus, ToolUseBlock,
};

const LARGE_LEN: usize = 2500 * 4 + 100;

fn large() -> String {
    "x".repeat(LARGE_LEN)
}

fn test_model(window: Option<u64>) -> TestModel {
    let model = TestModel::new().summarizing(summary_result("summary", None));
    match window {
        Some(limit) => model.with_context_window(limit),
        None => model,
    }
}

fn agent(messages: Vec<Message>) -> LocalAgent {
    agent_with(Arc::new(test_model(None)), messages)
}

fn agent_in_window(messages: Vec<Message>, window: Option<u64>) -> LocalAgent {
    agent_with(Arc::new(test_model(window)), messages)
}

/// An agent on `model`, so a test can read its summarize calls.
fn agent_on(model: &Arc<TestModel>, messages: Vec<Message>) -> LocalAgent {
    agent_with(model.clone(), messages)
}

async fn apply(strategy: &dyn ContextStrategy, agent: &mut LocalAgent, utilization: f64) -> bool {
    apply_with(strategy, agent, utilization, false).await
}

async fn apply_with(strategy: &dyn ContextStrategy, agent: &mut LocalAgent, utilization: f64, overflow: bool) -> bool {
    let mut context = ContextState::new(agent, utilization).with_overflow(overflow);
    strategy.apply(&mut context).await.unwrap()
}

fn none() -> OffloadConditions {
    OffloadConditions::default()
}

fn utilization(value: &str) -> OffloadConditions {
    OffloadConditions::builder().context_utilization(value).build()
}

fn threshold(value: impl Into<ConditionValue>) -> OffloadConditions {
    OffloadConditions::builder().block_threshold(value).build()
}

fn preserve(value: impl Into<ConditionValue>) -> OffloadConditions {
    OffloadConditions::builder().preserve_recent(value).build()
}

fn truncate(target: OffloadTarget) -> TruncateStrategy {
    Offload::truncate(target, TruncateConfig::default()).unwrap()
}

fn truncate_with(target: OffloadTarget, preview_tokens: f64) -> TruncateStrategy {
    Offload::truncate(
        target,
        TruncateConfig {
            preview_tokens: Some(preview_tokens),
            ..TruncateConfig::default()
        },
    )
    .unwrap()
}

fn drop_strategy(target: OffloadTarget) -> DropStrategy {
    Offload::drop(target).unwrap()
}

fn summarize_strategy(target: OffloadTarget) -> SummarizeStrategy {
    Offload::summarize(target, SummarizeConfig::default()).unwrap()
}

/// A builder per method, so a table runs one case for each.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Method {
    Drop,
    Truncate,
    Summarize,
}

const METHODS: [Method; 3] = [Method::Drop, Method::Truncate, Method::Summarize];

impl Method {
    fn offload(self) -> OffloadMethod {
        match self {
            Self::Drop => OffloadMethod::Drop,
            Self::Truncate => OffloadMethod::Truncate,
            Self::Summarize => OffloadMethod::Summarize,
        }
    }

    fn name(self) -> &'static str {
        self.offload().as_str()
    }

    /// The method's strategy on `target`; truncate previews 100 tokens.
    fn when(self, target: OffloadTarget, conditions: OffloadConditions) -> Result<Arc<dyn ContextStrategy>> {
        Ok(match self {
            Self::Drop => Arc::new(drop_strategy(target).when(conditions)?),
            Self::Truncate => Arc::new(truncate_with(target, 100.0).when(conditions)?),
            Self::Summarize => Arc::new(summarize_strategy(target).when(conditions)?),
        })
    }

    /// The method's strategy on `target` with no conditions.
    fn bare(self, target: OffloadTarget) -> Arc<dyn ContextStrategy> {
        match self {
            Self::Drop => Arc::new(drop_strategy(target)),
            Self::Truncate => Arc::new(truncate_with(target, 100.0)),
            Self::Summarize => Arc::new(summarize_strategy(target)),
        }
    }
}

fn expect_error<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(error) => error.to_string(),
    }
}

fn error_result_message(text: &str) -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::error(
            "tool-err",
            vec![ToolResultContent::text(text)],
        ))],
    )
}

fn tool_result(message: &Message, index: usize) -> &ToolResultBlock {
    let ContentBlock::ToolResult(result) = &message.content[index] else {
        panic!("not a tool result");
    };
    result
}

fn first_result_text(message: &Message) -> String {
    let ToolResultContent::Text(text) = &tool_result(message, 0).content[0] else {
        panic!("not text");
    };
    text.text.clone()
}

/// A task message followed by one tool call per result, each result `tokens[i]` tokens long
/// (`toolHistory`).
fn tool_history(tokens: &[usize]) -> Vec<Message> {
    let mut messages = vec![user("task")];
    for (index, size) in tokens.iter().enumerate() {
        let id = format!("tu-{index}");
        messages.push(tool_use_message(&id, "read"));
        messages.push(tool_result_message(&"x".repeat(size * 4), &id));
    }
    messages.push(assistant("done"));
    messages
}

fn results(messages: &[Message]) -> impl Iterator<Item = &ToolResultBlock> {
    messages
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(result),
            _ => None,
        })
}

fn result_texts(messages: &[Message]) -> Vec<String> {
    results(messages)
        .map(|result| match &result.content[0] {
            ToolResultContent::Text(text) => text.text.clone(),
            _ => String::new(),
        })
        .collect()
}

fn result_methods(messages: &[Message]) -> Vec<Option<OffloadMethod>> {
    results(messages)
        .map(|result| content_offloaded_by(&result.content[0]))
        .collect()
}

fn assert_alternates(messages: &[Message]) {
    for pair in messages.windows(2) {
        assert_ne!(pair[0].role, pair[1].role);
    }
}

fn all_text(messages: &[Message]) -> Vec<String> {
    texts_of(messages).into_iter().flatten().collect()
}

fn image_block(size: usize) -> ImageBlock {
    ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![0; size]))
}

// --- Offload.truncate ---------------------------------------------------------------------------

#[test]
fn rejects_a_token_threshold_at_or_below_preview_tokens() {
    let error = truncate_with(OffloadTarget::ToolResults, 500.0)
        .when(threshold(500))
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("blockThreshold (500) must be greater than previewTokens (500) to ensure truncation converges")
    );
}

#[test]
fn rejects_on_init_a_percent_threshold_at_or_below_preview_tokens() {
    for (window, percent, tokens) in [(Some(10_000), "5%", 500), (None, "0.25%", 500)] {
        let strategy = truncate_with(OffloadTarget::ToolResults, 500.0)
            .when(threshold(percent))
            .unwrap();
        let mut agent = agent_in_window(Vec::new(), window);
        let error = strategy.init(&mut agent, None).unwrap_err();
        assert!(
            error.to_string().contains(&format!(
                "blockThreshold ({tokens} tokens of the context window) must be greater than previewTokens (500)"
            )),
            "{window:?} {percent}: {error}"
        );
    }
}

#[test]
fn accepts_on_init_a_percent_threshold_above_preview_tokens() {
    let strategy = truncate_with(OffloadTarget::ToolResults, 500.0)
        .when(threshold("6%"))
        .unwrap();
    let mut agent = agent_in_window(Vec::new(), Some(10_000));
    strategy.init(&mut agent, None).unwrap();
}

#[test]
fn measures_a_percent_threshold_against_the_context_window_in_model_info() {
    let model = MockModel::new();
    let mut info = crate::models::ModelInfo::default();
    info.limits.context_window = Some(10_000);
    model
        .update_config(crate::models::BaseModelConfig {
            model_info: Some(info),
            ..crate::models::BaseModelConfig::default()
        })
        .unwrap();
    let mut agent = agent_with(Arc::new(model), Vec::new());
    let strategy = truncate_with(OffloadTarget::ToolResults, 500.0)
        .when(threshold("5%"))
        .unwrap();
    let error = strategy.init(&mut agent, None).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("blockThreshold (500 tokens of the context window) must be greater than previewTokens (500)")
    );
}

#[tokio::test]
async fn truncates_large_tool_results() {
    let mut agent = agent(vec![tool_result_message(&large(), "tool-123")]);
    let strategy = truncate(OffloadTarget::ToolResults).when(none()).unwrap();
    assert!(apply(&strategy, &mut agent, 0.5).await);
    let result = tool_result(&agent.messages()[0], 0);
    assert_eq!(content_offloaded_by(&result.content[0]), Some(OffloadMethod::Truncate));
}

#[tokio::test]
async fn does_not_truncate_results_below_threshold() {
    let mut agent = agent(vec![tool_result_message("short result", "tool-123")]);
    let strategy = truncate(OffloadTarget::ToolResults).when(threshold(2500)).unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
}

#[tokio::test]
async fn skips_error_results_when_target_is_tool_results() {
    let mut agent = agent(vec![error_result_message(&large())]);
    let strategy = truncate(OffloadTarget::ToolResults).when(none()).unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
}

#[tokio::test]
async fn truncates_error_results_when_target_is_tool_result_errors() {
    let mut agent = agent(vec![error_result_message(&large())]);
    let strategy = truncate(OffloadTarget::ToolResultErrors).when(none()).unwrap();
    assert!(apply(&strategy, &mut agent, 0.5).await);
}

#[tokio::test]
async fn skips_non_user_messages_when_targeting_tool_results() {
    let mut agent = agent(vec![assistant(&large())]);
    let strategy = truncate(OffloadTarget::ToolResults).when(none()).unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
}

#[tokio::test]
async fn does_not_truncate_user_messages_with_assistant_text_target() {
    let mut agent = agent(vec![user(&large())]);
    let strategy = truncate(OffloadTarget::AssistantText).when(none()).unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
}

#[tokio::test]
async fn builds_head_tail_preview() {
    let text = format!(
        "{}{}{}",
        "HEAD".repeat(1000),
        "MIDDLE".repeat(5000),
        "TAIL".repeat(1000)
    );
    let mut agent = agent(vec![tool_result_message(&text, "tool-123")]);
    let strategy = truncate_with(OffloadTarget::ToolResults, 100.0).when(none()).unwrap();
    apply(&strategy, &mut agent, 0.5).await;
    let preview = first_result_text(&agent.messages()[0]);
    assert!(preview.contains("[..."));
    assert!(preview.contains("chars elided"));
}

// https://github.com/strands-agents/harness-sdk/issues/4681
#[tokio::test]
async fn formats_preview_counts_the_same_regardless_of_the_host_locale() {
    let mut agent = agent(vec![tool_result_message(&"x".repeat(1_000_000), "tool-123")]);
    let strategy = truncate_with(OffloadTarget::ToolResults, 100.0).when(none()).unwrap();
    apply(&strategy, &mut agent, 0.5).await;
    let preview = first_result_text(&agent.messages()[0]);
    assert!(preview.contains("~250,000 tokens]"));
    assert!(preview.contains("[... 999,600 chars elided ...]"));
}

#[tokio::test]
async fn returns_false_for_empty_messages() {
    let mut agent = agent(Vec::new());
    let strategy = truncate(OffloadTarget::ToolResults).when(none()).unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
}

// --- Offload builder ------------------------------------------------------------------------------

#[tokio::test]
async fn offload_drop_drops_tool_result_content_from_context_window_entirely() {
    let mut agent = agent(vec![tool_result_message(&"x".repeat(100), "tool-123")]);
    let strategy = drop_strategy(OffloadTarget::ToolResults).when(none()).unwrap();
    assert!(apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(first_result_text(&agent.messages()[0]), "[Dropped: ~25 tokens]");
}

fn dropped_text(message: &Message, index: usize) -> String {
    let ToolResultContent::Text(text) = &tool_result(message, index).content[0] else {
        panic!("not text");
    };
    text.text.clone()
}

fn load_and_call(load: ToolResultBlock, other: ToolResultBlock, other_name: &str) -> Vec<Message> {
    vec![
        Message::new(
            Role::Assistant,
            vec![
                ToolUseBlock::new("load_tools", load.tool_use_id.clone(), serde_json::json!({})).into(),
                ToolUseBlock::new(other_name, other.tool_use_id.clone(), serde_json::json!({})).into(),
            ],
        ),
        Message::new(Role::User, vec![load.into(), other.into()]),
    ]
}

#[tokio::test]
async fn offload_drop_keeps_tool_results_made_of_tool_references_which_hold_the_loaded_schemas() {
    let reference = ToolResultContent::from(ToolReferenceBlock::new("bash"));
    let mut agent = agent(load_and_call(
        ToolResultBlock::success("load-1", vec![reference.clone()]),
        ToolResultBlock::success("bash-1", vec![ToolResultContent::text("x".repeat(100))]),
        "bash",
    ));
    assert!(
        apply(
            &drop_strategy(OffloadTarget::ToolResults).when(none()).unwrap(),
            &mut agent,
            0.5
        )
        .await
    );
    assert_eq!(tool_result(&agent.messages()[1], 0).content, vec![reference]);
    assert_eq!(dropped_text(&agent.messages()[1], 1), "[Dropped: ~25 tokens]");
}

#[tokio::test]
async fn offload_drop_tool_result_errors_keeps_the_answer_to_an_early_call_of_a_deferred_tool_which_holds_its_reference()
 {
    let answer = vec![
        ToolResultContent::text(
            "Not run: bash was called before its parameters were loaded. They are loaded now; call it again.",
        ),
        ToolReferenceBlock::new("bash").into(),
    ];
    let mut agent = agent(load_and_call(
        ToolResultBlock::error("bash-1", answer.clone()),
        ToolResultBlock::error("read-1", vec![ToolResultContent::text("x".repeat(100))]),
        "read",
    ));
    assert!(
        apply(
            &drop_strategy(OffloadTarget::ToolResultErrors).when(none()).unwrap(),
            &mut agent,
            0.5
        )
        .await
    );
    assert_eq!(tool_result(&agent.messages()[1], 0).content, answer);
    assert_eq!(dropped_text(&agent.messages()[1], 1), "[Dropped: ~25 tokens]");
}

#[tokio::test]
async fn offload_drop_drops_a_load_tools_result_that_holds_text_like_any_other_tool_result() {
    let mut agent = agent(vec![
        Message::new(
            Role::Assistant,
            vec![ToolUseBlock::new("load_tools", "load-1", serde_json::json!({})).into()],
        ),
        tool_result_message(&"x".repeat(100), "load-1"),
    ]);
    assert!(
        apply(
            &drop_strategy(OffloadTarget::ToolResults).when(none()).unwrap(),
            &mut agent,
            0.5
        )
        .await
    );
    assert_eq!(first_result_text(&agent.messages()[1]), "[Dropped: ~25 tokens]");
}

#[tokio::test]
async fn offload_truncate_with_a_tool_list_matches_tool_by_name_from_assistant_message() {
    let mut agent = agent(vec![
        tool_use_message("tool-bash", "bash"),
        tool_result_message(&large(), "tool-bash"),
    ]);
    let strategy = truncate(OffloadTarget::tools(["tool::bash"])).when(none()).unwrap();
    assert!(apply(&strategy, &mut agent, 0.5).await);
    let result = tool_result(&agent.messages()[1], 0);
    assert_eq!(content_offloaded_by(&result.content[0]), Some(OffloadMethod::Truncate));
}

#[tokio::test]
async fn offload_truncate_with_a_tool_list_skips_non_matching_tools() {
    let mut agent = agent(vec![
        tool_use_message("tool-read", "read_file"),
        tool_result_message(&large(), "tool-read"),
    ]);
    let strategy = truncate(OffloadTarget::tools(["tool::bash"])).when(none()).unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
}

#[test]
fn offload_returns_a_strategy_that_runs_eagerly_without_when() {
    for method in METHODS {
        let strategy = match method {
            Method::Truncate => Arc::new(truncate_with(OffloadTarget::ToolResults, 500.0)) as Arc<dyn ContextStrategy>,
            other => other.bare(OffloadTarget::ToolResults),
        };
        let mut agent = agent(Vec::new());
        strategy.init(&mut agent, None).unwrap();
        assert_eq!(strategy.name(), format!("offload:{}", method.name()));
        assert_eq!(agent.hooks().len(), 1, "{method:?}");
    }
}

#[tokio::test]
async fn when_replaces_the_conditions_and_keeps_the_target_and_config() {
    let bare = truncate_with(OffloadTarget::ToolResults, 100.0);
    let strategy = bare.when(threshold(2000)).unwrap().when(preserve(1)).unwrap();
    let mut agent = agent(tool_history(&[500, 500, 500]));
    assert!(apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(
        result_methods(agent.messages()),
        [Some(OffloadMethod::Truncate), Some(OffloadMethod::Truncate), None]
    );
}

#[test]
fn rejects_on_init_a_bare_whole_message_or_media_strategy() {
    for (target, error) in [
        (OffloadTarget::All, "(\"*\") would act on every message"),
        (OffloadTarget::Media, "(\"media\") would remove media"),
    ] {
        let strategy = drop_strategy(target);
        let mut agent = agent(Vec::new());
        assert!(strategy.init(&mut agent, None).unwrap_err().to_string().contains(error));
    }
}

#[test]
fn throws_on_empty_array_target() {
    let empty = || OffloadTarget::Tools(Vec::new());
    let error = |result: Result<()>| result.unwrap_err().to_string();
    assert!(error(Offload::truncate(empty(), TruncateConfig::default()).map(drop)).contains("Empty array target"));
    assert!(error(Offload::drop(empty()).map(drop)).contains("Empty array target"));
    assert!(error(Offload::summarize(empty(), SummarizeConfig::default()).map(drop)).contains("Empty array target"));
}

// --- message-level with role alternation ----------------------------------------------------------

#[tokio::test]
async fn drop_text_with_utilization_replaces_each_text_block_between_the_first_and_last_message() {
    for (target, role) in [
        (OffloadTarget::AssistantText, Role::Assistant),
        (OffloadTarget::UserText, Role::User),
    ] {
        let mut agent = agent(conversation(4));
        let strategy = drop_strategy(target).when(utilization("50%")).unwrap();
        assert!(apply(&strategy, &mut agent, 0.9).await);
        let messages = agent.messages();
        assert_eq!(messages.len(), 8);
        for (index, message) in messages.iter().enumerate() {
            let dropped = message.role == role && index > 0 && index < messages.len() - 1;
            let expected = dropped.then_some(OffloadMethod::Drop);
            assert_eq!(offloaded_by(&message.content[0]), expected, "{role:?} {index}");
        }
    }
}

#[tokio::test]
async fn drop_all_message_level_repairs_alternation() {
    let mut agent = agent(conversation(4));
    let strategy = drop_strategy(OffloadTarget::All).when(utilization("50%")).unwrap();
    apply(&strategy, &mut agent, 0.9).await;
    assert_alternates(agent.messages());
}

#[tokio::test]
async fn drop_all_message_level_with_tool_pairs_preserves_tool_pair_integrity() {
    let mut agent = agent(vec![
        user("q1"),
        tool_use_message("tu-1", "bash"),
        tool_result_message("result", "tu-1"),
        assistant("a2"),
        user("q3"),
        assistant("a3"),
        user("q4"),
        assistant("a4"),
    ]);
    let strategy = drop_strategy(OffloadTarget::All)
        .when(
            OffloadConditions::builder()
                .context_utilization("50%")
                .preserve_recent(4)
                .build(),
        )
        .unwrap();
    apply(&strategy, &mut agent, 0.9).await;
    assert_alternates(agent.messages());
    let blocks: Vec<&ContentBlock> = agent.messages().iter().flat_map(|message| &message.content).collect();
    for block in &blocks {
        if let ContentBlock::ToolResult(result) = block {
            assert!(blocks.iter().any(
                |other| matches!(other, ContentBlock::ToolUse(tool_use) if tool_use.tool_use_id == result.tool_use_id)
            ));
        }
    }
}

#[tokio::test]
async fn drop_all_keeps_a_tool_use_whose_result_preserve_recent_protects() {
    let tool_use = tool_use_message("tu-1", "bash");
    let result = tool_result_message("result", "tu-1");
    let (q1, a1, q2, a3) = (user("q1"), assistant("a1"), user("q2"), assistant("a3"));
    let mut agent = agent(vec![
        q1.clone(),
        a1.clone(),
        q2.clone(),
        tool_use.clone(),
        result.clone(),
        a3.clone(),
    ]);
    let removed = agent
        .model()
        .count_tokens(&[a1, q2], crate::models::CountTokensOptions::default())
        .await
        .unwrap();
    let strategy = drop_strategy(OffloadTarget::All).when(preserve(2)).unwrap();
    assert!(apply(&strategy, &mut agent, 0.5).await);
    let marker = offload_placeholder(OffloadMethod::Drop, &format_dropped_messages(removed), None, removed);
    let mut carrier = tool_use.content.clone();
    carrier.push(ContentBlock::Text(marker));
    let expected = vec![q1, tool_use.with_content(carrier), result.clone(), a3];
    assert_eq!(agent.messages(), expected.as_slice());
    assert_eq!(agent.messages()[2].tracking_id(), result.tracking_id());
}

#[tokio::test]
async fn drop_all_acts_when_only_message_0_precedes_the_candidates() {
    let mut agent = agent(conversation(2));
    let strategy = drop_strategy(OffloadTarget::All).when(utilization("50%")).unwrap();
    assert!(apply(&strategy, &mut agent, 0.9).await);
    assert_eq!(
        texts_of(agent.messages()),
        [vec!["q1"], vec!["a2", "[Dropped: earlier messages, ~2 tokens]"]]
    );
}

#[tokio::test]
async fn message_level_starts_with_user_message_after_operation() {
    let mut agent = agent(conversation(3));
    let strategy = drop_strategy(OffloadTarget::All).when(utilization("50%")).unwrap();
    apply(&strategy, &mut agent, 0.9).await;
    assert_eq!(agent.messages()[0].role, Role::User);
}

// --- target All and a threshold ---------------------------------------------------------------

fn large_history() -> Vec<Message> {
    vec![
        user("task"),
        assistant(&large()),
        user("small question"),
        assistant(&large()),
        user("next"),
    ]
}

#[tokio::test]
async fn offload_all_acts_on_large_messages_and_keeps_small_ones() {
    for method in [Method::Drop, Method::Summarize] {
        let mut agent = agent(large_history());
        let strategy = method.when(OffloadTarget::All, threshold(2500)).unwrap();
        assert!(apply(strategy.as_ref(), &mut agent, 0.5).await, "{method:?}");
        let texts = all_text(agent.messages());
        assert!(!texts.contains(&large()));
        assert!(texts.contains(&"small question".to_owned()));
        assert!(texts.contains(&"next".to_owned()));
    }
}

#[tokio::test]
async fn leaves_one_marker_for_each_run_of_removed_messages() {
    let mut agent = agent(large_history());
    let strategy = drop_strategy(OffloadTarget::All).when(threshold(2500)).unwrap();
    assert!(apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(
        texts_of(agent.messages()),
        [
            vec!["task".to_owned()],
            vec![format_dropped_messages(2525)],
            vec!["small question".to_owned()],
            vec![format_dropped_messages(2525)],
            vec!["next".to_owned()],
        ]
    );
    assert_eq!(
        placeholders_in(agent.messages()),
        [
            provenance(OffloadMethod::Drop, Some(2525)),
            provenance(OffloadMethod::Drop, Some(2525))
        ]
    );
}

#[test]
fn offload_truncate_all_rejects_a_block_threshold() {
    for value in [ConditionValue::from(2500), ConditionValue::from("5%")] {
        let error = truncate(OffloadTarget::All)
            .when(OffloadConditions {
                block_threshold: Some(value),
                ..OffloadConditions::default()
            })
            .unwrap_err();
        assert!(error.to_string().contains(
            "Offload.truncate('*') doesn't take a blockThreshold; use Offload.drop('*') to remove large messages, or Offload.truncate('toolResults') to preview large blocks"
        ));
    }
}

#[tokio::test]
async fn leaves_injected_text_in_place() {
    let injected = ContentBlock::Injected(InjectedBlock::new(large(), "strands:memory-manager"));
    let message = Message::new(Role::User, vec![ContentBlock::text("ask"), injected.clone()]);
    let mut agent = agent(vec![message]);
    let strategy = truncate_with(OffloadTarget::UserText, 50.0)
        .when(threshold(100))
        .unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(agent.messages()[0].content, [ContentBlock::text("ask"), injected]);
}

// --- media target -------------------------------------------------------------------------------

fn with_image() -> Message {
    Message::new(
        Role::User,
        vec![
            ContentBlock::text("look at this"),
            ContentBlock::Image(image_block(4000)),
            ContentBlock::ToolResult(ToolResultBlock::success(
                "tool-1",
                vec![ToolResultContent::text("x".repeat(4000))],
            )),
        ],
    )
}

#[tokio::test]
async fn drops_media_blocks_and_leaves_text_and_tool_results_alone() {
    let mut agent = agent(vec![user("task"), with_image(), assistant("b")]);
    let strategy = drop_strategy(OffloadTarget::Media)
        .when(
            OffloadConditions::builder()
                .context_utilization("50%")
                .block_threshold(10)
                .build(),
        )
        .unwrap();
    assert!(apply(&strategy, &mut agent, 0.5).await);
    let message = &agent.messages()[1];
    assert_eq!(message.content[0], ContentBlock::text("look at this"));
    assert_eq!(
        message.content[1].as_text(),
        Some("[Dropped: image, ~2,692 tokens, removed from context after it was received]")
    );
    assert_eq!(message.content[2], with_image().content[2]);
}

#[tokio::test]
async fn preserve_recent_counts_only_messages_with_media() {
    let mut agent = agent(vec![
        user("task"),
        with_image(),
        assistant("a"),
        with_image(),
        assistant("b"),
    ]);
    let strategy = drop_strategy(OffloadTarget::Media).when(preserve(1)).unwrap();
    apply(&strategy, &mut agent, 0.5).await;
    assert_eq!(
        agent.messages()[1].content[1].as_text(),
        Some("[Dropped: image, ~2,692 tokens, removed from context after it was received]")
    );
    assert!(matches!(agent.messages()[3].content[1], ContentBlock::Image(_)));
}

/// An agent on the model's own token heuristic, which counts media as 0 tokens.
fn heuristic_agent(messages: Vec<Message>) -> LocalAgent {
    agent_with(Arc::new(MockModel::new()), messages)
}

#[tokio::test]
async fn under_the_media_free_heuristic_drops_the_media() {
    for conditions in [
        utilization("50%"),
        OffloadConditions::builder()
            .context_utilization("50%")
            .block_threshold(1000)
            .build(),
    ] {
        let mut agent = heuristic_agent(vec![user("task"), with_image(), assistant("b")]);
        let strategy = drop_strategy(OffloadTarget::Media).when(conditions).unwrap();
        assert!(apply(&strategy, &mut agent, 0.5).await);
        assert_eq!(
            agent.messages()[1].content,
            [
                ContentBlock::text("look at this"),
                ContentBlock::Text(offload_placeholder(
                    OffloadMethod::Drop,
                    "[Dropped: image, removed from context after it was received]",
                    None,
                    0
                )),
                with_image().content[2].clone(),
            ]
        );
    }
}

#[tokio::test]
async fn under_the_media_free_heuristic_drops_a_tool_result_holding_only_media_with_a_block_threshold() {
    let result = Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tu-1",
            vec![ToolResultContent::Image(image_block(4000))],
        ))],
    );
    let mut agent = heuristic_agent(vec![user("task"), result, assistant("b")]);
    let strategy = drop_strategy(OffloadTarget::ToolResults)
        .when(
            OffloadConditions::builder()
                .context_utilization("50%")
                .block_threshold(1000)
                .build(),
        )
        .unwrap();
    assert!(apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(
        placeholders_in(agent.messages()),
        [provenance(OffloadMethod::Drop, None)]
    );
}

#[tokio::test]
async fn under_the_media_free_heuristic_offloads_the_media_with_a_marker_that_leaves_out_the_size() {
    let mut agent = heuristic_agent(vec![user("task"), with_image(), assistant("b")]);
    let strategy = truncate(OffloadTarget::Media).when(utilization("50%")).unwrap();
    assert!(apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(
        agent.messages()[1].content[1].as_text(),
        Some("[Offloaded: image, removed from context after it was received]")
    );
}

#[tokio::test]
async fn skips_empty_text_blocks_without_a_threshold() {
    let message = Message::new(
        Role::Assistant,
        vec![ContentBlock::text(""), ContentBlock::text("  \n")],
    );
    let mut agent = agent(vec![message.clone()]);
    let strategy = drop_strategy(OffloadTarget::AssistantText).when(none()).unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(agent.messages()[0].content, message.content);
}

// --- pinned message protection ------------------------------------------------------------------

#[tokio::test]
async fn message_level_drop_skips_pinned_messages() {
    let mut agent = agent(vec![
        user("q1"),
        assistant("a1"),
        pinned(user("pinned-msg")),
        assistant("a2"),
        user("q3"),
        assistant("a3"),
    ]);
    let strategy = drop_strategy(OffloadTarget::All).when(utilization("50%")).unwrap();
    apply(&strategy, &mut agent, 0.9).await;
    assert!(all_text(agent.messages()).contains(&"pinned-msg".to_owned()));
}

#[tokio::test]
async fn message_level_drop_skips_tool_pair_partner_of_pinned_message() {
    let mut agent = agent(vec![
        user("q1"),
        pinned(tool_use_message("tu-1", "test")),
        tool_result_message("result", "tu-1"),
        assistant("a2"),
        user("q3"),
        assistant("a3"),
    ]);
    let strategy = drop_strategy(OffloadTarget::All).when(utilization("50%")).unwrap();
    apply(&strategy, &mut agent, 0.9).await;
    assert!(results(agent.messages()).any(|result| result.tool_use_id == "tu-1"));
}

#[tokio::test]
async fn pinned_message_survives_repair_alternation_merge_across_two_passes() {
    let mut agent = agent(vec![
        user("q1"),
        assistant("a1"),
        user("q2"),
        pinned(assistant("pinned-a3")),
        user("q4"),
        assistant("a5"),
        user("q6"),
        assistant("a7"),
        user("q8"),
        assistant("a9"),
        user("q10"),
    ]);
    let strategy = drop_strategy(OffloadTarget::All)
        .when(
            OffloadConditions::builder()
                .context_utilization("50%")
                .preserve_recent(4)
                .build(),
        )
        .unwrap();
    apply(&strategy, &mut agent, 0.9).await;
    apply(&strategy, &mut agent, 0.9).await;
    let merged = agent
        .messages()
        .iter()
        .find(|message| message.content.iter().any(|block| block.as_text() == Some("pinned-a3")))
        .expect("the pinned message is kept");
    assert!(is_pinned(std::slice::from_ref(merged), 0));
}

#[test]
fn repair_alternation_merges_metadata_the_later_message_winning_and_custom_holding_both() {
    let custom = |pairs: &[(&str, JsonValue)]| -> JsonObject {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect()
    };
    let earlier_usage = Usage::new(1, 1, 2);
    let later_usage = Usage::new(5, 5, 10);
    let mut messages = vec![
        user("q1"),
        assistant("a1").with_tracking_id("a1").with_metadata(
            MessageMetadata::new()
                .with_usage(earlier_usage)
                .with_custom(custom(&[("pinned", JsonValue::Bool(true)), ("source", "a1".into())])),
        ),
        assistant("a2").with_metadata(
            MessageMetadata::new()
                .with_usage(later_usage)
                .with_custom(custom(&[("source", "a2".into()), ("tag", "x".into())])),
        ),
    ];
    repair_alternation(&mut messages);
    let expected = Message::new(
        Role::Assistant,
        vec![ContentBlock::text("a1"), ContentBlock::text("a2")],
    )
    .with_tracking_id("a1")
    .with_metadata(MessageMetadata::new().with_usage(later_usage).with_custom(custom(&[
        ("pinned", JsonValue::Bool(true)),
        ("source", "a2".into()),
        ("tag", "x".into()),
    ])));
    assert_eq!(messages[1], expected);
}

// --- overflow bypass ----------------------------------------------------------------------------

#[tokio::test]
async fn message_level_strategy_fires_on_low_utilization_when_overflow_is_set() {
    let mut agent = agent(conversation(2));
    let strategy = drop_strategy(OffloadTarget::All).when(utilization("85%")).unwrap();
    assert!(apply_with(&strategy, &mut agent, 0.5, true).await);
    assert!(agent.messages().len() < 4);
}

#[tokio::test]
async fn message_level_strategy_skips_on_low_utilization_without_overflow() {
    let mut agent = agent(conversation(2));
    let strategy = drop_strategy(OffloadTarget::All).when(utilization("85%")).unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(agent.messages().len(), 4);
}

// --- message trimming helpers -------------------------------------------------------------------

fn tool_pair(tool_use_id: &str) -> [Message; 2] {
    [
        tool_use_message(tool_use_id, "read"),
        tool_result_message("x", tool_use_id),
    ]
}

#[test]
fn collects_a_tool_use_with_its_following_tool_result() {
    let [call, result] = tool_pair("tu-1");
    let messages = [user("task"), call, result, assistant("latest")];
    assert_eq!(collect_removable_with_pair(&messages, 1), [1, 2]);
}

#[test]
fn never_collects_the_last_message() {
    let messages = [user("task"), assistant("a1"), user("latest")];
    assert!(collect_removable_with_pair(&messages, 2).is_empty());
}

#[test]
fn skips_a_tool_use_whose_result_is_the_last_message() {
    let [call, result] = tool_pair("tu-1");
    let messages = [user("task"), call, result];
    assert!(collect_removable_with_pair(&messages, 1).is_empty());
}

#[test]
fn insert_marker_inserts_an_assistant_message_between_user_messages() {
    let mut messages = vec![user("task"), user("u1")];
    insert_marker(&mut messages, 1, TextBlock::new("marker"));
    let roles: Vec<Role> = messages.iter().map(|message| message.role).collect();
    assert_eq!(roles, [Role::User, Role::Assistant, Role::User]);
    assert_eq!(messages[1].content, [ContentBlock::text("marker")]);
}

#[test]
fn insert_marker_appends_to_the_assistant_message_before_the_gap() {
    let mut custom = JsonObject::new();
    custom.insert("k".to_owned(), "v".into());
    let original = assistant("a1")
        .with_tracking_id("msg-1")
        .with_metadata(MessageMetadata::new().with_custom(custom.clone()));
    let mut messages = vec![user("task"), original, user("u1")];
    insert_marker(&mut messages, 2, TextBlock::new("marker"));
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[1].content,
        [ContentBlock::text("a1"), ContentBlock::text("marker")]
    );
    assert_eq!(messages[1].tracking_id(), "msg-1");
    assert_eq!(messages[1].metadata, Some(MessageMetadata::new().with_custom(custom)));
}

#[test]
fn insert_marker_appends_to_the_assistant_message_after_the_gap() {
    let mut messages = vec![user("task"), assistant("a1"), user("u1")];
    insert_marker(&mut messages, 1, TextBlock::new("marker"));
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[1].content,
        [ContentBlock::text("a1"), ContentBlock::text("marker")]
    );
}

#[test]
fn insert_marker_clamps_the_index_into_the_history_after_message_0() {
    for (index, expected) in [(0, ["task", "marker", "u1"]), (5, ["task", "u1", "marker"])] {
        let mut messages = vec![user("task"), user("u1")];
        insert_marker(&mut messages, index, TextBlock::new("marker"));
        let texts: Vec<&str> = messages
            .iter()
            .map(|message| message.content[0].as_text().unwrap())
            .collect();
        assert_eq!(texts, expected, "{index}");
    }
}

#[tokio::test]
async fn emergency_truncate_leaves_a_marker_on_the_assistant_message_after_the_cut() {
    let mut agent = agent(vec![
        user("pin"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
    ]);
    assert!(apply_with(&EmergencyTruncateStrategy::new(), &mut agent, 1.1, true).await);
    let shape: Vec<(Role, Vec<String>)> = agent
        .messages()
        .iter()
        .map(|message| (message.role, texts_of(std::slice::from_ref(message)).remove(0)))
        .collect();
    assert_eq!(
        shape,
        [
            (Role::User, vec!["pin".to_owned()]),
            (
                Role::Assistant,
                vec![
                    "a2".to_owned(),
                    "[... earlier messages elided, ~2 tokens ...]".to_owned()
                ]
            ),
            (Role::User, vec!["u3".to_owned()]),
        ]
    );
}

// Regression tests for https://github.com/strands-agents/harness-sdk/issues/4685
#[tokio::test]
async fn repeated_message_level_reduction_keeps_message_0_verbatim() {
    type Factory = fn() -> Arc<dyn ContextStrategy>;
    let factories: [(&str, Factory); 5] = [
        ("drop", || {
            Arc::new(
                drop_strategy(OffloadTarget::All)
                    .when(
                        OffloadConditions::builder()
                            .context_utilization("70%")
                            .preserve_recent(3)
                            .build(),
                    )
                    .unwrap(),
            )
        }),
        ("drop-all", || {
            Arc::new(drop_strategy(OffloadTarget::All).when(utilization("70%")).unwrap())
        }),
        ("truncate", || {
            Arc::new(
                truncate_with(OffloadTarget::All, 4.0)
                    .when(
                        OffloadConditions::builder()
                            .context_utilization("70%")
                            .preserve_recent(3)
                            .build(),
                    )
                    .unwrap(),
            )
        }),
        ("truncate-all", || {
            Arc::new(truncate_with(OffloadTarget::All, 4.0).when(utilization("70%")).unwrap())
        }),
        ("emergency", || Arc::new(EmergencyTruncateStrategy::new())),
    ];
    for (name, make) in factories {
        for text_only in [false, true] {
            let strategy = make();
            let task = || pinned(user("task"));
            let mut agent = agent(vec![task()]);
            for index in 0..30 {
                let added: Vec<Message> = if text_only {
                    vec![assistant(&format!("a{index}")), user(&format!("u{index}"))]
                } else {
                    let id = format!("tu-{index}");
                    vec![tool_use_message(&id, "read"), tool_result_message("x", &id)]
                };
                let last = added.last().unwrap().tracking_id().to_owned();
                agent.messages_mut().extend(added);
                apply_with(strategy.as_ref(), &mut agent, 1.1, true).await;
                assert_eq!(
                    agent.messages().last().unwrap().tracking_id(),
                    last,
                    "{name} {text_only}"
                );
            }
            assert_eq!(agent.messages()[0].content, task().content, "{name} {text_only}");
            assert_eq!(agent.messages()[0].metadata, task().metadata, "{name} {text_only}");
            assert!(agent.messages().len() < 10, "{name} {text_only}");
        }
    }
}

// --- condition resolution -----------------------------------------------------------------------

#[tokio::test]
async fn conditions_fire_at_the_configured_utilization() {
    let cases: [(OffloadConditions, Option<u64>, f64, bool); 4] = [
        (utilization("70%"), None, 0.7, true),
        (utilization("70%"), None, 0.69, false),
        (
            OffloadConditions::builder().context_utilization(50_000).build(),
            Some(100_000),
            0.5,
            true,
        ),
        (
            OffloadConditions::builder().context_utilization(50_000).build(),
            Some(100_000),
            0.49,
            false,
        ),
    ];
    for (conditions, window, level, fires) in cases {
        let strategy = drop_strategy(OffloadTarget::ToolResults)
            .when(conditions.clone())
            .unwrap();
        let mut agent = agent_in_window(tool_history(&[10]), window);
        assert_eq!(
            apply(&strategy, &mut agent, level).await,
            fires,
            "{conditions:?} {level}"
        );
    }
}

#[test]
fn rejects_a_utilization_token_count_larger_than_the_context_window_on_init() {
    let strategy = drop_strategy(OffloadTarget::All)
        .when(OffloadConditions::builder().context_utilization(100_001).build())
        .unwrap();
    let mut agent = agent_in_window(Vec::new(), Some(100_000));
    assert!(
        strategy
            .init(&mut agent, None)
            .unwrap_err()
            .to_string()
            .contains("contextUtilization (100001) is larger than the model's context window (100000 tokens)")
    );
}

#[test]
fn warns_and_skips_the_window_check_on_init_when_the_model_has_no_context_window() {
    let (logs, _guard) = record_logs();
    let strategy = drop_strategy(OffloadTarget::All)
        .when(OffloadConditions::builder().context_utilization(500_000).build())
        .unwrap();
    let mut agent = agent(Vec::new());
    strategy.init(&mut agent, None).unwrap();
    assert!(
        logs.text()
            .contains("contextUtilization=<500000> | contextWindowLimit is not set")
    );
}

#[test]
fn inits_with_a_window_and_utilization() {
    let cases: [(Option<u64>, ConditionValue); 3] = [
        (Some(100_000), 100_000.into()),
        (Some(100_000), "100%".into()),
        (None, "80%".into()),
    ];
    for (window, value) in cases {
        let strategy = drop_strategy(OffloadTarget::All)
            .when(OffloadConditions {
                context_utilization: Some(value),
                ..OffloadConditions::default()
            })
            .unwrap();
        let mut agent = agent_in_window(Vec::new(), window);
        strategy.init(&mut agent, None).unwrap();
    }
}

#[tokio::test]
async fn resolves_a_percent_threshold_against_the_context_window() {
    let mut agent = agent_in_window(tool_history(&[100, 101]), Some(10_000));
    let strategy = drop_strategy(OffloadTarget::ToolResults).when(threshold("1%")).unwrap();
    assert!(apply(&strategy, &mut agent, 0.0).await);
    assert_eq!(
        result_texts(agent.messages()),
        ["x".repeat(400), "[Dropped: ~101 tokens]".to_owned()]
    );
}

// --- tool results that already hold a placeholder -----------------------------------------------

#[tokio::test]
async fn leaves_tool_results_alone_on_a_second_pass() {
    for method in METHODS {
        let model = Arc::new(test_model(None));
        let mut messages = tool_history(&[1000, 1000]);
        messages.push(user("next"));
        let mut agent = agent_on(&model, messages);
        let strategy = method.when(OffloadTarget::ToolResults, utilization("50%")).unwrap();
        assert!(apply(strategy.as_ref(), &mut agent, 0.9).await, "{method:?}");
        let offloaded = result_texts(agent.messages());
        let calls = model.summarize_calls().len();
        assert!(!apply(strategy.as_ref(), &mut agent, 0.9).await, "{method:?}");
        assert_eq!(
            result_methods(agent.messages()),
            [Some(method.offload()), Some(method.offload())]
        );
        assert_eq!(result_texts(agent.messages()), offloaded);
        assert_eq!(model.summarize_calls().len(), calls);
    }
}

#[tokio::test]
async fn leaves_a_dropped_result_alone() {
    for method in [Method::Truncate, Method::Summarize] {
        let model = Arc::new(test_model(None));
        let mut messages = tool_history(&[1000, 1000]);
        messages.push(user("next"));
        let mut agent = agent_on(&model, messages);
        let dropper = drop_strategy(OffloadTarget::ToolResults)
            .when(utilization("50%"))
            .unwrap();
        apply(&dropper, &mut agent, 0.9).await;
        let strategy = method.when(OffloadTarget::ToolResults, utilization("50%")).unwrap();
        assert!(!apply(strategy.as_ref(), &mut agent, 0.9).await, "{method:?}");
        assert_eq!(
            result_methods(agent.messages()),
            [Some(OffloadMethod::Drop), Some(OffloadMethod::Drop)]
        );
        assert!(model.summarize_calls().is_empty());
    }
}

#[tokio::test]
async fn drop_replaces_a_tool_result_holding_a_truncate_placeholder() {
    let placeholder = offload_placeholder(OffloadMethod::Truncate, &large(), None, 0);
    let message = Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tool-123",
            vec![ToolResultContent::Text(placeholder)],
        ))],
    );
    let mut agent = agent(vec![message]);
    assert!(apply(&drop_strategy(OffloadTarget::ToolResults), &mut agent, 0.5).await);
    assert_eq!(result_methods(agent.messages()), [Some(OffloadMethod::Drop)]);
}

#[tokio::test]
async fn leaves_a_text_block_that_is_a_placeholder_alone() {
    let strategies: [Arc<dyn ContextStrategy>; 2] = [
        Arc::new(
            drop_strategy(OffloadTarget::AssistantText)
                .when(threshold(100))
                .unwrap(),
        ),
        Arc::new(
            truncate_with(OffloadTarget::AssistantText, 50.0)
                .when(threshold(100))
                .unwrap(),
        ),
    ];
    for strategy in strategies {
        let placeholder = offload_placeholder(OffloadMethod::Summarize, &large(), None, 0);
        let messages = vec![
            user("q"),
            Message::new(Role::Assistant, vec![ContentBlock::Text(placeholder)]),
            user("next"),
        ];
        let mut agent = agent(messages.clone());
        assert!(!apply(strategy.as_ref(), &mut agent, 0.5).await);
        assert_eq!(agent.messages(), messages.as_slice());
    }
}

// --- granularity --------------------------------------------------------------------------------

const BIG_LEN: usize = 4000;

fn big() -> String {
    "x".repeat(BIG_LEN)
}

fn granularity_history() -> Vec<Message> {
    vec![
        user("task"),
        assistant(&big()),
        user(&big()),
        assistant(&big()),
        user(&big()),
        assistant("end"),
        user("next"),
    ]
}

#[derive(Debug)]
enum Outcome {
    Messages,
    LargeMessages,
    Blocks(&'static [usize]),
    Nothing,
}

#[tokio::test]
async fn acts_at_the_granularity_its_target_and_conditions_set() {
    let cases = || -> Vec<(OffloadTarget, OffloadConditions, f64, Outcome)> {
        vec![
            (OffloadTarget::All, utilization("50%"), 0.9, Outcome::Messages),
            (OffloadTarget::All, preserve(1), 0.0, Outcome::Messages),
            (
                OffloadTarget::All,
                OffloadConditions::builder()
                    .block_threshold(200)
                    .context_utilization("50%")
                    .build(),
                0.9,
                Outcome::LargeMessages,
            ),
            (
                OffloadTarget::AssistantText,
                utilization("50%"),
                0.9,
                Outcome::Blocks(&[1, 3]),
            ),
            (OffloadTarget::AssistantText, utilization("50%"), 0.1, Outcome::Nothing),
        ]
    };
    for method in METHODS {
        for (target, conditions, level, outcome) in cases() {
            if method == Method::Truncate && matches!(outcome, Outcome::LargeMessages) {
                continue;
            }
            let label = format!("{method:?} {target:?} {conditions:?} {level}");
            let mut agent = agent(granularity_history());
            let strategy = method.when(target, conditions).unwrap();
            let acted = apply(strategy.as_ref(), &mut agent, level).await;
            let messages = agent.messages();
            match outcome {
                Outcome::Nothing => {
                    assert!(!acted, "{label}");
                    assert_eq!(texts_of(messages), texts_of(&granularity_history()), "{label}");
                }
                Outcome::Messages | Outcome::LargeMessages => {
                    assert!(acted, "{label}");
                    assert!(messages.len() < granularity_history().len(), "{label}");
                    assert!(
                        placeholders_in(messages)
                            .iter()
                            .any(|placeholder| placeholder.method == method.offload()),
                        "{label}"
                    );
                    if matches!(outcome, Outcome::LargeMessages) {
                        assert!(all_text(messages).contains(&"end".to_owned()), "{label}");
                    }
                }
                Outcome::Blocks(indices) => {
                    assert!(acted, "{label}");
                    assert_eq!(messages.len(), granularity_history().len(), "{label}");
                    for index in [1, 2, 3, 4] {
                        let block = &messages[index].content[0];
                        if indices.contains(&index) {
                            assert_eq!(offloaded_by(block), Some(method.offload()), "{label} {index}");
                        } else {
                            assert_eq!(block.as_text(), Some(big().as_str()), "{label} {index}");
                        }
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn leaves_the_newest_message_alone_when_gated_by_utilization() {
    for method in METHODS {
        let mut messages = granularity_history();
        messages.pop();
        messages.push(user(&big()));
        let mut agent = agent(messages);
        let strategy = method.when(OffloadTarget::UserText, utilization("50%")).unwrap();
        assert!(apply(strategy.as_ref(), &mut agent, 0.9).await, "{method:?}");
        assert_eq!(offloaded_by(&agent.messages()[2].content[0]), Some(method.offload()));
        assert_eq!(
            agent.messages().last().unwrap().content[0].as_text(),
            Some(big().as_str())
        );
    }
}

#[tokio::test]
async fn leaves_the_first_message_alone_when_gated_by_utilization() {
    for method in METHODS {
        let mut messages = granularity_history();
        messages[0] = user(&big());
        let mut agent = agent(messages);
        let strategy = method.when(OffloadTarget::UserText, utilization("50%")).unwrap();
        assert!(apply(strategy.as_ref(), &mut agent, 0.9).await, "{method:?}");
        assert_eq!(agent.messages()[0].content[0].as_text(), Some(big().as_str()));
        assert_eq!(offloaded_by(&agent.messages()[2].content[0]), Some(method.offload()));
    }
}

// --- unconditioned strategy warning -------------------------------------------------------------

#[test]
fn warns_once_per_process_for_an_unconditioned_strategy_that_acts_on_arrival() {
    let warning = "strategy=<offload:drop>, target=<\"assistantText\"> | strategy has no conditions, so it acts on every matching block as it arrives, before the model reads it | use .when() to set blockThreshold, contextUtilization, or preserveRecent";
    crate::logging::forget_warning(warning);
    let (logs, _guard) = record_logs();
    drop_strategy(OffloadTarget::AssistantText)
        .init(&mut agent(Vec::new()), None)
        .unwrap();
    drop_strategy(OffloadTarget::AssistantText)
        .init(&mut agent(Vec::new()), None)
        .unwrap();
    assert_eq!(logs.text().matches(warning).count(), 1);
}

#[test]
fn does_not_warn_for_a_strategy_with_conditions() {
    for conditions in [threshold(1), utilization("50%"), preserve(1)] {
        let (logs, _guard) = record_logs();
        drop_strategy(OffloadTarget::AssistantText)
            .when(conditions)
            .unwrap()
            .init(&mut agent(Vec::new()), None)
            .unwrap();
        assert!(!logs.text().contains("strategy has no conditions"));
    }
}

// --- whole-message and media conditions ---------------------------------------------------------

#[test]
fn whole_message_strategies_reject_conditions_that_act_on_every_message() {
    for method in METHODS {
        for conditions in [none(), preserve(0), preserve("0%")] {
            let error = expect_error(method.when(OffloadTarget::All, conditions));
            assert!(error.contains(&format!(
                "Offload.{}(\"*\") would act on every message; use .when() to set contextUtilization, blockThreshold, or a preserveRecent above 0",
                method.name()
            )));
        }
        let mut accepted = vec![utilization("50%"), preserve(1)];
        if method != Method::Truncate {
            accepted.push(threshold(2500));
        }
        for conditions in accepted {
            method.when(OffloadTarget::All, conditions).unwrap();
        }
    }
}

#[test]
fn media_strategies_reject_conditions_that_remove_media_unseen() {
    for method in METHODS {
        for conditions in [
            none(),
            threshold(100),
            preserve("0%"),
            OffloadConditions::builder()
                .block_threshold(100)
                .preserve_recent(0)
                .build(),
        ] {
            let error = expect_error(method.when(OffloadTarget::Media, conditions));
            assert!(error.contains(&format!(
                "Offload.{}(\"media\") would remove media before the model sees it; use .when() to set contextUtilization or a preserveRecent above 0",
                method.name()
            )));
        }
        for conditions in [utilization("80%"), preserve(1)] {
            method.when(OffloadTarget::Media, conditions).unwrap();
        }
    }
}

// --- tool list targets --------------------------------------------------------------------------

#[test]
fn subtracts_excluded_tools_from_included_ones_in_a_mixed_list() {
    let matcher = super::super::target::OffloadTargetMatcher::new(OffloadTarget::tools([
        "tool::bash",
        "python",
        "!tool::python",
        "!grep",
    ]))
    .unwrap();
    let tool_names: HashMap<String, String> = [("tu-bash", "bash"), ("tu-python", "python")]
        .into_iter()
        .map(|(id, name)| (id.to_owned(), name.to_owned()))
        .collect();
    let result_of = |id: &str| {
        ContentBlock::ToolResult(ToolResultBlock::new(
            id,
            ToolResultStatus::Success,
            vec![ToolResultContent::text("x")],
        ))
    };
    let message = Message::new(Role::User, Vec::new());
    assert!(matcher.matches_block(&result_of("tu-bash"), &message, &tool_names));
    assert!(!matcher.matches_block(&result_of("tu-python"), &message, &tool_names));
}

#[test]
fn rejects_a_list_that_excludes_every_tool_it_includes() {
    let error = Offload::drop(OffloadTarget::tools(["tool::bash", "!bash"])).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Tool target [\"tool::bash\",\"!bash\"] excludes every tool it includes, so it matches nothing")
    );
}

#[tokio::test]
async fn truncate_leaves_blocks_within_the_preview_alone_and_skips_blocks_it_already_truncated() {
    let mut agent = agent(tool_history(&[100, 2000]));
    let strategy = truncate_with(OffloadTarget::ToolResults, 100.0).when(none()).unwrap();
    assert!(apply(&strategy, &mut agent, 0.0).await);
    let first_pass = result_texts(agent.messages());
    assert_eq!(first_pass[0], "x".repeat(400));
    assert_eq!(result_methods(agent.messages()), [None, Some(OffloadMethod::Truncate)]);
    assert!(first_pass[1].len().div_ceil(4) > 100);
    assert!(!apply(&strategy, &mut agent, 0.0).await);
    assert_eq!(result_texts(agent.messages()), first_pass);
}

// --- truncate whole messages --------------------------------------------------------------------

/// Ten tokens per message under the heuristic.
fn pad(label: &str) -> String {
    format!("{label:.<40}")
}

fn padded_history() -> Vec<Message> {
    let mut messages = vec![user("task")];
    for index in 1..=10 {
        let role = if index % 2 == 1 { Role::Assistant } else { Role::User };
        messages.push(text(role, &pad(&format!("m{index}"))));
    }
    messages
}

fn labeled(expected: &[&str]) -> Vec<Vec<String>> {
    expected
        .iter()
        .map(|value| {
            let label = if value.starts_with('m') {
                pad(value)
            } else {
                (*value).to_owned()
            };
            vec![label]
        })
        .collect()
}

#[tokio::test]
async fn truncate_all_elides_the_middle() {
    let cases: [(PreviewMode, f64, &[&str]); 3] = [
        (
            PreviewMode::HeadTail,
            40.0,
            &[
                "task",
                "m1",
                "m2",
                "[... earlier messages elided, ~70 tokens ...]",
                "m10",
            ],
        ),
        (
            PreviewMode::Head,
            40.0,
            &[
                "task",
                "m1",
                "m2",
                "m3",
                "m4",
                "[... earlier messages elided, ~50 tokens ...]",
                "m10",
            ],
        ),
        (
            PreviewMode::Tail,
            50.0,
            &[
                "task",
                "[... earlier messages elided, ~50 tokens ...]",
                "m6",
                "m7",
                "m8",
                "m9",
                "m10",
            ],
        ),
    ];
    for (preview, preview_tokens, expected) in cases {
        let mut agent = agent(padded_history());
        let strategy = Offload::truncate(
            OffloadTarget::All,
            TruncateConfig {
                preview_tokens: Some(preview_tokens),
                preview: Some(preview),
            },
        )
        .unwrap()
        .when(utilization("50%"))
        .unwrap();
        assert!(apply(&strategy, &mut agent, 0.9).await, "{preview:?}");
        assert_eq!(texts_of(agent.messages()), labeled(expected), "{preview:?}");
    }
}

fn truncate_all(preview_tokens: f64) -> TruncateStrategy {
    truncate_with(OffloadTarget::All, preview_tokens)
        .when(utilization("50%"))
        .unwrap()
}

#[tokio::test]
async fn elides_another_strategys_marker_for_removed_messages() {
    let mut messages = padded_history();
    messages[3] = Message::new(
        Role::Assistant,
        vec![ContentBlock::Text(offload_placeholder(
            OffloadMethod::Summarize,
            &pad("summary"),
            None,
            0,
        ))],
    );
    let mut agent = agent(messages);
    assert!(apply(&truncate_all(40.0), &mut agent, 0.9).await);
    assert_eq!(
        texts_of(agent.messages()),
        labeled(&[
            "task",
            "m1",
            "m2",
            "[... earlier messages elided, ~70 tokens ...]",
            "m10"
        ])
    );
}

#[tokio::test]
async fn elides_a_message_that_holds_content_alongside_its_own_earlier_marker() {
    let mut messages = padded_history();
    messages[3] = Message::new(
        Role::Assistant,
        vec![
            ContentBlock::text(pad("m3")),
            ContentBlock::Text(offload_placeholder(
                OffloadMethod::Truncate,
                &format_elided(20),
                None,
                0,
            )),
        ],
    );
    let mut agent = agent(messages);
    assert!(apply(&truncate_all(40.0), &mut agent, 0.9).await);
    assert_eq!(
        texts_of(agent.messages()),
        labeled(&[
            "task",
            "m1",
            "m2",
            "[... earlier messages elided, ~82 tokens ...]",
            "m10"
        ])
    );
}

#[tokio::test]
async fn adds_back_the_tokens_an_elided_marker_already_stood_for() {
    let mut messages = padded_history();
    messages[3] = Message::new(
        Role::Assistant,
        vec![
            ContentBlock::text(pad("m3")),
            ContentBlock::Text(offload_placeholder(
                OffloadMethod::Truncate,
                &format_elided(1000),
                None,
                1000,
            )),
        ],
    );
    let mut agent = agent(messages);
    let elided = agent
        .model()
        .count_tokens(&agent.messages()[3..10], crate::models::CountTokensOptions::default())
        .await
        .unwrap();
    assert!(apply(&truncate_all(40.0), &mut agent, 0.9).await);
    // A marker's text is a few tokens, so without the size it recorded the new marker would
    // under-report the history.
    assert_eq!(
        texts_of(agent.messages()),
        [
            vec!["task".to_owned()],
            vec![pad("m1")],
            vec![pad("m2")],
            vec![format_elided(elided + 1000)],
            vec![pad("m10")],
        ]
    );
}

#[tokio::test]
async fn adds_back_the_tokens_a_truncated_tool_result_already_stood_for() {
    let mut agent = agent(vec![
        user("task"),
        assistant(&pad("m1")),
        tool_result_message(&"x".repeat(8000), "tool-123"),
        assistant(&pad("m3")),
        user("next"),
    ]);
    let model = agent.model().clone();
    let count = |messages: &[Message]| {
        let model = model.clone();
        let messages = messages.to_vec();
        async move {
            model
                .count_tokens(&messages, crate::models::CountTokensOptions::default())
                .await
                .unwrap()
        }
    };
    let original = count(&agent.messages()[2..3]).await;
    assert!(apply(&truncate_with(OffloadTarget::ToolResults, 10.0), &mut agent, 0.9).await);
    assert_eq!(
        placeholders_in(agent.messages()),
        [provenance(OffloadMethod::Truncate, Some(original))]
    );
    let left = count(&agent.messages()[1..4]).await;
    let dropper = drop_strategy(OffloadTarget::All).when(utilization("50%")).unwrap();
    assert!(apply(&dropper, &mut agent, 0.9).await);
    // A block placeholder sits inside the tool result, so the marker reports the result's whole
    // size, not its preview.
    assert_eq!(
        placeholders_in(agent.messages()),
        [provenance(OffloadMethod::Drop, Some(left + original))]
    );
    assert_eq!(
        texts_of(agent.messages()),
        [
            vec!["task".to_owned()],
            vec![format_dropped_messages(left + original)],
            vec!["next".to_owned()],
        ]
    );
}

#[tokio::test]
async fn stops_once_only_its_own_marker_is_left_to_elide() {
    let mut agent = agent(padded_history());
    let strategy = Offload::truncate(
        OffloadTarget::All,
        TruncateConfig {
            preview_tokens: Some(40.0),
            preview: Some(PreviewMode::Head),
        },
    )
    .unwrap()
    .when(utilization("50%"))
    .unwrap();
    assert!(apply(&strategy, &mut agent, 0.9).await);
    let after_first = texts_of(agent.messages());
    assert!(!apply(&strategy, &mut agent, 0.9).await);
    assert_eq!(texts_of(agent.messages()), after_first);
}

// --- eager arrival and the retrieval tool -------------------------------------------------------

#[tokio::test]
async fn offloads_eagerly_as_messages_arrive() {
    let strategy = truncate(OffloadTarget::ToolResults).when(threshold(1500)).unwrap();
    let mut agent = agent(Vec::new());
    strategy.init(&mut agent, None).unwrap();
    let message = tool_result_message(&large(), "tool-1");
    agent.messages_mut().push(message.clone());
    let hooks = agent.hooks().clone();
    let mut event = MessageAddedEvent::new(&mut agent, InvocationState::new(), message);
    hooks.invoke(&mut event).await.unwrap();
    drop(event);
    assert_eq!(
        content_offloaded_by(&tool_result(&agent.messages()[0], 0).content[0]),
        Some(OffloadMethod::Truncate)
    );
}

/// An agent whose model counts every message list as `tokens` and reads utilization against a
/// 100,000-token window.
fn proactive_agent(messages: Vec<Message>, tokens: u64) -> LocalAgent {
    let model = TestModel::new()
        .with_count(move |_| tokens)
        .with_utilization(|tokens| tokens as f64 / 100_000.0);
    agent_with(Arc::new(model), messages)
}

fn five_messages() -> Vec<Message> {
    vec![user("pin"), assistant("a1"), user("u2"), assistant("a2"), user("u3")]
}

#[tokio::test]
async fn emergency_truncate_truncates_when_the_messages_alone_fill_the_window() {
    // The messages are what this strategy removes, so they are what it measures.
    let mut agent = proactive_agent(five_messages(), 110_000);
    assert!(apply(&EmergencyTruncateStrategy::new(), &mut agent, 0.2).await);
    assert!(agent.messages().len() < 5);
}

#[tokio::test]
async fn emergency_truncate_skips_when_the_messages_fit_and_the_request_does_not() {
    // The pipeline's utilization carries the system prompt and tool specs, which dropping messages
    // cannot shrink.
    let mut agent = proactive_agent(five_messages(), 1_000);
    assert!(!apply(&EmergencyTruncateStrategy::new(), &mut agent, 1.1).await);
    assert_eq!(agent.messages().len(), 5);
}

#[tokio::test]
async fn emergency_truncate_truncates_on_overflow_even_when_the_messages_fit() {
    // An overflow signal is the provider's verdict on a request it refused, so it outranks the
    // estimate.
    let mut agent = proactive_agent(five_messages(), 1_000);
    assert!(apply_with(&EmergencyTruncateStrategy::new(), &mut agent, 0.2, true).await);
    assert!(agent.messages().len() < 5);
}
