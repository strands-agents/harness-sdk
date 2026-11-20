//! The children are real agents on a [`MockModel`], built by a capturing builder.

use std::sync::Mutex;

use super::*;
use crate::agent::LocalAgent;
use crate::agent::{InvocationContext, InvocationState, InvokeLimits};
use crate::cancel::{CancelHandle, CancelOptions};
use crate::experimental::context_manager::ContextManagerStrategy;
use crate::hooks::{BeforeInvocationEvent, BeforeToolCallEvent};
use crate::interrupt::{Interrupt, InterruptState};
use crate::models::streaming::Usage;
use crate::multiagent::{Choice, ChoiceOption};
use crate::plugins::Plugin;
use crate::session::SessionManager;
use crate::state_store::StateStore;
use crate::storage::{InMemoryStorage, Storage};
use crate::test_support::capture_logs;
use crate::testing::{MockModel, MockTurn};
use crate::tools::{FunctionTool, ToolSource};
use crate::types::{
    InjectedBlock, InterruptParams, InterruptResponse, InterruptResponseContent, ReasoningBlock, StopReason, TextBlock,
    ToolResultStatus, ToolUse, ToolUseBlock,
};
use crate::vended_tools::stop::stop;
use crate::vended_tools::test_support::{agent, text};

/// A builder that records each spec and builds a child on `model`, keeping its app state.
#[derive(Clone, Default)]
struct Capturing {
    specs: Arc<Mutex<Vec<AgentSpec>>>,
    states: Arc<Mutex<Vec<StateStore>>>,
    models: Arc<Mutex<Vec<MockModel>>>,
}

impl Capturing {
    fn builder(&self, reply: &'static str) -> ChildAgentBuilder {
        self.builder_with(move || MockModel::new().with_turn(reply), Vec::new)
    }

    fn builder_with(
        &self,
        model: impl Fn() -> MockModel + Send + Sync + 'static,
        tools: impl Fn() -> Vec<FunctionTool> + Send + Sync + 'static,
    ) -> ChildAgentBuilder {
        let this = self.clone();
        ChildAgentBuilder::sync(move |spec: &AgentSpec| {
            this.specs.lock().unwrap().push(spec.clone());
            let model = model();
            this.models.lock().unwrap().push(model.clone());
            let child = Agent::builder().model(model).tools(tools()).printer(false).build()?;
            this.states.lock().unwrap().push(child.app_state().clone());
            Ok(child)
        })
    }

    fn specs(&self) -> Vec<AgentSpec> {
        self.specs.lock().unwrap().clone()
    }

    fn model(&self) -> MockModel {
        self.models.lock().unwrap()[0].clone()
    }

    fn depth(&self) -> Option<JsonValue> {
        self.states.lock().unwrap()[0].get_value(DEPTH_STATE_KEY)
    }

    /// The messages the child's first model call received, as JSON shapes.
    fn prompt(&self) -> Vec<JsonValue> {
        self.model().requests()[0].messages.iter().map(shape).collect()
    }
}

fn shape(message: &Message) -> JsonValue {
    json!({"role": role_name(message.role), "content": message.content})
}

fn text_message(role: Role, text: &str) -> Message {
    Message::new(role, vec![ContentBlock::text(text)])
}

fn tool_use_message(id: &str, name: &str) -> Message {
    Message::new(
        Role::Assistant,
        vec![ContentBlock::ToolUse(ToolUseBlock::new(name, id, json!({})))],
    )
}

fn tool_result() -> ContentBlock {
    ContentBlock::ToolResult(ToolResultBlock::success("r1", vec![ToolResultContent::text("A")]))
}

fn parent(messages: Vec<Message>) -> ToolAgent {
    agent().with_messages(Arc::from(messages))
}

fn with_builder(builder: ChildAgentBuilder) -> MakeSubagentOptions {
    MakeSubagentOptions {
        builder: Some(builder),
        ..MakeSubagentOptions::default()
    }
}

fn tool(options: MakeSubagentOptions) -> SubagentTool {
    make_subagent(options).unwrap()
}

fn context_for(tool: &SubagentTool, input: JsonValue, agent: &ToolAgent) -> ToolContext {
    ToolContext::new(
        ToolUse::new(tool.name(), "t1", input),
        agent.clone(),
        InvocationState::new(),
    )
}

async fn run_with(tool: &SubagentTool, context: ToolContext) -> (Vec<ToolStreamEvent>, ToolOutcome) {
    let mut events = Vec::new();
    let outcome = tool.stream(context).run(|event| events.push(event)).await.unwrap();
    (events, outcome)
}

async fn run(tool: &SubagentTool, input: JsonValue, agent: &ToolAgent) -> ToolResultBlock {
    match run_with(tool, context_for(tool, input, agent)).await.1 {
        ToolOutcome::Result(result) => result,
        other => panic!("unexpected outcome {other:?}"),
    }
}

fn properties(tool: &SubagentTool) -> JsonObject {
    tool.tool_spec().input_schema.unwrap()["properties"]
        .as_object()
        .unwrap()
        .clone()
}

fn keys(tool: &SubagentTool) -> Vec<String> {
    properties(tool).keys().cloned().collect()
}

fn no_presets() -> Option<Vec<(String, Preset)>> {
    Some(Vec::new())
}

#[test]
fn exposes_the_default_name_description_and_schema() {
    let tool = subagent();
    assert_eq!(tool.name(), "subagent");
    assert_eq!(tool.tool_spec().description, DEFAULT_SUBAGENT_DESCRIPTION);
    assert_eq!(
        tool.tool_spec().input_schema.unwrap(),
        json!({
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": TASK_DESCRIPTION},
                "agent_type": {
                    "type": "string",
                    "enum": ["generalist"],
                    "description": format!("Role to assign this agent. Omit to use the default ('generalist').\nOptions:\n- generalist: {GENERALIST_DESCRIPTION} (sets instructions)")
                },
                "instructions": {"type": "string", "description": "A system prompt defining this agent's role."}
            },
            "required": ["task"]
        })
    );
}

#[test]
fn uses_a_custom_name_and_description() {
    assert_eq!(
        tool(MakeSubagentOptions::builder().name("delegate").build())
            .tool_spec()
            .name,
        "delegate"
    );
    let custom = tool(MakeSubagentOptions::builder().description("Hand off research.").build());
    assert_eq!(custom.tool_spec().description, "Hand off research.");
}

