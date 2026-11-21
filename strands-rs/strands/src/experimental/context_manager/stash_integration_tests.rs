//! Offload strategies with a stash: the references placeholders carry, what the stash holds, and
//! what the retrieval tool reads back.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use super::content_rendering::flatten_messages_to_content;
use super::message_trimming::repair_alternation;
use super::methods::truncate::TruncateConfig;
use super::placeholder::offload_placeholder;
use super::retrieval_tool::{RETRIEVAL_TOOL_NAME, retrieve_context};
use super::stash::Stash;
use super::strategies::offload::{Offload, OffloadConditions, OffloadTarget, SummarizeConfig};
use super::test_support::{TestModel, agent_with, summary_result, tool_result_message, tool_use_message};
use super::types::{ContextState, ContextStrategy};
use crate::agent::LocalAgent;
use crate::error::{Error, Result};
use crate::models::CountTokensOptions;
use crate::storage::{InMemoryStorage, Storage};
use crate::types::{
    ContentBlock, ImageBlock, ImageFormat, ImageSource, JsonValue, Message, OffloadMethod, Offloaded, Role,
    SummaryBlock, TextBlock, ToolResultBlock, ToolResultContent,
};

fn stash() -> Stash {
    Stash::new(Arc::new(InMemoryStorage::new()), "test-session", "test-agent").unwrap()
}

async fn stash_all(stash: &Stash, messages: &[Message]) {
    for message in messages {
        stash.store_message(message, None, None).await;
    }
}

fn agent(messages: Vec<Message>) -> LocalAgent {
    agent_with(Arc::new(TestModel::new()), messages)
}

async fn apply(
    strategy: &dyn ContextStrategy,
    agent: &mut LocalAgent,
    stash: Option<&Stash>,
    utilization: f64,
) -> bool {
    let mut context = ContextState::new(agent, utilization).with_stash(stash.cloned());
    strategy.apply(&mut context).await.unwrap()
}

/// What the retrieval tool returns for `reference`, with a result budget of `max_result_tokens`.
async fn retrieve(stash: &Stash, input: JsonValue, max_result_tokens: usize) -> JsonValue {
    let input = serde_json::from_value(input).unwrap();
    retrieve_context(stash, input, max_result_tokens * 4).await.unwrap()
}

/// The tool result content the retrieval tool's return value becomes.
async fn retrieved(stash: &Stash, reference: &str) -> Vec<ToolResultContent> {
    crate::tools::wrap_in_tool_result(
        retrieve(stash, json!({"reference": reference}), 1_000_000).await,
        "call",
    )
    .content
}

fn first_content(message: &Message) -> &ToolResultContent {
    let ContentBlock::ToolResult(result) = &message.content[0] else {
        panic!("not a tool result");
    };
    &result.content[0]
}

fn placeholder_of(content: &ToolResultContent) -> (&TextBlock, &Offloaded) {
    let ToolResultContent::Text(text) = content else {
        panic!("not text");
    };
    (text, text.offloaded.as_ref().expect("a placeholder"))
}

fn offloaded(method: OffloadMethod, reference: Option<&str>, tokens: u64) -> Offloaded {
    let offloaded = Offloaded::new(method).with_tokens(tokens);
    match reference {
        Some(reference) => offloaded.with_reference(reference),
        None => offloaded,
    }
}

fn text_message(role: Role, text: &str, tracking_id: &str) -> Message {
    Message::new(role, vec![ContentBlock::text(text)]).with_tracking_id(tracking_id)
}

fn utilization(value: &str) -> OffloadConditions {
    OffloadConditions::builder().context_utilization(value).build()
}

fn preview(tokens: f64) -> TruncateConfig {
    TruncateConfig {
        preview_tokens: Some(tokens),
        ..TruncateConfig::default()
    }
}

/// A storage whose writes of removed-message entries fail, as a store outage would.
#[derive(Default)]
struct FailingRemovedWrites {
    inner: InMemoryStorage,
}

