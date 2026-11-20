//! An agent used as a tool, with the invocation state and context it passes to the child.
//!
//! The interrupt cases read the orchestrator's interrupt state and are unit tests in
//! `strands/src/agent/agent_as_tool/tests.rs`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::{Arc, Mutex};

use common::{MockTool, tool_use_turn};
use futures::StreamExt;
use serde_json::json;
use strands::agent::{AgentAsTool, AgentAsToolOptions, DELEGATION_DESCRIPTION_SUFFIX};
use strands::hooks::{AfterToolCallEvent, BeforeModelCallEvent};
use strands::plugins::Plugin;
use strands::testing::{MockModel, MockTurn, tool_context};
use strands::tools::{ToolOutcome, ToolStream, ToolStreamEvent, ToolStreamItem, create_error_result};
use strands::types::{ToolResultContent, ToolSpec};
use strands::{
    Agent, CancelOptions, Error, InvokeLimits, InvokeOptions, LocalAgent, StopReason, Tool, ToolContext,
    ToolResultBlock, ToolUse, Usage, async_trait,
};
use tokio::sync::Notify;

fn sub_agent(model: MockModel, name: &str) -> Agent {
    Agent::builder().model(model).name(name).printer(false).build().unwrap()
}

fn hi_model() -> MockModel {
    MockModel::new().with_turn("Hi")
}

fn context(name: &str, tool_use_id: &str, input: &str) -> ToolContext {
    tool_context(ToolUse::new(name, tool_use_id, json!({"input": input})))
}

/// Drains a tool stream into its progress events and its result.
async fn run(stream: ToolStream) -> (Vec<ToolStreamEvent>, ToolResultBlock) {
    let mut stream = stream;
    let mut events = Vec::new();
    while let Some(item) = stream.next().await {
        match item {
            ToolStreamItem::Event(event) => events.push(event),
            ToolStreamItem::Outcome(ToolOutcome::Result(result)) => return (events, result),
            other => panic!("unexpected item: {other:?}"),
        }
    }
    panic!("tool stream ended without a result");
}

fn wire(result: &ToolResultBlock) -> serde_json::Value {
    serde_json::to_value(result).unwrap()
}

mod properties {
    use super::*;

    #[test]
    fn uses_agent_name_as_default_tool_name() {
        let tool = sub_agent(hi_model(), "researcher").as_tool(AgentAsToolOptions::default());
        assert_eq!(tool.name(), "researcher");
    }

    #[test]
    fn allows_overriding_the_tool_name() {
        let tool =
            sub_agent(hi_model(), "researcher").as_tool(AgentAsToolOptions::builder().name("research-tool").build());
        assert_eq!(tool.name(), "research-tool");
    }

    #[test]
    fn uses_agent_description_as_default_tool_description() {
        let agent = Agent::builder()
            .model(hi_model())
            .name("researcher")
            .description("Finds information")
            .build()
            .unwrap();
        assert_eq!(
            agent.as_tool(AgentAsToolOptions::default()).description(),
            "Finds information"
        );
    }

    #[test]
    fn falls_back_to_generic_description_when_agent_has_no_description() {
        let tool = sub_agent(hi_model(), "researcher").as_tool(AgentAsToolOptions::default());
        assert_eq!(
            tool.description(),
            "Use the researcher agent by providing a natural language input"
        );
    }

    #[test]
    fn allows_overriding_the_tool_description() {
        let tool = sub_agent(hi_model(), "researcher")
            .as_tool(AgentAsToolOptions::builder().description("Custom description").build());
        assert_eq!(tool.description(), "Custom description");
    }

    #[tokio::test]
    async fn exposes_the_wrapped_agent_via_getter() {
        let agent = sub_agent(hi_model(), "researcher");
        let id = agent.id().to_owned();
        let tool = agent.as_tool(AgentAsToolOptions::default());
        let wrapped = tool.agent().await;
        assert_eq!(wrapped.name(), "researcher");
        assert_eq!(wrapped.id(), id);
    }

    #[test]
    fn has_correct_tool_spec_shape() {
        let agent = Agent::builder()
            .model(hi_model())
            .name("researcher")
            .description("Finds info")
            .build()
            .unwrap();
        let tool = agent.as_tool(AgentAsToolOptions::default());
        assert_eq!(
            serde_json::to_value(tool.tool_spec()).unwrap(),
            json!({
                "name": "researcher",
                "description": "Finds info",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "input": {"type": "string", "description": "The natural language input to send to the agent."}
                    },
                    "required": ["input"]
                }
            })
        );
    }
}

