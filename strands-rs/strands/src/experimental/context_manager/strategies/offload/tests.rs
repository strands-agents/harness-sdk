use std::sync::Arc;

use super::*;
use crate::experimental::context_manager::methods::truncate::TruncateConfig;
use crate::experimental::context_manager::strategies::offload::{Offload, SummarizeConfig};
use crate::experimental::context_manager::test_support::{
    TestModel, agent_with, all_text, assistant, pinned, text, tool_result_message, tool_use_message, user,
};
use crate::storage::InMemoryStorage;
use crate::types::{ImageBlock, ImageFormat, ImageSource, InjectedBlock, ToolResultContent};

fn agent(messages: Vec<Message>) -> LocalAgent {
    agent_with(Arc::new(TestModel::new()), messages)
}

async fn apply(strategy: &dyn ContextStrategy, agent: &mut LocalAgent, utilization: f64) -> bool {
    apply_with(strategy, agent, utilization, false, None).await
}

async fn apply_with(
    strategy: &dyn ContextStrategy,
    agent: &mut LocalAgent,
    utilization: f64,
    overflow: bool,
    stash: Option<Stash>,
) -> bool {
    let mut context = ContextState::new(agent, utilization)
        .with_overflow(overflow)
        .with_stash(stash);
    strategy.apply(&mut context).await.unwrap()
}

fn large() -> String {
    "x".repeat(2500 * 4 + 100)
}

fn conditions(threshold: Option<f64>, utilization: Option<f64>, preserve_recent: Option<f64>) -> OffloadConditions {
    OffloadConditions {
        threshold,
        utilization,
        preserve_recent,
    }
}

fn truncate(target: OffloadTarget) -> crate::experimental::context_manager::TruncateStrategy {
    Offload::truncate(target, TruncateConfig::default()).unwrap()
}

fn drop_strategy(target: OffloadTarget) -> crate::experimental::context_manager::DropStrategy {
    Offload::drop(target).unwrap()
}

fn error_result(text: &str) -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::error(
            "tool-err",
            vec![ToolResultContent::text(text)],
        ))],
    )
}

fn result_text(message: &Message, index: usize) -> String {
    let ContentBlock::ToolResult(result) = &message.content[index] else {
        panic!("not a tool result");
    };
    let ToolResultContent::Text(text) = &result.content[0] else {
        panic!("not text");
    };
    text.text.clone()
}

fn block_text(message: &Message, index: usize) -> String {
    message.content[index].as_text().unwrap().to_owned()
}

fn eight_turns() -> Vec<Message> {
    vec![
        user("q1"),
        assistant("a1"),
        user("q2"),
        assistant("a2"),
        user("q3"),
        assistant("a3"),
        user("q4"),
        assistant("a4"),
    ]
}

fn assert_alternates(messages: &[Message]) {
    for pair in messages.windows(2) {
        assert_ne!(pair[0].role, pair[1].role);
    }
}

// --- Offload.truncate ---------------------------------------------------------------------------

#[test]
fn creates_a_strategy_with_correct_name() {
    assert_eq!(truncate(OffloadTarget::ToolResults).name(), "offload:truncate");
}

#[test]
fn creates_a_strategy_with_when_conditions() {
    let strategy = Offload::truncate(
        OffloadTarget::ToolResults,
        TruncateConfig {
            preview_tokens: Some(500.0),
            ..TruncateConfig::default()
        },
    )
    .unwrap()
    .when(conditions(Some(1000.0), None, None))
    .unwrap();
    assert_eq!(strategy.name(), "offload:truncate");
}

#[test]
fn rejects_a_threshold_that_does_not_exceed_the_preview() {
    let error = truncate(OffloadTarget::ToolResults)
        .when(conditions(Some(1000.0), None, None))
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "threshold (1000) must be greater than previewTokens (1000) to ensure truncation converges"
    );
}

#[tokio::test]
async fn truncates_large_tool_results() {
    let mut agent = agent(vec![tool_result_message(&large(), "tool-123")]);
    assert!(apply(&truncate(OffloadTarget::ToolResults), &mut agent, 0.5).await);
    assert!(result_text(&agent.messages()[0], 0).contains("[Truncated:"));
}

