//! Agent middleware on the `InvokeModelStage` and `ExecuteToolStage` stages: the middleware chain,
//! copy-on-input and middleware interrupts.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use common::{MockTool, collect, tool_use_turn};
use futures::StreamExt;
use serde_json::{Value, json};
use strands::hooks::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, BeforeModelCallEvent, BeforeToolCallEvent,
};
use strands::middleware::{
    ExecuteToolResult, ExecuteToolStage, InvokeModelResult, InvokeModelStage, MiddlewareError, StageItem, StageStream,
};
use strands::models::{BaseModelConfig, BoxStream, ModelRequest};
use strands::plugins::Plugin;
use strands::testing::{MockModel, MockTurn, test_agent};
use strands::types::{InterruptResponse, ToolResultContent, ToolSpec};
use strands::{
    Agent, AgentStreamEvent, ContentBlock, LocalAgent, Message, Model, ModelStreamEvent, ModelThrottledError, Role,
    StopReason, StreamAggregatedResult, SystemPrompt, ToolResultBlock,
};

type Log = Arc<Mutex<Vec<String>>>;

fn push(log: &Log, entry: &str) {
    log.lock().unwrap().push(entry.to_owned());
}

fn entries(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

fn agent_with(model: MockModel, tools: Vec<MockTool>) -> Agent {
    let mut agent = test_agent(model);
    for tool in tools {
        agent.tool_registry_mut().add(tool).unwrap();
    }
    agent
}

fn tool_then_done(name: &str, input: Value) -> MockModel {
    MockModel::from_turns([tool_use_turn(name, "tool-1", input), MockTurn::text("Done")])
}

fn cached(text: &str) -> StageStream<InvokeModelStage> {
    let message = Message::new(Role::Assistant, vec![ContentBlock::text(text)]);
    StageStream::from_result(Ok(InvokeModelResult::new(StreamAggregatedResult::new(
        message,
        StopReason::EndTurn,
    ))))
}

fn mocked(tool_use_id: &str, text: &str) -> StageStream<ExecuteToolStage> {
    let result = ToolResultBlock::success(tool_use_id, vec![ToolResultContent::text(text)]);
    StageStream::from_result(Ok(ExecuteToolResult::new(result)))
}

fn logging_wrap(log: &Log, name: &'static str) -> strands::middleware::Middleware<InvokeModelStage> {
    let log = log.clone();
    InvokeModelStage::wrap(move |context, next| {
        push(&log, &format!("{name}-before"));
        let log = log.clone();
        next.call(context).map_result(move |result| async move {
            push(&log, &format!("{name}-after"));
            result
        })
    })
}

// --- InvokeModelStage ---------------------------------------------------------------------------

#[tokio::test]
async fn middleware_handler_is_invoked_during_model_call() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        counter.fetch_add(1, Ordering::Relaxed);
        next.call(context)
    }));
    agent.invoke("Test prompt").await.unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn middleware_receives_invoke_model_context_with_correct_fields() {
    let model = MockModel::new().with_turn("Hello");
    let mut agent = agent_with(model, vec![MockTool::text("testTool", "ok")]);
    agent.set_system_prompt(Some("Be helpful".into()));
    let seen = Arc::new(Mutex::new(None));
    let slot = seen.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        *slot.lock().unwrap() = Some(context.clone());
        next.call(context)
    }));
    agent.invoke("Test prompt").await.unwrap();

    let context = seen.lock().unwrap().take().unwrap();
    assert_eq!(context.agent.id(), agent.id());
    assert!(Arc::ptr_eq(&context.model, agent.model()));
    assert_eq!(context.system_prompt, Some(SystemPrompt::from("Be helpful")));
    assert_eq!(context.messages.len(), 1);
    assert!(context.tool_specs.iter().any(|spec| spec.name == "testTool"));
    assert!(context.invocation_context.is_some());
    assert!(context.projected_input_tokens.is_some());
}

#[tokio::test]
async fn middleware_can_select_the_model_for_one_call() {
    let default_model = MockModel::new().with_turn("Default response");
    let selected = MockModel::new().with_turn("Selected response");
    let mut agent = test_agent(default_model.clone());
    let selected_model: Arc<dyn Model> = Arc::new(selected);
    agent.add_middleware(InvokeModelStage::input(move |mut context| {
        let model = selected_model.clone();
        async move {
            context.model = model;
            Ok(context)
        }
    }));
    let result = agent.invoke("Test prompt").await.unwrap();
    assert_eq!(result.last_message().content, [ContentBlock::text("Selected response")]);
    assert_eq!(default_model.call_count(), 0);
}

#[tokio::test]
async fn after_model_call_reports_the_model_middleware_selected() {
    let selected = MockModel::new().with_turn("Selected response");
    let selected_model: Arc<dyn Model> = Arc::new(selected);
    let mut agent = test_agent(MockModel::new().with_turn("Default"));
    let model = selected_model.clone();
    agent.add_middleware(InvokeModelStage::input(move |mut context| {
        let model = model.clone();
        async move {
            context.model = model;
            Ok(context)
        }
    }));
    let reported = Arc::new(AtomicBool::new(false));
    let flag = reported.clone();
    agent.add_hook(move |event: &mut AfterModelCallEvent<'_>| {
        flag.store(Arc::ptr_eq(event.model(), &selected_model), Ordering::Relaxed);
    });
    agent.invoke("Test prompt").await.unwrap();
    assert!(reported.load(Ordering::Relaxed));
}

