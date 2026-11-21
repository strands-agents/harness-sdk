//! `create_harness` end to end, including memory and the generalist subagent's memory.
//!
//! These assert the [`AgentConfig`] and model plan [`assemble`] resolves (plugins, interventions,
//! the Background Tasks policy, the model config), and build the agent where its behaviour is
//! observable.

use std::sync::Arc;

use serde_json::json;
use strands::experimental::context_manager::ContextManagerStrategy;
use strands::memory::{MemoryEntry, MemoryManagerConfig, SearchOptions};
use strands::models::routing::{ModelRouter, ModelRouterOptions, RoutingCandidate};
use strands::models::{BaseModelConfig, Model};
use strands::sandbox::{ExecuteOptions, ExecutionStream, FileInfo};
use strands::storage::InMemoryStorage;
use strands::testing::{MockModel, MockTurn};
use strands::tools::FunctionTool;
use strands::types::{ContentBlock, ToolUseBlock};
use strands::{InvokeLimits, InvokeOptions, async_trait};

use super::*;
use crate::builtin_tools::{child_options, delegable, subagent_tool_options};
use crate::factory::ChildSpec;
use crate::prompt::HARNESS_CONTRACT;
use crate::test_support::{offline_env, record_logs};
use crate::types::ShellConfig;
use crate::{BuiltinToolName, InterventionValue};

fn mock_model() -> ModelSource {
    MockModel::new().into()
}

/// Options that keep a test off the working directory's `.agent` folder.
fn quiet() -> HarnessAgentOptions {
    HarnessAgentOptions {
        session: Some(SessionOption::Off),
        memory: Some(MemoryOption::Off),
        skills: Some(SkillsOption::Off),
        printer: Some(false),
        ..Default::default()
    }
}

fn quiet_with_mock() -> HarnessAgentOptions {
    HarnessAgentOptions {
        model: Some(mock_model()),
        ..quiet()
    }
}

async fn assembled(options: HarnessAgentOptions) -> Assembly {
    assemble(options, &offline_env()).await.unwrap()
}

async fn rejection(options: HarnessAgentOptions) -> String {
    match assemble(options, &offline_env()).await {
        Ok(_) => panic!("expected an error"),
        Err(error) => error.to_string(),
    }
}

/// The names of the tools the agent config registers, plugin-vended tools included.
fn tool_names(config: &AgentConfig) -> Vec<String> {
    let plugin_tools = config.plugins.iter().flat_map(|plugin| plugin.get_tools());
    config
        .tools
        .iter()
        .cloned()
        .chain(plugin_tools)
        .filter_map(|source| match source {
            ToolSource::Tool(tool) => Some(tool.name().to_owned()),
            _ => None,
        })
        .collect()
}

#[cfg(feature = "bedrock")]
fn plugin_names(config: &AgentConfig) -> Vec<&str> {
    config.plugins.iter().map(|plugin| plugin.name()).collect()
}

fn tool(name: &str, description: &str) -> Arc<dyn Tool> {
    Arc::new(FunctionTool::builder(name, description).callback(|input, _| async move { Ok(input) }))
}

fn sample_tool() -> Arc<dyn Tool> {
    tool("sample_tool", "A sample tool.")
}

fn background(config: &AgentConfig) -> Option<BackgroundTasksConfig> {
    match config.background_tasks.clone()? {
        Toggle::On(config) => Some(config),
        _ => None,
    }
}

fn strings(values: &[&str]) -> Option<Vec<String>> {
    Some(values.iter().map(|value| (*value).to_owned()).collect())
}

fn write_skill(dir: &Path, name: &str) {
    let skill = dir.join(name);
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: A {name} skill.\n---\nDo the {name} thing.\n"),
    )
    .unwrap();
}

fn mock_with_id(model_id: &str) -> Arc<dyn Model> {
    let model = MockModel::new();
    model
        .update_config(BaseModelConfig {
            model_id: Some(model_id.to_owned()),
            ..Default::default()
        })
        .unwrap();
    Arc::new(model)
}

struct Recall;

#[async_trait]
impl strands::memory::MemoryStore for Recall {
    fn name(&self) -> &str {
        "custom"
    }

    fn writable(&self) -> bool {
        false
    }

    async fn search(&self, _query: &str, _options: SearchOptions) -> strands::Result<Vec<MemoryEntry>> {
        Ok(Vec::new())
    }
}

fn custom_manager() -> MemoryManager {
    MemoryManager::new(MemoryManagerConfig {
        stores: vec![Arc::new(Recall)],
        ..Default::default()
    })
    .unwrap()
}

#[cfg(feature = "bedrock")]
#[tokio::test]
async fn builds_an_agent_with_the_default_configuration() {
    let sessions = tempfile::tempdir().unwrap();
    let memory = tempfile::tempdir().unwrap();
    let options = HarnessAgentOptions {
        session: Some(SessionConfig::builder().dir(sessions.path()).build().into()),
        memory: Some(MemoryConfig::builder().dir(memory.path()).build().into()),
        printer: Some(false),
        ..Default::default()
    };
    let assembly = assembled(options).await;
    let names = tool_names(&assembly.config);
    for name in [
        "shell",
        "read",
        "write",
        "edit",
        "web_fetch",
        "subagent",
        "programmatic_tool_caller",
    ] {
        assert!(names.contains(&name.to_owned()), "{name}");
    }
    assert_eq!(assembly.config.system_prompt, Some(HARNESS_CONTRACT.into()));
    assert!(matches!(
        assembly.config.context_manager,
        Some(ContextManagerStrategy::Auto)
    ));
    assert_eq!(assembly.model_plan.unwrap().model_id, "global.anthropic.claude-opus-5");
    assert_eq!(plugin_names(&assembly.config), ["strands:environment"]);
    Agent::new(assembly.config).unwrap();
}

#[tokio::test]
async fn attaches_a_model_router_through_the_model_parameter() {
    let candidates: Vec<RoutingCandidate> = vec![mock_with_id("fast").into(), mock_with_id("deep").into()];
    let router = ModelRouter::new(candidates, ModelRouterOptions::default()).unwrap();
    let options = HarnessAgentOptions {
        model: Some(router.clone().into()),
        ..quiet()
    };
    let agent = create_harness_boxed(options, offline_env()).await.unwrap();
    assert!(Arc::ptr_eq(agent.model(), &router.default_model()));
}

#[tokio::test]
async fn backgrounds_the_subagent_and_leaves_other_compatible_tools_agent_selectable() {
    let policy = background(&assembled(quiet_with_mock()).await.config).unwrap();
    assert_eq!(policy.agentic, strings(&["*"]));
    assert_eq!(policy.always, strings(&["subagent"]));
    assert_eq!(policy.never, None);
}

#[tokio::test]
async fn treats_background_tasks_true_the_same_as_the_default() {
    let options = HarnessAgentOptions {
        background_tasks: Some(true.into()),
        ..quiet_with_mock()
    };
    let policy = background(&assembled(options).await.config).unwrap();
    assert_eq!(policy.agentic, strings(&["*"]));
    assert_eq!(policy.always, strings(&["subagent"]));
}

#[tokio::test]
async fn keeps_the_subagent_backgrounded_under_a_custom_policy() {
    let custom = BackgroundTasksConfig {
        always: strings(&["sample_tool", "subagent"]),
        never: strings(&["*", "subagent"]),
        wait_for_completion: Some(false),
        ..Default::default()
    };
    let options = HarnessAgentOptions {
        background_tasks: Some(Toggle::On(custom)),
        ..quiet_with_mock()
    };
    let policy = background(&assembled(options).await.config).unwrap();
    assert_eq!(policy.always, strings(&["sample_tool", "subagent"]));
    assert_eq!(policy.never, strings(&["*"]));
    assert_eq!(policy.agentic, None);
    assert_eq!(policy.wait_for_completion, Some(false));
}

