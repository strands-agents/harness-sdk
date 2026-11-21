//! Tests for the context manager, including its tool registration.

use std::sync::atomic::AtomicBool;

use super::*;
use crate::agent::InvocationState;
use crate::error::ContextWindowOverflowError;
use crate::experimental::context_manager::retrieval_tool::RETRIEVAL_TOOL_NAME;
use crate::experimental::context_manager::test_support::{
    TestModel, agent_with, assistant, tool_result_message, tool_use_message, user,
};
use crate::models::{CountTokensOptions, Model};
use crate::plugins::PluginRegistry;
use crate::types::{ContentBlock, Message, Role, ToolResultBlock, ToolResultContent};

struct Scripted {
    acts: bool,
    fails: bool,
    called: Arc<AtomicBool>,
    init_called: Arc<AtomicBool>,
    utilization: Arc<Mutex<Option<f64>>>,
}

impl Scripted {
    fn new(acts: bool) -> Self {
        Self {
            acts,
            fails: false,
            called: Arc::default(),
            init_called: Arc::default(),
            utilization: Arc::default(),
        }
    }
}

#[async_trait]
impl ContextStrategy for Scripted {
    fn name(&self) -> &str {
        "test"
    }

    fn init(&self, _agent: &mut LocalAgent, _stash: Option<&Stash>) -> Result<()> {
        self.init_called.store(true, Ordering::Relaxed);
        Ok(())
    }

    async fn apply(&self, context: &mut ContextState<'_>) -> Result<bool> {
        self.called.store(true, Ordering::Relaxed);
        *self.utilization.lock().unwrap() = Some(context.utilization);
        if self.fails {
            return Err(Error::other("summarizer rejected"));
        }
        Ok(self.acts)
    }
}

fn manager_with(strategy: impl ContextStrategy) -> ContextManager {
    ContextManager::new(ContextManagerConfig {
        strategies: Some(vec![strategy.into()]),
        ..ContextManagerConfig::default()
    })
    .unwrap()
}

fn model(count: u64, utilization: f64) -> Arc<TestModel> {
    Arc::new(
        TestModel::new()
            .with_count(move |_| count)
            .with_utilization(move |_| utilization),
    )
}

async fn installed(manager: &ContextManager, model: Arc<dyn Model>, messages: Vec<Message>) -> LocalAgent {
    let mut agent = agent_with(model, messages);
    manager.init_agent(&mut agent).await.unwrap();
    agent
}

async fn fire_overflow(agent: &mut LocalAgent) -> bool {
    fire_after_model_call(agent, Some(ContextWindowOverflowError::new("overflow").into())).await
}

async fn fire_after_model_call(agent: &mut LocalAgent, error: Option<Error>) -> bool {
    let hooks = agent.hooks().clone();
    let model = agent.model().clone();
    let mut event = AfterModelCallEvent::new(agent, InvocationState::new(), model, 1);
    if let Some(error) = error {
        event = event.with_error(error);
    }
    hooks.invoke(&mut event).await.unwrap();
    event.retry()
}

async fn fire_before_model_call(agent: &mut LocalAgent, projected: u64) {
    let hooks = agent.hooks().clone();
    let model = agent.model().clone();
    let mut event =
        BeforeModelCallEvent::new(agent, InvocationState::new(), model).with_projected_input_tokens(projected);
    hooks.invoke(&mut event).await.unwrap();
}

fn alternating(texts: &[&str]) -> Vec<Message> {
    texts
        .iter()
        .enumerate()
        .map(|(index, text)| if index % 2 == 0 { user(text) } else { assistant(text) })
        .collect()
}

#[test]
fn has_correct_plugin_name() {
    let manager = ContextManager::new(ContextManagerConfig::default()).unwrap();
    assert_eq!(manager.name(), "strands:context-manager");
}

#[test]
fn accepts_custom_strategies() {
    let manager = manager_with(Scripted::new(false));
    assert_eq!(manager.strategies.len(), 2);
}

#[test]
fn returns_a_context_manager_instance_as_is() {
    let manager = manager_with(Scripted::new(false));
    let resolved = ContextManager::from_strategy(Some(manager.clone().into()))
        .unwrap()
        .unwrap();
    assert_eq!(resolved, manager);
}