#[tokio::test]
async fn middleware_result_is_used_as_the_model_call_result() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    agent.add_middleware(InvokeModelStage::wrap(|context, next| next.call(context)));
    let result = agent.invoke("Test prompt").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().content, [ContentBlock::text("Hello")]);
}

#[tokio::test]
async fn returns_synthetic_result_without_calling_the_model() {
    let mut agent = test_agent(MockModel::new().with_turn("Real response"));
    agent.add_middleware(InvokeModelStage::wrap(|_, _| cached("Cached response")));
    let result = agent.invoke("Test prompt").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().content, [ContentBlock::text("Cached response")]);
}

#[tokio::test]
async fn model_is_not_called_when_middleware_short_circuits() {
    let model = MockModel::new().with_turn("Real response");
    let mut agent = test_agent(model.clone());
    agent.add_middleware(InvokeModelStage::wrap(|_, _| cached("Cached")));
    agent.invoke("Test prompt").await.unwrap();
    assert_eq!(model.call_count(), 0);
}

#[tokio::test]
async fn modified_messages_are_passed_to_the_model() {
    let model = MockModel::new().with_turn("Hello");
    let mut agent = test_agent(model.clone());
    agent.add_middleware(InvokeModelStage::wrap(|mut context, next| {
        context.messages.push(Message::user("Injected message"));
        next.call(context)
    }));
    agent.invoke("Test prompt").await.unwrap();
    assert!(model.requests()[0].messages.len() > 1);
    assert_eq!(agent.messages().len(), 2);
}

#[tokio::test]
async fn modified_tool_specs_are_passed_to_the_model() {
    let model = MockModel::new().with_turn("Hello");
    let mut agent = agent_with(model.clone(), vec![MockTool::text("testTool", "ok")]);
    agent.add_middleware(InvokeModelStage::wrap(|mut context, next| {
        context.tool_specs.clear();
        next.call(context)
    }));
    agent.invoke("Test prompt").await.unwrap();
    assert!(model.requests()[0].tool_specs.is_empty());
}

#[tokio::test]
async fn before_model_call_event_fires_before_middleware_executes() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = Log::default();
    let hook_log = log.clone();
    agent.add_hook(move |_: &mut BeforeModelCallEvent<'_>| push(&hook_log, "beforeModelCall"));
    let wrap_log = log.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        push(&wrap_log, "middleware");
        next.call(context)
    }));
    agent.invoke("Test prompt").await.unwrap();
    assert_eq!(entries(&log), ["beforeModelCall", "middleware"]);
}

#[tokio::test]
async fn after_model_call_event_fires_after_middleware_completes() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = Log::default();
    let hook_log = log.clone();
    agent.add_hook(move |_: &mut AfterModelCallEvent<'_>| push(&hook_log, "afterModelCall"));
    agent.add_middleware(logging_wrap(&log, "middleware"));
    agent.invoke("Test prompt").await.unwrap();
    assert_eq!(
        entries(&log),
        ["middleware-before", "middleware-after", "afterModelCall"]
    );
}

#[tokio::test]
async fn before_after_hooks_fire_even_when_middleware_short_circuits() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = Log::default();
    let before = log.clone();
    agent.add_hook(move |_: &mut BeforeModelCallEvent<'_>| push(&before, "before"));
    let after = log.clone();
    agent.add_hook(move |_: &mut AfterModelCallEvent<'_>| push(&after, "after"));
    agent.add_middleware(InvokeModelStage::wrap(|_, _| cached("Cached")));
    agent.invoke("Test prompt").await.unwrap();
    assert_eq!(entries(&log), ["before", "after"]);
}

#[tokio::test]
async fn returns_a_function_that_removes_the_middleware() {
    let mut agent = test_agent(MockModel::from_turns(["First", "Second"]));
    let called = Arc::new(AtomicBool::new(false));
    let flag = called.clone();
    let cleanup = agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        flag.store(true, Ordering::Relaxed);
        next.call(context)
    }));
    agent.invoke("First call").await.unwrap();
    assert!(called.swap(false, Ordering::Relaxed));
    cleanup.remove();
    agent.invoke("Second call").await.unwrap();
    assert!(!called.load(Ordering::Relaxed));
}

#[tokio::test]
async fn only_removes_the_specific_handler_not_others_on_the_same_stage() {
    let mut agent = test_agent(MockModel::new().with_turn("Result"));
    let log = Log::default();
    let keeper = log.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        push(&keeper, "keeper");
        next.call(context)
    }));
    let removed = log.clone();
    agent
        .add_middleware(InvokeModelStage::wrap(move |context, next| {
            push(&removed, "removed");
            next.call(context)
        }))
        .remove();
    agent.invoke("Test").await.unwrap();
    assert_eq!(entries(&log), ["keeper"]);
}

#[tokio::test]
async fn agent_works_correctly_without_any_middleware() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let result = agent.invoke("Test prompt").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().content, [ContentBlock::text("Hello")]);
}

#[tokio::test]
async fn agent_with_tools_works_correctly_without_middleware() {
    let mut agent = agent_with(
        tool_then_done("testTool", json!({})),
        vec![MockTool::text("testTool", "Tool executed")],
    );
    let result = agent.invoke("Use the tool").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().content, [ContentBlock::text("Done")]);
}

#[tokio::test]
async fn stream_works_correctly_without_middleware() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let events = collect(agent.stream("Test prompt")).await;
    let Some(AgentStreamEvent::AgentResult(result)) = events.last() else {
        panic!("the stream ends with the result");
    };
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.last_message().content, [ContentBlock::text("Hello")]);
}