#[test]
fn derives_parameters_from_choice_axes() {
    let tool = tool(MakeSubagentOptions {
        presets: no_presets(),
        instructions: Some(Choice::new(["concise", "verbose"]).into()),
        model: Some(Choice::new(["fast", "deep"]).into()),
        context: Some(Choice::new([ChoiceOption::new("none").with_description("fresh"), "all".into()]).into()),
        tools: Some(Choice::new(["read", "shell"]).multiple(true).into()),
        ..MakeSubagentOptions::default()
    });
    let properties = properties(&tool);
    assert_eq!(
        keys(&tool),
        ["task", "instructions", "tools", "model", "context", "last_messages"]
    );
    assert_eq!(properties["instructions"]["enum"], json!(["concise", "verbose"]));
    assert_eq!(properties["tools"]["type"], "array");
    assert_eq!(
        properties["tools"]["items"],
        json!({"type": "string", "enum": ["read", "shell"]})
    );
    assert_eq!(properties["model"]["enum"], json!(["fast", "deep"]));
    assert_eq!(properties["context"]["enum"], json!(["none", "all"]));
    assert!(
        properties["context"]["description"]
            .as_str()
            .unwrap()
            .ends_with("more tokens.\nOptions:\n- none: fresh")
    );
    assert_eq!(properties["last_messages"]["type"], "integer");
}

#[test]
fn omits_last_messages_when_the_only_context_option_is_none() {
    let tool = tool(MakeSubagentOptions {
        presets: no_presets(),
        context: Some(Choice::new(["none"]).into()),
        ..MakeSubagentOptions::default()
    });
    assert_eq!(keys(&tool), ["task", "instructions", "context"]);
}

#[test]
fn hides_fixed_and_inherit_axes_from_the_model() {
    let tool = tool(MakeSubagentOptions {
        presets: no_presets(),
        instructions: Some(Fixed::new("x").into()),
        tools: Some(Inherit.into()),
        model: Some(Inherit.into()),
        context: Some(Fixed::new("none").into()),
        ..MakeSubagentOptions::default()
    });
    assert_eq!(keys(&tool), ["task"]);
}

#[test]
fn adds_an_agent_type_parameter_naming_the_presets_and_default() {
    let tool = tool(MakeSubagentOptions {
        presets: Some(vec![
            ("generalist".to_owned(), generalist()),
            (
                "reviewer".to_owned(),
                Preset::builder()
                    .instructions("review")
                    .description("reviews diffs")
                    .build(),
            ),
        ]),
        default_preset: Some("generalist".to_owned()),
        instructions: Some(Fixed::none().into()),
        ..MakeSubagentOptions::default()
    });
    let properties = properties(&tool);
    assert_eq!(keys(&tool), ["task", "agent_type"]);
    assert_eq!(properties["agent_type"]["enum"], json!(["generalist", "reviewer"]));
    let description = properties["agent_type"]["description"].as_str().unwrap();
    assert!(description.contains("'generalist'") && description.contains("- reviewer: reviews diffs"));
}

#[test]
fn rejects_invalid_options() {
    let cases: [(MakeSubagentOptions, &str); 7] = [
        (
            MakeSubagentOptions::builder().name("").build(),
            "name must be a non-empty string.",
        ),
        (
            MakeSubagentOptions::builder().description("").build(),
            "description must be a non-empty string.",
        ),
        (
            MakeSubagentOptions::builder().max_depth(0).build(),
            "maxDepth must be a positive integer (>= 1).",
        ),
        (
            MakeSubagentOptions::builder().default_preset("reseacher").build(),
            "defaultPreset 'reseacher' is not one of the presets: generalist.",
        ),
        (
            MakeSubagentOptions::builder().context(Fixed::new("al").into()).build(),
            "context mode \"al\" must be one of: none, all, no_tools.",
        ),
        (
            MakeSubagentOptions::builder()
                .context(Choice::new(["none".into(), ChoiceOption::new("shared").with_value("everything")]).into())
                .build(),
            "context mode \"everything\" must be one of",
        ),
        (
            MakeSubagentOptions::builder().instructions(Inherit.into()).build(),
            "instructions: Inherit is not supported; use Open, Choice, Fixed.",
        ),
    ];
    for (options, message) in cases {
        let error = make_subagent(options).unwrap_err().to_string();
        assert!(error.starts_with(message), "{error}");
    }
}

#[tokio::test]
async fn awaits_an_async_builder() {
    let model = MockModel::new().with_turn("the answer");
    let child_model = model.clone();
    let builder = ChildAgentBuilder::new(move |_spec: AgentSpec| {
        let model = child_model.clone();
        async move {
            tokio::task::yield_now().await;
            Agent::builder().model(model).printer(false).build()
        }
    });

    let result = run(&tool(with_builder(builder)), json!({"task": "do it"}), &agent()).await;

    assert_eq!(
        result,
        ToolResultBlock::success("t1", vec![ToolResultContent::text("the answer")])
    );
    let prompts: Vec<String> = model
        .requests()
        .iter()
        .map(|request| request.messages[0].text())
        .collect();
    assert_eq!(prompts, ["do it"]);
}

#[tokio::test]
async fn builds_a_child_from_the_default_preset_and_returns_its_output() {
    let capturing = Capturing::default();
    let tool = tool(with_builder(capturing.builder("the answer")));
    let (events, outcome) = run_with(&tool, context_for(&tool, json!({"task": "do it"}), &agent())).await;
    let ToolOutcome::Result(result) = outcome else {
        panic!("unexpected outcome");
    };
    assert_eq!(
        result,
        ToolResultBlock::success("t1", vec![ToolResultContent::text("the answer")])
    );
    let spec = &capturing.specs()[0];
    assert_eq!(spec.name.as_deref(), Some("subagent"));
    assert_eq!(spec.instructions.as_deref(), Some(GENERALIST_INSTRUCTIONS));
    let types: Vec<&str> = events
        .iter()
        .filter_map(|event| event.data.as_ref()?["type"].as_str())
        .collect();
    assert!(types.contains(&"modelStreamUpdateEvent"), "{types:?}");
    assert_eq!(types.last(), Some(&"agentResultEvent"));
}

#[derive(Clone, Debug, PartialEq)]
struct Scratch(u32);

