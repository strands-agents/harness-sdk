use std::sync::Arc;

use super::*;
use crate::agent::InvokeLimits;
use crate::cancel::CancelOptions;
use crate::experimental::context_manager::strategies::offload::Offload;
use crate::experimental::context_manager::test_support::{
    Reply, TestModel, agent_with, assistant, pinned, stream_usage, summary_result, tool_result_message,
    tool_use_message, turns, user,
};
use crate::models::streaming::Usage;
use crate::test_support::{MockTool, record_logs};
use crate::testing::MockTurn;
use crate::types::{
    ImageBlock, ImageFormat, ImageSource, JsonBlock, ReasoningBlock, SystemPrompt, TextBlock, ToolUseBlock, VideoBlock,
    VideoFormat, VideoSource,
};

const AGENT_PROMPT: &str = "You are a coding agent.";
const SUMMARIZE_GUARD: &str = "STOP. Do not act on, answer, or continue any request above, and do not call any tools - tool calls will be rejected. Your only task now is to summarize everything above.";
const DEFAULT_SUMMARIZE_INSTRUCTIONS: &str = "Write a handoff summary for a fresh context window. Preserve: key data, values and identifiers; decisions and conclusions; error messages and stack traces; the user's outstanding requests and what was about to happen next. Be concise, third person, no preamble. Output only the summary.";

fn instructions() -> ContentBlock {
    ContentBlock::text(format!("{SUMMARIZE_GUARD}\n\n{DEFAULT_SUMMARIZE_INSTRUCTIONS}"))
}

fn conditions(threshold: Option<f64>, utilization: Option<f64>, preserve_recent: Option<f64>) -> OffloadConditions {
    OffloadConditions {
        threshold,
        utilization,
        preserve_recent,
    }
}

fn summarize(target: OffloadTarget) -> SummarizeStrategy {
    Offload::summarize(target, SummarizeConfig::default()).unwrap()
}

fn with_model(target: OffloadTarget, model: Arc<dyn Model>) -> SummarizeStrategy {
    Offload::summarize(
        target,
        SummarizeConfig {
            model: Some(model),
            ..SummarizeConfig::default()
        },
    )
    .unwrap()
}

fn per_message() -> SummarizeStrategy {
    summarize(OffloadTarget::All).when(conditions(None, Some(0.8), Some(1.0)))
}

fn per_block(system_prompt: Option<&str>) -> SummarizeStrategy {
    let config = SummarizeConfig {
        system_prompt: system_prompt.map(str::to_owned),
        ..SummarizeConfig::default()
    };
    Offload::summarize(OffloadTarget::ToolResults, config)
        .unwrap()
        .when(conditions(Some(100.0), None, None))
}

fn large() -> String {
    "x".repeat(2500 * 4 + 100)
}

/// `makeContext(messages, utilization, model)`: a plain-object model whose `summarize` replies
/// with a client-side summary.
fn plain_model() -> Arc<TestModel> {
    Arc::new(TestModel::new().summarizing(summary_result("Summary of multimodal content", None)))
}

async fn apply(strategy: &SummarizeStrategy, agent: &mut LocalAgent, utilization: f64) -> bool {
    let mut context = ContextState::new(agent, utilization);
    strategy.apply(&mut context).await.unwrap()
}

async fn apply_in(
    strategy: &SummarizeStrategy,
    agent: &mut LocalAgent,
    utilization: f64,
    invocation_context: &InvocationContext,
) -> bool {
    let mut context = ContextState::new(agent, utilization).with_invocation_context(Some(invocation_context.clone()));
    strategy.apply(&mut context).await.unwrap()
}

/// An agent with a base model counting 5,000 tokens, a system prompt and a tool.
fn mock_agent(messages: Vec<Message>, server_side_summary: bool) -> (LocalAgent, Arc<TestModel>) {
    let model = Arc::new(
        TestModel::new()
            .with_count(|_| 5000)
            .with_server_side_summary(server_side_summary),
    );
    let mut agent = agent_with(model.clone(), messages);
    agent.set_system_prompt(Some(SystemPrompt::from(AGENT_PROMPT)));
    agent
        .tool_registry_mut()
        .add(MockTool::new("shell").with_description("Run a command"))
        .unwrap();
    (agent, model)
}

fn assert_replay_options(options: &SummarizeOptions, instructions: Option<&str>) {
    assert_eq!(options.instructions.as_deref(), instructions);
    assert_eq!(options.system_prompt, Some(SystemPrompt::from(AGENT_PROMPT)));
    let names: Vec<&str> = options.tool_specs.iter().map(|spec| spec.name.as_str()).collect();
    assert_eq!(names, ["shell"]);
    assert!(options.cancel_signal.is_some());
}

fn marker(count: usize, summary: &str) -> ContentBlock {
    ContentBlock::text(format!("[Summarized: {count} messages, ~5,000 tokens]\n\n{summary}"))
}

fn server_side_messages() -> Vec<Message> {
    vec![
        user("task"),
        assistant("old1"),
        user("old2"),
        assistant("old3"),
        user("recent"),
    ]
}

fn tool_result_messages() -> Vec<Message> {
    vec![user("task"), tool_result_message(&"x".repeat(10000), "t1")]
}