#[async_trait]
impl Storage for FailingRemovedWrites {
    async fn write(&self, key: &str, data: &[u8]) -> Result<()> {
        if key.rsplit('/').next().is_some_and(|name| name.starts_with("removed-")) {
            return Err(Error::other("storage unavailable"));
        }
        self.inner.write(key, data).await
    }

    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.inner.read(key).await
    }

    async fn delete(&self, key: &str) -> Result<()> {
        self.inner.delete(key).await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        self.inner.list(prefix).await
    }
}

fn failing_stash() -> Stash {
    Stash::new(Arc::new(FailingRemovedWrites::default()), "test-session", "test-agent").unwrap()
}

// --- truncate + stash ---------------------------------------------------------------------------

#[tokio::test]
async fn resolves_the_reference_of_a_block_that_a_history_edit_moved_into_another_message() {
    let stash = stash();
    let big = "x".repeat(20000);
    let mut messages = vec![
        text_message(Role::User, "q", "u0"),
        text_message(Role::Assistant, "short", "a1"),
        text_message(Role::Assistant, &big, "a2"),
    ];
    stash_all(&stash, &messages).await;
    // Merges a2 into a1: the big block is now a1_1, while it was stored on arrival as a2_0.
    repair_alternation(&mut messages);
    let mut agent = agent(messages);
    let strategy = Offload::truncate(OffloadTarget::AssistantText, preview(10.0)).unwrap();
    apply(&strategy, &mut agent, Some(&stash), 0.5).await;
    let ContentBlock::Text(placeholder) = &agent.messages()[1].content[1] else {
        panic!("not text");
    };
    assert_eq!(
        placeholder
            .offloaded
            .as_ref()
            .and_then(|offloaded| offloaded.reference.as_deref()),
        Some("a1_1")
    );
    assert_eq!(retrieved(&stash, "a1_1").await, [ToolResultContent::text(big)]);
}

#[tokio::test]
async fn persists_original_content_to_stash_before_truncating() {
    let stash = stash();
    let large = "important data ".repeat(1000);
    let messages = vec![tool_result_message(&large, "tool-123")];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    let strategy = Offload::truncate(OffloadTarget::ToolResults, TruncateConfig::default()).unwrap();
    assert!(apply(&strategy, &mut agent, Some(&stash), 0.5).await);
    let keys = stash.list("").await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(stash.retrieve(&keys[0]).await.unwrap(), Some(json!({"text": large})));
}

#[tokio::test]
async fn leaves_an_offloaded_block_referencing_the_tool_result_in_the_truncated_preview() {
    let stash = stash();
    let messages = vec![tool_result_message(&"x".repeat(20000), "tool-123")];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    let strategy = Offload::truncate(OffloadTarget::ToolResults, TruncateConfig::default()).unwrap();
    apply(&strategy, &mut agent, Some(&stash), 0.5).await;
    let (text, provenance) = placeholder_of(first_content(&agent.messages()[0]));
    assert_eq!(provenance, &offloaded(OffloadMethod::Truncate, Some("tool-123"), 5000));
    assert!(text.text.ends_with(" [ref: tool-123]"));
}

#[tokio::test]
async fn never_stores_a_seeded_placeholder_under_the_original_key_when_a_strategy_acts_on_it() {
    let stash = stash();
    let seeded = Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tool-123",
            vec![ToolResultContent::Text(offload_placeholder(
                OffloadMethod::Truncate,
                "[Truncated: 1 block, ~7,500 tokens] preview",
                Some("tool-123"),
                0,
            ))],
        ))],
    );
    let messages = vec![seeded];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    apply(
        &Offload::drop(OffloadTarget::ToolResults).unwrap(),
        &mut agent,
        Some(&stash),
        0.5,
    )
    .await;
    let ContentBlock::ToolResult(result) = &agent.messages()[0].content[0] else {
        panic!("not a tool result");
    };
    assert_eq!(
        result.content,
        [ToolResultContent::Text(offload_placeholder(
            OffloadMethod::Drop,
            "[Dropped: ~15 tokens]",
            Some("tool-123"),
            15
        ))]
    );
    assert!(stash.list("").await.unwrap().is_empty());
    let input = serde_json::from_value(json!({"reference": "tool-123"})).unwrap();
    let error = retrieve_context(&stash, input, 40_000).await.unwrap_err();
    assert!(error.to_string().contains("reference not found: tool-123"));
}