mod name_validation {
    use super::*;

    #[test]
    fn throws_when_registered_with_agent_name_containing_spaces() {
        let sub = sub_agent(hi_model(), "Strands Agent");
        let error = Agent::builder().model(hi_model()).tools([sub]).build().unwrap_err();
        assert!(matches!(error, Error::ToolValidation(_)), "{error}");
    }

    #[test]
    fn throws_when_registered_with_explicit_name_containing_invalid_characters() {
        let tool =
            sub_agent(hi_model(), "researcher").as_tool(AgentAsToolOptions::builder().name("has spaces").build());
        let error = Agent::builder().model(hi_model()).tools([tool]).build().unwrap_err();
        assert!(matches!(error, Error::ToolValidation(_)), "{error}");
    }

    #[test]
    fn accepts_valid_name_with_hyphens_and_underscores() {
        let tool = sub_agent(hi_model(), "my_research-agent").as_tool(AgentAsToolOptions::default());
        assert_eq!(tool.name(), "my_research-agent");
        Agent::builder().model(hi_model()).tools([tool]).build().unwrap();
    }
}

/// A tool that reports progress twice before its result.
struct StreamingTool;

impl Tool for StreamingTool {
    fn name(&self) -> &str {
        "streaming-tool"
    }

    fn description(&self) -> &str {
        "A tool that yields stream events"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new(self.name(), self.description()).with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let result = ToolResultBlock::success(context.tool_use().tool_use_id.clone(), Vec::new());
        ToolStream::new(futures::stream::iter([
            ToolStreamItem::Event(ToolStreamEvent::new("progress-1")),
            ToolStreamItem::Event(ToolStreamEvent::new("progress-2")),
            ToolStreamItem::from(result),
        ]))
    }
}

/// A plugin whose initialization waits until released.
struct DelayedInitialization {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

#[async_trait]
impl Plugin for DelayedInitialization {
    fn name(&self) -> &str {
        "delayed-initialization"
    }

    async fn init_agent(&self, _agent: &mut LocalAgent) -> strands::Result<()> {
        self.started.notify_one();
        self.release.notified().await;
        Ok(())
    }
}

mod stream {
    use super::*;

    #[tokio::test]
    async fn invokes_the_wrapped_agent_and_returns_text_result() {
        let tool = sub_agent(MockModel::new().with_turn("Agent response"), "test-agent")
            .as_tool(AgentAsToolOptions::default());

        let (_, result) = run(tool.stream(context("test-agent", "tool-1", "Hello agent"))).await;

        assert_eq!(
            wire(&result),
            json!({"toolUseId": "tool-1", "status": "success", "content": [{"text": "Agent response"}]})
        );
    }

    #[tokio::test]
    async fn returns_an_error_with_the_partial_output_when_the_wrapped_agent_stops_with_content_filtered_or_refusal() {
        for stop_reason in [StopReason::ContentFiltered, StopReason::Refusal] {
            let model = MockModel::new().with_turn(MockTurn::text("partial").with_stop_reason(stop_reason.clone()));
            let tool = sub_agent(model, "test-agent").as_tool(AgentAsToolOptions::default());

            let (_, result) = run(tool.stream(context("test-agent", "tool-1", "Hello agent"))).await;

            assert_eq!(
                result,
                create_error_result(
                    format!(
                        "Agent 'test-agent' stopped before finishing (stopReason={stop_reason}).\n\nPartial output:\npartial"
                    ),
                    "tool-1"
                )
            );
        }
    }