#[tokio::test]
async fn registers_after_model_call_event_hook() {
    let manager = Arc::new(ContextManager::new(ContextManagerConfig::default()).unwrap());
    let agent = installed(&manager, Arc::new(TestModel::new()), Vec::new()).await;
    assert!(!agent.hooks().is_empty());
}

#[tokio::test]
async fn initializes_strategies_with_init_context() {
    let strategy = Scripted::new(false);
    let init_called = strategy.init_called.clone();
    let manager = manager_with(strategy);
    installed(&manager, Arc::new(TestModel::new()), Vec::new()).await;
    assert!(init_called.load(Ordering::Relaxed));
}

#[tokio::test]
async fn uses_an_explicitly_configured_scoped_stash_storage_as_the_exact_root() {
    let storage = InMemoryStorage::new();
    let manager = Arc::new(
        ContextManager::new(ContextManagerConfig {
            stash: Some(
                crate::experimental::context_manager::StashConfig {
                    storage: Some(Arc::new(storage.namespace("team").unwrap())),
                    ..Default::default()
                }
                .into(),
            ),
            ..ContextManagerConfig::default()
        })
        .unwrap(),
    );
    installed(&manager, Arc::new(TestModel::new()), Vec::new()).await;
    manager.stash().unwrap().store("tool-1", 0, b"{}").await.unwrap();
    assert_eq!(storage.list("").await.unwrap(), ["team/tool-1_0"]);
}

#[tokio::test]
async fn keeps_the_per_agent_root_under_a_scoped_agent_storage() {
    let storage = InMemoryStorage::new();
    let manager = Arc::new(ContextManager::new(ContextManagerConfig::default()).unwrap());
    let mut agent = agent_with(Arc::new(TestModel::new()), Vec::new());
    agent.set_session_id("test-ses".into());
    agent.set_storage(Some(Arc::new(storage.namespace("tenant").unwrap())));
    manager.init_agent(&mut agent).await.unwrap();
    manager.stash().unwrap().store("tool-1", 0, b"{}").await.unwrap();
    assert_eq!(
        storage.list("").await.unwrap(),
        ["tenant/context/test-ses/scopes/agent/test-agent/tool-1_0"]
    );
}

#[tokio::test]
async fn does_not_overwrite_a_stashed_original_with_a_seeded_preview() {
    let storage = InMemoryStorage::new();
    let view = Arc::new(storage.namespace("team").unwrap());
    view.write("tu-1_0", br#"{"text":"original full result"}"#)
        .await
        .unwrap();
    let preview = Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tu-1",
            vec![ToolResultContent::Text(crate::types::TextBlock::offloaded(
                "[Truncated: 1 block, ~7,500 tokens] preview [ref: tu-1]",
                crate::types::Offloaded::new(crate::types::OffloadMethod::Truncate).with_reference("tu-1"),
            ))],
        ))],
    );
    let manager = Arc::new(
        ContextManager::new(ContextManagerConfig {
            stash: Some(
                crate::experimental::context_manager::StashConfig {
                    storage: Some(view),
                    ..Default::default()
                }
                .into(),
            ),
            ..ContextManagerConfig::default()
        })
        .unwrap(),
    );
    installed(&manager, Arc::new(TestModel::new()), vec![preview]).await;
    assert_eq!(
        manager.stash().unwrap().retrieve("tu-1_0").await.unwrap(),
        Some(serde_json::json!({"text": "original full result"}))
    );
}

