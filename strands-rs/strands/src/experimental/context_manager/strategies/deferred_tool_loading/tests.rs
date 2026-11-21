use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::agent::{InvokeOptions, TakeSnapshotOptions};
use crate::background_tasks::BackgroundTasksConfig;
use crate::experimental::context_manager::{
    ContextManagerConfig, ContextManagerStrategy, Offload, OffloadConditions, OffloadTarget, StrategyEntry,
    StrategyPresetName, SummarizeConfig,
};
use crate::hooks::BeforeToolCallEvent;
use crate::models::model_proxy::count_request_tokens;
use crate::models::routing::{ModelRouter, ModelRouterOptions, RoutingCandidate, RoutingContext, RoutingStrategy};
use crate::models::{BaseModelConfig, ModelCapabilities, ModelInfo, ModelLimits, ModelRequest};
use crate::test_support::record_logs;
use crate::testing::{MockModel, MockTurn};
use crate::tools::{FunctionTool, ToolError, ToolSource};
use crate::types::{InterruptParams, InterruptResponse, Role, Snapshot, StopReason, Toggle, ToolUseBlock};
use crate::{Agent, BoxError};

fn make_tool(name: &str) -> FunctionTool {
    let label = name.to_owned();
    FunctionTool::builder(name, format!("Run {name}."))
        .input_schema(json!({
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"]
        }))
        .callback(move |input, _| {
            let text = format!("{label}:{}", input["value"].as_str().unwrap_or_default());
            async move { Ok::<_, ToolError>(json!(text)) }
        })
}

fn default_tools() -> Vec<ToolSource> {
    ["shell", "read", "write"]
        .into_iter()
        .map(|name| ToolSource::from(make_tool(name)))
        .collect()
}

fn shell_schema() -> JsonValue {
    make_tool("shell").tool_spec().input_schema.unwrap()
}

/// Three tools' schemas, as `heuristic_json` estimates them.
fn schema_tokens() -> u64 {
    3 * heuristic_json(&shell_schema())
}

#[derive(Default)]
struct Options {
    strategy: Option<StrategyEntry>,
    tools: Option<Vec<ToolSource>>,
    background_tasks: Option<BackgroundTasksConfig>,
    /// Puts the model behind a router whose default model has this capability and that sends every
    /// call to it.
    router_default: Option<DeferredToolLoading>,
}

fn capability(deferred_tool_loading: Option<DeferredToolLoading>) -> BaseModelConfig {
    BaseModelConfig {
        model_info: Some(ModelInfo {
            capabilities: ModelCapabilities {
                deferred_tool_loading,
                ..ModelCapabilities::default()
            },
            ..ModelInfo::default()
        }),
        ..BaseModelConfig::default()
    }
}

struct Second;

#[async_trait]
impl RoutingStrategy for Second {
    async fn select(&self, context: &RoutingContext) -> std::result::Result<Option<RoutingCandidate>, BoxError> {
        Ok(context.candidates.get(1).cloned())
    }
}

fn defer_all() -> StrategyEntry {
    Offload::defer(DeferTarget::ToolSpecs).unwrap().into()
}

fn make_agent(deferred_tool_loading: Option<DeferredToolLoading>, options: Options) -> (Agent, MockModel) {
    let model = MockModel::new();
    model.update_config(capability(deferred_tool_loading)).unwrap();
    let strategy = options.strategy.unwrap_or_else(defer_all);
    let builder = Agent::builder()
        .tools(options.tools.unwrap_or_else(default_tools))
        .context_manager(ContextManagerStrategy::Config(ContextManagerConfig {
            strategies: Some(vec![strategy]),
            ..ContextManagerConfig::default()
        }))
        .maybe_background_tasks(options.background_tasks.map(Toggle::On))
        .printer(false);
    let agent = match options.router_default {
        Some(default_capability) => {
            let default_model = MockModel::new();
            default_model
                .update_config(capability(Some(default_capability)))
                .unwrap();
            let router = ModelRouter::new(
                [Arc::new(default_model) as Arc<dyn Model>, Arc::new(model.clone())],
                ModelRouterOptions {
                    strategy: Some(Arc::new(Second)),
                    max_switches: None,
                },
            )
            .unwrap();
            builder.model(router).build().unwrap()
        }
        None => builder.model(model.clone()).build().unwrap(),
    };
    (agent, model)
}

fn native(options: Options) -> (Agent, MockModel) {
    make_agent(Some(DeferredToolLoading::Native), options)
}

fn with_strategy(strategy: StrategyEntry) -> Options {
    Options {
        strategy: Some(strategy),
        ..Options::default()
    }
}

fn defer_when(target: DeferTarget, conditions: DeferConditions) -> StrategyEntry {
    Offload::defer(target).unwrap().when(conditions).unwrap().into()
}

fn tool_use(name: &str, id: &str, input: JsonValue) -> MockTurn {
    MockTurn::content([ContentBlock::from(ToolUseBlock::new(name, id, input))])
}

fn sent_tool_specs(model: &MockModel) -> Vec<Vec<ToolSpec>> {
    model.requests().into_iter().map(|request| request.tool_specs).collect()
}

fn names(specs: &[ToolSpec]) -> Vec<String> {
    specs.iter().map(|spec| spec.name.clone()).collect()
}

/// The tools a model call defers, in the order of its tool specs.
fn deferred_names(model: &MockModel, call: usize) -> Vec<String> {
    let request: ModelRequest = model.requests().remove(call);
    request
        .tool_specs
        .iter()
        .filter(|spec| request.deferred_tools.contains(&spec.name))
        .map(|spec| spec.name.clone())
        .collect()
}

fn tool_result(message: &Message) -> &ToolResultBlock {
    let ContentBlock::ToolResult(result) = &message.content[0] else {
        panic!("not a tool result");
    };
    result
}

fn reference(name: &str) -> ToolResultContent {
    ToolReferenceBlock::new(name).into()
}