fn summarized_tool_result(summary: &str) -> (Role, Vec<ContentBlock>, bool) {
    (
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "t1",
            vec![ToolResultContent::text(format!(
                "[Summarized: tool result, ~5,000 tokens]\n\n{summary}"
            ))],
        ))],
        false,
    )
}

fn turn(role: Role, content: Vec<ContentBlock>) -> (Role, Vec<ContentBlock>, bool) {
    (role, content, false)
}

fn texts(values: &[&str]) -> Vec<ContentBlock> {
    values.iter().map(|value| ContentBlock::text(*value)).collect()
}

fn reasoning() -> ContentBlock {
    ContentBlock::Reasoning(ReasoningBlock::new().with_text("think").with_signature("sig"))
}

fn replay_messages() -> Vec<Message> {
    vec![
        user("task"),
        Message::new(Role::Assistant, vec![reasoning(), ContentBlock::text("old1")]),
        user("old2"),
        assistant("old3"),
        user("recent"),
    ]
}

fn summary(provider: &str, text: &str) -> ContentBlock {
    ContentBlock::Summary(SummaryBlock::new(text).with_provider(provider))
}

fn result_of(content: Vec<ContentBlock>) -> Reply {
    Reply::Result(SummarizeResult::new(content))
}

fn first_result_text(message: &Message) -> String {
    let ContentBlock::ToolResult(result) = &message.content[0] else {
        panic!("not a tool result");
    };
    let ToolResultContent::Text(text) = &result.content[0] else {
        panic!("not text");
    };
    text.text.clone()
}

// --- Offload.summarize --------------------------------------------------------------------------

#[test]
fn creates_a_strategy_with_correct_name() {
    assert_eq!(summarize(OffloadTarget::ToolResults).name(), "offload:summarize");
}

#[test]
fn creates_a_strategy_with_when_conditions() {
    let strategy = summarize(OffloadTarget::ToolResults).when(conditions(None, Some(0.85), None));
    assert_eq!(strategy.name(), "offload:summarize");
}

#[tokio::test]
async fn returns_false_when_blocks_are_below_threshold() {
    let mut agent = agent_with(plain_model(), vec![tool_result_message("short result", "tool-123")]);
    let strategy = summarize(OffloadTarget::ToolResults).when(conditions(Some(2500.0), None, None));
    assert!(!apply(&strategy, &mut agent, 0.9).await);
}

#[tokio::test]
async fn summarizes_large_tool_results() {
    let mut agent = agent_with(plain_model(), vec![tool_result_message(&large(), "tool-123")]);
    assert!(apply(&summarize(OffloadTarget::ToolResults), &mut agent, 0.9).await);
    assert!(first_result_text(&agent.messages()[0]).contains("[Summarized:"));
}

#[tokio::test]
async fn summarizes_with_agent_aux_model_when_the_strategy_has_no_model() {
    let main = plain_model();
    let aux = plain_model();
    let mut agent = agent_with(main.clone(), vec![tool_result_message(&large(), "tool-123")]);
    agent.set_aux_model(Some(aux.clone()));
    assert!(apply(&summarize(OffloadTarget::ToolResults), &mut agent, 0.9).await);
    assert_eq!(aux.summarize_calls().len(), 1);
    assert!(main.summarize_calls().is_empty());
}

#[tokio::test]
async fn summarizes_assistant_text_blocks() {
    let mut agent = agent_with(plain_model(), vec![assistant(&large())]);
    assert!(apply(&summarize(OffloadTarget::AssistantText), &mut agent, 0.9).await);
    assert!(
        agent.messages()[0].content[0]
            .as_text()
            .unwrap()
            .contains("[Summarized:")
    );
}

#[tokio::test]
async fn summarizes_user_text_blocks() {
    let mut agent = agent_with(plain_model(), vec![user(&large())]);
    assert!(apply(&summarize(OffloadTarget::UserText), &mut agent, 0.9).await);
    assert!(
        agent.messages()[0].content[0]
            .as_text()
            .unwrap()
            .contains("[Summarized:")
    );
}

#[tokio::test]
async fn skips_when_utilization_is_below_threshold() {
    let mut agent = agent_with(plain_model(), vec![tool_result_message(&large(), "tool-123")]);
    let strategy = summarize(OffloadTarget::ToolResults).when(conditions(None, Some(0.85), None));
    assert!(!apply(&strategy, &mut agent, 0.5).await);
}

#[tokio::test]
async fn fires_when_utilization_exceeds_threshold() {
    let model = Arc::new(
        TestModel::new()
            .with_count(|_| 5000)
            .summarizing(summary_result("Summary of multimodal content", None)),
    );
    let mut agent = agent_with(
        model,
        vec![
            user("initial question"),
            tool_result_message(&large(), "tool-123"),
            assistant("latest"),
        ],
    );
    let strategy = summarize(OffloadTarget::ToolResults).when(conditions(None, Some(0.85), None));
    assert!(apply(&strategy, &mut agent, 0.9).await);
}

#[tokio::test]
async fn returns_false_on_empty_messages() {
    let mut agent = agent_with(plain_model(), Vec::new());
    assert!(!apply(&summarize(OffloadTarget::ToolResults), &mut agent, 0.9).await);
}