#[tokio::test]
async fn lets_a_later_strategy_act_on_an_already_truncated_result_and_keeps_its_reference_resolvable() {
    let stash = stash();
    let original = "x".repeat(20000);
    let messages = vec![tool_result_message(&original, "tool-123")];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    let truncate = Offload::truncate(OffloadTarget::ToolResults, preview(10.0)).unwrap();
    apply(&truncate, &mut agent, Some(&stash), 0.5).await;
    let drop = Offload::drop(OffloadTarget::ToolResults).unwrap();
    assert!(apply(&drop, &mut agent, Some(&stash), 0.5).await);
    // The preview is ~32 tokens, so the marker reports the 5,000 the truncate placeholder stood for
    // as well.
    let ContentBlock::ToolResult(result) = &agent.messages()[0].content[0] else {
        panic!("not a tool result");
    };
    assert_eq!(
        result.content,
        [ToolResultContent::Text(TextBlock::offloaded(
            "[Dropped: ~5,032 tokens] [ref: tool-123]",
            offloaded(OffloadMethod::Drop, Some("tool-123"), 5032),
        ))]
    );
    assert_eq!(retrieved(&stash, "tool-123").await, [ToolResultContent::text(original)]);
}

#[tokio::test]
async fn leaves_a_placeholder_without_a_reference_when_no_stash_is_configured() {
    let mut agent = agent(vec![tool_result_message(&"x".repeat(20000), "tool-123")]);
    let strategy = Offload::truncate(OffloadTarget::ToolResults, TruncateConfig::default()).unwrap();
    apply(&strategy, &mut agent, None, 0.5).await;
    let (text, provenance) = placeholder_of(first_content(&agent.messages()[0]));
    assert_eq!(provenance, &offloaded(OffloadMethod::Truncate, None, 5000));
    assert!(!text.text.contains("[ref:"));
}

// --- drop + stash -------------------------------------------------------------------------------

#[tokio::test]
async fn persists_original_content_before_dropping() {
    let stash = stash();
    let large = "critical information ".repeat(500);
    let messages = vec![tool_result_message(&large, "tool-123")];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    assert!(
        apply(
            &Offload::drop(OffloadTarget::ToolResults).unwrap(),
            &mut agent,
            Some(&stash),
            0.5
        )
        .await
    );
    let keys = stash.list("").await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(stash.retrieve(&keys[0]).await.unwrap(), Some(json!({"text": large})));
}

#[tokio::test]
async fn leaves_an_offloaded_block_referencing_the_tool_result_as_the_drop_marker() {
    let stash = stash();
    let messages = vec![tool_result_message(&"x".repeat(20000), "tool-123")];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    apply(
        &Offload::drop(OffloadTarget::ToolResults).unwrap(),
        &mut agent,
        Some(&stash),
        0.5,
    )
    .await;
    assert_eq!(
        first_content(&agent.messages()[0]),
        &ToolResultContent::Text(TextBlock::offloaded(
            "[Dropped: ~5,000 tokens] [ref: tool-123]",
            offloaded(OffloadMethod::Drop, Some("tool-123"), 5000),
        ))
    );
}