#[tokio::test]
async fn middleware_can_filter_and_inject_stream_events() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    agent.add_middleware(InvokeModelStage::wrap(|context, next| {
        let inner = next.call(context);
        let injected = StageItem::Event(AgentStreamEvent::ContentBlock(
            strands::hooks::ContentBlockEventData::new(ContentBlock::text("injected")),
        ));
        let filtered = inner.filter(|item| {
            std::future::ready(!matches!(
                item,
                StageItem::Event(AgentStreamEvent::ModelStreamUpdate(_))
            ))
        });
        StageStream::new(futures::stream::iter([injected]).chain(filtered))
    }));
    let blocks = Arc::new(Mutex::new(Vec::new()));
    let seen = blocks.clone();
    agent.add_hook(move |event: &mut strands::hooks::ContentBlockEvent<'_>| {
        seen.lock().unwrap().push(event.content_block().clone());
    });
    let updates = Arc::new(AtomicUsize::new(0));
    let counter = updates.clone();
    agent.add_hook(move |_: &mut strands::hooks::ModelStreamUpdateEvent<'_>| {
        counter.fetch_add(1, Ordering::Relaxed);
    });
    let events = collect(agent.stream("Hi")).await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, AgentStreamEvent::ModelStreamUpdate(_)))
    );
    assert_eq!(updates.load(Ordering::Relaxed), 0);
    assert_eq!(
        *blocks.lock().unwrap(),
        [ContentBlock::text("injected"), ContentBlock::text("Hello")]
    );
}

// --- ExecuteToolStage ---------------------------------------------------------------------------

#[tokio::test]
async fn middleware_handler_is_invoked_during_tool_execution() {
    let mut agent = agent_with(
        tool_then_done("testTool", json!({"x": 1})),
        vec![MockTool::text("testTool", "executed")],
    );
    let log = Log::default();
    let wrap_log = log.clone();
    agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
        push(&wrap_log, "middleware:before");
        let log = wrap_log.clone();
        next.call(context).map_result(move |result| async move {
            push(&log, "middleware:after");
            result
        })
    }));
    agent.invoke("Use the tool").await.unwrap();
    assert_eq!(entries(&log), ["middleware:before", "middleware:after"]);
}

#[tokio::test]
async fn middleware_receives_execute_tool_context_with_correct_fields() {
    let mut agent = agent_with(
        tool_then_done("testTool", json!({"key": "val"})),
        vec![MockTool::text("testTool", "ok")],
    );
    let seen = Arc::new(Mutex::new(None));
    let slot = seen.clone();
    agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
        *slot.lock().unwrap() = Some(context.clone());
        next.call(context)
    }));
    agent.invoke("Use the tool").await.unwrap();
    let context = seen.lock().unwrap().take().unwrap();
    assert_eq!(context.agent.id(), agent.id());
    assert_eq!(context.tool.as_ref().unwrap().name(), "testTool");
    assert_eq!(
        serde_json::to_value(&context.tool_use).unwrap(),
        json!({"name": "testTool", "toolUseId": "tool-1", "input": {"key": "val"}})
    );
    assert!(!context.cancel_signal().is_cancelled());
}

#[tokio::test]
async fn multiple_tool_middleware_execute_in_registration_order() {
    let mut agent = agent_with(
        tool_then_done("testTool", json!({})),
        vec![MockTool::text("testTool", "ok")],
    );
    let log = Log::default();
    for name in ["outer", "inner"] {
        let log = log.clone();
        agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
            push(&log, &format!("{name}-before"));
            let log = log.clone();
            next.call(context).map_result(move |result| async move {
                push(&log, &format!("{name}-after"));
                result
            })
        }));
    }
    agent.invoke("Use the tool").await.unwrap();
    assert_eq!(
        entries(&log),
        ["outer-before", "inner-before", "inner-after", "outer-after"]
    );
}

#[tokio::test]
async fn returns_mock_result_without_executing_the_real_tool() {
    let ran = Arc::new(AtomicBool::new(false));
    let flag = ran.clone();
    let tool = MockTool::new("testTool", move |context| {
        flag.store(true, Ordering::Relaxed);
        ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into()
    });
    let mut agent = agent_with(tool_then_done("testTool", json!({})), vec![tool]);
    agent.add_middleware(ExecuteToolStage::wrap(|context, _| {
        mocked(&context.tool_use.tool_use_id, "mocked result")
    }));
    let result = agent.invoke("Use the tool").await.unwrap();
    assert!(!ran.load(Ordering::Relaxed));
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
}

#[tokio::test]
async fn short_circuit_result_is_used_in_the_conversation() {
    let mut agent = agent_with(
        tool_then_done("testTool", json!({})),
        vec![MockTool::text("testTool", "real")],
    );
    agent.add_middleware(ExecuteToolStage::wrap(|context, _| {
        mocked(&context.tool_use.tool_use_id, "mocked data")
    }));
    agent.invoke("Use the tool").await.unwrap();
    let block = agent
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .find_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(result.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        block,
        ToolResultBlock::success("tool-1", vec![ToolResultContent::text("mocked data")])
    );
}

fn input_recording_tool(seen: &Arc<Mutex<Option<Value>>>) -> MockTool {
    let seen = seen.clone();
    MockTool::new("testTool", move |context| {
        *seen.lock().unwrap() = Some(context.tool_use().input.clone());
        ToolResultBlock::success(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text("ok")],
        )
        .into()
    })
}