#[tokio::test]
async fn adds_the_summarizer_usage_to_the_request_total_even_when_the_request_limit_is_used_up() {
    let usage = Usage::new(4, 5, 9);
    let summarizer: Arc<dyn Model> = Arc::new(
        crate::testing::MockModel::new().with_turn(MockTurn::text("Summary of tool output").with_usage(usage)),
    );
    let mut agent = agent_with(plain_model(), vec![tool_result_message(&large(), "tool-123")]);
    let invocation_context = InvocationContext::new(Some(InvokeLimits {
        turns: Some(1),
        ..InvokeLimits::default()
    }));
    for _ in 0..5 {
        invocation_context.record_turn();
    }
    let strategy = with_model(OffloadTarget::ToolResults, summarizer);
    assert!(apply_in(&strategy, &mut agent, 0.9, &invocation_context).await);
    assert_eq!(
        agent.messages()[0].content,
        [ContentBlock::ToolResult(ToolResultBlock::success(
            "tool-123",
            vec![ToolResultContent::text(
                "[Summarized: tool result, ~2,525 tokens]\n\nSummary of tool output"
            )],
        ))]
    );
    let recorded = invocation_context.usage();
    assert_eq!(recorded.turns_taken, 5);
    assert_eq!(recorded.usage, usage);
}

// --- summarizer errors --------------------------------------------------------------------------

#[tokio::test]
async fn keeps_a_block_and_continues_the_pass_when_its_summarization_fails() {
    let (logs, _guard) = record_logs();
    let model = Arc::new(
        TestModel::new()
            .summarizing_once(Reply::Error("rejected".into()))
            .summarizing(summary_result("Summary of multimodal content", None)),
    );
    let mut agent = agent_with(
        model,
        vec![
            tool_result_message(&large(), "call_1"),
            tool_result_message(&large(), "call_2"),
        ],
    );
    assert!(apply(&summarize(OffloadTarget::ToolResults), &mut agent, 0.9).await);
    assert_eq!(first_result_text(&agent.messages()[0]), large());
    assert!(first_result_text(&agent.messages()[1]).contains("[Summarized:"));
    assert!(logs.text().contains("error=<rejected>"));
}

#[tokio::test]
async fn offloads_a_video_block_without_summarizing_it() {
    let summarizer = Arc::new(TestModel::new());
    let mut agent = agent_with(
        plain_model(),
        vec![Message::new(
            Role::User,
            vec![ContentBlock::Video(VideoBlock::new(
                VideoFormat::Mp4,
                VideoSource::Bytes(vec![0; 4000]),
            ))],
        )],
    );
    let strategy = with_model(OffloadTarget::All, summarizer.clone()).when(conditions(Some(10.0), None, None));
    assert!(apply(&strategy, &mut agent, 0.9).await);
    let text = agent.messages()[0].content[0].as_text().unwrap().to_owned();
    assert!(
        regex::Regex::new(r"^\[Offloaded: ~\d+ tokens\]")
            .unwrap()
            .is_match(&text)
    );
    assert!(summarizer.summarize_calls().is_empty());
}

#[tokio::test]
async fn offloads_a_media_block_when_its_summarization_fails() {
    let (logs, _guard) = record_logs();
    let summarizer = Arc::new(TestModel::new().summarizing_once(Reply::Error("images unsupported".into())));
    let mut agent = agent_with(
        plain_model(),
        vec![Message::new(
            Role::User,
            vec![ContentBlock::Image(ImageBlock::new(
                ImageFormat::Png,
                ImageSource::Bytes(vec![0; 4000]),
            ))],
        )],
    );
    let strategy = with_model(OffloadTarget::All, summarizer).when(conditions(Some(10.0), None, None));
    assert!(apply(&strategy, &mut agent, 0.9).await);
    let text = agent.messages()[0].content[0].as_text().unwrap().to_owned();
    assert!(text.starts_with("[Offloaded: ~"));
    assert!(logs.text().contains("error=<images unsupported>"));
}

#[tokio::test]
async fn keeps_summaries_out_of_a_pinned_message_0() {
    let strategy = summarize(OffloadTarget::All).when(conditions(None, Some(0.7), Some(4.0)));
    let task = || pinned(user("task"));
    let mut agent = agent_with(plain_model(), vec![task()]);
    for index in 0..30 {
        agent
            .messages_mut()
            .push(tool_use_message(&format!("t{index}"), "read"));
        agent
            .messages_mut()
            .push(tool_result_message("x", &format!("t{index}")));
        apply(&strategy, &mut agent, 0.9).await;
    }
    assert_eq!(agent.messages()[0].content, task().content);
    assert_eq!(agent.messages()[0].metadata, task().metadata);
    let summaries = agent
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .filter(|block| block.as_text().is_some_and(|text| text.starts_with("[Summarized:")))
        .count();
    assert_eq!(summaries, 1);
}

// --- per-block cancellation and placement -------------------------------------------------------

#[tokio::test]
async fn stops_sending_requests_after_a_cancel() {
    let (_logs, _guard) = record_logs();
    let results = || {
        (0..5)
            .map(|index| tool_result_message(&"x".repeat(10000), &format!("call_{index}")))
            .collect::<Vec<_>>()
    };
    let (mut agent, model) = mock_agent(results(), false);
    let handle = agent.cancel_handle().clone();
    model.on_stream(move || handle.cancel(CancelOptions::default()));
    assert!(!apply(&per_block(None), &mut agent, 0.5).await);
    assert_eq!(model.mock().requests().len(), 1);
    assert_eq!(turns(agent.messages()), turns(&results()));
}