#[tokio::test]
async fn disables_background_tasks_when_requested() {
    let options = HarnessAgentOptions {
        background_tasks: Some(false.into()),
        ..quiet_with_mock()
    };
    assert!(matches!(
        assembled(options).await.config.background_tasks,
        Some(Toggle::Off)
    ));
}

#[tokio::test]
async fn appends_instructions_after_the_contract() {
    let options = HarnessAgentOptions {
        instructions: Some("You are a migration assistant.".to_owned()),
        ..quiet_with_mock()
    };
    let config = assembled(options).await.config;
    let prompt = config.system_prompt.unwrap();
    let text = serde_json::to_value(&prompt).unwrap();
    let text = text.as_str().unwrap();
    assert!(text.starts_with(HARNESS_CONTRACT));
    assert!(text.ends_with("You are a migration assistant."));
}

#[tokio::test]
async fn lets_an_explicit_system_prompt_win_over_instructions() {
    let options = HarnessAgentOptions {
        instructions: Some("ignored".to_owned()),
        system_prompt: Some("my own prompt".into()),
        ..quiet_with_mock()
    };
    assert_eq!(
        assembled(options).await.config.system_prompt,
        Some("my own prompt".into())
    );
}

#[tokio::test]
async fn adds_consumer_tools_alongside_the_built_ins() {
    let options = HarnessAgentOptions {
        tools: vec![sample_tool().into()],
        ..quiet_with_mock()
    };
    let names = tool_names(&assembled(options).await.config);
    for name in ["shell", "read", "sample_tool"] {
        assert!(names.contains(&name.to_owned()), "{name}");
    }
}

#[tokio::test]
async fn enables_the_subagent_delegation_tool_by_default() {
    assert!(tool_names(&assembled(quiet_with_mock()).await.config).contains(&"subagent".to_owned()));
}

#[tokio::test]
async fn disables_the_subagent_tool_when_dropped_from_builtin_tools() {
    let options = HarnessAgentOptions {
        builtin_tools: Some([BuiltinToolName::Read].into()),
        ..quiet_with_mock()
    };
    let names = tool_names(&assembled(options).await.config);
    assert!(!names.contains(&"subagent".to_owned()));
    assert!(names.contains(&"read".to_owned()));
    assert!(!names.contains(&"shell".to_owned()));
}

#[tokio::test]
async fn edits_the_defaults_with_a_builtin_tools_mapping() {
    let options = HarnessAgentOptions {
        builtin_tools: Some(BuiltinToolsConfig::builder().subagent(false).build().into()),
        ..quiet_with_mock()
    };
    let names = tool_names(&assembled(options).await.config);
    assert!(!names.contains(&"subagent".to_owned()));
    for name in ["shell", "read", "write", "edit", "web_fetch"] {
        assert!(names.contains(&name.to_owned()), "{name}");
    }
}

#[tokio::test]
async fn starts_from_nothing_when_the_builtin_tools_mapping_sets_star_to_false() {
    let mapping = BuiltinToolsConfig::builder()
        .all(false)
        .read(true)
        .web_fetch(crate::WebFetchConfig::default())
        .build();
    let options = HarnessAgentOptions {
        builtin_tools: Some(mapping.into()),
        ..quiet_with_mock()
    };
    let mut names = tool_names(&assembled(options).await.config);
    names.sort();
    assert_eq!(names, ["read", "web_fetch"]);
}

#[tokio::test]
async fn configures_the_shell_tool_description() {
    let shell = ShellConfig::builder()
        .description("Run a command in the sandbox.")
        .build();
    let options = HarnessAgentOptions {
        builtin_tools: Some(BuiltinToolsConfig::builder().shell(shell).build().into()),
        ..quiet_with_mock()
    };
    let config = assembled(options).await.config;
    let shell = config
        .tools
        .iter()
        .find_map(|source| match source {
            ToolSource::Tool(tool) if tool.name() == "shell" => Some(tool.description().to_owned()),
            _ => None,
        })
        .unwrap();
    assert_eq!(shell, "Run a command in the sandbox.");
}

struct VendingSandbox;

#[async_trait]
impl strands::sandbox::Sandbox for VendingSandbox {
    fn execute_streaming(&self, _command: &str, _options: ExecuteOptions) -> ExecutionStream {
        Box::pin(futures::stream::empty())
    }

    fn execute_code_streaming(&self, _code: &str, _language: &str, _options: ExecuteOptions) -> ExecutionStream {
        Box::pin(futures::stream::empty())
    }

    async fn read_file(&self, path: &str) -> strands::Result<Vec<u8>> {
        Err(strands::SandboxPathNotFoundError::new(path).into())
    }

    async fn write_file(&self, _path: &str, _content: &[u8]) -> strands::Result<()> {
        Ok(())
    }

    async fn remove_file(&self, _path: &str) -> strands::Result<()> {
        Ok(())
    }

    async fn list_files(&self, _path: &str) -> strands::Result<Vec<FileInfo>> {
        Ok(Vec::new())
    }

    fn get_tools(&self) -> Vec<Arc<dyn Tool>> {
        vec![
            tool("sandbox_bash", "Run bash."),
            tool("sandbox_file_editor", "Edit files."),
            tool("shell", "The sandbox's own shell."),
        ]
    }
}

#[tokio::test]
async fn drops_sandbox_vended_tools() {
    let options = HarnessAgentOptions {
        sandbox: Some(Arc::new(VendingSandbox)),
        ..quiet_with_mock()
    };
    let mut agent = create_harness_boxed(options, offline_env()).await.unwrap();
    agent.initialize().await.unwrap();
    let names: Vec<String> = agent.tools().iter().map(|tool| tool.name().to_owned()).collect();
    for name in ["shell", "read", "write", "edit"] {
        assert!(names.contains(&name.to_owned()), "{name}");
    }
    assert!(!names.contains(&"sandbox_bash".to_owned()));
    assert!(!names.contains(&"sandbox_file_editor".to_owned()));
    let shell = agent.tool_registry().get("shell").unwrap();
    assert_ne!(shell.description(), "The sandbox's own shell.");
}

#[tokio::test]
async fn disables_built_in_tools_with_an_empty_list() {
    let options = HarnessAgentOptions {
        builtin_tools: Some(BuiltinToolsOption::List(Vec::new())),
        tools: vec![sample_tool().into()],
        ..quiet_with_mock()
    };
    let names = tool_names(&assembled(options).await.config);
    assert!(!names.contains(&"shell".to_owned()));
    assert!(!names.contains(&"read".to_owned()));
    assert!(names.contains(&"sample_tool".to_owned()));
}

#[cfg(feature = "openai")]
#[tokio::test]
async fn does_not_register_web_search_as_a_tool() {
    let options = HarnessAgentOptions {
        model: Some("openai/gpt-5.6-sol".into()),
        ..quiet()
    };
    let assembly = assembled(options).await;
    assert!(!tool_names(&assembly.config).contains(&"web_search".to_owned()));
    assert_eq!(
        assembly.model_plan.unwrap().params.unwrap()["tools"],
        json!([{ "type": "web_search" }])
    );
}

#[cfg(feature = "bedrock")]
#[tokio::test]
async fn logs_info_not_a_warning_and_builds_when_default_web_search_hits_the_default_bedrock_model() {
    let (logs, _guard) = record_logs();
    let assembly = assembled(quiet()).await;
    assert!(!tool_names(&assembly.config).contains(&"web_search".to_owned()));
    assert!(
        logs.lines("INFO")
            .iter()
            .any(|line| line.contains("has no built-in web search"))
    );
    assert!(
        !logs
            .lines("WARN")
            .iter()
            .any(|line| line.contains("has no built-in web search"))
    );
}