#[tokio::test]
async fn passes_a_copy_of_the_invocation_state_to_the_child() {
    let seen = Arc::new(Mutex::new(None));
    let recorded = seen.clone();
    let builder: ChildAgentBuilder = ChildAgentBuilder::sync(move |_spec: &AgentSpec| {
        let child = Agent::builder()
            .model(MockModel::new().with_turn("done"))
            .printer(false)
            .build()?;
        let recorded = recorded.clone();
        child.add_hook(move |event: &mut BeforeInvocationEvent<'_>| {
            *recorded.lock().unwrap() = event.invocation_state().get::<Scratch>();
            event.invocation_state().insert(Scratch(2));
        });
        Ok(child)
    });
    let tool = tool(with_builder(builder));
    let state = InvocationState::new();
    state.insert(Scratch(1));
    let context = ToolContext::new(
        ToolUse::new("subagent", "t1", json!({"task": "x"})),
        agent(),
        state.clone(),
    );
    run_with(&tool, context).await;
    assert_eq!(*seen.lock().unwrap(), Some(Scratch(1)));
    assert_eq!(state.get::<Scratch>(), Some(Scratch(1)));
}

#[tokio::test]
async fn adds_the_childs_model_usage_to_the_requests_usage() {
    let capturing = Capturing::default();
    let builder = capturing.builder_with(
        || MockModel::new().with_turn(MockTurn::text("child done").with_usage(Usage::new(3, 4, 7))),
        Vec::new,
    );
    let request = InvocationContext::new(Some(InvokeLimits {
        turns: Some(5),
        ..InvokeLimits::default()
    }));
    let result = run(
        &tool(with_builder(builder)),
        json!({"task": "x"}),
        &agent().with_invocation_context(Some(request.clone())),
    )
    .await;
    assert_eq!(text(&result), "child done");
    let usage = request.usage();
    assert_eq!((usage.turns_taken, usage.usage), (1, Usage::new(3, 4, 7)));
}

#[tokio::test]
async fn maps_tools_choice_option_names_to_values_and_clamps_off_enum_tools() {
    for (requested, expected) in [
        (json!(["readonly"]), vec!["read"]),
        (json!(["readonly", "write"]), vec!["read"]),
    ] {
        let capturing = Capturing::default();
        let tool = tool(MakeSubagentOptions {
            builder: Some(capturing.builder("done")),
            tools: Some(
                Choice::new([
                    ChoiceOption::new("readonly").with_value("read"),
                    ChoiceOption::new("sh").with_value("shell"),
                ])
                .multiple(true)
                .into(),
            ),
            ..MakeSubagentOptions::default()
        });
        run(&tool, json!({"task": "x", "tools": requested}), &agent()).await;
        assert_eq!(
            capturing.specs()[0].tools,
            Some(expected.into_iter().map(str::to_owned).collect())
        );
    }
}

#[tokio::test]
async fn ignores_model_values_for_fixed_axes() {
    let capturing = Capturing::default();
    let tool = tool(MakeSubagentOptions {
        builder: Some(capturing.builder("done")),
        presets: no_presets(),
        instructions: Some(Fixed::new("pinned").into()),
        context: Some(Fixed::new("none").into()),
        ..MakeSubagentOptions::default()
    });
    let input = json!({"task": "x", "instructions": "override", "context": "all"});
    run(&tool, input, &parent(vec![text_message(Role::User, "hi")])).await;
    assert_eq!(capturing.specs()[0].instructions.as_deref(), Some("pinned"));
    assert_eq!(capturing.prompt(), [shape(&text_message(Role::User, "x"))]);
}

#[tokio::test]
async fn rejects_invalid_input_as_an_error_result_without_building_a_child() {
    let cases = [
        (
            json!({"task": "x", "agent_type": "nope"}),
            "Subagent error: Unknown agent_type \"nope\"; valid values: generalist.",
        ),
        (
            json!({}),
            "Missing required parameter 'task': describe the task to delegate.",
        ),
        (
            json!({"task": ""}),
            "Missing required parameter 'task': describe the task to delegate.",
        ),
        (
            json!({"task": "   "}),
            "Missing required parameter 'task': describe the task to delegate.",
        ),
        (
            json!({"task": 42}),
            "Missing required parameter 'task': describe the task to delegate.",
        ),
        (
            json!({"task": "x", "instructions": ["not", "a", "string"]}),
            "Parameter 'instructions' must be a string.",
        ),
    ];
    for (input, message) in cases {
        let capturing = Capturing::default();
        let result = run(&tool(with_builder(capturing.builder("done"))), input, &agent()).await;
        assert_eq!(result.status, ToolResultStatus::Error);
        assert_eq!(text(&result), message);
        assert!(capturing.specs().is_empty());
    }
}

fn framed(task: &str) -> ContentBlock {
    ContentBlock::text(format!("{FORK_PREAMBLE}\n\n{task}"))
}

async fn forked_prompt(messages: Vec<Message>, input: JsonValue, context: Axis) -> (Capturing, ToolResultBlock) {
    let capturing = Capturing::default();
    let tool = tool(MakeSubagentOptions {
        builder: Some(capturing.builder("done")),
        context: Some(context),
        ..MakeSubagentOptions::default()
    });
    let result = run(&tool, input, &parent(messages)).await;
    (capturing, result)
}

#[tokio::test]
async fn forks_messages_for_all_dropping_reasoning_injected_text_and_in_flight_tool_calls() {
    let messages = vec![
        Message::new(
            Role::User,
            vec![
                ContentBlock::text("go"),
                ContentBlock::Injected(InjectedBlock::new("<todos>v1</todos>", "todos")),
            ],
        ),
        Message::new(
            Role::Assistant,
            vec![
                ContentBlock::Reasoning(ReasoningBlock::new().with_text("think").with_signature("sig")),
                ContentBlock::ToolUse(ToolUseBlock::new("read", "r1", json!({}))),
            ],
        ),
        Message::new(Role::User, vec![tool_result()]),
        tool_use_message("t1", "subagent"),
    ];
    let (capturing, _) = forked_prompt(
        messages,
        json!({"task": "do X", "context": "all"}),
        Choice::new(["none", "all"]).into(),
    )
    .await;
    assert_eq!(
        capturing.prompt(),
        [
            shape(&text_message(Role::User, "go")),
            json!({"role": "assistant", "content": [{"toolUse": {"name": "read", "toolUseId": "r1", "input": {}}}]}),
            json!({"role": "user", "content": [serde_json::to_value(tool_result()).unwrap(), serde_json::to_value(framed("do X")).unwrap()]}),
        ]
    );
}