#[tokio::test]
async fn skips_a_batch_summary_once_cancelled() {
    let (mut agent, model) = mock_agent(server_side_messages(), false);
    agent.cancel(CancelOptions::default());
    assert!(!apply(&per_message(), &mut agent, 0.9).await);
    assert!(model.mock().requests().is_empty());
    assert_eq!(turns(agent.messages()), turns(&server_side_messages()));
}

#[tokio::test]
async fn places_only_the_first_summary_block() {
    let reply = result_of(vec![
        ContentBlock::Summary(SummaryBlock::new("first")),
        ContentBlock::Summary(SummaryBlock::new("second")),
    ]);
    let (mut agent, _) = summarizing_agent(tool_result_messages(), Some(reply), false);
    assert!(apply(&per_block(None), &mut agent, 0.5).await);
    assert_eq!(turns(agent.messages())[1], summarized_tool_result("first"));
}

// --- batch summary replays the agent request ----------------------------------------------------

#[tokio::test]
async fn replays_tool_calls_in_a_single_model_call() {
    let tool_use = ContentBlock::ToolUse(ToolUseBlock::new(
        "shell",
        "call_1",
        serde_json::json!({"command": "ls"}),
    ));
    let tool_result = ContentBlock::ToolResult(ToolResultBlock::success(
        "call_1",
        vec![ToolResultContent::text("a.ts b.ts")],
    ));
    let messages = vec![
        user("fix the build"),
        Message::new(Role::Assistant, vec![tool_use.clone()]),
        Message::new(Role::User, vec![tool_result.clone()]),
        assistant("done"),
        user("next"),
    ];
    let (mut agent, model) = mock_agent(messages, false);
    let strategy = summarize(OffloadTarget::All).when(conditions(None, Some(0.7), Some(2.0)));
    assert!(apply(&strategy, &mut agent, 0.9).await);
    let requests = model.mock().requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        turns(&requests[0].messages),
        [
            turn(Role::User, texts(&["fix the build"])),
            turn(Role::Assistant, vec![tool_use]),
            turn(Role::User, vec![tool_result, instructions()]),
        ]
    );
    assert_eq!(requests[0].system_prompt, Some(SystemPrompt::from(AGENT_PROMPT)));
    let names: Vec<&str> = requests[0].tool_specs.iter().map(|spec| spec.name.as_str()).collect();
    assert_eq!(names, ["shell"]);
    assert!(requests[0].cancel_signal.is_some());
}

#[tokio::test]
async fn sends_the_history_prefix_with_the_agent_prompt_and_tools() {
    let (mut agent, model) = mock_agent(replay_messages(), false);
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let (sent, options) = model.summarize_calls().remove(0);
    assert_eq!(turns(&sent), turns(&replay_messages()[..4]));
    assert_replay_options(&options, None);
}

#[tokio::test]
async fn sends_only_the_replaced_messages_when_a_pin_is_kept() {
    let messages = vec![
        user("task"),
        assistant("old1"),
        pinned(user("pin")),
        assistant("old3"),
        user("recent"),
    ];
    let (mut agent, model) = mock_agent(messages, false);
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let (sent, options) = model.summarize_calls().remove(0);
    assert_eq!(
        turns(&sent),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, texts(&["old1", "old3"]))
        ]
    );
    assert_replay_options(&options, None);
    assert_eq!(
        turns(agent.messages()),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, vec![marker(2, "Summary of content.")]),
            (Role::User, texts(&["pin", "recent"]), true),
        ]
    );
}

#[tokio::test]
async fn sends_only_the_replaced_messages_when_a_threshold_skips_some() {
    let messages = vec![
        user("task"),
        assistant("big1"),
        user("question"),
        assistant("big2"),
        user("recent"),
    ];
    let model = Arc::new(TestModel::new().with_count(|counted| {
        let big = counted.iter().any(|message| {
            message
                .content
                .iter()
                .any(|block| block.as_text().is_some_and(|text| text.contains("big")))
        });
        if big { 5000 } else { 10 }
    }));
    let mut agent = agent_with(model.clone(), messages);
    agent.set_system_prompt(Some(SystemPrompt::from(AGENT_PROMPT)));
    agent
        .tool_registry_mut()
        .add(MockTool::new("shell").with_description("Run a command"))
        .unwrap();
    let strategy = summarize(OffloadTarget::All).when(conditions(Some(100.0), Some(0.8), None));
    assert!(apply(&strategy, &mut agent, 0.9).await);
    let (sent, options) = model.summarize_calls().remove(0);
    assert_eq!(
        turns(&sent),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, texts(&["big1", "big2"]))
        ]
    );
    assert_replay_options(&options, None);
    assert_eq!(
        turns(agent.messages()),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, vec![marker(2, "Summary of content.")]),
            turn(Role::User, texts(&["question", "recent"])),
        ]
    );
}

#[tokio::test]
async fn replays_the_prefix_as_sent_when_it_holds_adjacent_same_role_messages() {
    let messages = vec![user("task"), user("more task"), assistant("old1"), user("recent")];
    let (mut agent, model) = mock_agent(messages, false);
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let (sent, options) = model.summarize_calls().remove(0);
    assert_eq!(
        turns(&sent),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::User, texts(&["more task"])),
            turn(Role::Assistant, texts(&["old1"])),
        ]
    );
    assert_replay_options(&options, None);
}