    #[tokio::test]
    async fn returns_an_error_when_the_execution_signal_cancels_the_wrapped_agent() {
        let agent = sub_agent(MockModel::new().with_turn("Agent response"), "test-agent");
        let context = context("test-agent", "tool-1", "Hello agent");
        let caller = context.agent().clone();
        agent.add_hook(move |_: &mut BeforeModelCallEvent<'_>| caller.cancel(CancelOptions::default()));
        let tool = agent.as_tool(AgentAsToolOptions::default());

        let (_, result) = run(tool.stream(context)).await;

        assert_eq!(result, create_error_result("Agent 'test-agent' cancelled", "tool-1"));
        assert_eq!(
            wire(&result)["content"],
            json!([{"text": "Error: Agent 'test-agent' cancelled"}])
        );
    }

    #[tokio::test]
    async fn returns_a_success_result_when_the_wrapped_agent_ends_via_a_deferred_cancel_stop_tool() {
        let stop = MockTool::new("stop", |context| {
            context.agent().cancel(
                CancelOptions::builder()
                    .message("Answer is 42")
                    .after_current_tools(true)
                    .build(),
            );
            ToolResultBlock::success("t1", vec![ToolResultContent::text("Answer is 42")]).into()
        });
        let model = MockModel::new()
            .with_turn(tool_use_turn("stop", "t1", json!({})))
            .with_turn("unreachable");
        let agent = Agent::builder()
            .model(model)
            .name("test-agent")
            .tools([stop])
            .printer(false)
            .build()
            .unwrap();
        let tool = agent.as_tool(AgentAsToolOptions::default());

        let (_, result) = run(tool.stream(context("test-agent", "tool-1", "Hello agent"))).await;

        assert_eq!(
            wire(&result),
            json!({"toolUseId": "tool-1", "status": "success", "content": [{"text": "Answer is 42"}]})
        );
    }

    #[tokio::test]
    async fn returns_an_error_when_the_wrapped_agent_is_cancelled_immediately_from_a_tool() {
        let abort = MockTool::new("abort", |context| {
            context.agent().cancel(CancelOptions::default());
            ToolResultBlock::success("t1", vec![ToolResultContent::text("aborting")]).into()
        });
        let model = MockModel::new()
            .with_turn(tool_use_turn("abort", "t1", json!({})))
            .with_turn("unreachable");
        let agent = Agent::builder()
            .model(model)
            .name("test-agent")
            .tools([abort])
            .printer(false)
            .build()
            .unwrap();
        let tool = agent.as_tool(AgentAsToolOptions::default());

        let (_, result) = run(tool.stream(context("test-agent", "tool-1", "Hello agent"))).await;

        assert_eq!(result, create_error_result("Agent 'test-agent' cancelled", "tool-1"));
    }

    #[tokio::test]
    async fn does_not_persist_cancellation_when_the_signal_aborts_during_initialization() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let plugin = DelayedInitialization {
            started: started.clone(),
            release: release.clone(),
        };
        let agent = Agent::builder()
            .model(MockModel::new().with_turn("Agent response"))
            .name("test-agent")
            .plugins(vec![Arc::new(plugin)])
            .printer(false)
            .build()
            .unwrap();
        let tool = Arc::new(agent.as_tool(AgentAsToolOptions::builder().preserve_context(true).build()));
        let context = context("test-agent", "tool-1", "Hello agent");
        let caller = context.agent().clone();

        let running = tool.clone();
        let execution = tokio::spawn(async move { run(running.stream(context)).await });
        started.notified().await;
        caller.cancel(CancelOptions::default());
        release.notify_one();
        let (_, result) = execution.await.unwrap();

        assert_eq!(result, create_error_result("Agent 'test-agent' cancelled", "tool-1"));
        assert!(tool.agent().await.messages().is_empty());
    }

    #[tokio::test]
    async fn yields_tool_stream_events_wrapping_sub_agent_events() {
        let tool = sub_agent(MockModel::new().with_turn("Hello"), "test-agent").as_tool(AgentAsToolOptions::default());

        let (events, _) = run(tool.stream(context("test-agent", "tool-1", "Hi"))).await;

        assert!(!events.is_empty());
        let types: Vec<&str> = events
            .iter()
            .map(|event| event.data.as_ref().unwrap()["type"].as_str().unwrap())
            .collect();
        assert_eq!(types.first(), Some(&"beforeInvocationEvent"));
        assert_eq!(types.last(), Some(&"agentResultEvent"));
    }

    #[tokio::test]
    async fn unwraps_tool_stream_update_event_by_yielding_inner_tool_stream_event_directly() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("streaming-tool", "sub-tool-1", json!({})))
            .with_turn("Final response");
        let agent = Agent::builder()
            .model(model)
            .name("test-agent")
            .tools([StreamingTool])
            .printer(false)
            .build()
            .unwrap();
        let tool = agent.as_tool(AgentAsToolOptions::default());

