//! The context manager on a real agent: storage, the token-usage middleware and server-side
//! summaries.

use super::*;
use crate::Agent;
use crate::conversation_manager::SlidingWindowConversationManager;
use crate::experimental::context_manager::{OffloadConditions, OffloadTarget, SummarizeConfig};
use crate::models::streaming::Usage;
use crate::models::{BaseModelConfig, CountTokensOptions, Model, ModelInfo};
use crate::testing::{MockModel, MockTurn};
use crate::types::{ContentBlock, Message};

fn model() -> MockModel {
    MockModel::new().with_turn("hi")
}

fn agent(context_manager: Option<ContextManagerStrategy>) -> Agent {
    Agent::builder()
        .model(model())
        .maybe_context_manager(context_manager)
        .printer(false)
        .build()
        .unwrap()
}

fn noop_config() -> ContextManagerConfig {
    struct Noop;

    #[async_trait]
    impl ContextStrategy for Noop {
        fn name(&self) -> &str {
            "noop"
        }

        async fn apply(&self, _context: &mut ContextState<'_>) -> Result<bool> {
            Ok(false)
        }
    }

    ContextManagerConfig {
        strategies: Some(vec![Noop.into()]),
        ..ContextManagerConfig::default()
    }
}

fn manager_name(agent: &Agent) -> &str {
    agent.conversation_manager.name()
}

const NULL: &str = "strands:null-conversation-manager";
const SLIDING: &str = "strands:sliding-window-conversation-manager";

#[test]
fn uses_sliding_window_conversation_manager() {
    assert_eq!(manager_name(&agent(None)), SLIDING);
}

#[test]
fn does_not_set_context_manager() {
    assert!(agent(None).context_manager().is_none());
}

#[test]
fn auto_uses_null_conversation_manager() {
    assert_eq!(manager_name(&agent(Some(ContextManagerStrategy::Auto))), NULL);
}

#[test]
fn auto_creates_a_context_manager_instance() {
    assert!(agent(Some(ContextManagerStrategy::Auto)).context_manager().is_some());
}

#[tokio::test]
async fn auto_registers_context_manager_as_a_plugin() {
    let mut agent = agent(Some(ContextManagerStrategy::Auto));
    agent.invoke("hi").await.unwrap();
    assert!(agent.plugins.names().iter().any(|name| name == CONTEXT_MANAGER_NAME));
}

#[test]
fn ignores_user_provided_conversation_manager() {
    let agent = Agent::builder()
        .model(model())
        .context_manager(ContextManagerStrategy::Auto)
        .conversation_manager(Arc::new(SlidingWindowConversationManager::default()))
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(manager_name(&agent), NULL);
}

#[test]
fn agentic_uses_null_conversation_manager() {
    assert_eq!(manager_name(&agent(Some(ContextManagerStrategy::Agentic))), NULL);
}

#[test]
fn agentic_creates_a_context_manager_instance() {
    assert!(agent(Some(ContextManagerStrategy::Agentic)).context_manager().is_some());
}

#[test]
fn throws_when_used_with_a_stateful_model() {
    let model = model();
    let mut info = ModelInfo::default();
    info.capabilities.stateful = Some(true);
    model
        .update_config(BaseModelConfig {
            model_info: Some(info),
            ..BaseModelConfig::default()
        })
        .unwrap();
    let error = Agent::builder()
        .model(model.clone())
        .context_manager(ContextManagerStrategy::Auto)
        .printer(false)
        .build()
        .unwrap_err();
    assert!(error.to_string().contains("stateful model"));
    assert!(
        Agent::builder()
            .model(model)
            .context_manager(ContextManagerStrategy::Disabled)
            .printer(false)
            .build()
            .is_ok()
    );
}

#[test]
fn uses_null_conversation_manager_when_no_conversation_manager_provided() {
    assert_eq!(manager_name(&agent(Some(ContextManagerStrategy::Disabled))), NULL);
}

#[test]
fn uses_user_provided_conversation_manager() {
    let agent = Agent::builder()
        .model(model())
        .context_manager(ContextManagerStrategy::Disabled)
        .conversation_manager(Arc::new(SlidingWindowConversationManager::default()))
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(manager_name(&agent), SLIDING);
}

#[test]
fn false_does_not_set_context_manager() {
    assert!(
        agent(Some(ContextManagerStrategy::Disabled))
            .context_manager()
            .is_none()
    );
}

#[test]
fn config_uses_null_conversation_manager() {
    assert_eq!(manager_name(&agent(Some(noop_config().into()))), NULL);
}