#[tokio::test]
async fn does_not_overwrite_a_stashed_original_with_a_text_only_preview_from_a_session_without_placeholder_metadata() {
    let storage = InMemoryStorage::new();
    let view = Arc::new(storage.namespace("team").unwrap());
    view.write("tu-1_0", br#"{"text":"original full result"}"#)
        .await
        .unwrap();
    view.write("msg-1_0", br#"{"text":"original user text"}"#)
        .await
        .unwrap();
    let restored = Message::new(
        Role::User,
        vec![
            ContentBlock::text("[Truncated: ~2,000 tokens] original [ref: msg-1_0]"),
            ContentBlock::ToolResult(ToolResultBlock::success(
                "tu-1",
                vec![ToolResultContent::text(
                    "[Truncated: 1 block, ~7,500 tokens] preview [ref: tu-1_0]",
                )],
            )),
        ],
    )
    .with_tracking_id("msg-1");
    let manager = Arc::new(
        ContextManager::new(ContextManagerConfig {
            stash: Some(
                crate::experimental::context_manager::StashConfig {
                    storage: Some(view),
                    ..Default::default()
                }
                .into(),
            ),
            ..ContextManagerConfig::default()
        })
        .unwrap(),
    );
    installed(&manager, Arc::new(TestModel::new()), vec![restored]).await;
    let stash = manager.stash().unwrap();
    assert_eq!(
        stash.retrieve("tu-1_0").await.unwrap(),
        Some(serde_json::json!({"text": "original full result"}))
    );
    assert_eq!(
        stash.retrieve("msg-1_0").await.unwrap(),
        Some(serde_json::json!({"text": "original user text"}))
    );
}

#[tokio::test]
async fn runs_strategies_on_context_window_overflow_error_and_sets_retry() {
    let strategy = Scripted::new(true);
    let called = strategy.called.clone();
    let manager = manager_with(strategy);
    let mut agent = installed(&manager, model(0, 0.0), Vec::new()).await;
    assert!(fire_overflow(&mut agent).await);
    assert!(called.load(Ordering::Relaxed));
}

#[tokio::test]
async fn does_not_run_strategies_on_non_overflow_errors() {
    let strategy = Scripted::new(true);
    let called = strategy.called.clone();
    let manager = manager_with(strategy);
    let mut agent = installed(&manager, model(0, 0.0), Vec::new()).await;
    assert!(!fire_after_model_call(&mut agent, Some(Error::other("some other error"))).await);
    assert!(!called.load(Ordering::Relaxed));
}

#[tokio::test]
async fn truncates_when_utilization_remains_ge_1_0_after_strategies() {
    let messages = alternating(&[
        "system",
        "response 1",
        "msg 2",
        "response 2",
        "msg 3",
        "response 3",
        "msg 4",
        "response 4",
        "msg 5",
        "response 5",
    ]);
    let manager = manager_with(Scripted::new(false));
    let mut agent = installed(&manager, model(10000, 1.5), messages).await;
    assert!(fire_overflow(&mut agent).await);
    assert!(agent.messages().len() < 10);
}

#[tokio::test]
async fn truncates_when_a_strategy_throws() {
    let messages: Vec<Message> = (0..10)
        .map(|index| {
            if index % 2 == 0 {
                user(&format!("msg {index}"))
            } else {
                assistant(&format!("msg {index}"))
            }
        })
        .collect();
    let mut strategy = Scripted::new(false);
    strategy.fails = true;
    let manager = manager_with(strategy);
    let mut agent = installed(&manager, model(10000, 1.5), messages).await;
    assert!(fire_overflow(&mut agent).await);
    assert!(agent.messages().len() < 10);
}

#[tokio::test]
async fn continues_when_the_recount_after_a_strategy_fails() {
    let first = Scripted::new(true);
    let second = Scripted::new(false);
    let second_called = second.called.clone();
    let manager = Arc::new(
        ContextManager::new(ContextManagerConfig {
            strategies: Some(vec![first.into(), second.into()]),
            ..ContextManagerConfig::default()
        })
        .unwrap(),
    );
    let failing = Arc::new(TestModel::new().with_utilization(|_| 0.9).with_failing_count());
    let mut agent = installed(&manager, failing, alternating(&["a", "b"])).await;
    fire_before_model_call(&mut agent, 100).await;
    assert!(second_called.load(Ordering::Relaxed));
}

#[tokio::test]
async fn does_not_truncate_on_non_overflow_when_utilization_is_below_1_0() {
    let messages = alternating(&["system", "response 1", "msg 2", "response 2", "msg 3", "response 3"]);
    let manager = manager_with(Scripted::new(false));
    let mut agent = installed(&manager, model(100, 0.5), messages).await;
    fire_before_model_call(&mut agent, 100).await;
    assert_eq!(agent.messages().len(), 6);
}

#[tokio::test]
async fn emergency_truncate_fires_when_estimate_undercounts_on_overflow() {
    let messages = alternating(&[
        "system",
        "response 1",
        "msg 2",
        "response 2",
        "msg 3",
        "response 3",
        "msg 4",
        "response 4",
    ]);
    let manager = manager_with(Scripted::new(false));
    let mut agent = installed(&manager, model(100, 0.5), messages).await;
    assert!(fire_overflow(&mut agent).await);
    assert!(agent.messages().len() < 8);
}

#[tokio::test]
async fn caps_retries_at_3_and_stops_setting_retry() {
    let messages = alternating(&["system", "a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    let manager = manager_with(Scripted::new(false));
    let mut agent = installed(&manager, model(10000, 1.5), messages).await;
    for _ in 0..3 {
        assert!(fire_overflow(&mut agent).await);
    }
    assert!(!fire_overflow(&mut agent).await);
}

#[tokio::test]
async fn resets_retry_counter_on_successful_non_overflow_model_call() {
    let mut messages = vec![user("system")];
    for index in 0..20 {
        messages.push(assistant(&format!("r{index}")));
        messages.push(user(&format!("m{index}")));
    }
    let manager = manager_with(Scripted::new(false));
    let mut agent = installed(&manager, model(10000, 1.5), messages).await;
    for _ in 0..2 {
        assert!(fire_overflow(&mut agent).await);
    }
    fire_after_model_call(&mut agent, None).await;
    for _ in 0..3 {
        assert!(fire_overflow(&mut agent).await);
    }
}

#[tokio::test]
async fn preserves_the_first_message_content() {
    let messages = alternating(&["system prompt", "r1", "m2", "r2", "m3", "r3", "m4", "r4", "m5", "r5"]);
    let manager = manager_with(Scripted::new(false));
    let mut agent = installed(&manager, model(10000, 1.5), messages).await;
    fire_overflow(&mut agent).await;
    assert_eq!(agent.messages()[0].content[0].as_text(), Some("system prompt"));
}

#[tokio::test]
async fn does_not_orphan_tool_use_tool_result_pairs_in_preserved_region() {
    let mut messages = vec![
        user("system"),
        tool_use_message("tu-1", "myTool"),
        tool_result_message("result", "tu-1"),
    ];
    messages.extend(
        alternating(&["after tool", "m4", "r4", "m5", "r5", "m6", "r6", "m7", "r7"])
            .into_iter()
            .map(|message| {
                let role = if message.role == Role::User {
                    Role::Assistant
                } else {
                    Role::User
                };
                Message::new(role, message.content)
            }),
    );
    let manager = manager_with(Scripted::new(false));
    let mut agent = installed(&manager, model(10000, 1.5), messages).await;
    fire_overflow(&mut agent).await;
    let blocks: Vec<&ContentBlock> = agent.messages().iter().flat_map(|message| &message.content).collect();
    let has_use = blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolUse(tool_use) if tool_use.name == "myTool"));
    let has_result = blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult(result) if result.tool_use_id == "tu-1"));
    if has_use {
        assert!(has_result);
    }
}