#[tokio::test]
async fn does_not_truncate_results_below_threshold() {
    let mut agent = agent(vec![tool_result_message("short result", "tool-123")]);
    let strategy = truncate(OffloadTarget::ToolResults)
        .when(conditions(Some(2500.0), None, None))
        .unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
}

#[tokio::test]
async fn skips_error_results_when_target_is_tool_results() {
    let mut agent = agent(vec![error_result(&large())]);
    assert!(!apply(&truncate(OffloadTarget::ToolResults), &mut agent, 0.5).await);
}

#[tokio::test]
async fn truncates_error_results_when_target_is_tool_result_errors() {
    let mut agent = agent(vec![error_result(&large())]);
    assert!(apply(&truncate(OffloadTarget::ToolResultErrors), &mut agent, 0.5).await);
}

#[tokio::test]
async fn skips_non_user_messages_when_targeting_tool_results() {
    let mut agent = agent(vec![assistant(&large())]);
    assert!(!apply(&truncate(OffloadTarget::ToolResults), &mut agent, 0.5).await);
}

#[tokio::test]
async fn truncates_assistant_text_blocks_with_assistant_text_target() {
    let mut agent = agent(vec![assistant(&large())]);
    assert!(apply(&truncate(OffloadTarget::AssistantText), &mut agent, 0.5).await);
    assert!(block_text(&agent.messages()[0], 0).contains("[Truncated:"));
}

#[tokio::test]
async fn truncates_user_text_blocks_with_user_text_target() {
    let mut agent = agent(vec![user(&large())]);
    assert!(apply(&truncate(OffloadTarget::UserText), &mut agent, 0.5).await);
    assert!(block_text(&agent.messages()[0], 0).contains("[Truncated:"));
}

#[tokio::test]
async fn does_not_truncate_user_messages_with_assistant_text_target() {
    let mut agent = agent(vec![user(&large())]);
    assert!(!apply(&truncate(OffloadTarget::AssistantText), &mut agent, 0.5).await);
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
    let strategy = Offload::truncate(
        OffloadTarget::ToolResults,
        TruncateConfig {
            preview_tokens: Some(100.0),
            ..TruncateConfig::default()
        },
    )
    .unwrap();
    apply(&strategy, &mut agent, 0.5).await;
    let preview = result_text(&agent.messages()[0], 0);
    assert!(preview.contains("[..."));
    assert!(preview.contains("chars elided"));
}

#[tokio::test]
async fn formats_preview_counts_the_same_regardless_of_the_host_locale() {
    let mut agent = agent(vec![tool_result_message(&"x".repeat(1_000_000), "tool-123")]);
    let strategy = Offload::truncate(
        OffloadTarget::ToolResults,
        TruncateConfig {
            preview_tokens: Some(100.0),
            ..TruncateConfig::default()
        },
    )
    .unwrap();
    apply(&strategy, &mut agent, 0.5).await;
    let preview = result_text(&agent.messages()[0], 0);
    assert!(preview.contains("~250,000 tokens]"));
    assert!(preview.contains("[... 999,600 chars elided ...]"));
}

#[tokio::test]
async fn returns_false_for_empty_messages() {
    let mut agent = agent(Vec::new());
    assert!(!apply(&truncate(OffloadTarget::ToolResults), &mut agent, 0.5).await);
}

// --- Offload builder ----------------------------------------------------------------------------

#[test]
fn offload_drop_creates_a_drop_strategy() {
    assert_eq!(drop_strategy(OffloadTarget::ToolResults).name(), "offload:drop");
}

#[tokio::test]
async fn offload_drop_drops_tool_result_content_from_context_window_entirely() {
    let mut agent = agent(vec![tool_result_message(&"x".repeat(100), "tool-123")]);
    assert!(apply(&drop_strategy(OffloadTarget::ToolResults), &mut agent, 0.5).await);
    assert_eq!(result_text(&agent.messages()[0], 0), "[Dropped]");
}

#[tokio::test]
async fn offload_drop_drops_assistant_text_blocks() {
    let mut agent = agent(vec![assistant("some assistant response")]);
    assert!(apply(&drop_strategy(OffloadTarget::AssistantText), &mut agent, 0.5).await);
    assert_eq!(block_text(&agent.messages()[0], 0), "[Dropped]");
}