#[tokio::test]
async fn marks_removed_messages_with_an_offloaded_block_that_retrieves_them() {
    let stash = stash();
    let messages = vec![
        text_message(Role::User, "start", "m0"),
        text_message(Role::Assistant, "first answer", "m1"),
        text_message(Role::User, "second question", "m2"),
        text_message(Role::Assistant, "final", "m3"),
    ];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    let strategy = Offload::drop(OffloadTarget::All)
        .unwrap()
        .when(utilization("50%"))
        .unwrap();
    assert!(apply(&strategy, &mut agent, Some(&stash), 0.9).await);
    let marker = ContentBlock::Text(TextBlock::offloaded(
        "[Dropped: earlier messages, ~7 tokens] [ref: removed-m1]",
        offloaded(OffloadMethod::Drop, Some("removed-m1"), 7),
    ));
    let content: Vec<Vec<ContentBlock>> = agent.messages().iter().map(|message| message.content.clone()).collect();
    assert_eq!(
        content,
        [
            vec![ContentBlock::text("start")],
            vec![ContentBlock::text("final"), marker]
        ]
    );
    assert_eq!(
        retrieved(&stash, "removed-m1").await,
        [
            ToolResultContent::text("\n---\n[assistant]"),
            ToolResultContent::text("first answer"),
            ToolResultContent::text("\n---\n[user]"),
            ToolResultContent::text("second question"),
        ]
    );
    let matches = retrieve(&stash, json!({"reference": "removed-m1", "pattern": "second"}), 10_000).await;
    assert!(matches.as_str().unwrap().contains("second question"));
}

fn compaction() -> ContentBlock {
    ContentBlock::Summary(SummaryBlock::new("compacted").with_provider("anthropic"))
}

/// A history whose messages 1 through 3 a server-side summary replaces, `preserve_recent` keeping
/// the last.
fn server_side_history() -> Vec<Message> {
    [
        (Role::User, "start"),
        (Role::Assistant, "first answer"),
        (Role::User, "second question"),
        (Role::Assistant, "final"),
        (Role::User, "latest"),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (role, text))| text_message(role, text, &format!("m{index}")))
    .collect()
}

fn server_side_agent() -> LocalAgent {
    let model = TestModel::new()
        .with_server_side_summary(true)
        .summarizing(summary_result("compacted", Some("anthropic")));
    agent_with(Arc::new(model), server_side_history())
}

fn summarize_messages() -> impl ContextStrategy {
    Offload::summarize(OffloadTarget::All, SummarizeConfig::default())
        .unwrap()
        .when(
            OffloadConditions::builder()
                .context_utilization("50%")
                .preserve_recent(1)
                .build(),
        )
        .unwrap()
}

