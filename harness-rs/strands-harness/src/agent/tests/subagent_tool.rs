//! The harness `subagent` tool: the SDK's tool wired with the harness description, presets and
//! context choice, building each delegate through the harness.

use std::sync::Mutex;

use strands::{InterruptParams, InterruptResponse, StopReason};

use super::*;
use crate::builtin_tools::resolve_builtin_tools;

/// Options that keep a delegation test to the parent and its delegate.
fn delegating(model: MockModel, tools: Vec<Arc<dyn Tool>>) -> HarnessAgentOptions {
    HarnessAgentOptions {
        model: Some(Arc::new(model).into()),
        tools: tools.into_iter().map(Into::into).collect(),
        background_tasks: Some(false.into()),
        ..quiet()
    }
}

fn tool_use(name: &str, input: serde_json::Value) -> MockTurn {
    MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(name, name, input))])
}

fn subagent_spec(config: &AgentConfig) -> strands::ToolSpec {
    config
        .tools
        .iter()
        .find_map(|source| match source {
            ToolSource::Tool(tool) if tool.name() == "subagent" => Some(tool.tool_spec()),
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn is_the_sdk_tool_with_the_harness_description_generalist_preset_and_context_choice() {
    let options = HarnessAgentOptions {
        builtin_tools: Some([BuiltinToolName::Read, BuiltinToolName::Subagent].into()),
        ..quiet_with_mock()
    };
    let spec = subagent_spec(&assembled(options).await.config);
    assert_eq!(
        spec.description,
        "Delegate a self-contained task to a subagent that runs in its own context and returns a final report. Reach for this when a subtask would otherwise flood your context with intermediate work and you only need its conclusion. Do not poll for progress or redo its work."
    );
    let schema = serde_json::to_value(spec.input_schema.unwrap()).unwrap();
    let properties = schema["properties"].as_object().unwrap();
    let mut keys: Vec<&str> = properties.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "agent_type",
            "context",
            "instructions",
            "last_messages",
            "task",
            "tools"
        ]
    );
    assert_eq!(properties["agent_type"]["enum"], json!(["generalist"]));
    assert_eq!(properties["context"]["enum"], json!(["none", "all", "no_tools"]));
    assert_eq!(properties["tools"]["items"]["enum"], json!(["read", "subagent"]));
}

#[tokio::test]
async fn with_max_depth_registers_the_tool() {
    for (max_depth, registered) in [(0, false), (1, true)] {
        let mapping = BuiltinToolsConfig::builder()
            .subagent(crate::SubagentConfig {
                max_depth: Some(max_depth),
            })
            .build();
        let resolved = resolve_builtin_tools(Some(&mapping.clone().into()));
        assert_eq!(
            resolved.is_enabled(BuiltinToolName::Subagent),
            registered,
            "{max_depth}"
        );
        let options = HarnessAgentOptions {
            builtin_tools: Some(mapping.into()),
            ..quiet_with_mock()
        };
        let names = tool_names(&assembled(options).await.config);
        assert_eq!(names.contains(&"subagent".to_owned()), registered, "{max_depth}");
    }
}

#[tokio::test]
async fn builds_the_delegate_with_its_own_context_manager() {
    let parent = parent_of(&assembled(quiet_with_mock()).await);
    let child = child_options(&parent, &delegable(&parent.tools), ChildSpec::default(), &offline_env()).unwrap();
    let child = assembled(child).await;
    assert!(matches!(
        child.config.context_manager,
        Some(ContextManagerStrategy::Auto)
    ));
}

#[tokio::test]
async fn delegates_to_a_rebuilt_child_and_returns_its_answer_to_the_parent() {
    let model = MockModel::new()
        .with_turn(tool_use("subagent", json!({ "task": "add 1 and 2" })))
        .with_turn(MockTurn::text("3"))
        .with_turn(MockTurn::text("the child said 3"));
    let mut parent = create_harness_boxed(delegating(model, Vec::new()), offline_env())
        .await
        .unwrap();

    let result = parent.invoke("go").await.unwrap();

    assert_eq!(result.to_string(), "the child said 3");
    let messages = parent.messages();
    let result = serde_json::to_value(&messages[messages.len() - 2].content).unwrap();
    assert_eq!(result[0]["toolResult"]["toolUseId"], "subagent");
    assert_eq!(result[0]["toolResult"]["status"], "success");
    assert_eq!(result[0]["toolResult"]["content"][0]["text"], "3");
}

#[tokio::test]
async fn raises_a_delegate_interrupt_on_the_parent_under_the_subagent_namespace_and_resumes_it() {
    let executed = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&executed);
    let deploy: Arc<dyn Tool> = Arc::new(FunctionTool::builder("deploy", "Deploy after confirmation.").callback(
        move |_, context| {
            let log = Arc::clone(&log);
            async move {
                let answer = context.interrupt(InterruptParams::new("confirm").with_reason("deploy?"))?;
                if answer != json!("yes") {
                    return Ok(json!("declined"));
                }
                log.lock().unwrap().push("deploy");
                Ok(json!("deployed"))
            }
        },
    ));
    let model = MockModel::new()
        .with_turn(tool_use("subagent", json!({ "task": "deploy it" })))
        .with_turn(tool_use("deploy", json!({})))
        .with_turn(MockTurn::text("child deployed"))
        .with_turn(MockTurn::text("parent done"));
    let mut parent = create_harness_boxed(delegating(model, vec![deploy]), offline_env())
        .await
        .unwrap();

    let interrupted = parent.invoke("go").await.unwrap();
    assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
    let interrupt_id = interrupted.interrupts()[0].id.clone();
    assert!(interrupt_id.starts_with("subagent:subagent:"), "{interrupt_id}");

    let resumed = parent
        .invoke(vec![InterruptResponse::new(interrupt_id, "yes")])
        .await
        .unwrap();

    assert_eq!(resumed.to_string(), "parent done");
    assert_eq!(*executed.lock().unwrap(), ["deploy"]);
}