#[tokio::test]
async fn offload_drop_drops_user_text_blocks() {
    let mut agent = agent(vec![user("some user message")]);
    assert!(apply(&drop_strategy(OffloadTarget::UserText), &mut agent, 0.5).await);
    assert_eq!(block_text(&agent.messages()[0], 0), "[Dropped]");
}

#[tokio::test]
async fn offload_truncate_with_string_target_matches_tool_by_name_from_assistant_message() {
    let mut agent = agent(vec![
        tool_use_message("tool-bash", "bash"),
        tool_result_message(&large(), "tool-bash"),
    ]);
    assert!(apply(&truncate(OffloadTarget::tools(["tool::bash"])), &mut agent, 0.5).await);
    assert!(result_text(&agent.messages()[1], 0).contains("[Truncated:"));
}

#[tokio::test]
async fn offload_truncate_with_string_target_skips_non_matching_tools() {
    let mut agent = agent(vec![
        tool_use_message("tool-read", "read_file"),
        tool_result_message(&large(), "tool-read"),
    ]);
    assert!(!apply(&truncate(OffloadTarget::tools(["tool::bash"])), &mut agent, 0.5).await);
}

#[tokio::test]
async fn excludes_named_tools_with_a_bang_prefix() {
    let mut agent = agent(vec![
        tool_use_message("tool-read", "read_file"),
        tool_result_message(&large(), "tool-read"),
        tool_use_message("tool-bash", "bash"),
        tool_result_message(&large(), "tool-bash"),
    ]);
    assert!(apply(&truncate(OffloadTarget::tools(["!tool::bash"])), &mut agent, 0.5).await);
    assert!(result_text(&agent.messages()[1], 0).contains("[Truncated:"));
    assert_eq!(result_text(&agent.messages()[3], 0), large());
}

#[test]
fn offload_summarize_creates_a_summarize_strategy() {
    let strategy = Offload::summarize(OffloadTarget::ToolResults, SummarizeConfig::default()).unwrap();
    assert_eq!(strategy.name(), "offload:summarize");
}

#[test]
fn offload_summarize_when_creates_a_strategy_with_conditions() {
    let strategy = Offload::summarize(OffloadTarget::ToolResults, SummarizeConfig::default())
        .unwrap()
        .when(conditions(None, Some(0.85), None));
    assert_eq!(strategy.name(), "offload:summarize");
}

#[test]
fn offload_summarize_config_only_creates_untargeted_strategy() {
    let config = SummarizeConfig {
        system_prompt: Some("summarize briefly".into()),
        ..SummarizeConfig::default()
    };
    let strategy = Offload::summarize(OffloadTarget::All, config)
        .unwrap()
        .when(conditions(None, Some(0.85), None));
    assert_eq!(strategy.name(), "offload:summarize");
}

#[test]
fn offload_truncate_config_only_creates_untargeted_strategy() {
    let strategy = Offload::truncate(
        OffloadTarget::All,
        TruncateConfig {
            preview_tokens: Some(200.0),
            ..TruncateConfig::default()
        },
    )
    .unwrap()
    .when(conditions(Some(1000.0), None, None))
    .unwrap();
    assert_eq!(strategy.name(), "offload:truncate");
}

#[test]
fn throws_on_empty_array_target() {
    let empty = || OffloadTarget::Tools(Vec::new());
    let expected = "Empty array target matches nothing — provide at least one target";
    assert_eq!(
        Offload::truncate(empty(), TruncateConfig::default())
            .unwrap_err()
            .to_string(),
        expected
    );
    assert_eq!(Offload::drop(empty()).unwrap_err().to_string(), expected);
    assert_eq!(
        Offload::summarize(empty(), SummarizeConfig::default())
            .unwrap_err()
            .to_string(),
        expected
    );
}

// --- message-level with role alternation --------------------------------------------------------

fn message_level_drop(target: OffloadTarget) -> crate::experimental::context_manager::DropStrategy {
    drop_strategy(target).when(conditions(None, Some(0.5), None))
}

#[tokio::test]
async fn drop_assistant_text_repairs_alternation_after_removing_assistant_messages() {
    let mut agent = agent(eight_turns());
    apply(&message_level_drop(OffloadTarget::AssistantText), &mut agent, 0.9).await;
    assert_alternates(agent.messages());
}