#[tokio::test]
async fn does_not_truncate_when_messages_le_3() {
    let manager = manager_with(Scripted::new(false));
    let mut agent = installed(&manager, model(10000, 1.5), alternating(&["system", "r1", "m2"])).await;
    fire_overflow(&mut agent).await;
    assert_eq!(agent.messages().len(), 3);
}

#[tokio::test]
async fn runs_strategies_with_projected_input_tokens() {
    let strategy = Scripted::new(false);
    let utilization = strategy.utilization.clone();
    let manager = manager_with(strategy);
    let model = Arc::new(TestModel::new().with_utilization(|tokens| tokens as f64 / 10000.0));
    let mut agent = installed(&manager, model, Vec::new()).await;
    fire_before_model_call(&mut agent, 5000).await;
    assert_eq!(*utilization.lock().unwrap(), Some(0.5));
}

#[tokio::test]
async fn registers_retrieve_context_after_plugin_initialization() {
    let manager: Arc<dyn Plugin> = Arc::new(ContextManager::new(ContextManagerConfig::default()).unwrap());
    let mut agent = agent_with(Arc::new(TestModel::new()), Vec::new());
    PluginRegistry::new(vec![manager]).initialize(&mut agent).await.unwrap();
    assert!(agent.tool_registry().get(RETRIEVAL_TOOL_NAME).is_some());
}