#[tokio::test]
async fn leaves_reasoning_out_when_a_gap_merges_assistant_turns() {
    let messages = vec![
        user("task"),
        Message::new(Role::Assistant, vec![reasoning(), ContentBlock::text("old1")]),
        pinned(user("pin")),
        Message::new(Role::Assistant, vec![reasoning(), ContentBlock::text("old3")]),
        user("recent"),
    ];
    let (mut agent, model) = mock_agent(messages, false);
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let (sent, options) = model.summarize_calls().remove(0);
    assert_eq!(
        turns(&sent),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, texts(&["old1", "old3"]))
        ]
    );
    assert_replay_options(&options, None);
}

#[tokio::test]
async fn sends_no_system_prompt_for_an_agent_without_one() {
    let (mut agent, model) = mock_agent(replay_messages(), false);
    agent.set_system_prompt(None);
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    assert_eq!(model.mock().requests()[0].system_prompt, None);
}

#[tokio::test]
async fn leaves_the_history_unchanged_when_cancelled_mid_summary() {
    let (_logs, _guard) = record_logs();
    let (mut agent, model) = mock_agent(replay_messages(), false);
    let handle = agent.cancel_handle().clone();
    model.on_stream(move || handle.cancel(CancelOptions::default()));
    assert!(!apply(&per_message(), &mut agent, 0.9).await);
    assert_eq!(turns(agent.messages()), turns(&replay_messages()));
}

#[tokio::test]
async fn leaves_reasoning_out_for_a_model_other_than_the_agent_model() {
    let aux = Arc::new(
        TestModel::new()
            .with_count(|_| 5000)
            .summarizing(summary_result("aux summary", None)),
    );
    let (mut agent, _) = mock_agent(replay_messages(), false);
    agent.set_aux_model(Some(aux.clone()));
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let mut expected = replay_messages()[..4].to_vec();
    expected[1] = assistant("old1");
    assert_eq!(turns(&aux.summarize_calls()[0].0), turns(&expected));
}

#[tokio::test]
async fn leaves_the_history_unchanged_when_the_reply_holds_no_text() {
    let (logs, _guard) = record_logs();
    let model = Arc::new(TestModel::new().with_count(|_| 5000).summarizing(result_of(Vec::new())));
    let mut agent = agent_with(model, replay_messages());
    assert!(!apply(&per_message(), &mut agent, 0.9).await);
    assert_eq!(turns(agent.messages()), turns(&replay_messages()));
    assert!(logs.text().contains("summary held no text"));
}

// --- server-side summary ------------------------------------------------------------------------

fn server_side_agent(reply: Reply) -> (LocalAgent, Arc<TestModel>) {
    let model = Arc::new(
        TestModel::new()
            .with_count(|_| 5000)
            .with_server_side_summary(true)
            .summarizing(reply),
    );
    let mut agent = agent_with(model.clone(), server_side_messages());
    agent.set_system_prompt(Some(SystemPrompt::from(AGENT_PROMPT)));
    agent
        .tool_registry_mut()
        .add(MockTool::new("shell").with_description("Run a command"))
        .unwrap();
    (agent, model)
}

#[tokio::test]
async fn replaces_the_opening_run_with_the_server_side_summary() {
    let (mut agent, model) = server_side_agent(result_of(vec![summary("anthropic", "compacted")]));
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let sent = &model.summarize_calls()[0].0;
    let sent_texts: Vec<String> = sent.iter().map(Message::text).collect();
    assert_eq!(sent_texts, ["task", "old1", "old2", "old3"]);
    assert_eq!(
        turns(agent.messages()),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, vec![summary("anthropic", "compacted")]),
            turn(Role::User, texts(&["recent"])),
        ]
    );
}

#[tokio::test]
async fn sends_the_server_side_summary_the_same_sorted_tools_as_the_model_call() {
    let (mut agent, model) = server_side_agent(result_of(vec![summary("anthropic", "compacted")]));
    agent.tool_registry_mut().clear();
    agent.tool_registry_mut().set_sort_tool_specs(true);
    for name in ["zeta", "alpha", "mike"] {
        agent.tool_registry_mut().add(MockTool::new(name)).unwrap();
    }
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let (_, options) = model.summarize_calls().remove(0);
    let names: Vec<&str> = options.tool_specs.iter().map(|spec| spec.name.as_str()).collect();
    assert_eq!(names, ["alpha", "mike", "zeta"]);
}

#[tokio::test]
async fn places_a_summary_without_a_provider_as_a_client_side_marker() {
    let (_logs, _guard) = record_logs();
    let (mut agent, model) = server_side_agent(summary_result("written client-side", None));
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let counted = model.count_calls();
    assert_eq!(counted.len(), 1);
    assert_eq!(turns(&counted[0]), turns(&server_side_messages()[1..4]));
    assert_eq!(
        turns(agent.messages()),
        [
            turn(Role::User, texts(&["task"])),
            turn(
                Role::Assistant,
                texts(&["[Summarized: 3 messages, ~5,000 tokens]\n\nwritten client-side"])
            ),
            turn(Role::User, texts(&["recent"])),
        ]
    );
}