#[tokio::test]
async fn config_registers_context_manager_as_a_plugin() {
    let mut agent = agent(Some(noop_config().into()));
    agent.invoke("hi").await.unwrap();
    assert!(agent.plugins.names().iter().any(|name| name == CONTEXT_MANAGER_NAME));
}

#[test]
fn uses_the_instance_as_is() {
    let manager = ContextManager::new(noop_config()).unwrap();
    let agent = agent(Some(manager.clone().into()));
    assert_eq!(agent.context_manager().unwrap(), &manager);
    assert_eq!(manager_name(&agent), NULL);
}

#[tokio::test]
async fn registers_the_instance_as_a_plugin() {
    let manager = Arc::new(ContextManager::new(noop_config()).unwrap());
    let mut agent = agent(Some(manager.clone().into()));
    agent.invoke("hi").await.unwrap();
    assert!(agent.plugins.names().iter().any(|name| name == CONTEXT_MANAGER_NAME));
    assert!(manager.stash().is_some());
}

#[tokio::test]
async fn auto_created_context_manager_uses_agent_storage_when_provided() {
    let storage = Arc::new(InMemoryStorage::new());
    let mut agent = Agent::builder()
        .model(model())
        .context_manager(ContextManagerStrategy::Auto)
        .storage(storage.clone())
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("hi").await.unwrap();
    let manager = agent.context_manager().unwrap();
    assert!(manager.stash().is_some());
    let session = agent.local.session_id().to_owned();
    let keys = storage.list("").await.unwrap();
    assert!(!keys.is_empty());
    assert!(
        keys.iter()
            .all(|key| key.starts_with(&format!("context/{session}/scopes/agent/agent/")))
    );
}

#[tokio::test]
async fn auto_created_context_manager_uses_in_memory_storage_when_no_agent_storage() {
    let mut agent = agent(Some(ContextManagerStrategy::Auto));
    agent.invoke("hi").await.unwrap();
    let manager = agent.context_manager().unwrap();
    assert_eq!(manager.stash().unwrap().storage_type_name(), "InMemoryStorage");
    assert!(!manager.stash_is_durable());
}

fn usage(input: u64, output: u64) -> Usage {
    Usage::new(input, output, input + output)
}

fn with_limit(model: MockModel) -> MockModel {
    model
        .update_config(BaseModelConfig {
            context_window_limit: Some(100_000),
            ..BaseModelConfig::default()
        })
        .unwrap();
    model
}