        let (events, _) = run(tool.stream(context("test-agent", "outer-tool-1", "Do something"))).await;

        let progress: Vec<&serde_json::Value> = events
            .iter()
            .filter_map(|event| event.data.as_ref())
            .filter(|data| data.is_string())
            .collect();
        assert_eq!(progress, [&json!("progress-1"), &json!("progress-2")]);
    }

    #[tokio::test]
    async fn returns_error_result_on_agent_failure() {
        let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("Model failed")));
        let tool = sub_agent(model, "test-agent").as_tool(AgentAsToolOptions::default());

        let (_, result) = run(tool.stream(context("test-agent", "tool-1", "Hello"))).await;

        assert_eq!(result.tool_use_id, "tool-1");
        assert_eq!(wire(&result)["status"], json!("error"));
        assert_eq!(wire(&result)["content"], json!([{"text": "Error: Model failed"}]));
    }

    #[tokio::test]
    async fn returns_error_result_when_agent_is_already_busy() {
        let tool =
            sub_agent(MockModel::new().with_turn("Slow response"), "test-agent").as_tool(AgentAsToolOptions::default());

        let mut first = tool.stream(context("test-agent", "tool-1", "First call"));
        first.next().await.unwrap();

        let (_, result) = run(tool.stream(context("test-agent", "tool-2", "Second call"))).await;

        assert_eq!(result.tool_use_id, "tool-2");
        assert_eq!(wire(&result)["status"], json!("error"));
        assert!(
            wire(&result)["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("already processing")
        );
        run(first).await;
    }
}

mod preserve_context {
    use super::*;

    async fn message_counts(tool: &AgentAsTool) -> (usize, usize) {
        run(tool.stream(context("test-agent", "tool-1", "Hello"))).await;
        let first = tool.agent().await.messages().len();
        run(tool.stream(context("test-agent", "tool-2", "Hello again"))).await;
        let second = tool.agent().await.messages().len();
        (first, second)
    }

    #[tokio::test]
    async fn resets_agent_state_between_invocations_when_false_default() {
        let tool =
            sub_agent(MockModel::new().with_turn("Response"), "test-agent").as_tool(AgentAsToolOptions::default());
        let (first, second) = message_counts(&tool).await;
        assert_eq!(second, first);
    }

    #[tokio::test]
    async fn preserves_agent_state_across_invocations_when_true() {
        let tool = sub_agent(MockModel::new().with_turn("Response"), "test-agent")
            .as_tool(AgentAsToolOptions::builder().preserve_context(true).build());
        let (first, second) = message_counts(&tool).await;
        assert!(second > first);
    }

    #[tokio::test]
    async fn snapshots_at_construction_time_not_first_invocation() {
        let tool =
            sub_agent(MockModel::new().with_turn("Response"), "test-agent").as_tool(AgentAsToolOptions::default());
        let at_construction = tool.agent().await.messages().len();

        tool.agent().await.invoke("Direct invocation").await.unwrap();
        assert!(tool.agent().await.messages().len() > at_construction);

        let (first, second) = message_counts(&tool).await;
        assert_eq!(second, first);
        assert_eq!(first, at_construction + 2);
    }
}

mod as_tool {
    use super::*;

    #[test]
    fn returns_an_agent_as_tool_instance() {
        let tool: AgentAsTool = sub_agent(hi_model(), "researcher").as_tool(AgentAsToolOptions::default());
        assert_eq!(tool.name(), "researcher");
    }

    #[test]
    fn passes_options_through_to_agent_as_tool() {
        let tool = sub_agent(hi_model(), "researcher").as_tool(
            AgentAsToolOptions::builder()
                .name("custom-name")
                .description("Custom desc")
                .build(),
        );
        assert_eq!(tool.name(), "custom-name");
        assert_eq!(tool.description(), "Custom desc");
    }

    fn specialist() -> Agent {
        Agent::builder()
            .model(hi_model())
            .name("specialist")
            .description("Handles billing")
            .printer(false)
            .build()
            .unwrap()
    }

    #[test]
    fn sets_delegate_and_appends_description_suffix_when_delegate_is_true() {
        let tool = specialist().as_tool(AgentAsToolOptions::builder().delegate(true).build());
        let expected = format!("Handles billing{DELEGATION_DESCRIPTION_SUFFIX}");
        assert!(tool.delegate());
        assert_eq!(tool.description(), expected);
        assert_eq!(tool.tool_spec().description, expected);
    }