#[tokio::test]
async fn throws_when_web_search_is_explicitly_selected_on_an_unsupported_provider() {
    let list = HarnessAgentOptions {
        builtin_tools: Some([BuiltinToolName::Read, BuiltinToolName::WebSearch].into()),
        ..quiet()
    };
    assert!(rejection(list).await.contains("has no built-in web search"));
    let mapping = HarnessAgentOptions {
        builtin_tools: Some(BuiltinToolsConfig::builder().web_search(true).build().into()),
        ..quiet()
    };
    assert!(rejection(mapping).await.contains("has no built-in web search"));
}

#[cfg(feature = "mcp")]
#[tokio::test]
async fn builds_the_exa_tool_for_the_fallback_and_warns_about_the_third_party() {
    let (logs, _guard) = record_logs();
    let options = HarnessAgentOptions {
        builtin_tools: Some(
            BuiltinToolsConfig::builder()
                .web_search(crate::WebSearchSetting::Exa)
                .build()
                .into(),
        ),
        ..quiet_with_mock()
    };
    assert!(tool_names(&assembled(options).await.config).contains(&"web_search".to_owned()));
    assert!(
        logs.lines("WARN")
            .iter()
            .any(|line| line.contains("Exa (exa.ai), a third-party service"))
    );
    assert!(!logs.text().contains("has no built-in web search"));
}

#[cfg(feature = "openai")]
#[tokio::test]
async fn lets_an_explicit_exa_selection_win_over_native_search() {
    let options = HarnessAgentOptions {
        model: Some("openai/gpt-5.6-sol".into()),
        builtin_tools: Some(
            BuiltinToolsConfig::builder()
                .web_search(crate::WebSearchSetting::Exa)
                .build()
                .into(),
        ),
        ..quiet()
    };
    let assembly = assembled(options).await;
    assert!(tool_names(&assembly.config).contains(&"web_search".to_owned()));
    assert!(assembly.model_plan.unwrap().params.unwrap().get("tools").is_none());
}

#[cfg(feature = "mcp")]
#[tokio::test]
async fn serves_the_exa_fallback_on_a_model_instance() {
    let options = HarnessAgentOptions {
        builtin_tools: Some(
            BuiltinToolsConfig::builder()
                .web_search(crate::WebSearchSetting::Exa)
                .build()
                .into(),
        ),
        ..quiet_with_mock()
    };
    assert!(tool_names(&assembled(options).await.config).contains(&"web_search".to_owned()));
}

#[cfg(feature = "anthropic")]
#[tokio::test]
async fn enables_anthropic_native_web_search_from_the_default_set() {
    let options = HarnessAgentOptions {
        model: Some("anthropic/claude-opus-4-8".into()),
        ..quiet()
    };
    let assembly = assembled(options).await;
    assert!(!tool_names(&assembly.config).contains(&"web_search".to_owned()));
    assert_eq!(
        assembly.model_plan.unwrap().anthropic_tools,
        Some(vec![
            json!({ "type": "web_search_20260318", "name": "web_search", "allowed_callers": ["direct"] })
        ])
    );
}

#[cfg(feature = "mantle")]
#[tokio::test]
async fn only_offers_bedrock_web_search_on_gpt_5_and_gpt_6_mantle_models() {
    let (logs, _guard) = record_logs();
    let luna = HarnessAgentOptions {
        model: Some("bedrock-mantle/openai.gpt-5.6-luna".into()),
        ..quiet()
    };
    let plan = assembled(luna).await.model_plan.unwrap();
    assert_eq!(
        plan.params.unwrap()["tools"],
        json!([{ "type": "web_search", "external_web_access": true }])
    );
    let oss = HarnessAgentOptions {
        model: Some("bedrock-mantle/openai.gpt-oss-120b-1:0".into()),
        ..quiet()
    };
    let assembly = assembled(oss).await;
    assert!(!tool_names(&assembly.config).contains(&"web_search".to_owned()));
    assert!(assembly.model_plan.unwrap().params.unwrap().get("tools").is_none());
    assert!(
        logs.lines("INFO")
            .iter()
            .any(|line| line.contains("has no built-in web search"))
    );
}

#[tokio::test]
async fn enables_caching_by_default_on_bedrock_and_anthropic_direct() {
    for model in ["bedrock/global.anthropic.claude-opus-5", "anthropic/claude-opus-4-8"] {
        let options = HarnessAgentOptions {
            model: Some(model.into()),
            ..quiet()
        };
        let plan = assemble(options, &offline_env())
            .await
            .map(|assembly| assembly.model_plan);
        match plan {
            Ok(plan) => assert!(plan.unwrap().caching, "{model}"),
            Err(error) => assert!(
                error.to_string().contains("requires the strands-harness feature"),
                "{error}"
            ),
        }
    }
}

#[cfg(feature = "mantle")]
#[tokio::test]
async fn configures_openai_and_mantle_caching() {
    for model in ["openai/gpt-5.6-sol", "bedrock-mantle/openai.gpt-6-luna"] {
        for caching in [None, Some(true), Some(false)] {
            let options = HarnessAgentOptions {
                model: Some(model.into()),
                caching,
                builtin_tools: Some(BuiltinToolsOption::List(Vec::new())),
                ..quiet()
            };
            let plan = assembled(options).await.model_plan.unwrap();
            assert_eq!(plan.caching, caching != Some(false), "{model} {caching:?}");
        }
    }
}

#[tokio::test]
async fn builds_silently_with_default_caching_on_a_model_instance() {
    let (logs, _guard) = record_logs();
    assembled(quiet_with_mock()).await;
    assert!(!logs.text().contains("prompt caching not applied"));
}

#[tokio::test]
async fn warns_when_caching_is_explicitly_requested_on_a_model_instance() {
    let (logs, _guard) = record_logs();
    let options = HarnessAgentOptions {
        caching: Some(true),
        ..quiet_with_mock()
    };
    assembled(options).await;
    assert!(
        logs.lines("WARN")
            .iter()
            .any(|line| line.contains("pre-built Model instance"))
    );
}

#[cfg(feature = "openai")]
#[tokio::test]
async fn leaves_no_cache_config_when_caching_is_disabled() {
    let options = HarnessAgentOptions {
        model: Some("openai/gpt-5.6-sol".into()),
        caching: Some(false),
        ..quiet()
    };
    assert!(!assembled(options).await.model_plan.unwrap().caching);
}

#[tokio::test]
async fn disables_context_management_when_falsy() {
    let options = HarnessAgentOptions {
        context_manager: Some(ContextManagerStrategy::Disabled),
        ..quiet_with_mock()
    };
    assert!(matches!(
        assembled(options).await.config.context_manager,
        Some(ContextManagerStrategy::Disabled)
    ));
}

#[tokio::test]
async fn uses_the_default_strategy_when_context_manager_is_auto() {
    let options = HarnessAgentOptions {
        context_manager: Some(ContextManagerStrategy::Auto),
        ..quiet_with_mock()
    };
    assert!(matches!(
        assembled(options).await.config.context_manager,
        Some(ContextManagerStrategy::Auto)
    ));
}

#[tokio::test]
async fn lets_an_explicit_context_manager_win() {
    let options = HarnessAgentOptions {
        context_manager: Some(ContextManagerStrategy::Agentic),
        ..quiet_with_mock()
    };
    assert!(matches!(
        assembled(options).await.config.context_manager,
        Some(ContextManagerStrategy::Agentic)
    ));
}

#[tokio::test]
async fn uses_the_recommended_level_when_effort_is_auto_and_sends_none_when_off() {
    let auto = HarnessAgentOptions {
        model: Some("bedrock/global.anthropic.claude-opus-5".into()),
        ..quiet()
    };
    let Ok(assembly) = assemble(auto, &offline_env()).await else {
        return;
    };
    let fields = assembly.model_plan.unwrap().additional_request_fields.unwrap();
    assert_eq!(fields["output_config"]["effort"], json!("high"));
    let off = HarnessAgentOptions {
        model: Some("bedrock/global.anthropic.claude-opus-5".into()),
        effort: Effort::Off,
        ..quiet()
    };
    assert_eq!(assembled(off).await.model_plan.unwrap().additional_request_fields, None);
}