fn early_call_answer(name: &str) -> Vec<ToolResultContent> {
    vec![
        ToolResultContent::text(format!(
            "Not run: {name} was called before its parameters were loaded. They are loaded now; call it again."
        )),
        reference(name),
    ]
}

fn set_capability(agent: &Agent, deferred_tool_loading: DeferredToolLoading) {
    agent
        .model()
        .update_config(capability(Some(deferred_tool_loading)))
        .unwrap();
}

fn approve(event: &mut BeforeToolCallEvent, interrupted: &str) {
    if event.tool_use().name != interrupted {
        return;
    }
    match event.interrupt(InterruptParams::new("approve").with_reason("Run this tool?")) {
        Ok(answer) if answer == json!("yes") => {}
        Ok(_) => event.set_cancel("not approved"),
        Err(_) => {}
    }
}

/// Runs the model's tool calls, interrupting the last one, then approves that call on a restored
/// agent, which runs it before its first model call. Returns the interrupted call's result and the
/// restored agent's model.
async fn resume_call(
    calls: &[(&str, JsonValue)],
    options: impl Fn() -> Options,
    deferred_tool_loading: DeferredToolLoading,
) -> (ToolResultBlock, MockModel) {
    let interrupted = calls.last().unwrap().0.to_owned();
    let (mut agent, model) = make_agent(Some(deferred_tool_loading), options());
    let name = interrupted.clone();
    agent.add_hook(move |event: &mut BeforeToolCallEvent| approve(event, &name));
    for (index, (name, input)) in calls.iter().enumerate() {
        model.add_turn(tool_use(name, &format!("call-{index}"), input.clone()));
    }
    let first = agent.invoke("List the files.").await.unwrap();
    assert_eq!(first.stop_reason(), StopReason::Interrupt);
    let json = serde_json::to_string(&agent.take_snapshot(TakeSnapshotOptions::session()).unwrap()).unwrap();
    let snapshot: Snapshot = serde_json::from_str(&json).unwrap();

    let (mut restored, restored_model) = make_agent(Some(deferred_tool_loading), options());
    let name = interrupted.clone();
    restored.add_hook(move |event: &mut BeforeToolCallEvent| approve(event, &name));
    restored_model.add_turn("done");
    restored.load_snapshot(&snapshot).unwrap();
    let interrupt_id = first.interrupts()[0].id.clone();
    restored
        .invoke(vec![InterruptResponse::new(interrupt_id, json!("yes"))])
        .await
        .unwrap();
    let tool_use_id = format!("call-{}", calls.len() - 1);
    let result = restored
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .find_map(|block| match block {
            ContentBlock::ToolResult(result) if result.tool_use_id == tool_use_id => Some(result.clone()),
            _ => None,
        })
        .unwrap();
    (result, restored_model)
}

const SDK_AND_DEFAULT: [&str; 5] = ["shell", "read", "write", "retrieve_context", "load_tools"];

#[tokio::test]
async fn defers_every_tool_spec_but_the_sdk_ones_on_a_native_model_keeps_the_tools_list_fixed_and_loads_through_load_tools()
 {
    let (mut agent, model) = native(Options::default());
    model
        .add_turn(tool_use("load_tools", "load-1", json!({"names": ["shell"]})))
        .add_turn(tool_use("shell", "shell-1", json!({"value": "ls"})))
        .add_turn("done");

    agent.invoke("List the files.").await.unwrap();

    let sent = sent_tool_specs(&model);
    assert_eq!(sent[1], sent[0]);
    assert_eq!(sent[2], sent[0]);
    for call in 0..3 {
        assert_eq!(deferred_names(&model, call), ["shell", "read", "write"]);
    }
    assert_eq!(names(&sent[0]), SDK_AND_DEFAULT);
    assert_eq!(tool_result(&agent.messages()[2]).content, vec![reference("shell")]);
    let sent_load = model.requests().remove(1).messages.remove(2);
    assert_eq!(tool_result(&sent_load).content, vec![reference("shell")]);
}

#[tokio::test]
async fn loads_nothing_when_the_call_asks_for_a_name_that_is_not_a_tool_a_tool_shown_in_full_or_both() {
    let cases = [
        (json!(["shell", "nope"]), "nope is not a tool"),
        (
            json!(["shell", "retrieve_context"]),
            "retrieve_context is shown in full, so call it directly",
        ),
        (
            json!(["nope", "retrieve_context", "other"]),
            "retrieve_context is shown in full, so call it directly; nope, other are not tools",
        ),
    ];
    for (names, reason) in cases {
        let (mut agent, model) = native(Options::default());
        model
            .add_turn(tool_use("load_tools", "load-1", json!({"names": names})))
            .add_turn("done");

        agent.invoke("List the files.").await.unwrap();

        let result = tool_result(&agent.messages()[2]);
        assert_eq!(result.status, crate::types::ToolResultStatus::Error);
        assert_eq!(
            result.content,
            vec![ToolResultContent::text(format!(
                "Error: Nothing loaded: {reason}. Load only tools whose parameters are not shown."
            ))]
        );
    }
}

#[tokio::test]
async fn loads_each_tool_once_when_the_call_names_it_twice() {
    let (mut agent, model) = native(Options::default());
    model
        .add_turn(tool_use("load_tools", "load-1", json!({"names": ["shell", "shell"]})))
        .add_turn("done");

    agent.invoke("List the files.").await.unwrap();

    assert_eq!(tool_result(&agent.messages()[2]).content, vec![reference("shell")]);
}

#[tokio::test]
async fn loads_nothing_and_reports_an_error_when_the_call_names_no_tool() {
    let (mut agent, model) = native(Options::default());
    model
        .add_turn(tool_use("load_tools", "load-1", json!({"names": []})))
        .add_turn("done");

    agent.invoke("List the files.").await.unwrap();

    assert_eq!(
        tool_result(&agent.messages()[2]).status,
        crate::types::ToolResultStatus::Error
    );
}