    #[test]
    fn does_not_set_delegate_or_append_description_suffix_when_delegate_is_false() {
        let tool = specialist().as_tool(AgentAsToolOptions::builder().delegate(false).build());
        assert!(!tool.delegate());
        assert_eq!(tool.description(), "Handles billing");
        assert!(!tool.description().contains(DELEGATION_DESCRIPTION_SUFFIX));
    }
}

mod agent_in_tool_list {
    use super::*;

    #[test]
    fn auto_wraps_agent_as_agent_as_tool_when_passed_in_tools_array() {
        let sub = Agent::builder()
            .model(hi_model())
            .name("sub-agent")
            .description("A sub agent")
            .build()
            .unwrap();
        let parent = Agent::builder().model(hi_model()).tools([sub]).build().unwrap();

        let registered = parent.tool_registry().get("sub-agent").unwrap();
        assert_eq!(registered.name(), "sub-agent");
        assert_eq!(registered.description(), "A sub agent");
    }

    #[test]
    fn auto_wraps_agent_in_nested_tools_arrays() {
        let sub = sub_agent(hi_model(), "nested-agent");
        let parent = Agent::builder()
            .model(hi_model())
            .tools([strands::tool_list![vec![strands::ToolSource::from(sub)]]])
            .build()
            .unwrap();

        assert!(parent.tool_registry().get("nested-agent").is_some());
    }
}

#[derive(Clone, Debug, PartialEq)]
struct UserId(&'static str);

#[derive(Clone, Debug, PartialEq)]
struct InnerTouched(bool);

#[tokio::test]
async fn forwards_outer_invocation_state_into_the_wrapped_agent_and_reflects_inner_mutations_on_outer_result() {
    let inner = Agent::builder()
        .model(MockModel::new().with_turn("inner-done"))
        .name("inner")
        .description("inner agent")
        .printer(false)
        .build()
        .unwrap();
    let saw = Arc::new(Mutex::new(None));
    let seen = saw.clone();
    inner.add_hook(move |event: &mut BeforeModelCallEvent<'_>| {
        *seen.lock().unwrap() = event.invocation_state().get::<UserId>();
        event.invocation_state().insert(InnerTouched(true));
    });
    let outer_model = MockModel::new()
        .with_turn(tool_use_turn("inner", "tu-1", json!({"input": "hi"})))
        .with_turn("outer-done");
    let mut outer = Agent::builder()
        .model(outer_model)
        .tools([inner.as_tool(AgentAsToolOptions::default())])
        .printer(false)
        .build()
        .unwrap();
    let state = strands::InvocationState::new();
    state.insert(UserId("u-1"));

    let result = outer
        .invoke_with(
            "run inner",
            InvokeOptions {
                invocation_state: Some(state),
                ..InvokeOptions::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(*saw.lock().unwrap(), Some(UserId("u-1")));
    assert_eq!(result.invocation_state().get::<UserId>(), Some(UserId("u-1")));
    assert_eq!(
        result.invocation_state().get::<InnerTouched>(),
        Some(InnerTouched(true))
    );
}

mod request_wide_invocation_context {
    use super::*;

    fn usage(output_tokens: u64) -> Usage {
        Usage::new(0, output_tokens, output_tokens)
    }

    fn inner(model: MockModel) -> Agent {
        Agent::builder()
            .model(model)
            .name("inner")
            .description("inner agent")
            .printer(false)
            .build()
            .unwrap()
    }

    fn outer(model: MockModel, inner: Agent) -> Agent {
        Agent::builder()
            .model(model)
            .tools([inner.as_tool(AgentAsToolOptions::default())])
            .printer(false)
            .build()
            .unwrap()
    }

    fn limits(output_tokens: u64) -> InvokeOptions {
        InvokeOptions {
            limits: Some(InvokeLimits {
                output_tokens: Some(output_tokens),
                ..InvokeLimits::default()
            }),
            ..InvokeOptions::default()
        }
    }

    fn calls_inner() -> MockTurn {
        tool_use_turn("inner", "tu-1", json!({"input": "hi"})).with_usage(usage(60))
    }

    #[tokio::test]
    async fn folds_the_inner_agent_model_usage_into_the_parent_request_total() {
        let inner = inner(MockModel::new().with_turn(MockTurn::text("inner-done").with_usage(usage(60))));
        let seen = Arc::new(Mutex::new(None));
        let sink = seen.clone();
        inner.add_hook(move |event: &mut BeforeModelCallEvent<'_>| {
            *sink.lock().unwrap() = event
                .invocation_context()
                .map(|context| context.usage().usage.output_tokens);
        });
        let model = MockModel::new()
            .with_turn(calls_inner())
            .with_turn(MockTurn::text("outer-done").with_usage(usage(10)));
        let mut outer = outer(model, inner);

        outer.invoke("run inner").await.unwrap();

        assert_eq!(*seen.lock().unwrap(), Some(60));
    }

    #[tokio::test]
    async fn trips_a_limit_that_only_the_parent_plus_child_total_exceeds() {
        let inner = inner(MockModel::new().with_turn(MockTurn::text("inner-done").with_usage(usage(60))));
        let model = MockModel::new()
            .with_turn(calls_inner())
            .with_turn(MockTurn::text("outer-done").with_usage(usage(60)));
        let mut outer = outer(model, inner);

        let result = outer.invoke_with("run inner", limits(100)).await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::LimitOutputTokens);
    }

    #[tokio::test]
    async fn returns_an_error_result_when_the_child_stops_on_the_shared_limit() {
        let inner = inner(MockModel::new().with_turn("never reached"));
        let mut outer = outer(MockModel::new().with_turn(calls_inner()), inner);
        let tool_result = Arc::new(Mutex::new(None));
        let sink = tool_result.clone();
        outer.add_hook(move |event: &mut AfterToolCallEvent| *sink.lock().unwrap() = Some(event.result().clone()));

        let result = outer.invoke_with("run inner", limits(50)).await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::LimitOutputTokens);
        let tool_result = tool_result.lock().unwrap().clone().unwrap();
        assert_eq!(
            wire(&tool_result),
            json!({
                "toolUseId": "tu-1",
                "status": "error",
                "content": [{"text": "Error: Agent 'inner' stopped early (limitOutputTokens): a limit on this call was reached, so its answer is incomplete"}]
            })
        );
        assert!(tool_result.error.is_some());
    }
}