#[tokio::test]
async fn a_server_side_summary_leaves_an_offloaded_block_that_retrieves_every_message_it_stands_for() {
    let stash = stash();
    // Message 0 stays in the array but a compaction block stops it being sent, so the summary
    // stands for it too.
    let covered = server_side_history()[..4].to_vec();
    stash_all(&stash, &server_side_history()).await;
    let mut agent = server_side_agent();
    assert!(apply(&summarize_messages(), &mut agent, Some(&stash), 0.9).await);
    // The placeholder follows the summary: a provider sending it as a compaction block rejects
    // content before one.
    let content: Vec<Vec<ContentBlock>> = agent.messages().iter().map(|message| message.content.clone()).collect();
    assert_eq!(
        content,
        [
            vec![ContentBlock::text("start")],
            vec![
                compaction(),
                ContentBlock::Text(TextBlock::offloaded(
                    "[Summarized: earlier messages, ~11 tokens] [ref: removed-m0]",
                    offloaded(OffloadMethod::Summarize, Some("removed-m0"), 11),
                )),
            ],
            vec![ContentBlock::text("latest")],
        ]
    );
    let expected: Vec<ToolResultContent> = flatten_messages_to_content(&covered)
        .into_iter()
        .map(|block| match block {
            ContentBlock::Text(text) => ToolResultContent::Text(text),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(retrieved(&stash, "removed-m0").await, expected);
}

#[tokio::test]
async fn a_server_side_summary_stands_on_its_own_when_the_stash_write_fails() {
    let (_logs, _guard) = crate::test_support::record_logs();
    let stash = failing_stash();
    let mut agent = server_side_agent();
    apply(&summarize_messages(), &mut agent, Some(&stash), 0.9).await;
    let content: Vec<Vec<ContentBlock>> = agent.messages().iter().map(|message| message.content.clone()).collect();
    assert_eq!(
        content,
        [
            vec![ContentBlock::text("start")],
            vec![compaction()],
            vec![ContentBlock::text("latest")]
        ]
    );
}

#[tokio::test]
async fn leaves_a_marker_without_a_reference_when_there_is_no_stash() {
    let mut agent = agent(vec![
        tool_result_message("a", "t0"),
        Message::assistant("mid"),
        Message::user("next"),
        Message::assistant("final"),
    ]);
    let strategy = Offload::drop(OffloadTarget::All)
        .unwrap()
        .when(utilization("50%"))
        .unwrap();
    apply(&strategy, &mut agent, None, 0.9).await;
    assert_eq!(
        agent.messages().last().unwrap().content,
        [
            ContentBlock::text("final"),
            ContentBlock::Text(TextBlock::offloaded(
                "[Dropped: earlier messages, ~2 tokens]",
                offloaded(OffloadMethod::Drop, None, 2),
            )),
        ]
    );
}

// --- one reference per placeholder --------------------------------------------------------------

fn tracked_conversation() -> Vec<Message> {
    ["q1", "a1", "q2", "a2", "q3", "a3", "q4", "a4"]
        .into_iter()
        .enumerate()
        .map(|(index, text)| {
            let role = if index % 2 == 0 { Role::User } else { Role::Assistant };
            text_message(role, text, &format!("m{index}"))
        })
        .collect()
}

fn marker_of(messages: &[Message]) -> TextBlock {
    messages
        .iter()
        .flat_map(|message| &message.content)
        .find_map(|block| match block {
            ContentBlock::Text(text) if text.offloaded.is_some() => Some(text.clone()),
            _ => None,
        })
        .expect("a marker")
}

#[tokio::test]
async fn references_a_multi_item_tool_result_by_its_tool_use_id_and_retrieves_every_item() {
    let stash = stash();
    let messages = vec![Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tool-1",
            vec![
                ToolResultContent::text("first ".repeat(2000)),
                ToolResultContent::text("second"),
            ],
        ))],
    )];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    apply(
        &Offload::drop(OffloadTarget::ToolResults).unwrap(),
        &mut agent,
        Some(&stash),
        0.5,
    )
    .await;
    let (text, provenance) = placeholder_of(first_content(&agent.messages()[0]));
    assert_eq!(provenance.method, OffloadMethod::Drop);
    assert_eq!(provenance.reference.as_deref(), Some("tool-1"));
    assert!(provenance.tokens.is_some());
    assert!(
        regex::Regex::new(r"^\[Dropped: ~[\d,]+ tokens\] \[ref: tool-1\]$")
            .unwrap()
            .is_match(&text.text)
    );
    assert_eq!(
        retrieved(&stash, "tool-1").await,
        [
            ToolResultContent::text("first ".repeat(2000)),
            ToolResultContent::text("second")
        ]
    );
}

#[tokio::test]
async fn stashes_a_block_not_yet_stored_under_its_current_key_before_replacing_it() {
    let stash = stash();
    let mut agent = agent(vec![tool_result_message(&"x".repeat(20000), "tool-1")]);
    apply(
        &Offload::drop(OffloadTarget::ToolResults).unwrap(),
        &mut agent,
        Some(&stash),
        0.5,
    )
    .await;
    assert_eq!(
        JsonValue::Object(stash.take_snapshot().await.unwrap()),
        json!({"tool-1_0": {"text": "x".repeat(20000)}})
    );
}