#[tokio::test]
async fn keeps_the_agent_skills_skills_tool_which_the_skills_listing_tells_the_model_to_call_out_of_the_deferred_tools()
{
    // Protected by name, so a tool with the name AgentSkills gives its tool stands in for the plugin.
    let mut tools = default_tools();
    tools.push(make_tool("skills").into());
    let (mut agent, model) = native(Options {
        tools: Some(tools),
        ..Options::default()
    });
    model.add_turn("ok");

    agent.invoke("Hi.").await.unwrap();

    assert!(names(&sent_tool_specs(&model)[0]).contains(&"skills".to_owned()));
    assert_eq!(deferred_names(&model, 0), ["shell", "read", "write"]);
}

#[tokio::test]
async fn keeps_the_background_tasks_manage_tool_out_of_the_deferred_tools_under_its_default_name_and_a_manage_tool_name()
 {
    for (manage_tool_name, tool_name) in [
        (None, "strands_manage_background_task"),
        (Some("tasks".to_owned()), "tasks"),
    ] {
        let (mut agent, model) = native(Options {
            background_tasks: Some(BackgroundTasksConfig {
                manage_tool_name,
                ..BackgroundTasksConfig::default()
            }),
            ..Options::default()
        });
        model.add_turn("ok");

        agent.invoke("Hi.").await.unwrap();

        assert!(names(&sent_tool_specs(&model)[0]).contains(&tool_name.to_owned()));
        assert_eq!(deferred_names(&model, 0), ["shell", "read", "write"]);
    }
}