#[tokio::test]
async fn shapes_the_forked_history_for_all() {
    let cases = [
        (
            vec![text_message(Role::User, "hi"), text_message(Role::Assistant, "hello")],
            json!({}),
            vec![
                text_message(Role::User, "hi"),
                text_message(Role::Assistant, "hello"),
                Message::new(Role::User, vec![framed("x")]),
            ],
        ),
        (
            vec![
                text_message(Role::User, "one"),
                tool_use_message("x1", "sub"),
                text_message(Role::User, "two"),
            ],
            json!({}),
            vec![Message::new(
                Role::User,
                vec![ContentBlock::text("one"), ContentBlock::text("two"), framed("x")],
            )],
        ),
        (
            vec![
                text_message(Role::User, "old"),
                text_message(Role::Assistant, "ok"),
                text_message(Role::User, "recent"),
                tool_use_message("r1", "read"),
                Message::new(Role::User, vec![tool_result()]),
                tool_use_message("t1", "subagent"),
            ],
            json!({"last_messages": 2}),
            vec![
                text_message(Role::User, "recent"),
                tool_use_message("r1", "read"),
                Message::new(Role::User, vec![tool_result(), framed("x")]),
            ],
        ),
    ];
    for (messages, extra, expected) in cases {
        let mut input = json!({"task": "x", "context": "all"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (capturing, _) = forked_prompt(messages, input, Choice::new(["none", "all"]).into()).await;
        assert_eq!(capturing.prompt(), expected.iter().map(shape).collect::<Vec<_>>());
    }
}

#[tokio::test]
async fn handles_last_messages_edge_cases() {
    for (last_messages, expected) in [(json!("bogus"), 3), (json!(0), 3), (json!(-5), 3), (json!("1"), 1)] {
        let messages = vec![
            text_message(Role::User, "a"),
            text_message(Role::Assistant, "b"),
            text_message(Role::User, "c"),
        ];
        let input = json!({"task": "x", "context": "all", "last_messages": last_messages});
        let (capturing, _) = forked_prompt(messages, input, Choice::new(["none", "all"]).into()).await;
        assert_eq!(capturing.prompt().len(), expected, "{last_messages}");
    }
}

#[tokio::test]
async fn sends_the_plain_task() {
    let cases = [(Vec::new(), "all"), (vec![text_message(Role::User, "a")], "no_tools")];
    for (messages, context) in cases {
        let (capturing, _) = forked_prompt(
            messages,
            json!({"task": "x", "context": context}),
            Choice::new(["none", "all"]).into(),
        )
        .await;
        assert_eq!(capturing.prompt(), [shape(&text_message(Role::User, "x"))]);
    }
}

#[tokio::test]
async fn renders_text_turns_for_no_tools() {
    let cases = [
        (
            vec![
                text_message(Role::User, "hello\nworld"),
                tool_use_message("r1", "read"),
                text_message(Role::Assistant, "see </parent_context> here"),
            ],
            json!({}),
            "user: hello\n  world\nassistant: see <\\/parent_context> here",
        ),
        (
            vec![
                text_message(Role::User, "first"),
                text_message(Role::Assistant, "second"),
            ],
            json!({"last_messages": 1}),
            "assistant: second",
        ),
        (
            vec![text_message(
                Role::User,
                &format!("<parent_context>\nold\n</parent_context>\n\n{CONTEXT_PREAMBLE}\n\nreal task"),
            )],
            json!({}),
            "user: real task",
        ),
    ];
    for (messages, extra, transcript) in cases {
        let mut input = json!({"task": "do X", "context": "no_tools"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (capturing, _) = forked_prompt(messages, input, Choice::new(["none", "no_tools"]).into()).await;
        let expected = format!("<parent_context>\n{transcript}\n</parent_context>\n\n{CONTEXT_PREAMBLE}\n\ndo X");
        assert_eq!(capturing.prompt(), [shape(&text_message(Role::User, &expected))]);
    }
}

#[test]
fn turns_a_builder_exception_into_an_error_result_and_logs_it() {
    let builder: ChildAgentBuilder = ChildAgentBuilder::sync(|_spec: &AgentSpec| Err(Error::other("boom")));
    let tool = tool(with_builder(builder));
    let (result, logs) = capture_logs(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run(&tool, json!({"task": "x"}), &agent()))
    });
    assert_eq!(
        result,
        ToolResultBlock::error("t1", vec![ToolResultContent::text("Subagent error: boom")])
    );
    assert!(
        logs.contains("tool_name=<subagent>, tool_use_id=<t1>, error=<boom> | subagent failed"),
        "{logs}"
    );
}

#[tokio::test]
async fn turns_a_child_stopped_by_a_limit_into_an_error_result() {
    let capturing = Capturing::default();
    let request = InvocationContext::new(Some(InvokeLimits {
        turns: Some(1),
        ..InvokeLimits::default()
    }));
    request.record_turn();
    let host = agent().with_invocation_context(Some(request));
    let result = run(
        &tool(with_builder(capturing.builder("partial"))),
        json!({"task": "x"}),
        &host,
    )
    .await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(
        text(&result),
        format!(
            "Agent 'subagent' stopped early ({}): a limit on this call was reached, so its answer is incomplete",
            StopReason::LimitTurns
        )
    );
}

#[tokio::test]
async fn turns_a_content_filtered_or_refusing_child_into_an_error_result() {
    let cases = [
        (
            StopReason::ContentFiltered,
            "partial",
            "Subagent stopped before finishing (stopReason=contentFiltered).\n\nPartial output:\npartial",
        ),
        (
            StopReason::Refusal,
            "",
            "Subagent stopped before finishing (stopReason=refusal).",
        ),
    ];
    for (stop_reason, reply, message) in cases {
        let capturing = Capturing::default();
        let builder = capturing.builder_with(
            move || MockModel::new().with_turn(MockTurn::text(reply).with_stop_reason(stop_reason.clone())),
            Vec::new,
        );

        let result = run(&tool(with_builder(builder)), json!({"task": "x"}), &agent()).await;

        assert_eq!(
            result,
            ToolResultBlock::error("t1", vec![ToolResultContent::text(message)])
        );
    }
}

#[tokio::test]
async fn turns_an_immediately_cancelled_child_into_an_error_result() {
    let capturing = Capturing::default();
    let tool = tool(with_builder(capturing.builder("never")));
    let handle = CancelHandle::new();
    handle.cancel(CancelOptions::default());
    let context = context_for(&tool, json!({"task": "x"}), &agent()).with_cancel_signal(handle.signal());
    let ToolOutcome::Result(result) = run_with(&tool, context).await.1 else {
        panic!("unexpected outcome");
    };
    assert_eq!(
        result,
        ToolResultBlock::error("t1", vec![ToolResultContent::text("Subagent cancelled")])
    );
}

#[tokio::test]
async fn treats_a_child_that_ended_via_a_deferred_cancel_stop_tool_as_a_success() {
    let capturing = Capturing::default();
    let builder = capturing.builder_with(
        || {
            MockModel::new().with_turn(MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(
                "stop",
                "s1",
                json!({"message": "summary"}),
            ))]))
        },
        || vec![stop()],
    );
    let result = run(&tool(with_builder(builder)), json!({"task": "x"}), &agent()).await;
    assert_eq!(
        result,
        ToolResultBlock::success("t1", vec![ToolResultContent::text("summary")])
    );
}