// Truncate keeps the oldest message within its preview budget, so its elided run starts one
// message later.
#[tokio::test]
async fn message_level_marker_references_the_removed_messages() {
    let strategies: [(OffloadMethod, Arc<dyn ContextStrategy>, usize); 2] = [
        (
            OffloadMethod::Drop,
            Arc::new(
                Offload::drop(OffloadTarget::All)
                    .unwrap()
                    .when(utilization("50%"))
                    .unwrap(),
            ),
            1,
        ),
        (
            OffloadMethod::Truncate,
            Arc::new(
                Offload::truncate(OffloadTarget::All, preview(2.0))
                    .unwrap()
                    .when(utilization("50%"))
                    .unwrap(),
            ),
            2,
        ),
    ];
    for (method, strategy, first) in strategies {
        let stash = stash();
        let original = tracked_conversation();
        let mut agent = agent(original.clone());
        apply(strategy.as_ref(), &mut agent, Some(&stash), 0.9).await;
        let marker = marker_of(agent.messages());
        let reference = format!("removed-m{first}");
        // Merges move blocks between messages, so a message none of whose blocks are left was
        // removed.
        let kept: Vec<&ContentBlock> = agent.messages().iter().flat_map(|message| &message.content).collect();
        let removed: Vec<Message> = original
            .iter()
            .filter(|message| !message.content.iter().any(|block| kept.contains(&block)))
            .cloned()
            .collect();
        assert_eq!(removed[0].tracking_id(), original[first].tracking_id(), "{method:?}");
        let tokens = agent
            .model()
            .count_tokens(&removed, CountTokensOptions::default())
            .await
            .unwrap();
        assert_eq!(
            marker.offloaded,
            Some(offloaded(method, Some(&reference), tokens)),
            "{method:?}"
        );
        assert!(marker.text.ends_with(&format!(" [ref: {reference}]")));
        let expected: Vec<ToolResultContent> = flatten_messages_to_content(&removed)
            .into_iter()
            .map(|block| match block {
                ContentBlock::Text(text) => ToolResultContent::Text(text),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(retrieved(&stash, &reference).await, expected, "{method:?}");
    }
}

#[tokio::test]
async fn leaves_a_message_level_marker_without_a_reference_when_the_stash_write_fails() {
    let (_logs, _guard) = crate::test_support::record_logs();
    let stash = failing_stash();
    let mut agent = agent(tracked_conversation());
    let strategy = Offload::drop(OffloadTarget::All)
        .unwrap()
        .when(utilization("50%"))
        .unwrap();
    apply(&strategy, &mut agent, Some(&stash), 0.9).await;
    let marker = marker_of(agent.messages());
    assert!(
        regex::Regex::new(r"^\[Dropped: earlier messages, ~[\d,]+ tokens\]$")
            .unwrap()
            .is_match(&marker.text)
    );
    let provenance = marker.offloaded.unwrap();
    assert_eq!(provenance.method, OffloadMethod::Drop);
    assert_eq!(provenance.reference, None);
    assert!(provenance.tokens.is_some());
}

// --- binary content stashing --------------------------------------------------------------------

fn image_result(tool_use_id: &str, content: Vec<ToolResultContent>) -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(tool_use_id, content))],
    )
}