#[tokio::test]
async fn modified_input_reaches_the_tool() {
    let seen = Arc::new(Mutex::new(None));
    let mut agent = agent_with(
        tool_then_done("testTool", json!({"value": "original"})),
        vec![input_recording_tool(&seen)],
    );
    agent.add_middleware(ExecuteToolStage::wrap(|mut context, next| {
        context.tool_use.input = json!({"value": "transformed"});
        next.call(context)
    }));
    agent.invoke("Use the tool").await.unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(json!({"value": "transformed"})));
}

#[tokio::test]
async fn original_context_is_not_mutated() {
    let seen = Arc::new(Mutex::new(None));
    let mut agent = agent_with(
        tool_then_done("testTool", json!({"value": "original"})),
        vec![input_recording_tool(&seen)],
    );
    let original = Arc::new(Mutex::new(None));
    let slot = original.clone();
    agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
        let mut modified = context.clone();
        modified.tool_use.input = json!({"value": "modified"});
        let stream = next.call(modified);
        *slot.lock().unwrap() = Some(context.tool_use.input);
        stream
    }));
    agent.invoke("Use the tool").await.unwrap();
    assert_eq!(*original.lock().unwrap(), Some(json!({"value": "original"})));
    let tool_use_input = agent.messages()[1].content.iter().find_map(|block| match block {
        ContentBlock::ToolUse(tool_use) => Some(tool_use.input.clone()),
        _ => None,
    });
    assert_eq!(tool_use_input, Some(json!({"value": "original"})));
}

#[tokio::test]
async fn before_tool_call_event_fires_before_middleware_after_tool_call_event_fires_after() {
    let mut agent = agent_with(
        tool_then_done("testTool", json!({})),
        vec![MockTool::text("testTool", "executed")],
    );
    let log = Log::default();
    let before = log.clone();
    agent.add_hook(move |_: &mut BeforeToolCallEvent| push(&before, "hook:beforeToolCall"));
    let after = log.clone();
    agent.add_hook(move |_: &mut AfterToolCallEvent| push(&after, "hook:afterToolCall"));
    let wrap_log = log.clone();
    agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
        push(&wrap_log, "middleware:before");
        let log = wrap_log.clone();
        next.call(context).map_result(move |result| async move {
            push(&log, "middleware:after");
            result
        })
    }));
    agent.invoke("Use the tool").await.unwrap();
    assert_eq!(
        entries(&log),
        [
            "hook:beforeToolCall",
            "middleware:before",
            "middleware:after",
            "hook:afterToolCall"
        ]
    );
}

#[tokio::test]
async fn hooks_fire_even_when_middleware_short_circuits() {
    let mut agent = agent_with(
        tool_then_done("testTool", json!({})),
        vec![MockTool::text("testTool", "real")],
    );
    let log = Log::default();
    let before = log.clone();
    agent.add_hook(move |_: &mut BeforeToolCallEvent| push(&before, "before"));
    let after = log.clone();
    agent.add_hook(move |_: &mut AfterToolCallEvent| push(&after, "after"));
    agent.add_middleware(ExecuteToolStage::wrap(|context, _| {
        mocked(&context.tool_use.tool_use_id, "mocked")
    }));
    agent.invoke("Use the tool").await.unwrap();
    assert_eq!(entries(&log), ["before", "after"]);
}

#[tokio::test]
async fn after_tool_call_event_receives_the_middleware_result_when_short_circuited() {
    let mut agent = agent_with(
        tool_then_done("testTool", json!({})),
        vec![MockTool::text("testTool", "real")],
    );
    let seen = Arc::new(Mutex::new(None));
    let slot = seen.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        *slot.lock().unwrap() = Some(event.result().content.clone());
    });
    agent.add_middleware(ExecuteToolStage::wrap(|context, _| {
        mocked(&context.tool_use.tool_use_id, "from middleware")
    }));
    agent.invoke("Use the tool").await.unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        Some(vec![ToolResultContent::text("from middleware")])
    );
}

#[tokio::test]
async fn tool_middleware_errors_become_an_error_result_for_that_tool() {
    let mut agent = agent_with(
        tool_then_done("testTool", json!({})),
        vec![MockTool::text("testTool", "real")],
    );
    agent.add_middleware(ExecuteToolStage::wrap(|_, _| {
        StageStream::from_result(Err(strands::Error::other("middleware exploded").into()))
    }));
    agent.invoke("Use the tool").await.unwrap();
    let ContentBlock::ToolResult(result) = &agent.messages()[2].content[0] else {
        panic!("expected the tool result");
    };
    assert_eq!(result.content, [ToolResultContent::text("middleware exploded")]);
}

// --- Use cases ----------------------------------------------------------------------------------

struct ToolResultCache {
    cache: Arc<Mutex<std::collections::HashMap<String, ToolResultBlock>>>,
}

#[async_trait]
impl Plugin for ToolResultCache {
    fn name(&self) -> &str {
        "tool-result-cache"
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> strands::Result<()> {
        let cache = self.cache.clone();
        agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
            let key = format!("{}:{}", context.tool_use.name, context.tool_use.input);
            let hit = cache.lock().unwrap().get(&key).cloned();
            if let Some(cached) = hit {
                let result = ToolResultBlock::new(context.tool_use.tool_use_id, cached.status, cached.content);
                return StageStream::from_result(Ok(ExecuteToolResult::new(result)));
            }
            let cache = cache.clone();
            next.call(context).map_result(move |result| async move {
                if let Ok(result) = &result {
                    cache.lock().unwrap().insert(key, result.result.clone());
                }
                result
            })
        }));
        Ok(())
    }
}