#[tokio::test]
async fn refuses_to_delegate_once_the_depth_is_exhausted() {
    let capturing = Capturing::default();
    let tool = tool(MakeSubagentOptions {
        builder: Some(capturing.builder("done")),
        max_depth: Some(3),
        name: Some("delegate".to_owned()),
        ..MakeSubagentOptions::default()
    });
    let parent = agent();
    parent.app_state().set(DEPTH_STATE_KEY, 0).unwrap();
    let result = run(&tool, json!({"task": "x"}), &parent).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(
        text(&result),
        "Delegation depth limit reached (3 levels); you cannot delegate further. Complete this task yourself instead of calling delegate again."
    );
    assert!(capturing.specs().is_empty());
}

#[tokio::test]
async fn tracks_the_remaining_depth() {
    for (max_depth, parent_depth, expected) in [(Some(3), None, 2), (None, None, 1), (None, Some(1), 0)] {
        let capturing = Capturing::default();
        let tool = tool(MakeSubagentOptions {
            builder: Some(capturing.builder("done")),
            max_depth,
            ..MakeSubagentOptions::default()
        });
        let parent = agent();
        if let Some(depth) = parent_depth {
            parent.app_state().set(DEPTH_STATE_KEY, depth).unwrap();
        }
        run(&tool, json!({"task": "x"}), &parent).await;
        assert_eq!(capturing.depth(), Some(json!(expected)));
    }
}

fn confirm_tool() -> FunctionTool {
    FunctionTool::builder("dangerousAction", "needs approval").callback(|input, context| async move {
        let answer = context.interrupt(InterruptParams::new("confirm").with_reason("confirm?"))?;
        if answer != json!("APPROVE") {
            return Ok(json!("not approved"));
        }
        Ok(json!(format!("done: {}", input["target"].as_str().unwrap_or_default())))
    })
}

fn tool_use_turn(name: &str, id: &str, input: JsonValue) -> MockTurn {
    MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(name, id, input))])
}

#[tokio::test]
async fn raises_the_interrupt_again_and_keeps_the_turn_when_the_child_cannot_be_rebuilt_on_resume() {
    let child_model = MockModel::new()
        .with_turn(tool_use_turn("dangerousAction", "c1", json!({"target": "prod"})))
        .with_turn("child done");
    let fail_next = Arc::new(Mutex::new(false));
    let fail = fail_next.clone();
    let builder: ChildAgentBuilder = ChildAgentBuilder::sync(move |_spec: &AgentSpec| {
        if std::mem::take(&mut *fail.lock().unwrap()) {
            return Err(Error::other("mcp down"));
        }
        Agent::builder()
            .model(child_model.clone())
            .tools([confirm_tool()])
            .printer(false)
            .build()
    });
    let parent_model = MockModel::new()
        .with_turn(tool_use_turn("subagent", "t1", json!({"task": "do it"})))
        .with_turn("parent done");
    let mut parent = Agent::builder()
        .model(parent_model)
        .tools([tool(with_builder(builder))])
        .printer(false)
        .build()
        .unwrap();
    let interrupted = parent.invoke("go").await.unwrap();
    let interrupt_id = interrupted.interrupts()[0].id.clone();
    assert_eq!(interrupt_id, "subagent:t1:tool:c1:confirm");
    *fail_next.lock().unwrap() = true;
    let failed = parent
        .invoke(vec![InterruptResponse::new(interrupt_id.clone(), "APPROVE")])
        .await
        .unwrap();
    let ids: Vec<(&str, Option<&JsonValue>)> = failed
        .interrupts()
        .iter()
        .map(|interrupt| (interrupt.id.as_str(), interrupt.response.as_ref()))
        .collect();
    assert_eq!(ids, [(interrupt_id.as_str(), None)]);
    let result = parent
        .invoke(vec![InterruptResponse::new(interrupt_id, "APPROVE")])
        .await
        .unwrap();
    assert_eq!(result.to_string(), "parent done");
}