#[tokio::test]
async fn stashes_image_content_from_tool_results() {
    let stash = stash();
    let image = ImageBlock::new(
        ImageFormat::Png,
        ImageSource::Bytes(vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    let messages = vec![image_result("tool-img", vec![ToolResultContent::Image(image)])];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    assert!(
        apply(
            &Offload::drop(OffloadTarget::ToolResults).unwrap(),
            &mut agent,
            Some(&stash),
            0.5
        )
        .await
    );
    let keys = stash.list("").await.unwrap();
    assert_eq!(keys.len(), 1);
    let data = stash.retrieve(&keys[0]).await.unwrap().unwrap();
    assert_eq!(data["image"]["format"], "png");
    assert!(data["image"]["source"]["bytes"].is_string());
}

#[tokio::test]
async fn stashes_each_block_independently_when_mixed_content() {
    let stash = stash();
    let image = ImageBlock::new(ImageFormat::Jpeg, ImageSource::Bytes(vec![0xff, 0xd8]));
    let messages = vec![image_result(
        "tool-mixed",
        vec![
            ToolResultContent::text("description of image"),
            ToolResultContent::Image(image),
        ],
    )];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    apply(
        &Offload::drop(OffloadTarget::ToolResults).unwrap(),
        &mut agent,
        Some(&stash),
        0.5,
    )
    .await;
    let keys = stash.list("").await.unwrap();
    assert_eq!(keys.len(), 2);
    let mut entries = Vec::new();
    for key in &keys {
        entries.push(stash.retrieve(key).await.unwrap().unwrap());
    }
    let text = entries.iter().find(|entry| entry.get("text").is_some()).unwrap();
    assert_eq!(text["text"], "description of image");
    let image = entries.iter().find(|entry| entry.get("image").is_some()).unwrap();
    assert_eq!(image["image"]["format"], "jpeg");
}

// --- eager stashing via store_message -----------------------------------------------------------

#[tokio::test]
async fn persists_tool_result_content_on_message_arrival() {
    let stash = stash();
    let large = "important data ".repeat(500);
    stash
        .store_message(&tool_result_message(&large, "call-1"), None, None)
        .await;
    let keys = stash.list("").await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(stash.retrieve(&keys[0]).await.unwrap(), Some(json!({"text": large})));
}

#[tokio::test]
async fn persists_text_blocks_from_assistant_messages_on_arrival() {
    let stash = stash();
    let text = "important analysis ".repeat(200);
    stash.store_message(&Message::assistant(&text), None, None).await;
    let keys = stash.list("").await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(stash.retrieve(&keys[0]).await.unwrap(), Some(json!({"text": text})));
}

// --- retrieval loop prevention ------------------------------------------------------------------

fn retrieval_pair() -> Vec<Message> {
    vec![
        tool_use_message("call-1", RETRIEVAL_TOOL_NAME),
        tool_result_message(&"retrieved content ".repeat(1000), "call-1"),
    ]
}

#[tokio::test]
async fn does_not_offload_retrieve_context_tool_results_when_stash_is_active() {
    let stash = stash();
    let mut agent = agent(retrieval_pair());
    let strategy = Offload::truncate(OffloadTarget::ToolResults, TruncateConfig::default()).unwrap();
    assert!(!apply(&strategy, &mut agent, Some(&stash), 0.5).await);
    let ToolResultContent::Text(text) = first_content(&agent.messages()[1]) else {
        panic!("not text");
    };
    assert_eq!(text.text, "retrieved content ".repeat(1000));
}

#[tokio::test]
async fn offloads_retrieve_context_results_when_no_stash_is_configured() {
    let mut agent = agent(retrieval_pair());
    let strategy = Offload::truncate(OffloadTarget::ToolResults, TruncateConfig::default()).unwrap();
    assert!(apply(&strategy, &mut agent, None, 0.5).await);
}

#[tokio::test]
async fn a_restored_history_keeps_the_entries_its_placeholders_reference() {
    let stash = stash();
    let messages = vec![tool_result_message(&"x".repeat(20000), "tool-1")];
    stash_all(&stash, &messages).await;
    let mut agent = agent(messages);
    apply(
        &Offload::drop(OffloadTarget::ToolResults).unwrap(),
        &mut agent,
        Some(&stash),
        0.5,
    )
    .await;
    let stored: std::collections::HashSet<String> = stash.list("").await.unwrap().into_iter().collect();
    for message in agent.messages() {
        stash.store_message(message, None, Some(&stored)).await;
    }
    assert_eq!(
        retrieved(&stash, "tool-1").await,
        [ToolResultContent::text("x".repeat(20000))]
    );
}