fn session_id(config: &AgentConfig) -> String {
    config.session_manager.as_ref().unwrap().session_id().to_owned()
}

fn with_session(session: impl Into<SessionOption>) -> HarnessAgentOptions {
    HarnessAgentOptions {
        session: Some(session.into()),
        ..quiet_with_mock()
    }
}

#[tokio::test]
async fn wires_a_session_manager_on_by_default_with_a_random_id() {
    let dir = tempfile::tempdir().unwrap();
    let options = HarnessAgentOptions {
        session: None,
        ..with_session(SessionConfig::builder().dir(dir.path()).build())
    };
    let options = HarnessAgentOptions {
        session: Some(SessionConfig::builder().dir(dir.path()).build().into()),
        ..options
    };
    let id = session_id(&assembled(options).await.config);
    assert_eq!(id.len(), 8);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
}

#[tokio::test]
async fn mints_distinct_ids_for_two_default_agents() {
    let dir = tempfile::tempdir().unwrap();
    let first = assembled(with_session(SessionConfig::builder().dir(dir.path()).build())).await;
    let second = assembled(with_session(SessionConfig::builder().dir(dir.path()).build())).await;
    assert_ne!(session_id(&first.config), session_id(&second.config));
    let agent = Agent::new(first.config).unwrap();
    assert_eq!(agent.session_id().len(), 8);
}

#[tokio::test]
async fn builds_no_session_manager_when_the_session_is_disabled() {
    assert!(assembled(with_session(false)).await.config.session_manager.is_none());
}

#[tokio::test]
async fn passes_a_session_manager_instance_given_as_session_straight_through() {
    let supplied = SessionManager::new(SessionManagerConfig {
        session_id: Some("mine".to_owned()),
        storage: Some(Arc::new(InMemoryStorage::new())),
        ..Default::default()
    })
    .unwrap();
    let config = assembled(with_session(supplied)).await.config;
    assert_eq!(session_id(&config), "mine");
    assert!(config.storage.is_none());
}

#[tokio::test]
async fn prefers_an_explicitly_supplied_session_manager() {
    let supplied = SessionManager::new(SessionManagerConfig {
        session_id: Some("mine".to_owned()),
        storage: Some(Arc::new(InMemoryStorage::new())),
        ..Default::default()
    })
    .unwrap();
    let options = HarnessAgentOptions {
        session_manager: Some(supplied),
        ..with_session(SessionConfig::builder().id("ignored").build())
    };
    let config = assembled(options).await.config;
    assert_eq!(session_id(&config), "mine");
    assert!(config.storage.is_none());
}

#[tokio::test]
async fn wires_a_session_manager_when_a_session_id_is_given() {
    let dir = tempfile::tempdir().unwrap();
    let config = assembled(with_session(
        SessionConfig::builder().id("user-42").dir(dir.path()).build(),
    ))
    .await
    .config;
    assert_eq!(session_id(&config), "user-42");
}

#[tokio::test]
async fn persists_messages_before_the_invocation_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let model = MockModel::new().with_turn(MockTurn::error(|| {
        strands::Error::other("Stop before calling the model")
    }));
    let options = HarnessAgentOptions {
        model: Some(model.into()),
        session: Some(SessionConfig::builder().id("checkpoint").dir(dir.path()).build().into()),
        builtin_tools: Some(BuiltinToolsOption::List(Vec::new())),
        builtin_plugins: Some(Vec::new()),
        context_manager: Some(ContextManagerStrategy::Disabled),
        retry_strategy: Some(Vec::new()),
        ..quiet()
    };
    let mut agent = create_harness_boxed(options, offline_env()).await.unwrap();
    let error = agent.invoke("Remember the checkpoint").await.unwrap_err();
    assert!(error.to_string().contains("Stop before calling the model"));
    let snapshot = dir
        .path()
        .join("checkpoint/scopes/agent/agent/snapshots/snapshot_latest.json");
    assert!(
        std::fs::read_to_string(snapshot)
            .unwrap()
            .contains("Remember the checkpoint")
    );
}

#[tokio::test]
async fn rejects_an_empty_session_id() {
    for id in ["", "   "] {
        let message = rejection(with_session(SessionConfig::builder().id(id).build())).await;
        assert_eq!(message, "session.id must be a non-empty string.");
    }
}

#[tokio::test]
async fn sanitizes_the_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let options = with_session(
        SessionConfig::builder()
            .id("azrn:studio:us-west-2:session/abc")
            .dir(dir.path())
            .build(),
    );
    assert_eq!(
        session_id(&assembled(options).await.config),
        "azrn-studio-us-west-2-session-abc"
    );
}

#[tokio::test]
async fn lowercases_the_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let options = with_session(SessionConfig::builder().id("MyProj.v2").dir(dir.path()).build());
    assert_eq!(session_id(&assembled(options).await.config), "myproj-v2");
}

const LARGE_LINES: usize = 400;

fn large_result() -> String {
    (0..LARGE_LINES)
        .map(|line| format!("Line {line}: quarterly budget notes."))
        .collect::<Vec<_>>()
        .join("\n")
}

// https://github.com/strands-agents/harness-sdk/issues/4685
#[tokio::test]
async fn returns_an_offloaded_tool_result_to_the_model_in_full_on_retrieval() {
    let dir = tempfile::tempdir().unwrap();
    let read_large = Arc::new(
        FunctionTool::builder("read_large", "Read a large document.")
            .callback(|_, _| async move { Ok(large_result().into()) }),
    ) as Arc<dyn Tool>;
    let model = MockModel::new()
        .with_turn(MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(
            "read_large",
            "tooluse-0",
            json!({}),
        ))]))
        .with_turn(MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(
            "retrieve_context",
            "tooluse-1",
            json!({ "reference": "tooluse-0_0" }),
        ))]))
        .with_turn(MockTurn::text("done"));
    model
        .update_config(BaseModelConfig {
            context_window_limit: Some(1_000_000),
            ..Default::default()
        })
        .unwrap();
    let model = Arc::new(model);
    let options = HarnessAgentOptions {
        model: Some(Arc::clone(&model).into()),
        tools: vec![read_large.into()],
        session: Some(SessionConfig::builder().id("retrieval").dir(dir.path()).build().into()),
        builtin_tools: Some(BuiltinToolsOption::List(Vec::new())),
        builtin_plugins: Some(Vec::new()),
        ..quiet()
    };
    let mut agent = create_harness_boxed(options, offline_env()).await.unwrap();
    let limits = InvokeLimits {
        turns: Some(4),
        ..Default::default()
    };
    agent
        .invoke_with(
            "Read the document.",
            InvokeOptions {
                limits: Some(limits),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let requests = model.requests();
    let seen: Vec<String> = requests[1..]
        .iter()
        .map(|request| serde_json::to_string(request.messages.last().unwrap()).unwrap())
        .collect();
    assert!(seen[0].contains("[Truncated:"), "{}", seen[0]);
    assert!(seen[1].contains("Line 399: quarterly budget notes."));
    let scope = Path::new("scopes").join("agent").join(agent.id());
    let snapshot = std::fs::read_to_string(
        dir.path()
            .join("retrieval")
            .join(&scope)
            .join("snapshots/snapshot_latest.json"),
    )
    .unwrap();
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(
        snapshot["data"]["stash"],
        json!({ "location": "external", "storageType": "LocalFileStorage" })
    );
    assert!(
        dir.path()
            .join("retrieval/context/retrieval")
            .join(&scope)
            .join("tooluse-0_0")
            .exists()
    );
    let entries: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, ["retrieval"]);
}