/// A parent that delegates a confirm-guarded action to a subagent, persisting to `storage`; a
/// `rebuilt` parent starts from the turns that follow the interrupted tool call.
fn confirming_parent(
    storage: &Arc<InMemoryStorage>,
    rebuilt: bool,
    async_builder: bool,
) -> (Agent, Arc<Mutex<Vec<String>>>) {
    let executions = Arc::new(Mutex::new(Vec::new()));
    let recorded = executions.clone();
    let dangerous_action =
        FunctionTool::builder("dangerousAction", "needs approval").callback(move |input, context| {
            let recorded = recorded.clone();
            async move {
                let answer = context.interrupt(InterruptParams::new("confirm").with_reason("confirm?"))?;
                if answer != json!("APPROVE") {
                    return Ok(json!("not approved"));
                }
                let target = input["target"].as_str().unwrap_or_default().to_owned();
                recorded.lock().unwrap().push(target.clone());
                Ok(json!(format!("done: {target}")))
            }
        });
    let mut child_model = MockModel::new();
    if !rebuilt {
        child_model = child_model.with_turn(tool_use_turn("dangerousAction", "c1", json!({"target": "prod"})));
    }
    let child_model = child_model.with_turn("child done");
    let build = move || {
        Agent::builder()
            .model(child_model.clone())
            .tools([dangerous_action.clone()])
            .printer(false)
            .build()
    };
    let builder = if async_builder {
        ChildAgentBuilder::new(move |_spec: AgentSpec| {
            let child = build();
            async move { child }
        })
    } else {
        ChildAgentBuilder::sync(move |_spec: &AgentSpec| build())
    };
    let mut parent_model = MockModel::new();
    if !rebuilt {
        parent_model = parent_model.with_turn(tool_use_turn("subagent", "t1", json!({"task": "do it"})));
    }
    let session_manager = SessionManager::builder()
        .session_id("s1")
        .storage(storage.clone() as Arc<dyn Storage>)
        .build()
        .unwrap();
    let parent = Agent::builder()
        .model(parent_model.with_turn("parent done"))
        .tools([tool(with_builder(builder))])
        .session_manager(session_manager)
        .printer(false)
        .build()
        .unwrap();
    (parent, executions)
}

#[tokio::test]
async fn resumes_the_stored_child_turn_after_the_parent_is_rebuilt_with_a_sync_or_an_async_builder() {
    for async_builder in [false, true] {
        resumes_the_stored_child_turn_after_the_parent_is_rebuilt(async_builder).await;
    }
}

async fn resumes_the_stored_child_turn_after_the_parent_is_rebuilt(async_builder: bool) {
    let storage = Arc::new(InMemoryStorage::new());
    let (mut first, _) = confirming_parent(&storage, false, async_builder);
    let interrupted = first.invoke("go").await.unwrap();
    let interrupt_id = interrupted.interrupts()[0].id.clone();
    assert_eq!(interrupt_id, "subagent:t1:tool:c1:confirm");
    let turns = first.local.interrupt_state().context_value("subAgentInterruptedTurns");
    assert_eq!(
        turns
            .as_ref()
            .and_then(JsonValue::as_object)
            .map(|turns| turns.keys().cloned().collect::<Vec<_>>()),
        Some(vec!["t1".to_owned()])
    );
    drop(first);

    let (mut second, executions) = confirming_parent(&storage, true, async_builder);
    let result = second
        .invoke(vec![InterruptResponse::new(interrupt_id, "APPROVE")])
        .await
        .unwrap();

    assert_eq!(result.to_string(), "parent done");
    assert_eq!(*executions.lock().unwrap(), ["prod"]);
    let messages = second.messages();
    assert_eq!(
        messages[messages.len() - 2].content,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "t1",
            vec![ToolResultContent::text("child done")]
        ))]
    );
}

fn resuming_parent(response: Option<&str>) -> ToolAgent {
    let state = InterruptState::new();
    state.register_interrupt(&Interrupt::new("subagent:t1:i1", "confirm"));
    state.activate();
    if let Some(response) = response {
        let content = InterruptResponseContent::new(InterruptResponse::new("subagent:t1:i1", response));
        state.resume(&[content]).unwrap();
    }
    agent().with_interrupt_state(state)
}

#[tokio::test]
async fn raises_the_interrupts_again_when_none_were_answered() {
    let capturing = Capturing::default();
    let tool = tool(with_builder(capturing.builder("done")));
    let parent = resuming_parent(None);
    let ToolOutcome::Interrupt(error) = run_with(&tool, context_for(&tool, json!({"task": "x"}), &parent))
        .await
        .1
    else {
        panic!("expected the interrupts again");
    };
    let ids: Vec<&str> = error.interrupts.iter().map(|interrupt| interrupt.id.as_str()).collect();
    assert_eq!(ids, ["subagent:t1:i1"]);
}

#[tokio::test]
async fn returns_an_error_when_the_interrupted_child_turn_is_not_available() {
    let capturing = Capturing::default();
    let tool = tool(with_builder(capturing.builder("done")));
    let result = run(&tool, json!({"task": "x"}), &resuming_parent(Some("yes"))).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("did NOT run"), "{}", text(&result));
}

fn confirm_tool_counting(seen: Arc<Mutex<Vec<String>>>) -> FunctionTool {
    FunctionTool::builder("confirmTool", "asks to confirm").callback(move |_input, context| {
        let seen = seen.clone();
        async move {
            let response = context.interrupt(InterruptParams::new("confirm").with_reason("Please confirm"))?;
            seen.lock()
                .unwrap()
                .push(response.as_str().unwrap_or_default().to_owned());
            Ok(json!("ok"))
        }
    })
}

#[tokio::test]
async fn delegates_to_a_child_built_from_the_parent_propagating_a_child_tool_interrupt_and_resuming_it() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let model = MockModel::new()
        .with_turn(tool_use_turn("subagent", "t1", json!({"task": "confirm it"})))
        .with_turn(tool_use_turn("confirmTool", "inner-1", json!({})))
        .with_turn("child report")
        .with_turn("parent done");
    let mut parent = Agent::builder()
        .model(model)
        .tools(crate::tool_list![subagent(), confirm_tool_counting(seen.clone())])
        .printer(false)
        .build()
        .unwrap();
    let interrupted = parent.invoke("go").await.unwrap();
    assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
    let interrupt_id = "subagent:t1:tool:inner-1:confirm";
    assert_eq!(interrupted.interrupts()[0].id, interrupt_id);
    assert_eq!(interrupted.interrupts()[0].name, "confirm");
    assert_eq!(interrupted.interrupts()[0].reason, Some(json!("Please confirm")));
    let result = parent
        .invoke(vec![InterruptResponse::new(interrupt_id, "yes")])
        .await
        .unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.to_string(), "parent done");
    assert_eq!(*seen.lock().unwrap(), ["yes"]);
    assert_eq!(
        parent.messages()[2].content,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "t1",
            vec![ToolResultContent::Text(TextBlock::new("child report"))]
        ))]
    );
}