#[tokio::test]
async fn does_not_register_retrieve_context_when_stash_is_disabled() {
    let manager: Arc<dyn Plugin> = Arc::new(
        ContextManager::new(ContextManagerConfig {
            stash: Some(false.into()),
            ..ContextManagerConfig::default()
        })
        .unwrap(),
    );
    let mut agent = agent_with(Arc::new(TestModel::new()), Vec::new());
    PluginRegistry::new(vec![manager]).initialize(&mut agent).await.unwrap();
    assert!(agent.tool_registry().get(RETRIEVAL_TOOL_NAME).is_none());
}

#[tokio::test]
async fn keeps_the_stash_but_not_the_tool_when_the_retrieval_tool_is_off() {
    let manager = Arc::new(
        ContextManager::new(ContextManagerConfig {
            stash: Some(
                crate::experimental::context_manager::StashConfig {
                    retrieval_tool: Some(false),
                    ..Default::default()
                }
                .into(),
            ),
            ..ContextManagerConfig::default()
        })
        .unwrap(),
    );
    let mut agent = agent_with(Arc::new(TestModel::new()), Vec::new());
    PluginRegistry::new(vec![manager.clone() as Arc<dyn Plugin>])
        .initialize(&mut agent)
        .await
        .unwrap();
    assert!(agent.tool_registry().get(RETRIEVAL_TOOL_NAME).is_none());
    assert!(manager.stash().is_some());
    assert!(!manager.stash_is_durable());
}

#[tokio::test]
async fn backfills_stash_from_pre_existing_messages_at_init() {
    let text = "restored content ".repeat(500);
    let manager = Arc::new(ContextManager::new(ContextManagerConfig::default()).unwrap());
    installed(
        &manager,
        Arc::new(TestModel::new()),
        vec![tool_result_message(&text, "tool-123")],
    )
    .await;
    let stash = manager.stash().unwrap();
    let keys = stash.list("").await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(
        stash.retrieve(&keys[0]).await.unwrap().unwrap()["text"],
        serde_json::json!(text)
    );
}

#[tokio::test]
async fn stashes_messages_as_they_arrive_and_skips_retrieval_results() {
    let manager = Arc::new(ContextManager::new(ContextManagerConfig::default()).unwrap());
    let mut agent = installed(&manager, Arc::new(TestModel::new()), Vec::new()).await;
    for message in [
        tool_use_message("call-1", RETRIEVAL_TOOL_NAME),
        tool_result_message("retrieved", "call-1"),
        tool_result_message("fresh", "call-2"),
    ] {
        agent.messages_mut().push(message.clone());
        let hooks = agent.hooks().clone();
        let mut event = MessageAddedEvent::new(&mut agent, InvocationState::new(), message);
        hooks.invoke(&mut event).await.unwrap();
    }
    assert_eq!(manager.stash().unwrap().list("").await.unwrap(), ["call-2_0"]);
}

#[tokio::test]
async fn reports_a_durable_stash_for_persistent_storage() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Arc::new(
        ContextManager::new(ContextManagerConfig {
            stash: Some(
                crate::experimental::context_manager::StashConfig {
                    storage: Some(Arc::new(crate::storage::LocalFileStorage::new(dir.path()))),
                    ..Default::default()
                }
                .into(),
            ),
            ..ContextManagerConfig::default()
        })
        .unwrap(),
    );
    installed(&manager, Arc::new(TestModel::new()), Vec::new()).await;
    assert!(manager.stash_is_durable());
    assert_eq!(manager.stash().unwrap().storage_type_name(), "LocalFileStorage");
}