#[tokio::test]
async fn keeps_the_stash_in_memory_without_a_harness_built_session() {
    let in_memory = || -> Arc<dyn Storage> { Arc::new(InMemoryStorage::new()) };
    let manager = || {
        SessionManager::new(SessionManagerConfig {
            storage: Some(in_memory()),
            ..Default::default()
        })
        .unwrap()
    };
    let cases = [
        with_session(false),
        with_session(manager()),
        HarnessAgentOptions {
            session_manager: Some(manager()),
            ..quiet_with_mock()
        },
    ];
    for options in cases {
        assert!(assembled(options).await.config.storage.is_none());
    }
}

#[tokio::test]
async fn backs_the_stash_with_an_explicit_storage() {
    let dir = tempfile::tempdir().unwrap();
    let storage: Arc<dyn Storage> = Arc::new(InMemoryStorage::new());
    let options = HarnessAgentOptions {
        storage: Some(Arc::clone(&storage)),
        ..with_session(SessionConfig::builder().dir(dir.path()).build())
    };
    assert!(Arc::ptr_eq(&assembled(options).await.config.storage.unwrap(), &storage));
}

fn skills_plugins(config: &AgentConfig) -> usize {
    config
        .plugins
        .iter()
        .filter(|plugin| plugin.name() == AGENT_SKILLS_NAME)
        .count()
}

fn with_skills(skills: impl Into<SkillsOption>) -> HarnessAgentOptions {
    HarnessAgentOptions {
        skills: Some(skills.into()),
        ..quiet_with_mock()
    }
}

#[tokio::test]
async fn loads_skills_from_the_skills_directory() {
    let dir = tempfile::tempdir().unwrap();
    write_skill(dir.path(), "hello");
    assert_eq!(skills_plugins(&assembled(with_skills(dir.path())).await.config), 1);
}

#[tokio::test]
async fn passes_an_explicit_missing_skills_path_through_to_the_plugin() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        skills_plugins(&assembled(with_skills(dir.path().join("absent"))).await.config),
        1
    );
}

#[tokio::test]
async fn skips_the_default_skills_directory_when_it_is_absent() {
    assert!(!Path::new(DEFAULT_SKILLS_DIR).exists());
    assert_eq!(skills_plugins(&assembled(with_skills(true)).await.config), 0);
}

#[tokio::test]
async fn disables_skills_when_skills_is_null() {
    assert_eq!(skills_plugins(&assembled(with_skills(false)).await.config), 0);
}

#[tokio::test]
async fn loads_skills_from_multiple_directories_and_keeps_missing_ones() {
    let a = tempfile::tempdir().unwrap();
    write_skill(a.path(), "hello");
    let sources = [a.path().to_path_buf(), a.path().join("absent")];
    assert_eq!(skills_plugins(&assembled(with_skills(sources)).await.config), 1);
    assert!(matches!(SkillsOption::from(vec!["a", "b"]), SkillsOption::Sources(sources) if sources.len() == 2));
}

#[tokio::test]
async fn disables_skills_when_skills_is_an_empty_array() {
    assert_eq!(
        skills_plugins(&assembled(with_skills(SkillsOption::Sources(Vec::new()))).await.config),
        0
    );
}

#[tokio::test]
async fn does_not_double_add_a_skills_plugin_supplied_via_plugins() {
    let dir = tempfile::tempdir().unwrap();
    write_skill(dir.path(), "hello");
    let existing = AgentSkills::new(AgentSkillsConfig {
        skills: vec![dir.path().into()],
        ..Default::default()
    });
    let options = HarnessAgentOptions {
        plugins: vec![Arc::new(existing)],
        ..with_skills(dir.path())
    };
    assert_eq!(skills_plugins(&assembled(options).await.config), 1);
}

fn with_tools(tools: Vec<Arc<dyn Tool>>) -> HarnessAgentOptions {
    HarnessAgentOptions {
        tools: tools.into_iter().map(ToolSource::Tool).collect(),
        ..quiet_with_mock()
    }
}

#[tokio::test]
async fn rejects_a_built_in_tool_colliding_with_a_consumer_tool() {
    let message = rejection(with_tools(vec![tool(
        "read",
        "A consumer tool that collides with the built-in read.",
    )]))
    .await;
    assert_eq!(
        message,
        "Tool name \"read\" is registered more than once (from a built-in tool and tools). Rename the tool you passed, or drop the built-in via builtinTools / builtinPlugins."
    );
}

#[tokio::test]
async fn rejects_the_built_in_subagent_tool_colliding_with_a_consumer_tool() {
    let message = rejection(with_tools(vec![tool(
        "subagent",
        "Collides with the built-in subagent tool.",
    )]))
    .await;
    assert!(message.contains("Tool name \"subagent\" is registered more than once (from a built-in tool and tools)"));
}

#[tokio::test]
async fn rejects_a_consumer_tool_colliding_with_the_memory_search_tool() {
    let dir = tempfile::tempdir().unwrap();
    let options = HarnessAgentOptions {
        memory: Some(MemoryConfig::builder().dir(dir.path()).build().into()),
        ..with_tools(vec![tool("search_memory", "Collides with the memory manager tool.")])
    };
    assert!(
        rejection(options)
            .await
            .contains("Tool name \"search_memory\" is registered more than once (from tools and memory)")
    );
}

#[tokio::test]
async fn rejects_the_same_consumer_tool_listed_twice() {
    let message = rejection(with_tools(vec![sample_tool(), sample_tool()])).await;
    assert!(message.contains("Tool name \"sample_tool\" is registered more than once (from tools)"));
}

#[tokio::test]
async fn does_not_mention_built_ins_in_a_consumer_only_collision_remedy() {
    let message = rejection(with_tools(vec![sample_tool(), sample_tool()])).await;
    assert!(message.contains("unique name"));
    assert!(!message.contains("built-in"));
}

#[tokio::test]
async fn treats_a_dash_vs_underscore_near_collision_as_a_collision() {
    let message = rejection(with_tools(vec![tool(
        "web-fetch",
        "Collides with web_fetch by '-' vs '_'.",
    )]))
    .await;
    assert!(message.contains("registered more than once"));
}

#[tokio::test]
async fn frees_the_name_for_a_consumer_tool_once_the_built_in_is_dropped() {
    let options = HarnessAgentOptions {
        builtin_tools: Some([BuiltinToolName::Shell, BuiltinToolName::Write, BuiltinToolName::Edit].into()),
        ..with_tools(vec![tool(
            "read",
            "A consumer tool that collides with the built-in read.",
        )])
    };
    let config = assembled(options).await.config;
    let read = config
        .tools
        .iter()
        .find_map(|source| match source {
            ToolSource::Tool(tool) if tool.name() == "read" => Some(tool.tool_spec().description),
            _ => None,
        })
        .unwrap();
    assert!(read.contains("consumer tool that collides"));
}

#[tokio::test]
async fn does_not_name_check_non_tool_entries_in_tools() {
    let options = HarnessAgentOptions {
        tools: vec![ToolSource::List(vec![sample_tool().into()])],
        ..quiet_with_mock()
    };
    let config = assembled(options).await.config;
    let agent = Agent::new(config).unwrap();
    assert!(agent.tool_registry().get("sample_tool").is_some());
}

#[tokio::test]
async fn registers_no_interventions_by_default() {
    assert!(assembled(quiet_with_mock()).await.config.interventions.is_empty());
}

#[tokio::test]
async fn wires_an_interventions_preset() {
    let options = HarnessAgentOptions {
        interventions: Some("ask".into()),
        ..quiet_with_mock()
    };
    let handlers = assembled(options).await.config.interventions;
    assert_eq!(
        handlers.iter().map(|handler| handler.name()).collect::<Vec<_>>(),
        ["strands:human-in-the-loop"]
    );
}

#[tokio::test]
async fn passes_an_intervention_handler_instance_through() {
    let handler: Arc<dyn InterventionHandler> =
        Arc::new(strands::vended_interventions::hitl::HumanInTheLoop::default());
    let options = HarnessAgentOptions {
        interventions: Some(InterventionValue::Handler(Arc::clone(&handler)).into()),
        ..quiet_with_mock()
    };
    let handlers = assembled(options).await.config.interventions;
    assert!(Arc::ptr_eq(&handlers[0], &handler));
}

