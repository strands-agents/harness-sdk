use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use async_trait::async_trait;

use super::*;
use crate::agent::InvocationState;
use crate::hooks::BeforeInvocationEvent;
use crate::plugins::ModelPlugin;
use crate::test_support::{MockTool, local_agent};
use crate::testing::MockModel;
use crate::tools::{Tool, ToolSource};
use crate::types::Message;

#[derive(Default)]
struct TestPlugin {
    name: String,
    hook_called: Arc<AtomicBool>,
}

impl TestPlugin {
    fn named(name: &str) -> Arc<Self> {
        Arc::new(Self {
            name: name.to_owned(),
            hook_called: Arc::default(),
        })
    }
}

#[async_trait]
impl Plugin for TestPlugin {
    fn name(&self) -> &str {
        &self.name
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        let called = self.hook_called.clone();
        agent.add_hook(move |_: &mut BeforeInvocationEvent<'_>| called.store(true, Ordering::SeqCst));
        Ok(())
    }
}

#[derive(Default)]
struct InitializablePlugin {
    initialized: AtomicBool,
    calls: AtomicUsize,
}

#[async_trait]
impl Plugin for InitializablePlugin {
    fn name(&self) -> &str {
        "initializable-plugin"
    }

    async fn init_agent(&self, _agent: &mut LocalAgent) -> Result<()> {
        tokio::task::yield_now().await;
        self.initialized.store(true, Ordering::SeqCst);
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct ToolProviderPlugin {
    initialized: AtomicBool,
    tools: Vec<Arc<dyn Tool>>,
}

#[async_trait]
impl Plugin for ToolProviderPlugin {
    fn name(&self) -> &str {
        "tool-provider"
    }

    async fn init_agent(&self, _agent: &mut LocalAgent) -> Result<()> {
        self.initialized.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn get_tools(&self) -> Vec<ToolSource> {
        if self.initialized.load(Ordering::SeqCst) {
            self.tools.iter().cloned().map(ToolSource::from).collect()
        } else {
            Vec::new()
        }
    }
}

struct FailingPlugin {
    calls: AtomicUsize,
}

#[async_trait]
impl Plugin for FailingPlugin {
    fn name(&self) -> &str {
        "failing-plugin"
    }

    async fn init_agent(&self, _agent: &mut LocalAgent) -> Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(crate::error::SessionError::new("plugin initialization failed").into())
    }
}

#[tokio::test]
async fn initializes_a_plugin_and_calls_init_agent() {
    let plugin = Arc::new(InitializablePlugin::default());
    let mut registry = PluginRegistry::new(vec![plugin.clone()]);
    registry.initialize(&mut local_agent()).await.unwrap();
    assert!(plugin.initialized.load(Ordering::SeqCst));
}

#[tokio::test]
async fn registers_hooks_via_agent_add_hook() {
    let mut agent = local_agent();
    let mut registry = PluginRegistry::new(vec![TestPlugin::named("test-plugin")]);
    registry.initialize(&mut agent).await.unwrap();
    assert_eq!(agent.hooks().len(), 1);
}

#[tokio::test]
async fn throws_error_when_plugins_have_duplicate_names() {
    let mut registry = PluginRegistry::new(vec![
        TestPlugin::named("duplicate-name"),
        TestPlugin::named("duplicate-name"),
    ]);
    let error = registry.initialize(&mut local_agent()).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "plugin_name=<duplicate-name> | plugin already registered"
    );
}

#[tokio::test]
async fn initializes_multiple_plugins_with_different_names() {
    let mut agent = local_agent();
    let mut registry = PluginRegistry::new(vec![TestPlugin::named("plugin-1"), TestPlugin::named("plugin-2")]);
    registry.initialize(&mut agent).await.unwrap();
    assert_eq!(agent.hooks().len(), 2);
    assert_eq!(registry.names(), ["plugin-1", "plugin-2"]);
}

#[tokio::test]
async fn auto_registers_tools_from_plugin_get_tools() {
    let tool: Arc<dyn Tool> = Arc::new(MockTool::new("mock-tool"));
    let plugin = Arc::new(ToolProviderPlugin {
        initialized: AtomicBool::new(true),
        tools: vec![tool.clone()],
    });
    let mut agent = local_agent();
    PluginRegistry::new(vec![plugin]).initialize(&mut agent).await.unwrap();
    assert!(Arc::ptr_eq(agent.tool_registry().get("mock-tool").unwrap(), &tool));
}

#[tokio::test]
async fn calls_get_tools_after_init_agent_so_tools_can_depend_on_initialization_state() {
    let tool: Arc<dyn Tool> = Arc::new(MockTool::new("deferred-tool"));
    let plugin = Arc::new(ToolProviderPlugin {
        initialized: AtomicBool::new(false),
        tools: vec![tool],
    });
    let mut agent = local_agent();
    PluginRegistry::new(vec![plugin]).initialize(&mut agent).await.unwrap();
    assert!(agent.tool_registry().get("deferred-tool").is_some());
}

#[tokio::test]
async fn handles_async_init_agent() {
    let plugin = Arc::new(InitializablePlugin::default());
    PluginRegistry::new(vec![plugin.clone()])
        .initialize(&mut local_agent())
        .await
        .unwrap();
    assert!(plugin.initialized.load(Ordering::SeqCst));
}

#[tokio::test]
async fn preserves_init_agent_failures_across_initialization_attempts() {
    let plugin = Arc::new(FailingPlugin {
        calls: AtomicUsize::new(0),
    });
    let mut registry = PluginRegistry::new(vec![plugin.clone()]);
    let mut agent = local_agent();
    let first = registry.initialize(&mut agent).await.unwrap_err();
    let second = registry.initialize(&mut agent).await.unwrap_err();
    assert!(matches!(first, Error::Session(_)));
    assert_eq!(first.to_string(), "plugin initialization failed");
    assert_eq!(second.to_string(), "plugin initialization failed");
    assert_eq!(plugin.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn is_idempotent_calling_initialize_twice_only_runs_plugins_once() {
    let plugin = Arc::new(InitializablePlugin::default());
    let mut registry = PluginRegistry::new(vec![plugin.clone()]);
    let mut agent = local_agent();
    registry.initialize(&mut agent).await.unwrap();
    registry.initialize(&mut agent).await.unwrap();
    assert_eq!(plugin.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn hooks_are_invoked_when_callbacks_are_called() {
    let plugin = TestPlugin::named("test-plugin");
    let mut agent = local_agent();
    PluginRegistry::new(vec![plugin.clone()])
        .initialize(&mut agent)
        .await
        .unwrap();
    let hooks = agent.hooks().clone();
    let mut event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), Vec::new());
    hooks.invoke(&mut event).await.unwrap();
    assert!(plugin.hook_called.load(Ordering::SeqCst));
}

#[test]
fn returns_the_plugin_name() {
    assert_eq!(TestPlugin::named("test-plugin").name(), "test-plugin");
}

#[test]
fn supports_custom_names_via_constructor() {
    assert_eq!(TestPlugin::named("my-custom-plugin").name(), "my-custom-plugin");
}

#[tokio::test]
async fn registers_callbacks_via_agent_add_hook() {
    let mut agent = local_agent();
    TestPlugin::named("test-plugin").init_agent(&mut agent).await.unwrap();
    assert_eq!(agent.hooks().len(), 1);
}

#[tokio::test]
async fn can_be_implemented_for_custom_initialization() {
    let plugin = InitializablePlugin::default();
    assert!(!plugin.initialized.load(Ordering::SeqCst));
    plugin.init_agent(&mut local_agent()).await.unwrap();
    assert!(plugin.initialized.load(Ordering::SeqCst));
}

#[test]
fn is_optional_plugins_without_get_tools_are_valid() {
    assert!(TestPlugin::named("test-plugin").get_tools().is_empty());
}

#[test]
fn can_be_implemented_to_provide_tools() {
    let tool: Arc<dyn Tool> = Arc::new(MockTool::new("tool"));
    let plugin = ToolProviderPlugin {
        initialized: AtomicBool::new(true),
        tools: vec![tool.clone()],
    };
    let ToolSource::Tool(provided) = &plugin.get_tools()[0] else {
        panic!("expected one tool");
    };
    assert!(Arc::ptr_eq(provided, &tool));
}

struct StatefulModel(MockModel);

impl crate::models::Model for StatefulModel {
    fn stream(
        &self,
        request: crate::models::ModelRequest,
    ) -> crate::models::BoxStream<'static, Result<crate::models::streaming::ModelStreamEvent>> {
        self.0.stream(request)
    }

    fn get_config(&self) -> crate::models::BaseModelConfig {
        self.0.get_config()
    }

    fn update_config(&self, config: crate::models::BaseModelConfig) -> crate::Result<()> {
        self.0.update_config(config)
    }

    fn stateful(&self) -> bool {
        true
    }
}

#[tokio::test]
async fn model_plugin_clears_messages_after_invocation_for_stateful_models() {
    for (model, cleared) in [
        (
            Arc::new(StatefulModel(MockModel::new())) as Arc<dyn crate::models::Model>,
            true,
        ),
        (Arc::new(MockModel::new()), false),
    ] {
        let mut agent = local_agent();
        PluginRegistry::new(vec![Arc::new(ModelPlugin::new(model))])
            .initialize(&mut agent)
            .await
            .unwrap();
        agent.messages_mut().push(Message::user("hi"));
        let hooks = agent.hooks().clone();
        let mut event = crate::hooks::AfterInvocationEvent::new(&mut agent, InvocationState::new());
        hooks.invoke(&mut event).await.unwrap();
        assert_eq!(agent.messages().is_empty(), cleared);
    }
}