#[tokio::test]
async fn passes_the_live_system_prompt_and_tools_to_the_server_side_summary() {
    for instructions in [Some("keep ids"), None] {
        let model = Arc::new(
            TestModel::new()
                .with_count(|_| 5000)
                .with_server_side_summary(true)
                .summarizing(summary_result("compacted", Some("anthropic"))),
        );
        let mut agent = agent_with(model.clone(), server_side_messages());
        agent.set_system_prompt(Some(SystemPrompt::from("be terse")));
        agent
            .tool_registry_mut()
            .add(MockTool::new("read").with_description("Read a file"))
            .unwrap();
        let config = SummarizeConfig {
            system_prompt: instructions.map(str::to_owned),
            ..SummarizeConfig::default()
        };
        let strategy =
            Offload::summarize(OffloadTarget::All, config)
                .unwrap()
                .when(conditions(None, Some(0.8), Some(1.0)));
        assert!(apply(&strategy, &mut agent, 0.9).await);
        let options = &model.summarize_calls()[0].1;
        assert_eq!(options.system_prompt, Some(SystemPrompt::from("be terse")));
        let names: Vec<&str> = options.tool_specs.iter().map(|spec| spec.name.as_str()).collect();
        assert_eq!(names, ["read"]);
        assert_eq!(options.instructions.as_deref(), instructions);
        assert!(options.cancel_signal.is_some());
    }
}

#[tokio::test]
async fn places_a_server_side_summary_when_the_agent_model_is_a_different_model() {
    let other_id = TestModel::new().with_server_side_summary(true);
    other_id
        .update_config(crate::models::BaseModelConfig {
            model_id: Some("claude-opus-5-5".into()),
            ..crate::models::BaseModelConfig::default()
        })
        .unwrap();
    let other_provider = crate::testing::MockModel::new();
    let mut info = crate::models::ModelInfo::default();
    info.capabilities.server_side_summary = Some(true);
    other_provider
        .update_config(crate::models::BaseModelConfig {
            model_info: Some(info),
            ..crate::models::BaseModelConfig::default()
        })
        .unwrap();
    let agent_models: Vec<Arc<dyn Model>> = vec![Arc::new(other_id), Arc::new(other_provider)];
    for agent_model in agent_models {
        let aux = Arc::new(
            TestModel::new()
                .with_count(|_| 5000)
                .with_server_side_summary(true)
                .summarizing(result_of(vec![summary("anthropic", "compacted")])),
        );
        let mut agent = agent_with(agent_model, server_side_messages());
        agent.set_aux_model(Some(aux));
        assert!(apply(&per_message(), &mut agent, 0.9).await);
        assert_eq!(
            turns(agent.messages())[1],
            turn(Role::Assistant, vec![summary("anthropic", "compacted")])
        );
    }
}

#[tokio::test]
async fn summarizes_client_side_when_message_0_holds_a_tool_use() {
    let mut messages = vec![tool_use_message("t0", "read"), tool_result_message("done", "t0")];
    messages.extend(server_side_messages().into_iter().skip(1));
    let (mut agent, _) = server_side_agent(summary_result("compacted", Some("anthropic")));
    *agent.messages_mut() = messages;
    apply(&per_message(), &mut agent, 0.9).await;
    assert!(matches!(agent.messages()[0].content[0], ContentBlock::ToolUse(_)));
    assert!(!agent.messages().iter().any(|message| {
        message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::Summary(_)))
    }));
}

#[tokio::test]
async fn falls_back_to_client_side_when_message_0_is_pinned() {
    let (logs, _guard) = record_logs();
    let (mut agent, _) = server_side_agent(summary_result("compacted", Some("anthropic")));
    agent.messages_mut()[0] = pinned(user("task"));
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    assert_eq!(
        turns(agent.messages()),
        [
            (Role::User, texts(&["task"]), true),
            turn(Role::Assistant, vec![marker(3, "compacted")]),
            turn(Role::User, texts(&["recent"])),
        ]
    );
    assert!(
        logs.text()
            .contains("pinned=<1> | server-side summary does not support pinned messages")
    );
}

#[tokio::test]
async fn falls_back_to_client_side_when_a_pin_is_summarized() {
    let (logs, _guard) = record_logs();
    let (mut agent, model) = server_side_agent(summary_result("compacted", Some("anthropic")));
    *agent.messages_mut() = vec![
        user("task"),
        assistant("old1"),
        pinned(user("pin")),
        assistant("old3"),
        user("recent"),
    ];
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let calls = model.summarize_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        turns(&calls[0].0),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, texts(&["old1", "old3"]))
        ]
    );
    assert_replay_options(&calls[0].1, None);
    assert!(
        logs.text()
            .contains("pinned=<1> | server-side summary does not support pinned messages")
    );
    assert_eq!(
        turns(agent.messages()),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, vec![marker(2, "compacted")]),
            (Role::User, texts(&["pin", "recent"]), true),
        ]
    );
}

#[tokio::test]
async fn requires_both_models_to_support_server_side_summary() {
    for (agent_supports, aux_supports) in [(false, true), (true, false)] {
        let aux = Arc::new(
            TestModel::new()
                .with_count(|_| 5000)
                .with_server_side_summary(aux_supports),
        );
        let (mut agent, _) = mock_agent(server_side_messages(), agent_supports);
        agent.set_aux_model(Some(aux));
        assert!(apply(&per_message(), &mut agent, 0.9).await);
        assert_eq!(
            turns(agent.messages()),
            [
                turn(Role::User, texts(&["task"])),
                turn(Role::Assistant, vec![marker(3, "Summary of content.")]),
                turn(Role::User, texts(&["recent"])),
            ]
        );
    }
}