fn parent_of(assembly: &Assembly) -> Arc<ParentConfig> {
    Arc::clone(&assembly.parent)
}

#[tokio::test]
async fn has_a_subagent_delegate_inherit_the_parent_interventions_and_background_tasks_policy() {
    let options = HarnessAgentOptions {
        interventions: Some("smart".into()),
        background_tasks: Some(false.into()),
        ..quiet_with_mock()
    };
    let parent = parent_of(&assembled(options).await);
    let child = child_options(&parent, &delegable(&parent.tools), ChildSpec::default(), &offline_env()).unwrap();
    assert!(
        matches!(child.interventions, Some(InterventionsOption::Value(InterventionValue::Text(text))) if text == "smart")
    );
    assert!(matches!(child.background_tasks, Some(Toggle::Off)));
    assert_eq!(child.printer, Some(false));
}

#[cfg(feature = "openai")]
#[tokio::test]
async fn forwards_a_per_tool_web_fetch_config_to_the_delegate_as_a_pinned_mapping() {
    let mapping = BuiltinToolsConfig::builder()
        .web_fetch(crate::WebFetchConfig::builder().model("openai/gpt-5-mini").build())
        .shell(ShellConfig::builder().description("Run it.").build())
        .build();
    let options = HarnessAgentOptions {
        builtin_tools: Some(mapping.into()),
        ..quiet_with_mock()
    };
    let parent = parent_of(&assembled(options).await);
    let spec = ChildSpec {
        tools: strings(&["web_fetch", "read", "shell"]),
        ..Default::default()
    };
    let child = child_options(&parent, &delegable(&parent.tools), spec, &offline_env()).unwrap();
    let Some(BuiltinToolsOption::Mapping(pinned)) = child.builtin_tools else {
        panic!("a pinned mapping")
    };
    assert_eq!(pinned.all, None);
    assert_eq!(
        pinned.shell,
        Some(ShellConfig::builder().description("Run it.").build().into())
    );
    assert_eq!(pinned.read, Some(true.into()));
    assert_eq!(pinned.write, Some(false));
    assert_eq!(pinned.edit, Some(false));
    let Some(crate::Setting::Config(web_fetch)) = pinned.web_fetch else {
        panic!("web_fetch config")
    };
    assert!(matches!(web_fetch.model, Some(ModelSource::Id(model)) if model == "openai/gpt-5-mini"));
    // The parent's model has no native search, so it forwards web_search off to keep the child quiet.
    assert_eq!(pinned.web_search, Some(false.into()));
    assert_eq!(pinned.programmatic_tool_caller, Some(false.into()));
    assert_eq!(pinned.subagent, Some(false.into()));
}

#[cfg(feature = "mcp")]
#[tokio::test]
async fn loads_mcp_servers_through_the_sdk_resilient_and_prefixed_by_server_name() {
    let servers = json!({ "srv": { "command": "strands-harness-test-missing-server" } });
    let options = HarnessAgentOptions {
        mcp_servers: Some(crate::McpServersOption::Json(servers.as_object().unwrap().clone())),
        ..quiet_with_mock()
    };
    let config = assembled(options).await.config;
    let clients: Vec<&strands::mcp::McpClient> = config
        .tools
        .iter()
        .filter_map(|source| match source {
            ToolSource::McpClient(client) => Some(client),
            _ => None,
        })
        .collect();
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0].client_name(), "srv");
    assert!(clients[0].continue_on_error());
}

#[cfg(not(feature = "mcp"))]
#[tokio::test]
async fn names_the_feature_mcp_servers_need() {
    let options = HarnessAgentOptions {
        mcp_servers: Some("./mcp.json".into()),
        ..quiet_with_mock()
    };
    let error = assemble(options, &offline_env()).await.err().unwrap();
    assert_eq!(
        error.to_string(),
        "mcp_servers needs the strands-harness feature \"mcp\"; enable it to connect MCP servers."
    );
}

#[tokio::test]
async fn does_not_touch_mcp_when_no_servers_are_given() {
    let config = assembled(quiet_with_mock()).await.config;
    assert!(config.tools.iter().all(|source| matches!(source, ToolSource::Tool(_))));
}

mod subagent_delegate_built_child {
    use super::*;

    async fn build_child(options: HarnessAgentOptions, spec: ChildSpec) -> Assembly {
        let parent = parent_of(&assembled(options).await);
        let child = child_options(&parent, &delegable(&parent.tools), spec, &offline_env()).unwrap();
        assembled(child).await
    }

    #[tokio::test]
    async fn narrows_the_built_child_to_the_requested_subset_dropping_the_rest() {
        let options = HarnessAgentOptions {
            builtin_tools: Some([BuiltinToolName::Read, BuiltinToolName::Shell, BuiltinToolName::Subagent].into()),
            ..quiet_with_mock()
        };
        let spec = ChildSpec {
            tools: strings(&["read"]),
            ..Default::default()
        };
        let names = tool_names(&build_child(options, spec).await.config);
        assert!(names.contains(&"read".to_owned()));
        assert!(!names.contains(&"shell".to_owned()));
    }

    #[tokio::test]
    async fn hands_the_built_child_every_consumer_tool_when_the_model_does_not_narrow() {
        let names = tool_names(
            &build_child(with_tools(vec![sample_tool()]), ChildSpec::default())
                .await
                .config,
        );
        assert!(names.contains(&"sample_tool".to_owned()));
    }

    #[tokio::test]
    async fn gives_the_built_child_a_recall_only_memory_view() {
        let dir = tempfile::tempdir().unwrap();
        let options = HarnessAgentOptions {
            memory: Some(MemoryConfig::builder().dir(dir.path()).build().into()),
            ..quiet_with_mock()
        };
        let parent = parent_of(&assembled(options).await);
        let child = child_options(&parent, &delegable(&parent.tools), ChildSpec::default(), &offline_env()).unwrap();
        assert!(matches!(child.memory, Some(MemoryOption::Off)));
        assert!(matches!(child.memory_manager, Some(MemoryManagerSource::Manager(_))));
    }

    #[tokio::test]
    async fn builds_the_child_with_sessions_forced_off() {
        let dir = tempfile::tempdir().unwrap();
        let options = with_session(SessionConfig::builder().dir(dir.path()).build());
        assert!(
            build_child(options, ChildSpec::default())
                .await
                .config
                .session_manager
                .is_none()
        );
    }

    #[tokio::test]
    async fn registers_the_inherited_interventions_gate_on_the_built_child() {
        let options = HarnessAgentOptions {
            interventions: Some("ask".into()),
            ..quiet_with_mock()
        };
        let handlers = build_child(options, ChildSpec::default()).await.config.interventions;
        assert_eq!(handlers.len(), 1);
        assert_eq!(handlers[0].name(), "strands:human-in-the-loop");
    }

    #[tokio::test]
    async fn keeps_its_own_subagent_tool_so_a_delegate_can_sub_delegate() {
        let names = tool_names(&build_child(quiet_with_mock(), ChildSpec::default()).await.config);
        assert!(names.contains(&"subagent".to_owned()));
    }

    #[cfg(feature = "openai")]
    #[tokio::test]
    async fn carries_explicit_web_search_onto_a_narrowed_delegate() {
        let options = HarnessAgentOptions {
            model: Some("openai/gpt-5.6-sol".into()),
            builtin_tools: Some(
                [
                    BuiltinToolName::Read,
                    BuiltinToolName::WebSearch,
                    BuiltinToolName::Subagent,
                ]
                .into(),
            ),
            ..quiet()
        };
        let spec = ChildSpec {
            tools: strings(&["read"]),
            ..Default::default()
        };
        let plan = build_child(options, spec).await.model_plan.unwrap();
        assert_eq!(plan.params.unwrap()["tools"], json!([{ "type": "web_search" }]));
    }