#[tokio::test]
async fn returns_cached_result_on_second_call_skipping_real_execution() {
    let model = MockModel::from_turns([
        common::tool_use_turn("expensiveApi", "call-1", json!({"query": "weather"})),
        MockTurn::text("First done"),
        common::tool_use_turn("expensiveApi", "call-2", json!({"query": "weather"})),
        MockTurn::text("Second done"),
    ]);
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let tool = MockTool::new("expensiveApi", move |context| {
        counter.fetch_add(1, Ordering::Relaxed);
        ToolResultBlock::success(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text("sunny")],
        )
        .into()
    });
    let mut agent = Agent::builder()
        .model(model)
        .tools([tool])
        .plugins(vec![
            Arc::new(ToolResultCache { cache: Arc::default() }) as Arc<dyn Plugin>
        ])
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("What is the weather?").await.unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    agent.invoke("What is the weather?").await.unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn retries_on_transient_error_and_succeeds_on_second_attempt() {
    let model = MockModel::from_turns([
        MockTurn::throttled("ThrottlingException: rate limit exceeded"),
        MockTurn::text("Success after retry"),
    ]);
    let mut agent = Agent::builder()
        .model(model.clone())
        .retry_strategy(vec![])
        .printer(false)
        .build()
        .unwrap();
    agent.add_middleware(InvokeModelStage::wrap(|context, next| {
        StageStream::new(async_stream::stream! {
            for attempt in 0..3 {
                let mut inner = next.call(context.clone());
                while let Some(item) = inner.next().await {
                    match item {
                        StageItem::Done(Err(MiddlewareError::Error(error)))
                            if error.to_string().contains("ThrottlingException") && attempt < 2 => break,
                        StageItem::Done(outcome) => {
                            yield StageItem::Done(outcome);
                            return;
                        }
                        event => yield event,
                    }
                }
            }
        })
    }));
    let result = agent.invoke("Hello").await.unwrap();
    assert_eq!(model.call_count(), 2);
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(
        result.last_message().content,
        [ContentBlock::text("Success after retry")]
    );
    let _ = ModelThrottledError::NAME;
}

// --- Phases -------------------------------------------------------------------------------------

#[tokio::test]
async fn transforms_context_before_the_model_call() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    agent.add_middleware(InvokeModelStage::input(|mut context| async move {
        context.messages.push(Message::user("injected"));
        Ok(context)
    }));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let slot = seen.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        slot.lock().unwrap().clone_from(&context.messages);
        next.call(context)
    }));
    agent.invoke("Original").await.unwrap();
    let messages = seen.lock().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].content[0], ContentBlock::text("injected"));
}

fn logging_input(log: &Log, name: &'static str) -> strands::middleware::Middleware<InvokeModelStage> {
    let log = log.clone();
    InvokeModelStage::input(move |context| {
        push(&log, name);
        async move { Ok(context) }
    })
}

fn logging_output(log: &Log, name: &'static str) -> strands::middleware::Middleware<InvokeModelStage> {
    let log = log.clone();
    InvokeModelStage::output(move |result| {
        push(&log, name);
        async move { Ok(result) }
    })
}

fn logging_pass(log: &Log, name: &'static str) -> strands::middleware::Middleware<InvokeModelStage> {
    let log = log.clone();
    InvokeModelStage::wrap(move |context, next| {
        push(&log, name);
        next.call(context)
    })
}

#[tokio::test]
async fn runs_before_wrap_handlers_regardless_of_registration_order() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = Log::default();
    agent.add_middleware(logging_pass(&log, "wrap"));
    agent.add_middleware(logging_input(&log, "input"));
    agent.invoke("Test").await.unwrap();
    assert_eq!(entries(&log), ["input", "wrap"]);
}

#[tokio::test]
async fn multiple_input_handlers_compose_in_registration_order() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = Log::default();
    agent.add_middleware(logging_input(&log, "input-1"));
    agent.add_middleware(logging_input(&log, "input-2"));
    agent.invoke("Test").await.unwrap();
    assert_eq!(entries(&log), ["input-1", "input-2"]);
}

#[tokio::test]
async fn transforms_result_after_the_model_call() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let stop = Arc::new(Mutex::new(None));
    let slot = stop.clone();
    agent.add_middleware(InvokeModelStage::output(move |result| {
        *slot.lock().unwrap() = Some(result.result.stop_reason.clone());
        async move { Ok(result) }
    }));
    agent.invoke("Test").await.unwrap();
    assert_eq!(*stop.lock().unwrap(), Some(StopReason::EndTurn));
}

#[tokio::test]
async fn transformed_result_message_is_appended_to_agent_messages() {
    let mut agent = test_agent(MockModel::new().with_turn("Original"));
    agent.add_middleware(InvokeModelStage::output(|mut result| async move {
        result.result.message = Message::new(Role::Assistant, vec![ContentBlock::text("Rewritten by middleware")]);
        Ok(result)
    }));
    agent.invoke("Test").await.unwrap();
    assert_eq!(
        agent.messages().last().unwrap().content,
        [ContentBlock::text("Rewritten by middleware")]
    );
}