#[tokio::test]
async fn drop_user_text_repairs_alternation_after_removing_user_messages() {
    let mut agent = agent(eight_turns());
    apply(&message_level_drop(OffloadTarget::UserText), &mut agent, 0.9).await;
    assert_alternates(agent.messages());
}

#[tokio::test]
async fn drop_all_message_level_repairs_alternation() {
    let mut agent = agent(eight_turns());
    apply(&message_level_drop(OffloadTarget::All), &mut agent, 0.9).await;
    assert_alternates(agent.messages());
}

#[tokio::test]
async fn drop_assistant_text_message_level_with_tool_pairs_preserves_tool_pair_integrity() {
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
    apply(&message_level_drop(OffloadTarget::AssistantText), &mut agent, 0.9).await;
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
async fn drop_user_text_is_not_a_no_op_when_messages_0_is_the_only_front_candidate() {
    let mut agent = agent(vec![user("q1"), assistant("a1"), user("q2"), assistant("a2")]);
    assert!(apply(&message_level_drop(OffloadTarget::UserText), &mut agent, 0.9).await);
    assert!(agent.messages().len() <= 4);
}

#[tokio::test]
async fn message_level_starts_with_user_message_after_operation() {
    let mut agent = agent(eight_turns()[..6].to_vec());
    apply(&message_level_drop(OffloadTarget::AssistantText), &mut agent, 0.9).await;
    assert_eq!(agent.messages()[0].role, Role::User);
}

// --- `*` target ---------------------------------------------------------------------------------

#[tokio::test]
async fn offload_drop_all_drops_all_content() {
    let user_message = Message::new(
        Role::User,
        vec![
            ContentBlock::text("user text"),
            ContentBlock::ToolResult(ToolResultBlock::success(
                "tool-1",
                vec![ToolResultContent::text("tool output")],
            )),
        ],
    );
    let mut agent = agent(vec![assistant("assistant text"), user_message]);
    assert!(apply(&drop_strategy(OffloadTarget::All), &mut agent, 0.5).await);
    assert_eq!(block_text(&agent.messages()[0], 0), "[Dropped]");
    assert_eq!(block_text(&agent.messages()[1], 0), "[Dropped]");
    assert_eq!(result_text(&agent.messages()[1], 1), "[Dropped]");
}

#[tokio::test]
async fn offload_truncate_all_truncates_all_large_content() {
    let user_message = Message::new(
        Role::User,
        vec![
            ContentBlock::text(large()),
            ContentBlock::ToolResult(ToolResultBlock::success(
                "tool-1",
                vec![ToolResultContent::text(large())],
            )),
        ],
    );
    let mut agent = agent(vec![assistant(&large()), user_message]);
    assert!(apply(&truncate(OffloadTarget::All), &mut agent, 0.5).await);
    assert!(block_text(&agent.messages()[0], 0).contains("[Truncated:"));
    assert!(block_text(&agent.messages()[1], 0).contains("[Truncated:"));
    assert!(result_text(&agent.messages()[1], 1).contains("[Truncated:"));
}

#[tokio::test]
async fn offload_truncate_all_with_threshold_skips_small_content() {
    let mut agent = agent(vec![assistant("short")]);
    let strategy = truncate(OffloadTarget::All)
        .when(conditions(Some(2500.0), None, None))
        .unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
}

#[tokio::test]
async fn leaves_injected_text_in_place() {
    let injected = ContentBlock::Injected(InjectedBlock::new("x".repeat(2500 * 4 + 100), "strands:memory-manager"));
    let mut agent = agent(vec![Message::new(
        Role::User,
        vec![ContentBlock::text("ask"), injected.clone()],
    )]);
    let strategy = Offload::truncate(
        OffloadTarget::All,
        TruncateConfig {
            preview_tokens: Some(50.0),
            ..TruncateConfig::default()
        },
    )
    .unwrap()
    .when(conditions(Some(100.0), None, None))
    .unwrap();
    assert!(!apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(agent.messages()[0].content, [ContentBlock::text("ask"), injected]);
}

// --- markers ------------------------------------------------------------------------------------

#[tokio::test]
async fn drop_leaves_dropped_n_messages_marker() {
    let mut agent = agent(eight_turns());
    apply(&message_level_drop(OffloadTarget::All), &mut agent, 0.9).await;
    let pattern = regex::Regex::new(r"\[Dropped: \d+ messages?\]").unwrap();
    assert!(all_text(agent.messages()).iter().any(|text| pattern.is_match(text)));
}

#[tokio::test]
async fn truncate_leaves_n_messages_elided_marker() {
    let mut agent = agent(eight_turns());
    let strategy = truncate(OffloadTarget::All)
        .when(conditions(None, Some(0.5), None))
        .unwrap();
    apply(&strategy, &mut agent, 0.9).await;
    let pattern = regex::Regex::new(r"\[\.\.\. \d+ messages? elided \.\.\.\]").unwrap();
    assert!(all_text(agent.messages()).iter().any(|text| pattern.is_match(text)));
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
    apply(&message_level_drop(OffloadTarget::All), &mut agent, 0.9).await;
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
    apply(&message_level_drop(OffloadTarget::All), &mut agent, 0.9).await;
    assert!(agent.messages().iter().any(|message| {
        message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolResult(result) if result.tool_use_id == "tu-1"))
    }));
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
    let strategy = drop_strategy(OffloadTarget::All).when(conditions(None, Some(0.5), Some(4.0)));
    apply(&strategy, &mut agent, 0.9).await;
    apply(&strategy, &mut agent, 0.9).await;
    let merged = agent
        .messages()
        .iter()
        .find(|message| message.content.iter().any(|block| block.as_text() == Some("pinned-a3")))
        .unwrap();
    assert_eq!(
        merged
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.custom.as_ref())
            .and_then(|custom| custom.get("pinned")),
        Some(&JsonValue::Bool(true))
    );
}