    #[cfg(feature = "openai")]
    #[tokio::test]
    async fn keeps_native_search_on_a_narrowed_delegate_of_a_default_configured_parent() {
        let options = HarnessAgentOptions {
            model: Some("openai/gpt-5.6-sol".into()),
            ..quiet()
        };
        let spec = ChildSpec {
            tools: strings(&["read"]),
            ..Default::default()
        };
        let plan = build_child(options, spec).await.model_plan.unwrap();
        assert_eq!(plan.provider, crate::models::Provider::OpenAI);
        assert_eq!(plan.params.unwrap()["tools"], json!([{ "type": "web_search" }]));
    }

    #[cfg(feature = "mcp")]
    #[tokio::test]
    async fn carries_the_exa_fallback_onto_a_narrowed_delegate() {
        let options = HarnessAgentOptions {
            builtin_tools: Some(
                BuiltinToolsConfig::builder()
                    .web_search(crate::WebSearchSetting::Exa)
                    .build()
                    .into(),
            ),
            ..quiet_with_mock()
        };
        let spec = ChildSpec {
            tools: strings(&["read"]),
            ..Default::default()
        };
        assert!(tool_names(&build_child(options, spec).await.config).contains(&"web_search".to_owned()));
    }

    #[cfg(feature = "mcp")]
    fn client_names(tools: &[ToolSource]) -> Vec<String> {
        tools
            .iter()
            .filter_map(|source| match source {
                ToolSource::McpClient(client) => Some(client.client_name().to_owned()),
                _ => None,
            })
            .collect()
    }

    #[cfg(feature = "mcp")]
    fn subagent_schema(config: &AgentConfig) -> serde_json::Value {
        let tool = config
            .tools
            .iter()
            .find_map(|source| match source {
                ToolSource::Tool(tool) if tool.name() == "subagent" => Some(tool),
                _ => None,
            })
            .unwrap();
        tool.tool_spec().input_schema.unwrap()
    }

    #[cfg(feature = "mcp")]
    #[tokio::test]
    async fn inherits_every_parent_mcp_server_also_on_a_narrowed_delegate() {
        let servers = json!({ "alpha": { "command": "node" }, "beta": { "command": "node" } });
        let options = HarnessAgentOptions {
            mcp_servers: Some(crate::McpServersOption::Json(servers.as_object().unwrap().clone())),
            ..quiet_with_mock()
        };
        let assembly = assembled(options).await;
        assert!(
            subagent_schema(&assembly.config)["properties"]
                .get("mcp_servers")
                .is_none()
        );
        let parent = parent_of(&assembly);
        let delegable = delegable(&parent.tools);
        let child = |tools: Option<Vec<String>>| {
            let spec = ChildSpec {
                tools,
                ..Default::default()
            };
            client_names(&child_options(&parent, &delegable, spec, &offline_env()).unwrap().tools)
        };
        assert_eq!(child(None), ["alpha", "beta"]);
        assert_eq!(child(strings(&["read"])), ["alpha", "beta"]);
    }

    #[cfg(feature = "mcp")]
    #[tokio::test]
    async fn hands_mcp_clients_passed_in_tools_to_a_narrowed_delegate_without_offering_them_as_tools() {
        use strands::mcp::{McpClient, McpClientConfig, McpClientOptions, McpLoadServersOptions, McpServersSource};

        let servers = json!({ "alpha": { "command": "node" } });
        let mut clients = McpClient::load_servers(
            McpServersSource::Json(servers.as_object().unwrap().clone()),
            McpClientOptions::default(),
            McpLoadServersOptions {
                prefix_with_server_name: true,
            },
        )
        .await
        .unwrap();
        clients.push(
            McpClient::new(McpClientConfig {
                url: Some("http://127.0.0.1:9/mcp".to_owned()),
                options: McpClientOptions {
                    prefix: Some("bare".to_owned()),
                    ..Default::default()
                },
                ..Default::default()
            })
            .unwrap(),
        );
        let options = HarnessAgentOptions {
            tools: clients.into_iter().map(ToolSource::McpClient).collect(),
            ..quiet_with_mock()
        };
        let parent = parent_of(&assembled(options).await);
        let options = subagent_tool_options(&parent, crate::SubagentConfig::default(), &offline_env());
        assert!(!options.inherited_tools.contains(&"alpha".to_owned()));
        let spec = ChildSpec {
            tools: strings(&["read"]),
            ..Default::default()
        };
        let child = child_options(&parent, &delegable(&parent.tools), spec, &offline_env()).unwrap();
        assert_eq!(client_names(&child.tools).len(), 2);
    }
}

mod subagent_selectable_set {
    use super::*;

    #[tokio::test]
    async fn keeps_subagent_for_sub_delegation_and_drops_web_search() {
        let parent = parent_of(&assembled(quiet_with_mock()).await);
        let options = subagent_tool_options(&parent, crate::SubagentConfig::default(), &offline_env());
        assert!(options.inherited_tools.contains(&"subagent".to_owned()));
        assert!(!options.inherited_tools.contains(&"web_search".to_owned()));
    }

    #[tokio::test]
    async fn adds_consumer_tools_and_the_depth_bound() {
        let options = HarnessAgentOptions {
            builtin_tools: Some(
                BuiltinToolsConfig::builder()
                    .subagent(crate::SubagentConfig { max_depth: Some(1) })
                    .build()
                    .into(),
            ),
            ..with_tools(vec![sample_tool()])
        };
        let assembly = assembled(options).await;
        let parent = parent_of(&assembly);
        let config = resolve_builtin_tools(Some(&BuiltinToolsOption::Mapping(parent.builtin_tools.clone())))
            .subagent_config()
            .unwrap();
        let options = subagent_tool_options(&parent, config, &offline_env());
        assert_eq!(options.max_depth, Some(1));
        assert!(options.inherited_tools.contains(&"sample_tool".to_owned()));
    }
}

mod create_harness_memory {
    use super::*;

    fn with_memory(memory: impl Into<MemoryOption>) -> HarnessAgentOptions {
        HarnessAgentOptions {
            memory: Some(memory.into()),
            ..quiet_with_mock()
        }
    }

    #[tokio::test]
    async fn attaches_a_memory_manager_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let config = assembled(with_memory(MemoryConfig::builder().dir(dir.path()).build()))
            .await
            .config;
        assert!(matches!(config.memory_manager, Some(MemoryManagerSource::Manager(_))));
    }

    #[tokio::test]
    async fn attaches_no_memory_manager_when_memory_is_disabled() {
        assert!(assembled(with_memory(false)).await.config.memory_manager.is_none());
    }

    #[tokio::test]
    async fn passes_a_memory_manager_given_as_memory_straight_through() {
        let config = assembled(with_memory(custom_manager())).await.config;
        assert!(matches!(config.memory_manager, Some(MemoryManagerSource::Manager(_))));
    }

    #[tokio::test]
    async fn lets_a_memory_manager_escape_hatch_win_over_a_memory_config() {
        let dir = tempfile::tempdir().unwrap();
        let options = HarnessAgentOptions {
            memory_manager: Some(MemoryManagerConfig::default().into()),
            ..with_memory(MemoryConfig::builder().dir(dir.path()).build())
        };
        assert!(matches!(
            assembled(options).await.config.memory_manager,
            Some(MemoryManagerSource::Config(_))
        ));
    }

    #[tokio::test]
    async fn manages_consumer_memory_stores_under_the_harness_policy() {
        let options = with_memory(MemoryConfig {
            stores: vec![Arc::new(Recall)],
            ..Default::default()
        });
        let config = assembled(options).await.config;
        let Some(MemoryManagerSource::Manager(manager)) = config.memory_manager else {
            panic!("a manager")
        };
        let names: Vec<String> = manager
            .get_tools()
            .into_iter()
            .flat_map(ToolSource::into_tools)
            .map(|tool| tool.name().to_owned())
            .collect();
        assert!(names.contains(&"search_memory".to_owned()));
    }
}