#[tokio::test]
async fn runs_after_wrap_handlers_wraps_them() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = Log::default();
    agent.add_middleware(logging_output(&log, "output"));
    agent.add_middleware(logging_wrap(&log, "wrap"));
    agent.invoke("Test").await.unwrap();
    assert_eq!(entries(&log), ["wrap-before", "wrap-after", "output"]);
}

#[tokio::test]
async fn changing_stop_reason_from_tool_use_to_end_turn_prevents_tool_dispatch() {
    let ran = Arc::new(AtomicBool::new(false));
    let flag = ran.clone();
    let tool = MockTool::new("shouldNotRun", move |context| {
        flag.store(true, Ordering::Relaxed);
        ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into()
    });
    let mut agent = agent_with(tool_then_done("shouldNotRun", json!({})), vec![tool]);
    agent.add_middleware(InvokeModelStage::output(|mut result| async move {
        result.result.stop_reason = StopReason::EndTurn;
        Ok(result)
    }));
    let result = agent.invoke("Use the tool").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert!(!ran.load(Ordering::Relaxed));
}

#[tokio::test]
async fn bare_invoke_model_stage_registers_as_wrap_phase_and_executes_between_input_and_output() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = Log::default();
    agent.add_middleware(logging_input(&log, "input"));
    agent.add_middleware(logging_pass(&log, "wrap"));
    agent.add_middleware(logging_output(&log, "output"));
    agent.invoke("Test prompt").await.unwrap();
    assert_eq!(entries(&log), ["input", "wrap", "output"]);
}

#[tokio::test]
async fn input_wrap_output_execution_order() {
    let mut agent = test_agent(MockModel::new().with_turn("Hello"));
    let log = Log::default();
    agent.add_middleware(logging_output(&log, "output"));
    agent.add_middleware(logging_pass(&log, "wrap"));
    agent.add_middleware(logging_input(&log, "input"));
    agent.invoke("Test").await.unwrap();
    assert_eq!(entries(&log), ["input", "wrap", "output"]);
}

#[tokio::test]
async fn input_transforms_tool_context_before_execution() {
    let seen = Arc::new(Mutex::new(None));
    let mut agent = agent_with(
        tool_then_done("testTool", json!({"x": 1})),
        vec![input_recording_tool(&seen)],
    );
    agent.add_middleware(ExecuteToolStage::input(|mut context| async move {
        context.tool_use.input = json!({"x": 2});
        Ok(context)
    }));
    agent.invoke("Test").await.unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(json!({"x": 2})));
}

#[tokio::test]
async fn cleanup_removes_input_handler() {
    let mut agent = test_agent(MockModel::from_turns(["First", "Second"]));
    let log = Log::default();
    let cleanup = agent.add_middleware(logging_input(&log, "input"));
    agent.invoke("First").await.unwrap();
    cleanup.remove();
    agent.invoke("Second").await.unwrap();
    assert_eq!(entries(&log), ["input"]);
}

#[tokio::test]
async fn cleanup_removes_output_handler() {
    let mut agent = test_agent(MockModel::from_turns(["First", "Second"]));
    let log = Log::default();
    let cleanup = agent.add_middleware(logging_output(&log, "output"));
    agent.invoke("First").await.unwrap();
    cleanup.remove();
    agent.invoke("Second").await.unwrap();
    assert_eq!(entries(&log), ["output"]);
}

// --- Copy on input ------------------------------------------------------------------------------

#[tokio::test]
async fn mutating_the_context_messages_array_does_not_affect_agent_messages() {
    let mut agent = test_agent(MockModel::new().with_turn("Hi"));
    agent.add_middleware(InvokeModelStage::wrap(|mut context, next| {
        context.messages.clear();
        context.messages.push(Message::user("replaced"));
        next.call(context)
    }));
    agent.invoke("Hello").await.unwrap();
    assert_eq!(agent.messages()[0].text(), "Hello");
}

#[tokio::test]
async fn tool_choice_is_undefined_when_not_explicitly_configured() {
    let mut agent = test_agent(MockModel::new().with_turn("Hi"));
    let seen = Arc::new(Mutex::new(Some(strands::ToolChoice::Auto)));
    let slot = seen.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        slot.lock().unwrap().clone_from(&context.tool_choice);
        next.call(context)
    }));
    agent.invoke("Hello").await.unwrap();
    assert!(seen.lock().unwrap().is_none());
}

/// A model that writes to the model state it is given, then streams the mock's turn.
struct StateWritingModel {
    inner: MockModel,
    write: fn(&strands::StateStore),
    seen: Arc<Mutex<Option<Value>>>,
}

impl Model for StateWritingModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, strands::Result<ModelStreamEvent>> {
        *self.seen.lock().unwrap() = Some(Value::Object(request.model_state.get_all()));
        (self.write)(&request.model_state);
        self.inner.stream(request)
    }

    fn get_config(&self) -> BaseModelConfig {
        self.inner.get_config()
    }

    fn update_config(&self, config: BaseModelConfig) -> strands::Result<()> {
        self.inner.update_config(config)
    }
}

fn state_agent(write: fn(&strands::StateStore), model_state: &Value) -> (Agent, Arc<Mutex<Option<Value>>>) {
    let seen = Arc::new(Mutex::new(None));
    let model = StateWritingModel {
        inner: MockModel::new().with_turn("Hi"),
        write,
        seen: seen.clone(),
    };
    let agent = Agent::builder()
        .model(model)
        .model_state(model_state.as_object().unwrap().clone())
        .printer(false)
        .build()
        .unwrap();
    (agent, seen)
}