// --- overflow bypass ----------------------------------------------------------------------------

#[tokio::test]
async fn message_level_strategy_fires_on_low_utilization_when_overflow_is_set() {
    let mut agent = agent(eight_turns()[..4].to_vec());
    let strategy = drop_strategy(OffloadTarget::All).when(conditions(None, Some(0.85), None));
    assert!(apply_with(&strategy, &mut agent, 0.5, true, None).await);
    assert!(agent.messages().len() < 4);
}

#[tokio::test]
async fn message_level_strategy_skips_on_low_utilization_without_overflow() {
    let mut agent = agent(eight_turns()[..4].to_vec());
    let strategy = drop_strategy(OffloadTarget::All).when(conditions(None, Some(0.85), None));
    assert!(!apply(&strategy, &mut agent, 0.5).await);
    assert_eq!(agent.messages().len(), 4);
}

// --- getOldestMatches ---------------------------------------------------------------------------

fn alternating(count: usize) -> Vec<Message> {
    (0..count)
        .map(|index| {
            text(
                if index % 2 == 0 { Role::User } else { Role::Assistant },
                &format!("msg-{index}"),
            )
        })
        .collect()
}

fn oldest(count: usize, preserve_recent: f64) -> usize {
    let messages = alternating(count);
    let tool_names = build_tool_name_map(&messages);
    get_oldest_matches(
        &messages,
        &OffloadTarget::All,
        preserve_recent,
        &tool_names,
        &ToolFilter::default(),
    )
    .len()
}

#[test]
fn integer_preserve_recent_keeps_absolute_count() {
    assert_eq!(oldest(10, 3.0), 7);
}

#[test]
fn decimal_preserve_recent_keeps_ratio_of_matches() {
    assert_eq!(oldest(10, 0.7), 3);
}

#[test]
fn decimal_preserve_recent_rounds_up() {
    assert_eq!(oldest(3, 0.5), 1);
}

#[test]
fn decimal_preserve_recent_of_0_99_preserves_almost_all() {
    assert_eq!(oldest(10, 0.99), 0);
}

// --- collectRemovableWithPair -------------------------------------------------------------------

#[test]
fn collects_a_tool_use_with_its_following_tool_result() {
    let messages = vec![
        user("task"),
        tool_use_message("tu-1", "read"),
        tool_result_message("x", "tu-1"),
        assistant("latest"),
    ];
    assert_eq!(collect_removable_with_pair(&messages, 1), [1, 2]);
}