#[tokio::test]
async fn a_failed_server_side_summary_leaves_the_history_unchanged() {
    for (reply, log) in [
        (
            Reply::Error("overloaded".into()),
            "error=<overloaded> | summarization failed",
        ),
        (result_of(Vec::new()), "summary held no text"),
    ] {
        let (logs, _guard) = record_logs();
        let (mut agent, model) = server_side_agent(reply);
        assert!(!apply(&per_message(), &mut agent, 0.9).await);
        assert_eq!(model.summarize_calls().len(), 1);
        assert_eq!(turns(agent.messages()), turns(&server_side_messages()));
        assert!(logs.text().contains(log), "{log}");
    }
}

#[tokio::test]
async fn warns_that_a_client_side_summary_drops_kept_thinking() {
    let (logs, _guard) = record_logs();
    let (mut agent, _) = server_side_agent(summary_result("written client-side", None));
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    assert_eq!(
        turns(agent.messages()),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, vec![marker(3, "written client-side")]),
            turn(Role::User, texts(&["recent"])),
        ]
    );
    assert!(logs.text().contains("thinking blocks kept after it will be dropped"));
}

#[tokio::test]
async fn sends_an_earlier_server_side_summary_with_the_opening_messages() {
    let earlier = summary("anthropic", "fact");
    let (mut agent, model) = server_side_agent(summary_result("compacted", Some("anthropic")));
    *agent.messages_mut() = vec![
        user("task"),
        Message::new(Role::Assistant, vec![earlier.clone()]),
        user("old1"),
        assistant("old2"),
        user("recent"),
    ];
    assert!(apply(&per_message(), &mut agent, 0.9).await);
    let calls = model.summarize_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        turns(&calls[0].0),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, vec![earlier]),
            turn(Role::User, texts(&["old1"])),
            turn(Role::Assistant, texts(&["old2"])),
        ]
    );
    assert_replay_options(&calls[0].1, None);
    assert_eq!(
        turns(agent.messages()),
        [
            turn(Role::User, texts(&["task"])),
            turn(Role::Assistant, vec![summary("anthropic", "compacted")]),
            turn(Role::User, texts(&["recent"])),
        ]
    );
}

// --- client-side summaries use Model.summarize --------------------------------------------------

fn summarizing_agent(messages: Vec<Message>, reply: Option<Reply>, server_side: bool) -> (LocalAgent, Arc<TestModel>) {
    let mut model = TestModel::new()
        .with_count(|_| 5000)
        .with_server_side_summary(server_side);
    if let Some(reply) = reply {
        model = model.summarizing(reply);
    }
    let model = Arc::new(model);
    let mut agent = agent_with(model.clone(), messages);
    agent.set_system_prompt(Some(SystemPrompt::from(AGENT_PROMPT)));
    agent
        .tool_registry_mut()
        .add(MockTool::new("shell").with_description("Run a command"))
        .unwrap();
    (agent, model)
}

#[tokio::test]
async fn a_provider_override_writes_client_side_summaries() {
    let (mut agent, model) = summarizing_agent(
        tool_result_messages(),
        Some(summary_result("provider summary", None)),
        false,
    );
    assert!(apply(&per_block(None), &mut agent, 0.5).await);
    assert_eq!(turns(agent.messages())[1], summarized_tool_result("provider summary"));
    let (sent, options) = model.summarize_calls().remove(0);
    assert_eq!(
        turns(&sent),
        [turn(
            Role::User,
            vec![
                ContentBlock::text("<content>"),
                ContentBlock::text("[tool result]"),
                ContentBlock::text("x".repeat(10000)),
                ContentBlock::text("</content>"),
            ]
        )]
    );
    assert!(options.tool_specs.is_empty());
    assert_eq!(options.system_prompt, None);
}

#[tokio::test]
async fn a_server_side_model_writes_block_summaries_as_text() {
    let (mut agent, model) = summarizing_agent(
        tool_result_messages(),
        Some(summary_result("compacted", Some("anthropic"))),
        true,
    );
    assert!(apply(&per_block(None), &mut agent, 0.5).await);
    assert_eq!(model.summarize_calls().len(), 1);
    assert_eq!(turns(agent.messages())[1], summarized_tool_result("compacted"));
}

#[tokio::test]
async fn a_failed_per_message_summary_leaves_the_history_unchanged() {
    let (logs, _guard) = record_logs();
    let (mut agent, _) = summarizing_agent(server_side_messages(), Some(Reply::Error("throttled".into())), false);
    assert!(!apply(&per_message(), &mut agent, 0.9).await);
    assert_eq!(turns(agent.messages()), turns(&server_side_messages()));
    assert!(logs.text().contains("error=<throttled> | summarization failed"));
}

#[tokio::test]
async fn a_block_summary_sends_a_tool_result_after_its_tool_name() {
    let mut messages = tool_result_messages();
    messages.insert(
        1,
        Message::new(
            Role::Assistant,
            vec![ContentBlock::ToolUse(ToolUseBlock::new(
                "read_file",
                "t1",
                serde_json::json!({"path": "a.py"}),
            ))],
        ),
    );
    let (mut agent, model) = summarizing_agent(messages, None, false);
    assert!(apply(&per_block(None), &mut agent, 0.5).await);
    assert_eq!(
        turns(&model.summarize_calls()[0].0),
        [turn(
            Role::User,
            vec![
                ContentBlock::text("<content>"),
                ContentBlock::text("[tool result: read_file]"),
                ContentBlock::text("x".repeat(10000)),
                ContentBlock::text("</content>"),
            ]
        )]
    );
}