fn last_block_text(request: &crate::models::ModelRequest) -> String {
    let last = request.messages.last().unwrap();
    last.content
        .last()
        .and_then(ContentBlock::as_text)
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn injects_context_status_into_messages_sent_to_model_on_second_call() {
    let model = with_limit(MockModel::from_turns([
        MockTurn::text("First response").with_usage(usage(1000, 200)),
        MockTurn::text("Second response").with_usage(usage(2000, 300)),
    ]));
    let mut agent = Agent::builder()
        .model(model.clone())
        .context_manager(ContextManagerStrategy::Agentic)
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("First message").await.unwrap();
    agent.invoke("Second message").await.unwrap();
    let text = last_block_text(&model.requests()[1]);
    assert!(text.contains("<context-status>"));
    assert!(text.contains("100,000"));
    assert!(text.contains("<remaining>"));
}

#[tokio::test]
async fn injects_on_first_call_when_token_estimation_succeeds() {
    let model = with_limit(MockModel::new().with_turn(MockTurn::text("First response").with_usage(usage(1000, 200))));
    let mut agent = Agent::builder()
        .model(model.clone())
        .context_manager(ContextManagerStrategy::Agentic)
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("First message").await.unwrap();
    let text = last_block_text(&model.requests()[0]);
    assert!(text.contains("<context-status>"));
    assert!(text.contains("100,000"));
}

#[tokio::test]
async fn stores_its_summary_as_text() {
    let model = MockModel::from_turns([MockTurn::text("a summary"), MockTurn::text("reply")]);
    model
        .update_config(BaseModelConfig {
            model_id: Some("claude-sonnet-5-5".into()),
            ..BaseModelConfig::default()
        })
        .unwrap();
    assert_eq!(model.model_info().capabilities.server_side_summary, Some(true));
    let messages = vec![
        Message::user("task"),
        Message::assistant("old1"),
        Message::user("old2"),
        Message::assistant("old3"),
        Message::user("recent"),
    ];
    let tokens = model
        .count_tokens(&messages[1..4], CountTokensOptions::default())
        .await
        .unwrap();
    let mut agent = Agent::builder()
        .model(model.clone())
        .messages(messages)
        .printer(false)
        .build()
        .unwrap();
    let strategy =
        crate::experimental::context_manager::Offload::summarize(OffloadTarget::All, SummarizeConfig::default())
            .unwrap()
            .when(OffloadConditions {
                context_utilization: Some("80%".into()),
                preserve_recent: Some(1.into()),
                ..OffloadConditions::default()
            })
            .unwrap();
    let mut state = ContextState::new(&mut agent.local, 0.9);
    assert!(strategy.apply(&mut state).await.unwrap());
    agent.invoke("next").await.unwrap();
    let marker = super::super::placeholder::offload_placeholder(
        crate::types::OffloadMethod::Summarize,
        &super::super::placeholder::format_summarized(
            super::super::placeholder::REMOVED_MESSAGES,
            tokens,
            Some("a summary"),
        ),
        None,
        tokens,
    );
    let shape: Vec<(crate::types::Role, Vec<ContentBlock>)> = agent.messages()[..3]
        .iter()
        .map(|message| (message.role, message.content.clone()))
        .collect();
    assert_eq!(
        shape,
        [
            (crate::types::Role::User, vec![ContentBlock::text("task")]),
            (crate::types::Role::Assistant, vec![ContentBlock::Text(marker)]),
            (crate::types::Role::User, vec![ContentBlock::text("recent")]),
        ]
    );
    let sent_summary = model
        .requests()
        .iter()
        .flat_map(|request| request.messages.iter().flat_map(|message| message.content.clone()))
        .any(|block| matches!(block, ContentBlock::Summary(_)));
    assert!(!sent_summary);
}

#[tokio::test]
async fn stores_and_sends_the_model_its_text_and_resolves_the_tool_use_id_to_the_original() {
    let rows: String = (1..=5000)
        .map(|index| format!("row-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let tool_rows = rows.clone();
    let tool = crate::test_support::MockTool::new("rows")
        .with_description("lists rows")
        .with_result(move |context| {
            crate::types::ToolResultBlock::success(
                context.tool_use().tool_use_id.clone(),
                vec![crate::types::ToolResultContent::text(tool_rows.clone())],
            )
            .into()
        });
    let model = MockModel::new()
        .with_turn(MockTurn::content([crate::types::ToolUseBlock::new(
            "rows",
            "tu-1",
            serde_json::json!({}),
        )]))
        .with_turn("done");
    let truncate = crate::experimental::context_manager::Offload::truncate(
        OffloadTarget::ToolResults,
        crate::experimental::context_manager::TruncateConfig {
            preview_tokens: Some(100.0),
            ..Default::default()
        },
    )
    .unwrap()
    .when(OffloadConditions {
        block_threshold: Some(200.into()),
        ..OffloadConditions::default()
    })
    .unwrap();
    let mut agent = Agent::builder()
        .model(model.clone())
        .tools([crate::tools::ToolSource::from(tool)])
        .printer(false)
        .context_manager(ContextManagerStrategy::Config(ContextManagerConfig {
            strategies: Some(vec![truncate.into()]),
            ..ContextManagerConfig::default()
        }))
        .build()
        .unwrap();
    agent.invoke("list the rows").await.unwrap();
    let ContentBlock::ToolResult(result) = &agent.messages()[2].content[0] else {
        panic!("not a tool result");
    };
    let crate::types::ToolResultContent::Text(stored) = &result.content[0] else {
        panic!("not text");
    };
    let offloaded = stored.offloaded.as_ref().expect("a placeholder");
    assert_eq!(offloaded.method, crate::types::OffloadMethod::Truncate);
    assert_eq!(offloaded.reference.as_deref(), Some("tu-1"));
    assert!(offloaded.tokens.is_some());
    assert!(stored.text.ends_with(" [ref: tu-1]"));
    let sent = &model.requests()[1].messages[2].content[0];
    let ContentBlock::ToolResult(sent) = sent else {
        panic!("not a tool result");
    };
    let crate::types::ToolResultContent::Text(received) = &sent.content[0] else {
        panic!("not text");
    };
    assert_eq!(received.text, stored.text);
    let stash = agent.context_manager().unwrap().stash().unwrap();
    for reference in ["tu-1", "tu-1_0"] {
        let input = serde_json::from_value(serde_json::json!({"reference": reference, "pattern": "row-4321"})).unwrap();
        let found = super::super::retrieval_tool::retrieve_context(&stash, input, 40_000)
            .await
            .unwrap();
        assert!(found.as_str().unwrap().contains("row-4321"), "{reference}");
    }
}