#[test]
fn never_collects_the_last_message() {
    let messages = vec![user("task"), assistant("a1"), user("latest")];
    assert!(collect_removable_with_pair(&messages, 2).is_empty());
}

#[test]
fn skips_a_tool_use_whose_result_is_the_last_message() {
    let messages = vec![
        user("task"),
        tool_use_message("tu-1", "read"),
        tool_result_message("x", "tu-1"),
    ];
    assert!(collect_removable_with_pair(&messages, 1).is_empty());
}

// --- insertMarker -------------------------------------------------------------------------------

#[test]
fn inserts_an_assistant_message_between_user_messages() {
    let mut messages = vec![user("task"), user("u1")];
    insert_marker(&mut messages, 1, "marker");
    let roles: Vec<Role> = messages.iter().map(|message| message.role).collect();
    assert_eq!(roles, [Role::User, Role::Assistant, Role::User]);
    assert_eq!(messages[1].content, [ContentBlock::text("marker")]);
}

#[test]
fn appends_to_the_assistant_message_before_the_gap() {
    let mut custom = JsonObject::new();
    custom.insert("k".to_owned(), JsonValue::from("v"));
    let original = assistant("a1")
        .with_tracking_id("msg-1")
        .with_metadata(MessageMetadata::new().with_custom(custom.clone()));
    let mut messages = vec![user("task"), original, user("u1")];
    insert_marker(&mut messages, 2, "marker");
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[1].content,
        [ContentBlock::text("a1"), ContentBlock::text("marker")]
    );
    assert_eq!(messages[1].tracking_id(), "msg-1");
    assert_eq!(messages[1].metadata, Some(MessageMetadata::new().with_custom(custom)));
}

#[test]
fn appends_to_the_assistant_message_after_the_gap() {
    let mut messages = vec![user("task"), assistant("a1"), user("u1")];
    insert_marker(&mut messages, 1, "marker");
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[1].content,
        [ContentBlock::text("a1"), ContentBlock::text("marker")]
    );
}

#[test]
fn clamps_index_into_the_history_after_message_0() {
    for (index, expected) in [(0, ["task", "marker", "u1"]), (5, ["task", "u1", "marker"])] {
        let mut messages = vec![user("task"), user("u1")];
        insert_marker(&mut messages, index, "marker");
        assert_eq!(all_text(&messages), expected);
    }
}

// --- EmergencyTruncateStrategy ------------------------------------------------------------------