#[tokio::test]
async fn gives_each_agent_of_a_shared_manager_its_own_stash() {
    let manager = Arc::new(ContextManager::new(ContextManagerConfig::default()).unwrap());
    let mut first = LocalAgent::new("first", Arc::new(TestModel::new()));
    *first.messages_mut() = vec![tool_result_message("first content", "call-first")];
    let mut second = LocalAgent::new("second", Arc::new(TestModel::new()));
    *second.messages_mut() = vec![tool_result_message("second content", "call-second")];
    for agent in [&mut first, &mut second] {
        PluginRegistry::new(vec![manager.clone() as Arc<dyn Plugin>])
            .initialize(agent)
            .await
            .unwrap();
    }

    let first_stash = first.context_stash().unwrap().stash.clone();
    let second_stash = second.context_stash().unwrap().stash.clone();
    assert_eq!(first_stash.list("").await.unwrap(), ["call-first_0"]);
    assert_eq!(second_stash.list("").await.unwrap(), ["call-second_0"]);
    assert_eq!(manager.stash().unwrap().list("").await.unwrap(), ["call-second_0"]);

    let message = tool_result_message("later", "call-later");
    first.messages_mut().push(message.clone());
    let hooks = first.hooks().clone();
    let mut event = MessageAddedEvent::new(&mut first, InvocationState::new(), message);
    hooks.invoke(&mut event).await.unwrap();
    assert_eq!(first_stash.list("").await.unwrap(), ["call-first_0", "call-later_0"]);
    assert_eq!(second_stash.list("").await.unwrap(), ["call-second_0"]);

    let retrieve = first.tool_registry().get(RETRIEVAL_TOOL_NAME).unwrap();
    let second_retrieve = second.tool_registry().get(RETRIEVAL_TOOL_NAME).unwrap();
    assert!(!Arc::ptr_eq(retrieve, second_retrieve));
}

async fn fire_before_model_call_unprojected(agent: &mut LocalAgent) {
    let hooks = agent.hooks().clone();
    let model = agent.model().clone();
    let mut event = BeforeModelCallEvent::new(agent, InvocationState::new(), model);
    hooks.invoke(&mut event).await.unwrap();
}

fn without_stash(strategy: impl ContextStrategy) -> ContextManager {
    ContextManager::new(ContextManagerConfig {
        strategies: Some(vec![strategy.into()]),
        stash: Some(Toggle::Off),
    })
    .unwrap()
}

#[tokio::test]
async fn counts_the_system_prompt_and_tool_specs_alongside_the_messages() {
    let model = model(100, 0.5);
    let manager = without_stash(Scripted::new(true));
    let mut agent = agent_with(model.clone(), vec![user("hello")]);
    agent.set_system_prompt(Some(crate::types::SystemPrompt::from("be helpful")));
    agent
        .tool_registry_mut()
        .add(crate::test_support::MockTool::new("lookup"))
        .unwrap();
    manager.init_agent(&mut agent).await.unwrap();
    // No projected input tokens, so the initial gate counts too; both counts see the same inputs.
    fire_before_model_call_unprojected(&mut agent).await;
    let expected = CountTokensOptions {
        system_prompt: Some(crate::types::SystemPrompt::from("be helpful")),
        tool_specs: agent
            .tool_registry()
            .list()
            .iter()
            .map(|tool| tool.tool_spec())
            .collect(),
    };
    assert_eq!(model.count_options(), [expected.clone(), expected]);
}

#[tokio::test]
async fn omits_the_system_prompt_when_the_agent_has_none() {
    let model = model(100, 0.5);
    let manager = without_stash(Scripted::new(false));
    let mut agent = agent_with(model.clone(), vec![user("hello")]);
    manager.init_agent(&mut agent).await.unwrap();
    fire_before_model_call_unprojected(&mut agent).await;
    assert_eq!(model.count_options(), [CountTokensOptions::default()]);
}

// The gate measures the messages it would drop, not the whole request the other gates measure.
#[tokio::test]
async fn leaves_messages_that_fit_the_window_in_the_emergency_truncate_gate() {
    // The request is over the window, the messages are a tenth of it: dropping them cannot be what
    // helps.
    let model = Arc::new(
        TestModel::new()
            .with_count(|_| 1_000)
            .with_utilization(|tokens| tokens as f64 / 10_000.0),
    );
    let manager = without_stash(Scripted::new(false));
    let mut agent = agent_with(model.clone(), alternating(&["a", "b", "c", "d"]));
    agent.set_system_prompt(Some(crate::types::SystemPrompt::from("be helpful")));
    agent
        .tool_registry_mut()
        .add(crate::test_support::MockTool::new("lookup"))
        .unwrap();
    manager.init_agent(&mut agent).await.unwrap();
    fire_before_model_call(&mut agent, 20_000).await;
    assert_eq!(agent.messages().len(), 4);
    assert_eq!(model.count_calls().len(), 1);
}