mod session_manager_validation {
    use strands::SessionManager;
    use strands::storage::InMemoryStorage;

    use super::*;

    const CONFLICT: &str = "Agent 'test-agent' has a SessionManager, which conflicts with preserveContext=false. The SessionManager persists conversation history externally, but preserveContext=false resets state between invocations. Use preserveContext=true or remove the SessionManager.";

    fn agent_with_session() -> Agent {
        let session_manager = SessionManager::builder()
            .storage(Arc::new(InMemoryStorage::new()))
            .build()
            .unwrap();
        Agent::builder()
            .model(hi_model())
            .name("test-agent")
            .session_manager(session_manager)
            .printer(false)
            .build()
            .unwrap()
    }

    #[test]
    fn throws_when_preserve_context_is_false_and_agent_has_a_session_manager() {
        let error = agent_with_session()
            .try_as_tool(AgentAsToolOptions::default())
            .unwrap_err();
        assert_eq!(error.to_string(), CONFLICT);
    }

    #[test]
    fn throws_when_preserve_context_is_explicitly_false_and_agent_has_a_session_manager() {
        let error = agent_with_session()
            .try_as_tool(AgentAsToolOptions::builder().preserve_context(false).build())
            .unwrap_err();
        assert_eq!(error.to_string(), CONFLICT);
    }

    #[test]
    fn allows_preserve_context_true_with_session_manager() {
        let tool = agent_with_session().try_as_tool(AgentAsToolOptions::builder().preserve_context(true).build());
        assert!(tool.is_ok());
    }

    #[tokio::test]
    async fn an_infallibly_built_conflicting_tool_fails_each_call_with_the_conflict() {
        let tool = agent_with_session().as_tool(AgentAsToolOptions::default());

        let (_, result) = run(tool.stream(context("test-agent", "tool-1", "Hi"))).await;

        assert_eq!(
            wire(&result),
            json!({"toolUseId": "tool-1", "status": "error", "content": [{"text": format!("Error: {CONFLICT}")}]})
        );
    }
}