mod subagent_memory_and_plugin_forwarding {
    use super::*;

    struct PolicyPlugin;

    #[async_trait]
    impl Plugin for PolicyPlugin {
        fn name(&self) -> &str {
            "policy"
        }

        async fn init_agent(&self, _agent: &mut strands::agent::LocalAgent) -> strands::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn disables_the_delegates_memory_when_the_parent_uses_a_custom_memory_manager() {
        let options = HarnessAgentOptions {
            memory_manager: Some(custom_manager().into()),
            memory: None,
            ..quiet_with_mock()
        };
        let parent = parent_of(&assembled(options).await);
        assert!(matches!(parent.memory, Some(MemoryOption::Off)));
    }

    #[tokio::test]
    async fn forwards_the_parent_memory_stores_to_the_delegate_so_it_shares_the_same_backend() {
        let options = HarnessAgentOptions {
            memory: Some(
                MemoryConfig {
                    stores: vec![Arc::new(Recall)],
                    ..Default::default()
                }
                .into(),
            ),
            ..quiet_with_mock()
        };
        let parent = parent_of(&assembled(options).await);
        let Some(MemoryOption::On(memory)) = &parent.memory else {
            panic!("memory on")
        };
        assert_eq!(
            memory.stores.iter().map(|store| store.name()).collect::<Vec<_>>(),
            ["custom"]
        );
    }

    #[tokio::test]
    async fn forwards_consumer_plugins_to_the_delegate() {
        let options = HarnessAgentOptions {
            plugins: vec![Arc::new(PolicyPlugin)],
            ..quiet_with_mock()
        };
        let parent = parent_of(&assembled(options).await);
        assert_eq!(
            parent.plugins.iter().map(|plugin| plugin.name()).collect::<Vec<_>>(),
            ["policy"]
        );
    }
}

#[test]
fn sanitize_session_id_falls_back_to_default() {
    assert_eq!(sanitize_session_id("  "), "default");
    assert_eq!(sanitize_session_id("A b"), "a-b");
}

/// A factory that records what each configurable built-in is built with, then builds it for real.
mod builtin_tool_factories {
    use std::cell::RefCell;

    use super::*;
    use crate::factory::{BUILTIN_TOOL_FACTORY, BuiltinToolFactory, SubagentToolOptions};
    use crate::types::ProgrammaticToolCallerConfig;

    thread_local! {
        static CALLS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    fn record(call: String) {
        CALLS.with(|calls| calls.borrow_mut().push(call));
    }

    const RECORDING: BuiltinToolFactory = BuiltinToolFactory {
        shell: |config| {
            record(format!("shell {:?}", config.description));
            (BUILTIN_TOOL_FACTORY.shell)(config)
        },
        programmatic_tool_caller: |config: &ProgrammaticToolCallerConfig| {
            record(format!(
                "programmatic_tool_caller {:?} {:?}",
                config.allowed_tools, config.timeout
            ));
            (BUILTIN_TOOL_FACTORY.programmatic_tool_caller)(config)
        },
        subagent: |options: SubagentToolOptions| {
            record(format!("subagent {:?}", options.max_depth));
            (BUILTIN_TOOL_FACTORY.subagent)(options)
        },
        ..BUILTIN_TOOL_FACTORY
    };

    async fn calls_for(builtin_tools: BuiltinToolsConfig) -> (Vec<String>, Vec<String>) {
        CALLS.with(|calls| calls.borrow_mut().clear());
        let options = HarnessAgentOptions {
            builtin_tools: Some(builtin_tools.into()),
            ..quiet_with_mock()
        };
        let assembly = assemble_with(options, &offline_env(), &RECORDING).await.unwrap();
        (CALLS.with(|calls| calls.borrow().clone()), tool_names(&assembly.config))
    }

    fn only(calls: &[String], name: &str) -> Vec<String> {
        calls.iter().filter(|call| call.starts_with(name)).cloned().collect()
    }

    #[tokio::test]
    async fn builds_each_tool_from_its_factory_with_its_per_tool_config() {
        let shell = BuiltinToolsConfig::builder()
            .shell(ShellConfig::builder().description("Run a command.").build())
            .build();
        let (calls, names) = calls_for(shell).await;
        assert!(names.contains(&"shell".to_owned()));
        assert_eq!(only(&calls, "shell"), ["shell Some(\"Run a command.\")"]);

        let caller = ProgrammaticToolCallerConfig {
            allowed_tools: Some(vec!["read".to_owned()]),
            timeout: Some(Some(60.0)),
        };
        let (calls, names) = calls_for(BuiltinToolsConfig::builder().programmatic_tool_caller(caller).build()).await;
        assert!(names.contains(&"programmatic_tool_caller".to_owned()));
        assert_eq!(
            only(&calls, "programmatic"),
            ["programmatic_tool_caller Some([\"read\"]) Some(Some(60.0))"]
        );

        let unbounded = ProgrammaticToolCallerConfig {
            timeout: Some(None),
            ..Default::default()
        };
        let (calls, _) = calls_for(
            BuiltinToolsConfig::builder()
                .programmatic_tool_caller(unbounded)
                .build(),
        )
        .await;
        assert_eq!(
            only(&calls, "programmatic"),
            ["programmatic_tool_caller None Some(None)"]
        );

        let subagent = crate::SubagentConfig { max_depth: Some(1) };
        let (calls, names) = calls_for(BuiltinToolsConfig::builder().subagent(subagent).build()).await;
        assert!(names.contains(&"subagent".to_owned()));
        assert_eq!(only(&calls, "subagent"), ["subagent Some(1)"]);
    }

    #[tokio::test]
    async fn builds_each_tool_from_its_factory_with_no_config_when_enabled_with_true() {
        let (calls, _) = calls_for(
            BuiltinToolsConfig::builder()
                .shell(true)
                .programmatic_tool_caller(true)
                .subagent(true)
                .build(),
        )
        .await;
        assert_eq!(only(&calls, "shell"), ["shell None"]);
        assert_eq!(only(&calls, "programmatic"), ["programmatic_tool_caller None None"]);
        assert_eq!(only(&calls, "subagent"), ["subagent None"]);
    }
}

/// The environment plugin through `create_harness`.
mod builtin_plugins {
    use super::*;

    #[test]
    fn throws_on_an_unknown_built_in_plugin_name() {
        let error = "nope".parse::<BuiltinPluginName>().unwrap_err();
        assert!(error.to_string().contains("Unknown built-in plugin"));
    }

    #[tokio::test]
    async fn environment_is_enabled_by_default_and_opts_out_with_an_empty_list() {
        let config = assembled(quiet_with_mock()).await.config;
        assert!(
            config
                .plugins
                .iter()
                .any(|plugin| plugin.name() == "strands:environment")
        );
        let bare = HarnessAgentOptions {
            builtin_plugins: Some(Vec::new()),
            ..quiet_with_mock()
        };
        let config = assembled(bare).await.config;
        assert!(
            !config
                .plugins
                .iter()
                .any(|plugin| plugin.name() == "strands:environment")
        );
    }

    #[tokio::test]
    async fn a_consumer_plugin_named_like_a_built_in_replaces_it() {
        let options = HarnessAgentOptions {
            plugins: vec![Arc::new(crate::EnvironmentContext::default())],
            ..quiet_with_mock()
        };
        let config = assembled(options).await.config;
        assert_eq!(
            config
                .plugins
                .iter()
                .filter(|plugin| plugin.name() == "strands:environment")
                .count(),
            1
        );
    }
}

#[cfg(feature = "mcp")]
mod connected_mcp_delegates;
#[cfg(feature = "openai")]
mod openai_cache;
mod subagent_tool;