#[tokio::test]
async fn sends_stubs_that_point_at_load_tools_and_answers_a_call_made_before_the_load_with_the_schema() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let guarded = FunctionTool::builder("shell", "Run shell.")
        .input_schema(json!({"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}))
        .callback(move |input, _| {
            seen.lock().unwrap().push(input.clone());
            async move { Ok::<_, ToolError>(json!(format!("shell:{}", input["value"].as_str().unwrap_or_default()))) }
        });
    let schema = guarded.tool_spec().input_schema.unwrap();
    let (mut agent, model) = make_agent(
        Some(DeferredToolLoading::Stubs),
        Options {
            tools: Some(vec![guarded.into()]),
            ..Options::default()
        },
    );
    model
        .add_turn(tool_use("shell", "early", json!({})))
        .add_turn(tool_use("shell", "loaded", json!({"value": "ls"})))
        .add_turn("done");

    agent.invoke("List the files.").await.unwrap();

    let stub = sent_tool_specs(&model)[0]
        .iter()
        .find(|spec| spec.name == "shell")
        .cloned()
        .unwrap();
    assert_eq!(
        stub,
        ToolSpec::new(
            "shell",
            "Run shell.\nCall load_tools with this name for its parameters first."
        )
        .with_input_schema(json!({"type": "object"}))
    );
    assert_eq!(
        *tool_result(&agent.messages()[2]),
        ToolResultBlock::error("early", early_call_answer("shell"))
    );
    let sent_guard = model.requests().remove(1).messages.remove(2);
    assert_eq!(
        tool_result(&sent_guard).content,
        vec![
            early_call_answer("shell").remove(0),
            ToolResultContent::text(format!("shell parameters: {schema}")),
        ]
    );
    assert_eq!(*calls.lock().unwrap(), vec![json!({"value": "ls"})]);
}

#[tokio::test]
async fn answers_a_call_to_a_natively_deferred_tool_made_before_its_load_and_runs_a_tool_kept_in_full() {
    let (mut agent, model) = native(with_strategy(defer_when(
        DeferTarget::tools(["!read"]),
        DeferConditions {
            tool_count: Some(1.into()),
            ..DeferConditions::default()
        },
    )));
    model
        .add_turn(tool_use("shell", "early", json!({"value": "ls"})))
        .add_turn(tool_use("read", "direct", json!({"value": "notes"})))
        .add_turn("done");

    agent.invoke("List the files.").await.unwrap();

    assert_eq!(
        tool_result(&agent.messages()[2]).content[0],
        early_call_answer("shell")[0]
    );
    let direct = tool_result(&agent.messages()[4]);
    assert_eq!(
        (direct.tool_use_id.as_str(), direct.status),
        ("direct", crate::types::ToolResultStatus::Success)
    );
}

#[tokio::test]
async fn answers_an_early_call_on_the_model_a_model_router_picked_though_its_default_model_can_not_defer_tools() {
    let (mut agent, model) = make_agent(
        Some(DeferredToolLoading::Stubs),
        Options {
            router_default: Some(DeferredToolLoading::Unsupported),
            ..Options::default()
        },
    );
    model.add_turn(tool_use("shell", "early", json!({}))).add_turn("done");

    agent.invoke("List the files.").await.unwrap();

    assert_eq!(
        tool_result(&agent.messages()[2]).content[0],
        early_call_answer("shell")[0]
    );
}

#[tokio::test]
async fn keeps_deferring_when_a_later_call_model_defers_another_way() {
    let (mut agent, model) = native(Options::default());
    model.add_turn("one").add_turn("two");

    agent.invoke("First.").await.unwrap();
    set_capability(&agent, DeferredToolLoading::Stubs);
    agent.invoke("Second.").await.unwrap();

    let sent = sent_tool_specs(&model);
    let shell = |call: usize| sent[call].iter().find(|spec| spec.name == "shell").cloned().unwrap();
    assert_eq!(shell(0), make_tool("shell").tool_spec());
    assert_eq!(shell(1).input_schema, Some(json!({"type": "object"})));
    assert_eq!(deferred_names(&model, 1), ["shell", "read", "write"]);
}

#[tokio::test]
async fn defers_a_tool_registered_after_the_first_call() {
    let (mut agent, model) = native(Options::default());
    model.add_turn("one").add_turn("two");

    agent.invoke("First.").await.unwrap();
    agent.tool_registry_mut().add(make_tool("late")).unwrap();
    agent.invoke("Second.").await.unwrap();

    assert_eq!(deferred_names(&model, 0), ["shell", "read", "write"]);
    assert_eq!(deferred_names(&model, 1), ["shell", "read", "write", "late"]);
}

#[tokio::test]
async fn starts_deferring_on_the_first_call_whose_tools_meet_the_conditions_and_logs_the_change_once() {
    let (logs, _guard) = record_logs();
    let (mut agent, model) = native(with_strategy(defer_when(
        DeferTarget::ToolSpecs,
        DeferConditions {
            tool_count: Some(6.into()),
            ..DeferConditions::default()
        },
    )));
    model.add_turn("one").add_turn("two").add_turn("three");

    agent.invoke("First.").await.unwrap();
    agent.tool_registry_mut().add(make_tool("late")).unwrap();
    agent.invoke("Second.").await.unwrap();
    agent.invoke("Third.").await.unwrap();

    let sent = sent_tool_specs(&model);
    assert!(deferred_names(&model, 0).is_empty());
    assert!(!names(&sent[0]).contains(&"load_tools".to_owned()));
    assert_eq!(deferred_names(&model, 1), ["shell", "read", "write", "late"]);
    assert!(names(&sent[1]).contains(&"load_tools".to_owned()));
    let changes: Vec<String> = logs
        .text()
        .lines()
        .filter(|line| line.contains("deferred tools changed"))
        .map(str::to_owned)
        .collect();
    assert_eq!(changes.len(), 1);
    assert!(changes[0].ends_with("model_id=<test-model>, deferred=<4> | deferred tools changed"));
}

#[tokio::test]
async fn runs_load_tools_in_the_foreground_when_background_tasks_are_on() {
    let (mut agent, model) = native(Options {
        background_tasks: Some(BackgroundTasksConfig {
            always: Some(vec!["*".to_owned()]),
            ..BackgroundTasksConfig::default()
        }),
        ..Options::default()
    });
    model
        .add_turn(tool_use("load_tools", "load-1", json!({"names": ["shell"]})))
        .add_turn("done");

    agent.invoke("List the files.").await.unwrap();

    assert_eq!(tool_result(&agent.messages()[2]).content, vec![reference("shell")]);
}

#[tokio::test]
async fn sends_the_same_tools_list_after_a_session_restore_with_nothing_saved_for_it() {
    let (mut agent, model) = native(Options::default());
    model.add_turn("one");
    agent.invoke("First.").await.unwrap();
    let snapshot = agent.take_snapshot(TakeSnapshotOptions::session()).unwrap();

    let (mut restored, restored_model) = native(Options::default());
    restored_model.add_turn("two");
    restored.load_snapshot(&snapshot).unwrap();
    restored.invoke("Second.").await.unwrap();

    assert!(snapshot.data.get("state").is_none_or(|state| state == &json!({})));
    assert_eq!(sent_tool_specs(&restored_model), sent_tool_specs(&model));
    assert_eq!(deferred_names(&restored_model, 0), deferred_names(&model, 0));
}

#[tokio::test]
async fn loads_a_tool_when_an_interrupted_load_resumes_on_a_restored_agent_before_its_first_model_call() {
    let cases: [fn() -> Options; 3] = [
        Options::default,
        // The call defers once background tasks add to the schemas schemaTokens measures.
        || Options {
            strategy: Some(defer_when(
                DeferTarget::ToolSpecs,
                DeferConditions {
                    schema_tokens: Some((schema_tokens() + 1).into()),
                    ..DeferConditions::default()
                },
            )),
            background_tasks: Some(BackgroundTasksConfig::default()),
            ..Options::default()
        },
        // The call defers on the model a router picks over a default that can not defer tools.
        || Options {
            router_default: Some(DeferredToolLoading::Unsupported),
            ..Options::default()
        },
    ];
    for options in cases {
        let (result, model) = resume_call(
            &[("load_tools", json!({"names": ["shell"]}))],
            options,
            DeferredToolLoading::Native,
        )
        .await;

        assert_eq!(result.content, vec![reference("shell")]);
        assert_eq!(deferred_names(&model, 0), ["shell", "read", "write"]);
    }
}

#[tokio::test]
async fn answers_a_call_to_an_unloaded_deferred_tool_when_the_interrupted_call_resumes_on_a_restored_agent() {
    for deferred_tool_loading in [DeferredToolLoading::Native, DeferredToolLoading::Stubs] {
        let (result, _) = resume_call(
            &[("shell", json!({"value": "ls"}))],
            Options::default,
            deferred_tool_loading,
        )
        .await;

        assert_eq!(result, ToolResultBlock::error("call-0", early_call_answer("shell")));
    }
}

#[tokio::test]
async fn runs_an_approved_call_that_resumes_on_a_restored_agent_when_nothing_was_deferred() {
    let cases: [(fn() -> Options, DeferredToolLoading); 2] = [
        // Its tools are below the conditions.
        (
            || with_strategy(StrategyPresetName::DeferredToolLoading.into()),
            DeferredToolLoading::Native,
        ),
        // Its model can not defer tools.
        (Options::default, DeferredToolLoading::Unsupported),
    ];
    for (options, deferred_tool_loading) in cases {
        let (result, _) = resume_call(&[("shell", json!({"value": "ls"}))], options, deferred_tool_loading).await;

        assert_eq!(
            (result.tool_use_id.as_str(), result.status),
            ("call-0", crate::types::ToolResultStatus::Success)
        );
    }
}

#[tokio::test]
async fn runs_a_resumed_call_on_a_restored_agent_to_a_tool_its_conversation_loaded() {
    let (result, _) = resume_call(
        &[
            ("load_tools", json!({"names": ["shell"]})),
            ("shell", json!({"value": "ls"})),
        ],
        Options::default,
        DeferredToolLoading::Native,
    )
    .await;

    assert_eq!(
        (result.tool_use_id.as_str(), result.status),
        ("call-1", crate::types::ToolResultStatus::Success)
    );
}

#[tokio::test]
async fn loads_no_tool_the_target_keeps_in_full_when_an_interrupted_load_resumes_on_a_restored_agent() {
    let (result, _) = resume_call(
        &[("load_tools", json!({"names": ["read"]}))],
        || with_strategy(Offload::defer(DeferTarget::tools(["!read"])).unwrap().into()),
        DeferredToolLoading::Native,
    )
    .await;

    assert_eq!(
        result.content,
        vec![ToolResultContent::text(
            "Error: Nothing loaded: read is shown in full, so call it directly. Load only tools whose parameters are not shown."
        )]
    );
}

#[tokio::test]
async fn counts_each_deferred_tool_as_the_model_sees_it_when_the_context_manager_measures_the_next_request() {
    let hint = "\nCall load_tools with this name for its parameters first.";
    let cases = [
        // Counts each deferred tool by its name and description.
        (
            DeferredToolLoading::Native,
            SDK_AND_DEFAULT.to_vec(),
            vec!["shell", "read", "write"],
            "",
        ),
        // Counts each deferred tool as its stub on a model that takes stubs.
        (
            DeferredToolLoading::Stubs,
            SDK_AND_DEFAULT.to_vec(),
            vec!["shell", "read", "write"],
            hint,
        ),
        // Counts every tool the request sends in full on a model that can not defer tools.
        (
            DeferredToolLoading::Unsupported,
            vec!["shell", "read", "write", "retrieve_context"],
            vec![],
            "",
        ),
    ];
    for (deferred_tool_loading, sent, deferred, hint) in cases {
        let counted = Arc::new(Mutex::new(Vec::new()));
        let (mut agent, _) = make_agent(Some(deferred_tool_loading), Options::default());
        agent.initialize().await.unwrap();
        let counting = CountingModel::new(agent.model().clone(), counted.clone());
        agent.local_mut().set_model(Arc::new(counting));

        count_request_tokens(agent.local(), agent.messages()).await.unwrap();

        let expected: Vec<ToolSpec> = sent
            .iter()
            .map(|name| {
                let spec = agent.tool_registry().get(name).unwrap().tool_spec();
                if deferred.contains(name) {
                    ToolSpec::new(*name, format!("{}{hint}", spec.description))
                        .with_input_schema(json!({"type": "object"}))
                } else {
                    spec
                }
            })
            .collect();
        assert_eq!(counted.lock().unwrap()[0].1, expected);
    }
}

#[tokio::test]
async fn keeps_the_order_sort_tools_gives_in_the_model_call_and_when_the_context_manager_measures_the_next_request() {
    let model = MockModel::new().with_turn("ok");
    model
        .update_config(capability(Some(DeferredToolLoading::Stubs)))
        .unwrap();
    let mut agent = Agent::builder()
        .model(model.clone())
        .tools(["write", "shell", "read"].map(|name| ToolSource::from(make_tool(name))))
        .sort_tools(true)
        .context_manager(ContextManagerStrategy::Config(ContextManagerConfig {
            strategies: Some(vec![defer_all()]),
            ..ContextManagerConfig::default()
        }))
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("Hi.").await.unwrap();
    let counted = Arc::new(Mutex::new(Vec::new()));
    let counting = CountingModel::new(agent.model().clone(), counted.clone());
    agent.local_mut().set_model(Arc::new(counting));
    count_request_tokens(agent.local(), agent.messages()).await.unwrap();

    let sorted = ["load_tools", "read", "retrieve_context", "shell", "write"];
    assert_eq!(names(&sent_tool_specs(&model)[0]), sorted);
    assert_eq!(names(&counted.lock().unwrap().last().unwrap().1), sorted);
}

#[tokio::test]
async fn counts_a_loaded_tool_by_its_full_schema_when_the_context_manager_measures_the_next_request() {
    let (mut agent, model) = native(Options::default());
    model
        .add_turn(tool_use("load_tools", "load-1", json!({"names": ["shell"]})))
        .add_turn("done");
    agent.invoke("List the files.").await.unwrap();
    let counted = Arc::new(Mutex::new(Vec::new()));
    let counting = CountingModel::new(agent.model().clone(), counted.clone());
    agent.local_mut().set_model(Arc::new(counting));

    count_request_tokens(agent.local(), agent.messages()).await.unwrap();

    let messages = counted.lock().unwrap()[0].0.clone();
    assert_eq!(
        tool_result(&messages[2]).content,
        vec![ToolResultContent::json(shell_schema())]
    );
}

#[tokio::test]
async fn sends_every_spec_without_the_loader_on_a_model_that_can_not_defer_tools() {
    let (logs, _guard) = record_logs();
    let (mut agent, model) = make_agent(Some(DeferredToolLoading::Unsupported), Options::default());
    // The warning is once per process and model, so this model has an id no other test uses.
    agent
        .model()
        .update_config(BaseModelConfig {
            model_id: Some("never-defers".to_owned()),
            ..BaseModelConfig::default()
        })
        .unwrap();
    model.add_turn("ok");

    agent.invoke("Hi.").await.unwrap();

    assert!(deferred_names(&model, 0).is_empty());
    assert!(!names(&sent_tool_specs(&model)[0]).contains(&"load_tools".to_owned()));
    assert!(logs.text().contains(
        "model_id=<never-defers> | model or its config can not defer tool schemas | sending every tool spec"
    ));
}

#[tokio::test]
async fn warns_once_when_it_sends_stubs_to_a_model_the_shared_model_info_does_not_list_and_not_otherwise() {
    let cases = [
        // Warns once when it sends stubs to a model the shared model info does not list.
        (None, "unlisted-a", 1),
        // Does not warn when the model config chose stubs.
        (Some(DeferredToolLoading::Stubs), "unlisted-b", 0),
        // Does not warn when the shared model info lists the model.
        (None, "gpt-5.4", 0),
    ];
    for (deferred_tool_loading, model_id, warnings) in cases {
        let (logs, _guard) = record_logs();
        let (mut agent, model) = make_agent(deferred_tool_loading, Options::default());
        agent
            .model()
            .update_config(BaseModelConfig {
                model_id: Some(model_id.to_owned()),
                ..BaseModelConfig::default()
            })
            .unwrap();
        model.add_turn("one").add_turn("two");

        agent.invoke("First.").await.unwrap();
        agent.invoke("Second.").await.unwrap();

        assert_eq!(
            agent.model().model_info().capabilities.deferred_tool_loading,
            Some(DeferredToolLoading::Stubs)
        );
        let expected = format!(
            "model_id=<{model_id}> | model is not in the shared model info | sending deferred tools as stubs, set modelInfo.capabilities.deferredToolLoading to unsupported if it calls them badly"
        );
        assert_eq!(logs.text().matches(&expected).count(), warnings, "{model_id}");
    }
}

#[tokio::test]
async fn sends_every_spec_without_the_loader_when_a_later_call_model_can_not_defer_tools() {
    let (mut agent, model) = native(Options::default());
    model.add_turn("one").add_turn("two");

    agent.invoke("First.").await.unwrap();
    set_capability(&agent, DeferredToolLoading::Unsupported);
    agent.invoke("Second.").await.unwrap();

    assert!(deferred_names(&model, 1).is_empty());
    assert!(!names(&sent_tool_specs(&model)[1]).contains(&"load_tools".to_owned()));
}

#[tokio::test]
async fn defers_tools_on_a_later_call_whose_model_can_after_a_first_call_on_a_model_that_can_not() {
    let (mut agent, model) = make_agent(Some(DeferredToolLoading::Unsupported), Options::default());
    model.add_turn("one").add_turn("two");

    agent.invoke("First.").await.unwrap();
    set_capability(&agent, DeferredToolLoading::Native);
    agent.invoke("Second.").await.unwrap();

    assert_eq!(deferred_names(&model, 1), ["shell", "read", "write"]);
    assert!(names(&sent_tool_specs(&model)[1]).contains(&"load_tools".to_owned()));
}

mod target {
    use super::*;

    #[tokio::test]
    async fn with_a_target_defers_its_tools_and_sends_the_other_tools_in_full() {
        let cases: [(&[&str], &[&str]); 4] = [
            (&["!shell"], &["read", "write"]),
            (&["!tool::shell", "!read"], &["write"]),
            (&["shell"], &["shell"]),
            (&["tool::shell", "read", "!read"], &["shell"]),
        ];
        for (target, expected) in cases {
            let (mut agent, model) = native(with_strategy(
                Offload::defer(DeferTarget::tools(target.iter().copied()))
                    .unwrap()
                    .into(),
            ));
            model.add_turn("ok");

            agent.invoke("Hi.").await.unwrap();

            assert_eq!(deferred_names(&model, 0), expected, "{target:?}");
        }
    }

    #[tokio::test]
    async fn never_defers_an_sdk_tool_the_target_names() {
        let (mut agent, model) = native(with_strategy(
            Offload::defer(DeferTarget::tools(["shell", "load_tools", "retrieve_context"]))
                .unwrap()
                .into(),
        ));
        model.add_turn("ok");

        agent.invoke("Hi.").await.unwrap();

        assert_eq!(deferred_names(&model, 0), ["shell"]);
    }

    #[tokio::test]
    async fn never_defers_a_tool_that_takes_no_parameters_so_a_call_to_it_runs_without_a_load() {
        for background_tasks in [None, Some(BackgroundTasksConfig::default())] {
            let ping = FunctionTool::builder("ping", "Ping the service.")
                .input_schema(json!({"type": "object", "properties": {}}))
                .callback(|_, _| async { Ok::<_, ToolError>(json!("pong")) });
            let (mut agent, model) = make_agent(
                Some(DeferredToolLoading::Stubs),
                Options {
                    tools: Some(vec![make_tool("shell").into(), ping.into()]),
                    background_tasks,
                    ..Options::default()
                },
            );
            model.add_turn(tool_use("ping", "ping-1", json!({}))).add_turn("done");

            agent.invoke("Ping it.").await.unwrap();

            assert_eq!(deferred_names(&model, 0), ["shell"]);
            let ping_spec = sent_tool_specs(&model)[0]
                .iter()
                .find(|spec| spec.name == "ping")
                .cloned()
                .unwrap();
            assert_eq!(ping_spec.description, "Ping the service.");
            assert_eq!(
                tool_result(&agent.messages()[2]).status,
                crate::types::ToolResultStatus::Success
            );
        }
    }

    #[tokio::test]
    async fn with_the_input_schema_defers_the_tool_when_it_takes_parameters() {
        let cases = [
            (json!({"type": "object"}), false),
            (
                json!({"type": "object", "properties": {}, "required": [], "additionalProperties": false, "title": "Ping"}),
                false,
            ),
            (
                json!({"type": "object", "properties": {"host": {"type": "string"}}}),
                true,
            ),
            (
                json!({"type": "object", "additionalProperties": {"type": "string"}}),
                true,
            ),
            (
                json!({"type": "object", "oneOf": [{"required": ["host"]}, {"required": ["ip"]}]}),
                true,
            ),
        ];
        for (input_schema, deferred) in cases {
            let target = FunctionTool::builder("target", "Run target.")
                .input_schema(input_schema.clone())
                .callback(|_, _| async { Ok::<_, ToolError>(json!("ok")) });
            let (mut agent, model) = native(Options {
                tools: Some(vec![target.into()]),
                ..Options::default()
            });
            model.add_turn("ok");

            agent.invoke("Hi.").await.unwrap();

            let expected: &[&str] = if deferred { &["target"] } else { &[] };
            assert_eq!(deferred_names(&model, 0), expected, "{input_schema}");
        }
    }

    #[test]
    fn rejects_a_target_it_can_not_act_on() {
        let cases = [
            (
                DeferTarget::Tools(Vec::new()),
                "Empty array target matches nothing — provide at least one target".to_owned(),
            ),
            (
                DeferTarget::tools(["shell", "!shell"]),
                "Tool target [\"shell\",\"!shell\"] excludes every tool it includes, so it matches nothing".to_owned(),
            ),
            (
                DeferTarget::tools(["toolSpecs", "!shell"]),
                "Offload.defer target [\"toolSpecs\",\"!shell\"] lists 'toolSpecs', which is not a tool name: use 'toolSpecs' alone, or list only the tools to keep in full, such as ['!shell']".to_owned(),
            ),
        ];
        for (target, message) in cases {
            assert_eq!(Offload::defer(target).unwrap_err().to_string(), message);
        }
    }
}

#[tokio::test]
async fn warns_once_per_process_when_the_strategy_has_no_conditions() {
    let (logs, _guard) = record_logs();
    let message = "strategy=<offload:defer>, target=<[\"write\"]> | strategy has no conditions, so it defers every tool it targets at any tool count | use .when() to set toolCount or schemaTokens";
    crate::logging::forget_warning(message);
    for conditions in [
        None,
        None,
        Some(DeferConditions {
            tool_count: Some(1.into()),
            ..DeferConditions::default()
        }),
    ] {
        let strategy = Offload::defer(DeferTarget::tools(["write"])).unwrap();
        let strategy = match conditions {
            Some(conditions) => strategy.when(conditions).unwrap(),
            None => strategy,
        };
        let mut agent = crate::experimental::context_manager::test_support::agent_with(
            Arc::new(crate::experimental::context_manager::test_support::TestModel::new()),
            Vec::new(),
        );
        strategy.init(&mut agent, None).unwrap();
    }
    assert_eq!(logs.text().matches(message).count(), 1);
}

mod conditions {
    use super::*;

    fn when(tool_count: Option<usize>, schema_tokens: Option<u64>) -> StrategyEntry {
        defer_when(
            DeferTarget::ToolSpecs,
            DeferConditions {
                tool_count: tool_count.map(Into::into),
                schema_tokens: schema_tokens.map(Into::into),
            },
        )
    }

    async fn deferred_count(strategy: StrategyEntry) -> usize {
        let (mut agent, model) = native(with_strategy(strategy));
        model.add_turn("ok");
        agent.invoke("Hi.").await.unwrap();
        deferred_names(&model, 0).len()
    }

    #[tokio::test]
    async fn with_conditions_defers_the_tools_when_either_is_met() {
        // The call holds 5 tools: the 3 below, retrieve_context and load_tools.
        let tokens = schema_tokens();
        let cases = [
            (None, None, 3),
            (Some(5), None, 3),
            (Some(6), None, 0),
            (None, Some(tokens), 3),
            (None, Some(tokens + 1), 0),
            (Some(6), Some(tokens), 3),
            (Some(5), Some(tokens + 1), 3),
            (Some(6), Some(tokens + 1), 0),
        ];
        for (tool_count, schema_tokens, expected) in cases {
            assert_eq!(
                deferred_count(when(tool_count, schema_tokens)).await,
                expected,
                "{tool_count:?} {schema_tokens:?}"
            );
        }
    }

    #[tokio::test]
    async fn tool_count_counts_a_tool_kept_in_full_and_the_sdk_tools_and_schema_tokens_measures_only_the_tools_it_would_defer()
     {
        let cases = [
            (
                DeferConditions {
                    tool_count: Some(5.into()),
                    ..DeferConditions::default()
                },
                vec!["read", "write"],
            ),
            (
                DeferConditions {
                    schema_tokens: Some(schema_tokens().into()),
                    ..DeferConditions::default()
                },
                vec![],
            ),
        ];
        for (conditions, expected) in cases {
            let (mut agent, model) = native(with_strategy(defer_when(DeferTarget::tools(["!shell"]), conditions)));
            model.add_turn("ok");

            agent.invoke("Hi.").await.unwrap();

            assert_eq!(deferred_names(&model, 0), expected);
        }
    }

    #[tokio::test]
    async fn tool_count_leaves_out_the_structured_output_tool_so_an_invocation_with_structured_output_defers_the_same_tools()
     {
        let (mut agent, model) = native(with_strategy(when(Some(6), None)));
        model
            .add_turn("one")
            .add_turn(tool_use(STRUCTURED_OUTPUT_TOOL_NAME, "out-1", json!({"answer": "two"})))
            .add_turn("three");

        agent.invoke("First.").await.unwrap();
        agent
            .invoke_with(
                "Second.",
                InvokeOptions {
                    structured_output_schema: Some(json!({
                        "type": "object",
                        "properties": {"answer": {"type": "string"}},
                        "required": ["answer"]
                    })),
                    ..InvokeOptions::default()
                },
            )
            .await
            .unwrap();
        agent.invoke("Third.").await.unwrap();

        let sent = sent_tool_specs(&model);
        assert!(names(&sent[1]).contains(&STRUCTURED_OUTPUT_TOOL_NAME.to_owned()));
        for call in 0..3 {
            assert!(deferred_names(&model, call).is_empty());
        }
        assert_eq!(sent[2], sent[0]);
    }

    #[tokio::test]
    async fn with_schema_tokens_as_a_share_of_the_context_window_defers_the_tools() {
        for (share, expected) in [("1%", 3), ("2%", 0)] {
            let (mut agent, model) = native(with_strategy(defer_when(
                DeferTarget::ToolSpecs,
                DeferConditions {
                    schema_tokens: Some(share.into()),
                    ..DeferConditions::default()
                },
            )));
            agent
                .model()
                .update_config(BaseModelConfig {
                    model_info: Some(ModelInfo {
                        capabilities: ModelCapabilities {
                            deferred_tool_loading: Some(DeferredToolLoading::Native),
                            ..ModelCapabilities::default()
                        },
                        limits: ModelLimits {
                            context_window: Some(100 * schema_tokens()),
                            ..ModelLimits::default()
                        },
                    }),
                    ..BaseModelConfig::default()
                })
                .unwrap();
            model.add_turn("ok");

            agent.invoke("Hi.").await.unwrap();

            assert_eq!(deferred_names(&model, 0).len(), expected, "{share}");
        }
    }

    #[test]
    fn rejects_an_invalid_condition() {
        let cases = [
            (
                DeferConditions {
                    tool_count: Some(0.into()),
                    ..DeferConditions::default()
                },
                "toolCount=0 is invalid: expected a whole tool count above 0",
            ),
            (
                DeferConditions {
                    tool_count: Some("20".into()),
                    ..DeferConditions::default()
                },
                "toolCount=\"20\" is invalid: expected a whole tool count above 0",
            ),
            (
                DeferConditions {
                    schema_tokens: Some("100%".into()),
                    ..DeferConditions::default()
                },
                "schemaTokens=\"100%\" is invalid: expected a \"N%\" string below \"100%\"",
            ),
        ];
        let strategy = Offload::defer(DeferTarget::ToolSpecs).unwrap();
        for (conditions, message) in cases {
            let error = strategy.when(conditions).unwrap_err().to_string();
            assert!(error.starts_with(message), "{error}");
        }
    }
}

#[tokio::test]
async fn replays_the_tools_of_the_first_model_call_in_a_summary_before_and_after_it() {
    for (deferred_tool_loading, tool_names, deferred) in [
        (
            DeferredToolLoading::Native,
            SDK_AND_DEFAULT.to_vec(),
            vec!["shell", "read", "write"],
        ),
        (
            DeferredToolLoading::Unsupported,
            vec!["shell", "read", "write", "retrieve_context"],
            vec![],
        ),
    ] {
        let model = MockModel::new()
            .with_turn("a summary")
            .with_turn("ok")
            .with_turn("another summary");
        model.update_config(capability(Some(deferred_tool_loading))).unwrap();
        let summarize = Arc::new(
            Offload::summarize(OffloadTarget::All, SummarizeConfig::default())
                .unwrap()
                .when(OffloadConditions {
                    context_utilization: Some("80%".into()),
                    preserve_recent: Some(1.into()),
                    ..OffloadConditions::default()
                })
                .unwrap(),
        );
        let messages = ["task", "old", "more", "older"]
            .iter()
            .enumerate()
            .map(|(index, text)| {
                let role = if index % 2 == 1 { Role::Assistant } else { Role::User };
                Message::new(role, vec![ContentBlock::text(*text)])
            })
            .collect::<Vec<_>>();
        let mut agent = Agent::builder()
            .model(model.clone())
            .tools(default_tools())
            .messages(messages)
            .context_manager(ContextManagerStrategy::Config(ContextManagerConfig {
                strategies: Some(vec![defer_all(), StrategyEntry::Strategy(summarize.clone())]),
                ..ContextManagerConfig::default()
            }))
            .printer(false)
            .build()
            .unwrap();
        agent.initialize().await.unwrap();

        assert!(apply_to(summarize.as_ref(), &mut agent).await);
        agent.invoke("next").await.unwrap();
        let sent = model.requests().remove(1);
        assert!(apply_to(summarize.as_ref(), &mut agent).await);

        assert_eq!(names(&sent.tool_specs), tool_names);
        let expected: HashSet<String> = deferred.iter().map(|name| (*name).to_owned()).collect();
        assert_eq!(sent.deferred_tools, expected);
        for replay in [model.requests().remove(0), model.requests().remove(2)] {
            assert_eq!(replay.tool_specs, sent.tool_specs);
            assert_eq!(replay.deferred_tools, sent.deferred_tools);
        }
    }
}

async fn apply_to(strategy: &dyn ContextStrategy, agent: &mut Agent) -> bool {
    let mut context = ContextState::new(agent.local_mut(), 0.9);
    strategy.apply(&mut context).await.unwrap()
}

#[tokio::test]
async fn the_deferred_tool_loading_preset_counting_load_tools_and_retrieve_context_defers_from_twenty_tools() {
    for (count, expected) in [(17, 0), (18, 18)] {
        let tools = (0..count)
            .map(|index| ToolSource::from(make_tool(&format!("tool_{index}"))))
            .collect();
        let (mut agent, model) = native(Options {
            strategy: Some(StrategyPresetName::DeferredToolLoading.into()),
            tools: Some(tools),
            ..Options::default()
        });
        model.add_turn("ok");

        agent.invoke("Hi.").await.unwrap();

        assert_eq!(deferred_names(&model, 0).len(), expected, "{count}");
    }
}

type Counted = Arc<Mutex<Vec<(Vec<Message>, Vec<ToolSpec>)>>>;

/// Wraps a model and records what each `count_tokens` call measured.
struct CountingModel {
    inner: Arc<dyn Model>,
    counted: Counted,
}

impl CountingModel {
    fn new(inner: Arc<dyn Model>, counted: Counted) -> Self {
        Self { inner, counted }
    }
}

#[async_trait]
impl Model for CountingModel {
    fn stream(
        &self,
        request: ModelRequest,
    ) -> crate::models::BoxStream<'static, Result<crate::models::streaming::ModelStreamEvent>> {
        self.inner.stream(request)
    }

    fn get_config(&self) -> BaseModelConfig {
        self.inner.get_config()
    }

    fn update_config(&self, config: BaseModelConfig) -> Result<()> {
        self.inner.update_config(config)
    }

    fn model_info(&self) -> ModelInfo {
        self.inner.model_info()
    }

    async fn count_tokens(&self, messages: &[Message], options: crate::models::CountTokensOptions) -> Result<u64> {
        self.counted
            .lock()
            .unwrap()
            .push((messages.to_vec(), options.tool_specs.clone()));
        self.inner.count_tokens(messages, options).await
    }
}