#[tokio::test]
async fn resumes_the_same_child_across_consecutive_interrupts() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let model = MockModel::new()
        .with_turn(tool_use_turn("subagent", "t1", json!({"task": "confirm twice"})))
        .with_turn(tool_use_turn("confirmTool", "inner-1", json!({})))
        .with_turn(tool_use_turn("confirmTool", "inner-2", json!({})))
        .with_turn("child report")
        .with_turn("parent done");
    let mut parent = Agent::builder()
        .model(model)
        .tools(crate::tool_list![subagent(), confirm_tool_counting(seen.clone())])
        .printer(false)
        .build()
        .unwrap();
    let first = parent.invoke("go").await.unwrap();
    assert_eq!(first.interrupts()[0].id, "subagent:t1:tool:inner-1:confirm");
    let second = parent
        .invoke(vec![InterruptResponse::new("subagent:t1:tool:inner-1:confirm", "A")])
        .await
        .unwrap();
    assert_eq!(second.interrupts()[0].id, "subagent:t1:tool:inner-2:confirm");
    let result = parent
        .invoke(vec![InterruptResponse::new("subagent:t1:tool:inner-2:confirm", "B")])
        .await
        .unwrap();
    assert_eq!(result.to_string(), "parent done");
    assert_eq!(*seen.lock().unwrap(), ["A", "B"]);
}

#[tokio::test]
async fn delegates_two_levels_deep_from_a_parent_with_an_auto_context_manager() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("subagent", "t1", json!({"task": "delegate again"})))
        .with_turn(tool_use_turn("subagent", "t2", json!({"task": "do it"})))
        .with_turn("grandchild report")
        .with_turn("child report")
        .with_turn("parent done");
    let mut parent = Agent::builder()
        .model(model)
        .tools([subagent()])
        .context_manager(ContextManagerStrategy::Auto)
        .printer(false)
        .build()
        .unwrap();
    let result = parent.invoke("go").await.unwrap();
    assert_eq!(result.to_string(), "parent done");
    assert_eq!(
        parent.messages()[2].content,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "t1",
            vec![ToolResultContent::text("child report")]
        ))]
    );
}

/// Cases for the default child builder.
mod default_builder_cases {
    use std::collections::BTreeMap;

    use super::*;
    use crate::hooks::BeforeToolCallEvent;
    use crate::interventions::{InterventionAction, InterventionHandler, InterventionResult};
    use crate::models::{BaseModelConfig, Model, ModelCapabilities, ModelInfo};
    use crate::sandbox::{NotASandboxLocalEnvironment, Sandbox};
    use crate::telemetry::AttributeValue;

    fn noop(name: &str) -> Arc<dyn Tool> {
        Arc::new(FunctionTool::builder(name, "noop").callback(|_, _| async { Ok(JsonValue::from("ok")) }))
    }

    fn parent_view(printer: bool) -> (ToolAgent, Arc<dyn Model>, Arc<dyn Sandbox>) {
        let sandbox: Arc<dyn Sandbox> = Arc::new(NotASandboxLocalEnvironment::new());
        let parent = Agent::builder()
            .model(MockModel::new())
            .tools([noop("read"), noop("shell")])
            .sandbox(sandbox.clone())
            .printer(printer)
            .build()
            .unwrap();
        let model = parent.model().clone();
        (parent.local().tool_agent(), model, sandbox)
    }

    fn tool_names(child: &Agent) -> Vec<String> {
        child
            .tool_registry()
            .list()
            .iter()
            .map(|tool| tool.name().to_owned())
            .collect()
    }

    #[test]
    fn builds_a_child_agent_that_inherits_the_parent_model_and_takes_spec_name_as_its_name_and_id() {
        let (parent, model, sandbox) = parent_view(false);
        let spec = AgentSpec {
            name: Some("worker".to_owned()),
            ..AgentSpec::default()
        };
        let child = default_builder(&spec, &parent).unwrap();
        assert!(Arc::ptr_eq(child.model(), &model));
        assert_eq!(child.name(), "worker");
        assert_eq!(child.id(), "worker");
        assert!(Arc::ptr_eq(child.sandbox(), &sandbox));
    }

    #[test]
    fn inherits_all_parent_tools_when_spec_tools_is_undefined() {
        let (parent, _, _) = parent_view(false);
        let child = default_builder(&AgentSpec::default(), &parent).unwrap();
        assert_eq!(tool_names(&child), ["read", "shell"]);
    }

    #[test]
    fn resolves_only_matching_tools_and_warns_about_unknown_tools() {
        let (parent, _, _) = parent_view(false);
        let spec = AgentSpec {
            tools: Some(vec!["read".to_owned(), "nonexistent".to_owned()]),
            ..AgentSpec::default()
        };
        let (child, logs) = capture_logs(|| default_builder(&spec, &parent).unwrap());
        assert_eq!(tool_names(&child), ["read"]);
        assert!(
            logs.contains("tool_name=<nonexistent> | subagent requested tool but parent does not own it, skipping"),
            "{logs}"
        );
    }

    #[tokio::test]
    async fn does_not_inherit_the_parent_s_context_manager_tools() {
        let mut parent = Agent::builder()
            .model(MockModel::new())
            .tools([noop("read")])
            .context_manager(ContextManagerStrategy::Auto)
            .printer(false)
            .build()
            .unwrap();
        parent.initialize().await.unwrap();
        let parent_retrieve = parent.tool_registry().get("retrieve_context").cloned().unwrap();

        let mut child = default_builder(&AgentSpec::default(), &parent.local().tool_agent()).unwrap();
        child.initialize().await.unwrap();

        assert_eq!(tool_names(&child), ["read", "retrieve_context"]);
        let child_retrieve = child.tool_registry().get("retrieve_context").cloned().unwrap();
        assert!(!Arc::ptr_eq(&child_retrieve, &parent_retrieve));
    }

    #[test]
    fn gives_the_child_an_auto_context_manager_for_a_stateless_model() {
        let (parent, _, _) = parent_view(false);
        let child = default_builder(&AgentSpec::default(), &parent).unwrap();
        assert!(child.local.context_manager().is_some());
    }

    #[test]
    fn skips_the_context_manager_for_a_stateful_model() {
        let model = MockModel::new();
        model
            .update_config(BaseModelConfig {
                model_info: Some(ModelInfo {
                    capabilities: ModelCapabilities {
                        stateful: Some(true),
                        ..ModelCapabilities::default()
                    },
                    ..ModelInfo::default()
                }),
                ..BaseModelConfig::default()
            })
            .unwrap();
        let parent = Agent::builder().model(model).printer(false).build().unwrap();
        let child = default_builder(&AgentSpec::default(), &parent.local().tool_agent()).unwrap();
        assert!(child.local.context_manager().is_none());
    }