#[tokio::test]
async fn model_state_changes_are_written_back_to_agent_model_state_after_streaming() {
    let (mut agent, _) = state_agent(|state| state.set("responseId", "resp_123").unwrap(), &json!({}));
    agent.invoke("Hello").await.unwrap();
    assert_eq!(
        Value::Object(agent.model_state().get_all()),
        json!({"responseId": "resp_123"})
    );
}

#[tokio::test]
async fn model_state_deletions_are_synced_back_to_agent_model_state() {
    let (mut agent, _) = state_agent(
        |state| {
            state.delete("oldKey");
            state.set("newKey", "fresh").unwrap();
        },
        &json!({"oldKey": "stale"}),
    );
    agent.invoke("Hello").await.unwrap();
    assert_eq!(agent.model_state().get_value("oldKey"), None);
    assert_eq!(agent.model_state().get_value("newKey"), Some(json!("fresh")));
}

#[tokio::test]
async fn middleware_mutations_to_agent_model_state_before_next_do_not_affect_the_model_call() {
    let (mut agent, seen) = state_agent(|_| {}, &json!({"key": "snapshotted"}));
    agent.add_middleware(InvokeModelStage::wrap(|context, next| {
        context.agent.model_state().set("key", "mutated-before-next").unwrap();
        context.agent.model_state().set("extra", "injected").unwrap();
        next.call(context)
    }));
    agent.invoke("Hello").await.unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(json!({"key": "snapshotted"})));
}

#[tokio::test]
async fn middleware_mutations_to_agent_model_state_after_next_do_not_persist() {
    let (mut agent, _) = state_agent(
        |state| state.set("fromModel", "model-wrote-this").unwrap(),
        &json!({"key": "original"}),
    );
    agent.add_middleware(InvokeModelStage::wrap(|context, next| {
        let state = context.agent.model_state().clone();
        next.call(context).map_result(move |result| async move {
            state.set("sneaky", "should-be-gone").unwrap();
            state.set("fromModel", "overwritten").unwrap();
            result
        })
    }));
    agent.invoke("Hello").await.unwrap();
    assert_eq!(
        agent.model_state().get_value("fromModel"),
        Some(json!("model-wrote-this"))
    );
    assert_eq!(agent.model_state().get_value("sneaky"), None);
    assert_eq!(agent.model_state().get_value("key"), Some(json!("original")));
}

#[tokio::test]
async fn invocation_state_is_shared_by_reference_mutations_are_visible_on_the_result() {
    #[derive(Clone)]
    struct Marker(&'static str);
    let mut agent = test_agent(MockModel::new().with_turn("Hi"));
    agent.add_middleware(InvokeModelStage::wrap(|context, next| {
        context.invocation_state.insert(Marker("from-middleware"));
        next.call(context)
    }));
    let result = agent.invoke("Hello").await.unwrap();
    assert_eq!(result.invocation_state().get::<Marker>().unwrap().0, "from-middleware");
}

#[tokio::test]
async fn execute_tool_stage_invocation_state_is_shared_by_reference() {
    #[derive(Clone)]
    struct Original;
    #[derive(Clone)]
    struct MiddlewareTouched;
    let mut agent = agent_with(
        tool_then_done("testTool", json!({})),
        vec![MockTool::text("testTool", "ok")],
    );
    agent.add_middleware(ExecuteToolStage::wrap(|context, next| {
        context.invocation_state.insert(MiddlewareTouched);
        next.call(context)
    }));
    let invocation_state = strands::InvocationState::new();
    invocation_state.insert(Original);
    let options = strands::InvokeOptions {
        invocation_state: Some(invocation_state),
        ..Default::default()
    };
    let result = agent.invoke_with("Call the tool", options).await.unwrap();
    assert!(result.invocation_state().get::<Original>().is_some());
    assert!(result.invocation_state().get::<MiddlewareTouched>().is_some());
}

#[tokio::test]
async fn tool_specs_are_deep_copied_across_invocations() {
    let model = MockModel::from_turns(["First", "Second"]);
    let mut agent = agent_with(model.clone(), vec![MockTool::text("testTool", "ok")]);
    let cleanup = agent.add_middleware(InvokeModelStage::wrap(|mut context, next| {
        if let Some(spec) = context.tool_specs.first_mut() {
            spec.description = "mutated".into();
        }
        next.call(context)
    }));
    agent.invoke("First").await.unwrap();
    cleanup.remove();
    agent.invoke("Second").await.unwrap();
    let specs: Vec<ToolSpec> = model
        .requests()
        .into_iter()
        .map(|request| request.tool_specs[0].clone())
        .collect();
    assert_eq!(specs[0].description, "mutated");
    assert_eq!(specs[1].description, "Mock tool");
}

// --- Interrupts ---------------------------------------------------------------------------------

fn gated_agent(name: &str, tool_use_id: &str, ran: &Arc<AtomicUsize>) -> Agent {
    let counter = ran.clone();
    let tool = MockTool::new(name, move |context| {
        counter.fetch_add(1, Ordering::Relaxed);
        ToolResultBlock::success(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text("executed")],
        )
        .into()
    });
    let model = MockModel::from_turns([tool_use_turn(name, tool_use_id, json!({})), MockTurn::text("Done")]);
    agent_with(model, vec![tool])
}