#[tokio::test]
async fn a_custom_system_prompt_reaches_client_side_summaries() {
    let (mut agent, model) = summarizing_agent(
        tool_result_messages(),
        Some(summary_result("provider summary", None)),
        false,
    );
    assert!(apply(&per_block(Some("Be very brief.")), &mut agent, 0.5).await);
    assert_eq!(
        model.summarize_calls()[0].1.instructions.as_deref(),
        Some("Be very brief.")
    );
}

#[tokio::test]
async fn a_custom_system_prompt_reaches_batch_summaries() {
    let (mut agent, model) = summarizing_agent(
        server_side_messages(),
        Some(summary_result("provider summary", None)),
        false,
    );
    let config = SummarizeConfig {
        system_prompt: Some("Be very brief.".into()),
        ..SummarizeConfig::default()
    };
    let strategy = Offload::summarize(OffloadTarget::All, config)
        .unwrap()
        .when(conditions(None, Some(0.8), Some(1.0)));
    assert!(apply(&strategy, &mut agent, 0.9).await);
    let calls = model.summarize_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(turns(&calls[0].0), turns(&server_side_messages()[..4]));
    assert_replay_options(&calls[0].1, Some("Be very brief."));
}

#[tokio::test]
async fn a_block_summary_sends_the_block_instructions_without_a_system_prompt() {
    let (mut agent, model) = summarizing_agent(tool_result_messages(), None, false);
    assert!(apply(&per_block(None), &mut agent, 0.5).await);
    let options = &model.summarize_calls()[0].1;
    assert_eq!(options.instructions.as_deref(), Some(BLOCK_SUMMARY_INSTRUCTIONS));
    assert!(options.cancel_signal.is_some());
    assert_eq!(options.agent_metadata, None);
    assert!(options.tool_specs.is_empty());
    assert_eq!(options.system_prompt, None);
}

#[tokio::test]
async fn a_block_summary_adds_its_usage_to_the_request() {
    for server_side in [false, true] {
        let (mut agent, _) = summarizing_agent(tool_result_messages(), None, server_side);
        let invocation_context = InvocationContext::new(None);
        assert!(apply_in(&per_block(None), &mut agent, 0.5, &invocation_context).await);
        let recorded = invocation_context.usage();
        assert_eq!(recorded.turns_taken, 0);
        assert_eq!(recorded.usage, stream_usage());
    }
}

#[tokio::test]
async fn a_per_message_summary_adds_its_usage_to_the_request() {
    let (mut agent, _) = summarizing_agent(server_side_messages(), None, false);
    let invocation_context = InvocationContext::new(None);
    assert!(apply_in(&per_message(), &mut agent, 0.9, &invocation_context).await);
    let recorded = invocation_context.usage();
    assert_eq!(recorded.turns_taken, 0);
    assert_eq!(recorded.usage, stream_usage());
}

#[tokio::test]
async fn a_server_side_summary_adds_its_usage_to_the_request() {
    let usage = Usage::new(100, 20, 120);
    for content in [vec![summary("anthropic", "compacted")], Vec::new()] {
        let (_logs, _guard) = record_logs();
        let acted = !content.is_empty();
        let reply = Reply::Result(SummarizeResult::new(content).with_usage(usage));
        let (mut agent, _) = server_side_agent(reply);
        let invocation_context = InvocationContext::new(None);
        assert_eq!(
            apply_in(&per_message(), &mut agent, 0.9, &invocation_context).await,
            acted
        );
        let recorded = invocation_context.usage();
        assert_eq!(recorded.turns_taken, 0);
        assert_eq!(recorded.usage, usage);
    }
}

#[tokio::test]
async fn warns_when_summarize_returns_no_text() {
    let (logs, _guard) = record_logs();
    let (mut agent, _) = summarizing_agent(tool_result_messages(), Some(result_of(Vec::new())), false);
    assert!(!apply(&per_block(None), &mut agent, 0.5).await);
    assert!(logs.text().contains("summary held no text"));
    assert_eq!(turns(agent.messages()), turns(&tool_result_messages()));
}

#[test]
fn uses_the_expected_prefix() {
    assert!(format_summarized("test", 100, None).starts_with("[Summarized:"));
}

#[test]
fn converts_text_content() {
    assert_eq!(
        tool_result_to_content_blocks(&[ToolResultContent::text("hello")]),
        [ContentBlock::text("hello")]
    );
}

#[test]
fn passes_through_images() {
    let image = ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3]));
    assert_eq!(
        tool_result_to_content_blocks(&[ToolResultContent::Image(image.clone())]),
        [ContentBlock::Image(image)]
    );
}

#[test]
fn converts_json_content_to_text() {
    assert_eq!(
        tool_result_to_content_blocks(&[
            ToolResultContent::text("plain text"),
            ToolResultContent::Json(JsonBlock::new(serde_json::json!({"key": "value", "count": 42}))),
        ]),
        [
            ContentBlock::text("plain text"),
            ContentBlock::Text(TextBlock::new("{\n  \"key\": \"value\",\n  \"count\": 42\n}")),
        ]
    );
}