    #[test]
    fn propagates_the_parent_s_sandbox_trace_attributes_and_printer_setting() {
        for printer in [true, false] {
            let sandbox: Arc<dyn Sandbox> = Arc::new(NotASandboxLocalEnvironment::new());
            let parent = Agent::builder()
                .model(MockModel::new())
                .sandbox(sandbox.clone())
                .trace_attributes([("team".to_owned(), AttributeValue::from("infra"))])
                .printer(printer)
                .build()
                .unwrap();

            let child = default_builder(&AgentSpec::default(), &parent.local().tool_agent()).unwrap();

            assert!(Arc::ptr_eq(child.sandbox(), &sandbox));
            assert_eq!(
                child.local.tracer().trace_attributes(),
                BTreeMap::from([("team".to_owned(), AttributeValue::from("infra"))])
            );
            assert_eq!(child.printer.is_some(), printer);
        }
    }

    struct DenyToolCalls;

    #[async_trait::async_trait]
    impl InterventionHandler for DenyToolCalls {
        fn name(&self) -> &str {
            "deny-tool-calls"
        }

        async fn before_tool_call(&self, _event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
            Ok(InterventionAction::deny("not authorized"))
        }
    }

    /// Counts the invocations it sees.
    #[derive(Default)]
    struct CountInvocations(std::sync::atomic::AtomicUsize);

    #[async_trait::async_trait]
    impl InterventionHandler for CountInvocations {
        fn name(&self) -> &str {
            "count-invocations"
        }

        async fn before_invocation<'a>(
            &self,
            _event: &mut BeforeInvocationEvent<'a>,
        ) -> InterventionResult<BeforeInvocationEvent<'a>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(InterventionAction::proceed())
        }
    }

    #[tokio::test]
    async fn shares_the_parent_s_intervention_handler_instances() {
        let handler = Arc::new(CountInvocations::default());
        let parent = Agent::builder()
            .model(MockModel::new())
            .intervention(handler.clone())
            .printer(false)
            .build()
            .unwrap();
        let spec = AgentSpec {
            model: Some(SpecValue::Model(Arc::new(MockModel::new().with_turn("done")))),
            ..AgentSpec::default()
        };

        let mut child = default_builder(&spec, &parent.local().tool_agent()).unwrap();
        child.invoke("go").await.unwrap();

        let names: Vec<&str> = child
            .local
            .interventions()
            .iter()
            .map(|handler| handler.name())
            .collect();
        assert_eq!(names, ["count-invocations"]);
        assert_eq!(handler.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn gates_an_inherited_tool_with_the_parent_s_interventions_when_the_child_s_model_calls_it() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = calls.clone();
        let danger_tool = FunctionTool::builder("dangerTool", "dangerous").callback(move |_, _| {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Ok(JsonValue::from("done")) }
        });
        let parent = Agent::builder()
            .model(MockModel::new())
            .tools([danger_tool])
            .intervention(DenyToolCalls)
            .printer(false)
            .build()
            .unwrap();
        let child_model = MockModel::new()
            .with_turn(tool_use_turn("dangerTool", "t1", json!({})))
            .with_turn("finished");
        let spec = AgentSpec {
            model: Some(SpecValue::Model(Arc::new(child_model))),
            ..AgentSpec::default()
        };

        let mut child = default_builder(&spec, &parent.local().tool_agent()).unwrap();
        child.invoke("run dangerTool").await.unwrap();

        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn inherits_the_parent_printer_setting() {
        let (quiet, _, _) = parent_view(false);
        assert!(
            default_builder(&AgentSpec::default(), &quiet)
                .unwrap()
                .printer
                .is_none()
        );
        let (printing, _, _) = parent_view(true);
        assert!(
            default_builder(&AgentSpec::default(), &printing)
                .unwrap()
                .printer
                .is_some()
        );
    }
}

/// Adds a tool and a `BeforeToolCallEvent` hook that records which agent the call ran on.
struct AuditPlugin {
    events: Arc<Mutex<Vec<String>>>,
    tool: FunctionTool,
}

#[async_trait::async_trait]
impl Plugin for AuditPlugin {
    fn name(&self) -> &str {
        "audit"
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        let events = self.events.clone();
        agent.add_hook(move |event: &mut BeforeToolCallEvent| {
            events
                .lock()
                .unwrap()
                .push(format!("plugin hook {}", event.agent().id()));
        });
        Ok(())
    }

    fn get_tools(&self) -> Vec<ToolSource> {
        vec![self.tool.clone().into()]
    }
}

#[tokio::test]
async fn gives_the_child_a_tool_the_parents_plugin_added_without_the_parents_hooks_or_the_plugins() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let ran = events.clone();
    let plugin_tool = FunctionTool::builder("pluginTool", "a plugin's tool").callback(move |_, _| {
        let ran = ran.clone();
        async move {
            ran.lock().unwrap().push("tool ran".to_owned());
            Ok(json!("done"))
        }
    });
    let calls_plugin_tool = || {
        MockModel::new()
            .with_turn(tool_use_turn("pluginTool", "t1", json!({})))
            .with_turn("finished")
    };
    let mut parent = Agent::builder()
        .id("parent")
        .model(calls_plugin_tool())
        .plugins([AuditPlugin {
            events: events.clone(),
            tool: plugin_tool,
        }])
        .printer(false)
        .build()
        .unwrap();
    let hooked = events.clone();
    parent.add_hook(move |event: &mut BeforeToolCallEvent| {
        hooked
            .lock()
            .unwrap()
            .push(format!("parent hook {}", event.agent().id()));
    });
    parent.initialize().await.unwrap();
    let spec = AgentSpec {
        name: Some("child".to_owned()),
        model: Some(SpecValue::Model(Arc::new(calls_plugin_tool()))),
        ..AgentSpec::default()
    };

    let mut child = default_builder(&spec, &parent.local.tool_agent()).unwrap();

    parent.invoke("run pluginTool").await.unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        ["parent hook parent", "plugin hook parent", "tool ran"]
    );
    events.lock().unwrap().clear();
    child.invoke("run pluginTool").await.unwrap();
    assert_eq!(*events.lock().unwrap(), ["tool ran"]);
}