#[tokio::test]
async fn leaves_a_marker_on_the_assistant_message_after_the_cut() {
    let mut agent = agent(vec![
        user("pin"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
        user("u3"),
    ]);
    assert!(apply_with(&EmergencyTruncateStrategy::new(), &mut agent, 1.1, true, None).await);
    let shape: Vec<(Role, Vec<String>)> = agent
        .messages()
        .iter()
        .map(|message| (message.role, all_text(std::slice::from_ref(message))))
        .collect();
    assert_eq!(
        shape,
        [
            (Role::User, vec!["pin".to_owned()]),
            (
                Role::Assistant,
                vec!["a2".to_owned(), "[... 2 messages elided ...]".to_owned()]
            ),
            (Role::User, vec!["u3".to_owned()]),
        ]
    );
}

// --- repeated message-level reduction -----------------------------------------------------------

fn turn(index: usize, text_only: bool) -> Vec<Message> {
    if text_only {
        return vec![assistant(&format!("a{index}")), user(&format!("u{index}"))];
    }
    vec![
        tool_use_message(&format!("tu-{index}"), "read"),
        tool_result_message("x", &format!("tu-{index}")),
    ]
}

type MakeStrategy = Box<dyn Fn() -> Box<dyn ContextStrategy>>;

#[tokio::test]
async fn keeps_message_0_verbatim_when_text_only() {
    let strategies: Vec<(&str, MakeStrategy)> = vec![
        (
            "drop",
            Box::new(|| Box::new(drop_strategy(OffloadTarget::All).when(conditions(None, Some(0.7), Some(3.0))))),
        ),
        (
            "drop-all",
            Box::new(|| Box::new(drop_strategy(OffloadTarget::All).when(conditions(None, Some(0.7), None)))),
        ),
        (
            "truncate",
            Box::new(|| {
                Box::new(
                    truncate(OffloadTarget::All)
                        .when(conditions(None, Some(0.7), Some(3.0)))
                        .unwrap(),
                )
            }),
        ),
        (
            "truncate-all",
            Box::new(|| {
                Box::new(
                    truncate(OffloadTarget::All)
                        .when(conditions(None, Some(0.7), None))
                        .unwrap(),
                )
            }),
        ),
        ("emergency", Box::new(|| Box::new(EmergencyTruncateStrategy::new()))),
    ];
    for (name, make) in &strategies {
        for text_only in [false, true] {
            let strategy = make();
            let task = || pinned(user("task"));
            let mut agent = agent(vec![task()]);
            for index in 0..30 {
                let added = turn(index, text_only);
                let last = added[1].tracking_id().to_owned();
                agent.messages_mut().extend(added);
                apply_with(strategy.as_ref(), &mut agent, 1.1, true, None).await;
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

// --- stash integration --------------------------------------------------------------------------

fn new_stash() -> Stash {
    Stash::new(Arc::new(InMemoryStorage::new()), "test-session", "test-agent").unwrap()
}

async fn stash_all(stash: &Stash, messages: &[Message]) {
    for message in messages {
        stash.store_message(message, None).await;
    }
}

#[tokio::test]
async fn persists_original_content_to_stash_before_truncating() {
    let stash = new_stash();
    let text = "important data ".repeat(1000);
    let mut agent = agent(vec![tool_result_message(&text, "tool-123")]);
    stash_all(&stash, agent.messages()).await;
    assert!(
        apply_with(
            &truncate(OffloadTarget::ToolResults),
            &mut agent,
            0.5,
            false,
            Some(stash.clone())
        )
        .await
    );
    let keys = stash.list().await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(
        stash.retrieve(&keys[0]).await.unwrap().unwrap()["text"],
        JsonValue::from(text)
    );
}

#[tokio::test]
async fn includes_stash_reference_in_the_truncated_preview() {
    let stash = new_stash();
    let mut agent = agent(vec![tool_result_message(&"x".repeat(20000), "tool-123")]);
    stash_all(&stash, agent.messages()).await;
    apply_with(
        &truncate(OffloadTarget::ToolResults),
        &mut agent,
        0.5,
        false,
        Some(stash),
    )
    .await;
    assert!(result_text(&agent.messages()[0], 0).contains("[Stashed] [ref:"));
}

#[tokio::test]
async fn does_not_stash_when_no_stash_is_configured() {
    let mut agent = agent(vec![tool_result_message(&"x".repeat(20000), "tool-123")]);
    apply(&truncate(OffloadTarget::ToolResults), &mut agent, 0.5).await;
    assert!(!result_text(&agent.messages()[0], 0).contains("[Stashed]"));
}

#[tokio::test]
async fn persists_original_content_before_dropping() {
    let stash = new_stash();
    let text = "critical information ".repeat(500);
    let mut agent = agent(vec![tool_result_message(&text, "tool-123")]);
    stash_all(&stash, agent.messages()).await;
    assert!(
        apply_with(
            &drop_strategy(OffloadTarget::ToolResults),
            &mut agent,
            0.5,
            false,
            Some(stash.clone())
        )
        .await
    );
    let keys = stash.list().await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(
        stash.retrieve(&keys[0]).await.unwrap().unwrap()["text"],
        JsonValue::from(text)
    );
}

#[tokio::test]
async fn includes_stash_reference_in_the_drop_marker() {
    let stash = new_stash();
    let mut agent = agent(vec![tool_result_message(&"x".repeat(20000), "tool-123")]);
    stash_all(&stash, agent.messages()).await;
    apply_with(
        &drop_strategy(OffloadTarget::ToolResults),
        &mut agent,
        0.5,
        false,
        Some(stash),
    )
    .await;
    assert!(result_text(&agent.messages()[0], 0).contains("[Dropped] [ref:"));
}

fn image_result(tool_use_id: &str, content: Vec<ToolResultContent>) -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(tool_use_id, content))],
    )
}

fn image(format: ImageFormat, bytes: Vec<u8>) -> ToolResultContent {
    ToolResultContent::Image(ImageBlock::new(format, ImageSource::Bytes(bytes)))
}

#[tokio::test]
async fn stashes_image_content_from_tool_results() {
    let stash = new_stash();
    let mut agent = agent(vec![image_result(
        "tool-img",
        vec![image(
            ImageFormat::Png,
            vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        )],
    )]);
    stash_all(&stash, agent.messages()).await;
    assert!(
        apply_with(
            &drop_strategy(OffloadTarget::ToolResults),
            &mut agent,
            0.5,
            false,
            Some(stash.clone())
        )
        .await
    );
    let keys = stash.list().await.unwrap();
    assert_eq!(keys.len(), 1);
    let data = stash.retrieve(&keys[0]).await.unwrap().unwrap();
    assert_eq!(data["image"]["format"], "png");
    assert!(data["image"]["source"]["bytes"].is_string());
}

#[tokio::test]
async fn stashes_each_block_independently_when_mixed_content() {
    let stash = new_stash();
    let mut agent = agent(vec![image_result(
        "tool-mixed",
        vec![
            ToolResultContent::text("description of image"),
            image(ImageFormat::Jpeg, vec![0xff, 0xd8]),
        ],
    )]);
    stash_all(&stash, agent.messages()).await;
    apply_with(
        &drop_strategy(OffloadTarget::ToolResults),
        &mut agent,
        0.5,
        false,
        Some(stash.clone()),
    )
    .await;
    let keys = stash.list().await.unwrap();
    assert_eq!(keys.len(), 2);
    let mut entries = Vec::new();
    for key in &keys {
        entries.push(stash.retrieve(key).await.unwrap().unwrap());
    }
    assert!(entries.iter().any(|entry| entry["text"] == "description of image"));
    assert!(entries.iter().any(|entry| entry["image"]["format"] == "jpeg"));
}

#[tokio::test]
async fn persists_tool_result_content_on_message_arrival() {
    let stash = new_stash();
    let text = "important data ".repeat(500);
    stash.store_message(&tool_result_message(&text, "call-1"), None).await;
    let keys = stash.list().await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(
        stash.retrieve(&keys[0]).await.unwrap().unwrap()["text"],
        JsonValue::from(text)
    );
}

#[tokio::test]
async fn persists_text_blocks_from_assistant_messages_on_arrival() {
    let stash = new_stash();
    let text = "important analysis ".repeat(200);
    stash.store_message(&assistant(&text), None).await;
    let keys = stash.list().await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(
        stash.retrieve(&keys[0]).await.unwrap().unwrap()["text"],
        JsonValue::from(text)
    );
}

fn retrieval_pair() -> Vec<Message> {
    vec![
        tool_use_message("call-1", RETRIEVAL_TOOL_NAME),
        tool_result_message(&"retrieved content ".repeat(1000), "call-1"),
    ]
}

#[tokio::test]
async fn does_not_offload_retrieve_context_tool_results_when_stash_is_active() {
    let mut agent = agent(retrieval_pair());
    let acted = apply_with(
        &truncate(OffloadTarget::ToolResults),
        &mut agent,
        0.5,
        false,
        Some(new_stash()),
    )
    .await;
    assert!(!acted);
    assert_eq!(result_text(&agent.messages()[1], 0), "retrieved content ".repeat(1000));
}

#[tokio::test]
async fn offloads_retrieve_context_results_when_no_stash_stash_not_configured() {
    let mut agent = agent(retrieval_pair());
    assert!(apply(&truncate(OffloadTarget::ToolResults), &mut agent, 0.5).await);
}

#[tokio::test]
async fn offloads_eagerly_as_messages_arrive() {
    let strategy = truncate(OffloadTarget::ToolResults)
        .when(conditions(Some(1500.0), None, None))
        .unwrap();
    let mut agent = agent(Vec::new());
    strategy.init(&mut agent, None);
    let message = tool_result_message(&large(), "tool-1");
    agent.messages_mut().push(message.clone());
    let hooks = agent.hooks().clone();
    let mut event = MessageAddedEvent::new(&mut agent, crate::agent::InvocationState::new(), message);
    hooks.invoke(&mut event).await.unwrap();
    drop(event);
    assert!(result_text(&agent.messages()[0], 0).contains("[Truncated:"));
}