fn approval_gate(interrupt: &'static str, approved: &'static str) -> strands::middleware::Middleware<ExecuteToolStage> {
    ExecuteToolStage::wrap(move |context, next| {
        let approval = match context.interrupt(strands::types::InterruptParams::new(interrupt).with_reason("Confirm?"))
        {
            Ok(approval) => approval,
            Err(interrupt) => return StageStream::from_result(Err(interrupt.into())),
        };
        if approval.response != json!(approved) {
            let denied = ToolResultBlock::error(context.tool_use.tool_use_id, vec![ToolResultContent::text("Denied")]);
            return StageStream::from_result(Ok(ExecuteToolResult::new(denied)));
        }
        next.call(context)
    })
}

#[tokio::test]
async fn middleware_can_raise_an_interrupt_agent_stops_with_stop_reason_interrupt() {
    let ran = Arc::new(AtomicUsize::new(0));
    let mut agent = gated_agent("dangerousTool", "tool-1", &ran);
    agent.add_middleware(approval_gate("approve_tool", "yes"));
    let result = agent.invoke("Do the dangerous thing").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(
        serde_json::to_value(result.interrupts()).unwrap(),
        json!([{
            "id": "middleware:executeTool:tool-1:approve_tool",
            "name": "approve_tool",
            "reason": "Confirm?",
            "source": "middleware"
        }])
    );
    assert_eq!(ran.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn middleware_gets_response_on_resume_and_continues_execution() {
    let ran = Arc::new(AtomicUsize::new(0));
    let mut agent = gated_agent("dangerousTool", "tool-1", &ran);
    agent.add_middleware(approval_gate("approve_tool", "yes"));
    let interrupted = agent.invoke("Do it").await.unwrap();
    assert_eq!(ran.load(Ordering::Relaxed), 0);
    let response = InterruptResponse::new(interrupted.interrupts()[0].id.clone(), "yes");
    let result = agent.invoke(vec![response]).await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(ran.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn uses_interrupt_state_restored_after_executor_construction() {
    let ran = Arc::new(AtomicUsize::new(0));
    let mut agent = gated_agent("dangerousTool", "tool-1", &ran);
    agent.add_middleware(approval_gate("approve_tool", "yes"));
    let snapshot = agent
        .take_snapshot(strands::TakeSnapshotOptions {
            include: vec![strands::SnapshotField::Interrupts],
            ..Default::default()
        })
        .unwrap();
    agent.load_snapshot(&snapshot).unwrap();
    let interrupted = agent.invoke("Do it").await.unwrap();
    let response = InterruptResponse::new(interrupted.interrupts()[0].id.clone(), "yes");
    let result = agent.invoke(vec![response]).await.unwrap();
    assert_eq!(
        (
            interrupted.stop_reason(),
            result.stop_reason(),
            ran.load(Ordering::Relaxed)
        ),
        (StopReason::Interrupt, StopReason::EndTurn, 1)
    );
}

#[tokio::test]
async fn interrupt_id_includes_tool_use_id_for_disambiguation() {
    let ran = Arc::new(AtomicUsize::new(0));
    let mut agent = gated_agent("myTool", "unique-tool-id", &ran);
    agent.add_middleware(approval_gate("check", "yes"));
    let result = agent.invoke("Test").await.unwrap();
    assert!(result.interrupts()[0].id.contains("unique-tool-id"));
    assert!(result.interrupts()[0].id.contains("check"));
}

#[tokio::test]
async fn preemptive_response_skips_the_interrupt_no_halt() {
    let ran = Arc::new(AtomicUsize::new(0));
    let mut agent = gated_agent("myTool", "tool-1", &ran);
    agent.add_middleware(ExecuteToolStage::wrap(|context, next| {
        let approval = context
            .interrupt(strands::types::InterruptParams::new("check").with_response("pre-approved"))
            .unwrap();
        assert_eq!(approval.response, json!("pre-approved"));
        next.call(context)
    }));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(ran.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn yields_interrupt_event_on_the_stream_for_execute_tool_stage_interrupts() {
    let ran = Arc::new(AtomicUsize::new(0));
    let mut agent = gated_agent("myTool", "tool-1", &ran);
    agent.add_middleware(approval_gate("tool_gate", "yes"));
    let events = collect(agent.stream("Test")).await;
    let interrupts: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            AgentStreamEvent::Interrupt(data) => Some(data.interrupt.name.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(interrupts, ["tool_gate"]);
}

#[tokio::test]
async fn context_spread_preserves_interrupt_function() {
    let ran = Arc::new(AtomicUsize::new(0));
    let mut agent = gated_agent("myTool", "tool-1", &ran);
    agent.add_middleware(ExecuteToolStage::wrap(|context, next| {
        let mut modified = context;
        modified.tool_use.input = json!({"x": 2});
        if let Err(interrupt) = modified.interrupt("after_spread") {
            return StageStream::from_result(Err(interrupt.into()));
        }
        next.call(modified)
    }));
    let result = agent.invoke("Test").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(result.interrupts()[0].name, "after_spread");
}

#[tokio::test]
async fn after_invocation_event_hook_can_resume_a_tool_level_interrupt_in_middleware() {
    let ran = Arc::new(AtomicUsize::new(0));
    let mut agent = gated_agent("myTool", "tool-1", &ran);
    agent.add_middleware(approval_gate("gate", "approved"));
    let resumed = Arc::new(AtomicBool::new(false));
    agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
        if !resumed.swap(true, Ordering::Relaxed) {
            event.set_resume(vec![InterruptResponse::new(
                "middleware:executeTool:tool-1:gate",
                "approved",
            )]);
        }
    });
    let result = agent.invoke("Do it").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(ran.load(Ordering::Relaxed), 1);
}
