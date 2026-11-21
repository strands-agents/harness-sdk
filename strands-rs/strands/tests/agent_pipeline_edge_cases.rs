//! Model and tool pipeline edge cases: model state across middleware retries and
//! short circuits, middleware interrupts and errors, panicking background tools, metrics for an
//! early-dropped tool stream, conversation manager limits and snapshot loading.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockTool, tool_use_turn, tool_uses_turn};
use futures::StreamExt;
use serde_json::{Value, json};
use strands::hooks::{AfterModelCallEvent, AfterToolCallEvent};
use strands::middleware::{
    ExecuteToolStage, InvokeModelResult, InvokeModelStage, MiddlewareError, StageItem, StageStream,
};
use strands::models::{BaseModelConfig, BoxStream, ModelRequest};
use strands::testing::{MockModel, MockTurn};
use strands::tools::{FunctionTool, ToolExecutorStrategy, ToolStream, ToolStreamEvent, ToolStreamItem};
use strands::types::{ToolResultContent, ToolResultStatus, ToolSpec};
use strands::{
    Agent, BackgroundTasksConfig, ContentBlock, ConversationManager, ConversationManagerReduceOptions, Error,
    Interrupt, Message, Model, ModelStreamEvent, NullConversationManager, Role, StopReason, StreamAggregatedResult,
    Tool, ToolContext, ToolOutcome, ToolResultBlock,
};

/// Counts its calls in the model state it is given, then streams the next scripted turn.
struct CountingStateModel {
    inner: MockModel,
    seen: Arc<Mutex<Vec<u64>>>,
}

impl Model for CountingStateModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, strands::Result<ModelStreamEvent>> {
        let count = request.model_state.get::<u64>("count").unwrap().unwrap_or(0);
        self.seen.lock().unwrap().push(count);
        request.model_state.set("count", count + 1).unwrap();
        self.inner.stream(request)
    }

    fn get_config(&self) -> BaseModelConfig {
        self.inner.get_config()
    }

    fn update_config(&self, config: BaseModelConfig) -> strands::Result<()> {
        self.inner.update_config(config)
    }
}

fn agent(model: MockModel, tools: Vec<MockTool>, executor: ToolExecutorStrategy) -> Agent {
    Agent::builder()
        .model(model)
        .tools(tools)
        .tool_executor(executor)
        .printer(false)
        .build()
        .unwrap()
}

fn echo_id(name: &str) -> MockTool {
    MockTool::new(name, |context| {
        let id = context.tool_use().tool_use_id.clone();
        ToolResultBlock::success(id.clone(), vec![ToolResultContent::text(format!("completed:{id}"))]).into()
    })
}

fn failing_tool_middleware() -> strands::middleware::Middleware<ExecuteToolStage> {
    ExecuteToolStage::wrap(|context, next| {
        if context.tool_use.tool_use_id == "failed-tool" {
            return StageStream::from_result(Err(Error::other("middleware failed").into()));
        }
        next.call(context)
    })
}

fn tool_result_texts(message: &Message) -> Vec<(String, ToolResultStatus, String)> {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolResult(result) => Some((
                result.tool_use_id.clone(),
                result.status,
                result
                    .content
                    .iter()
                    .filter_map(|content| match content {
                        ToolResultContent::Text(text) => Some(text.text.clone()),
                        _ => None,
                    })
                    .collect(),
            )),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn retried_terminal_calls_each_start_from_the_pre_chain_model_state() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let model = CountingStateModel {
        inner: MockModel::new().with_turn("first").with_turn("second"),
        seen: seen.clone(),
    };
    let mut agent = Agent::builder().model(model).printer(false).build().unwrap();
    agent.add_middleware(InvokeModelStage::wrap(|context, next| {
        let retry_context = context.clone();
        StageStream::new(async_stream::stream! {
            let _ = next.call(context).result().await;
            let mut second = next.call(retry_context);
            while let Some(item) = second.next().await {
                yield item;
            }
        })
    }));

    agent.invoke("Hi").await.unwrap();

    assert_eq!(*seen.lock().unwrap(), vec![0, 0]);
    assert_eq!(agent.model_state().get::<u64>("count").unwrap(), Some(1));
}

#[tokio::test]
async fn a_short_circuited_model_call_commits_no_model_state() {
    let mut agent = Agent::builder().model(MockModel::new()).printer(false).build().unwrap();
    agent.model_state().set("kept", 1).unwrap();
    agent.add_middleware(InvokeModelStage::wrap(|context, _next| {
        context.agent.model_state().set("written", true).unwrap();
        let message = Message::new(Role::Assistant, vec![ContentBlock::text("cached")]);
        StageStream::from_result(Ok(InvokeModelResult::new(StreamAggregatedResult::new(
            message,
            StopReason::EndTurn,
        ))))
    }));

    agent.invoke("Hi").await.unwrap();

    assert_eq!(
        agent.model_state().get_all(),
        json!({"kept": 1, "written": true}).as_object().unwrap().clone()
    );
}

#[tokio::test]
async fn after_model_call_fires_for_a_model_middleware_interrupt() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .printer(false)
        .build()
        .unwrap();
    agent.add_middleware(InvokeModelStage::wrap(|_context, _next| {
        StageStream::from_result(Err(Interrupt::new("mw:approve", "approve").into()))
    }));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let seen = errors.clone();
    agent.add_hook(move |event: &mut AfterModelCallEvent<'_>| {
        seen.lock().unwrap().push(event.error().map(ToString::to_string));
    });

    let result = agent.invoke("Hi").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(
        *errors.lock().unwrap(),
        vec![Some("Interrupt raised: approve".to_owned())]
    );
}

#[tokio::test]
async fn after_model_call_can_retry_a_model_middleware_interrupt() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .printer(false)
        .build()
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
        if counter.fetch_add(1, Ordering::SeqCst) == 0 {
            return StageStream::from_result(Err(Interrupt::new("mw:approve", "approve").into()));
        }
        next.call(context)
    }));
    agent.add_hook(|event: &mut AfterModelCallEvent<'_>| {
        if matches!(event.error(), Some(Error::Interrupt(_))) {
            event.set_retry(true);
        }
    });

    let result = agent.invoke("Hi").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(result.to_string(), "hi");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_tool_stage_middleware_error_is_that_tools_error_result_without_after_tool_call() {
    let model = MockModel::from_turns([
        tool_uses_turn(&[("tool", "failed-tool"), ("tool", "successful-tool")]),
        MockTurn::text("Done"),
    ]);
    let mut agent = agent(model, vec![echo_id("tool")], ToolExecutorStrategy::Concurrent);
    agent.add_middleware(failing_tool_middleware());
    let after_ids = Arc::new(Mutex::new(Vec::<String>::new()));
    let ids = after_ids.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        ids.lock().unwrap().push(event.tool_use().tool_use_id.clone());
    });

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.to_string(), "Done");
    assert_eq!(*after_ids.lock().unwrap(), vec!["successful-tool".to_owned()]);
    assert_eq!(
        tool_result_texts(&agent.messages()[2]),
        vec![
            (
                "failed-tool".to_owned(),
                ToolResultStatus::Error,
                "middleware failed".to_owned()
            ),
            (
                "successful-tool".to_owned(),
                ToolResultStatus::Success,
                "completed:successful-tool".to_owned()
            ),
        ]
    );
}

#[tokio::test]
async fn a_tool_stage_middleware_error_fails_a_sequential_invocation() {
    let model = MockModel::from_turns([
        tool_uses_turn(&[("tool", "failed-tool"), ("tool", "successful-tool")]),
        MockTurn::text("Done"),
    ]);
    let mut agent = agent(model, vec![echo_id("tool")], ToolExecutorStrategy::Sequential);
    agent.add_middleware(failing_tool_middleware());
    let after_calls = Arc::new(AtomicUsize::new(0));
    let counter = after_calls.clone();
    agent.add_hook(move |_: &mut AfterToolCallEvent| {
        counter.fetch_add(1, Ordering::SeqCst);
    });

    let error = agent.invoke("Go").await.unwrap_err();

    assert_eq!(error.to_string(), "middleware failed");
    assert_eq!(after_calls.load(Ordering::SeqCst), 0);
}

fn background_agent(tool: FunctionTool) -> Agent {
    let model = MockModel::from_turns([tool_use_turn("work", "w1", json!({})), MockTurn::text("admitted")]);
    Agent::builder()
        .model(model)
        .tools([tool])
        .background_tasks(BackgroundTasksConfig {
            always: Some(vec!["work".into()]),
            ..Default::default()
        })
        .printer(false)
        .build()
        .unwrap()
}

fn work_tool(panics: bool) -> FunctionTool {
    FunctionTool::builder("work", "Work")
        .input_schema(json!({"type": "object", "properties": {}}))
        .callback(move |_, _| async move {
            assert!(!panics, "boom");
            Ok(json!("done"))
        })
}

/// The task record the agent delivered to the model as a tool result.
fn delivered_task(agent: &Agent) -> Value {
    let delivery = &agent.messages()[4];
    let Some(ContentBlock::ToolResult(result)) = delivery.content.first() else {
        panic!("expected the delivered task result, got {delivery:?}");
    };
    let Some(ToolResultContent::Json(json)) = result.content.first() else {
        panic!("expected the task record, got {result:?}");
    };
    assert_eq!(json.json["status"], "failed");
    json.json.clone()
}

#[tokio::test(start_paused = true)]
async fn a_panicking_background_tool_fails_its_task_and_the_invocation_finishes() {
    let mut agent = background_agent(work_tool(true));

    let result = tokio::time::timeout(Duration::from_secs(60), agent.invoke("Go"))
        .await
        .expect("the invocation finishes")
        .unwrap();

    assert_eq!(result.to_string(), "admitted");
    assert_eq!(
        delivered_task(&agent)["error"],
        json!({"type": "toolError", "message": "boom"})
    );
}

#[tokio::test(start_paused = true)]
async fn a_panicking_background_middleware_fails_its_task_and_the_invocation_finishes() {
    let mut agent = background_agent(work_tool(false));
    agent.add_middleware(ExecuteToolStage::wrap(|_context, _next| {
        StageStream::new(futures::stream::once(async { panic!("middleware boom") }))
    }));

    let result = tokio::time::timeout(Duration::from_secs(60), agent.invoke("Go"))
        .await
        .expect("the invocation finishes")
        .unwrap();

    assert_eq!(result.to_string(), "admitted");
    assert_eq!(
        delivered_task(&agent)["error"],
        json!({"type": "executionError", "message": "middleware boom"})
    );
}

/// Streams one event, then succeeds.
struct ChattyTool;

impl Tool for ChattyTool {
    fn name(&self) -> &str {
        "chatty"
    }

    fn description(&self) -> &str {
        "Streams progress"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new("chatty", "Streams progress").with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let id = context.tool_use().tool_use_id.clone();
        ToolStream::new(futures::stream::iter([
            ToolStreamItem::Event(ToolStreamEvent::new(json!("progress"))),
            ToolStreamItem::Outcome(ToolOutcome::Result(ToolResultBlock::success(
                id,
                vec![ToolResultContent::text("ok")],
            ))),
        ]))
    }
}

#[tokio::test]
async fn a_tool_stream_a_wrap_handler_drops_early_still_records_the_tool_metric() {
    let model = MockModel::from_turns([tool_use_turn("chatty", "c1", json!({})), MockTurn::text("Done")]);
    let mut agent = Agent::builder()
        .model(model)
        .tools([ChattyTool])
        .printer(false)
        .build()
        .unwrap();
    agent.add_middleware(ExecuteToolStage::wrap(|context, next| {
        let id = context.tool_use.tool_use_id.clone();
        StageStream::new(async_stream::stream! {
            let mut inner = next.call(context);
            if let Some(StageItem::Event(event)) = inner.next().await {
                yield StageItem::Event(event);
            }
            drop(inner);
            let result = ToolResultBlock::success(id, vec![ToolResultContent::text("cut short")]);
            yield StageItem::Done(Ok(strands::middleware::ExecuteToolResult::new(result)));
        })
    }));

    agent.invoke("Go").await.unwrap();

    let metrics = agent.metrics();
    let tool = metrics.tool("chatty").expect("the call is recorded");
    assert_eq!((tool.call_count, tool.success_count, tool.error_count), (1, 0, 1));
}

// --- API ----------------------------------------------------------------------------------------

#[test]
fn middleware_interrupts_read_like_the_ts_interrupt_error() {
    let error = MiddlewareError::from(Interrupt::new("middleware:executeTool:t-1:approve", "approve"));
    assert_eq!(error.to_string(), "Interrupt raised: approve");
    let boxed: strands::BoxError = Box::new(strands::InterruptError::from(Interrupt::new("id", "confirm")));
    assert!(matches!(
        MiddlewareError::from_boxed(boxed),
        MiddlewareError::Interrupt(_)
    ));
}

#[tokio::test]
async fn from_stream_future_keeps_the_events_of_next() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .printer(false)
        .build()
        .unwrap();
    agent.add_middleware(InvokeModelStage::wrap(|context, next| {
        StageStream::from_stream_future(async move {
            tokio::task::yield_now().await;
            next.call(context)
        })
    }));
    let blocks = Arc::new(AtomicUsize::new(0));
    let counter = blocks.clone();
    agent.add_hook(move |_: &mut strands::ContentBlockEvent<'_>| {
        counter.fetch_add(1, Ordering::SeqCst);
    });

    assert_eq!(agent.invoke("Hi").await.unwrap().to_string(), "Hello");
    assert_eq!(blocks.load(Ordering::SeqCst), 1);
}

struct ThresholdManager(f64);

#[strands::async_trait]
impl ConversationManager for ThresholdManager {
    fn name(&self) -> &str {
        "test:threshold"
    }

    async fn reduce(&self, _: ConversationManagerReduceOptions<'_>) -> strands::Result<bool> {
        Ok(false)
    }

    fn compression_threshold(&self) -> Option<f64> {
        Some(self.0)
    }
}

#[tokio::test]
async fn a_custom_manager_threshold_outside_zero_to_one_fails_initialization() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .conversation_manager(ThresholdManager(1.5))
        .printer(false)
        .build()
        .unwrap();

    let error = agent.invoke("Hi").await.unwrap_err();

    assert_eq!(
        error.to_string(),
        "compressionThreshold must be between 0 (exclusive) and 1 (inclusive), got 1.5"
    );
}

#[tokio::test]
async fn the_builder_takes_a_conversation_manager_by_value_or_as_an_arc() {
    for manager in [
        Arc::new(NullConversationManager::new()) as Arc<dyn ConversationManager>,
        Arc::new(ThresholdManager(0.5)),
    ] {
        let mut agent = Agent::builder()
            .model(MockModel::new().with_turn("Hello"))
            .conversation_manager(manager)
            .printer(false)
            .build()
            .unwrap();
        assert_eq!(agent.invoke("Hi").await.unwrap().to_string(), "Hello");
    }
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("Hello"))
        .conversation_manager(ThresholdManager(1.0))
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(agent.invoke("Hi").await.unwrap().to_string(), "Hello");
}

#[tokio::test(start_paused = true)]
async fn local_agent_load_snapshot_refuses_while_background_tasks_are_tracked() {
    let pending = FunctionTool::builder("work", "Work")
        .input_schema(json!({"type": "object", "properties": {}}))
        .callback(|_, _| std::future::pending::<Result<Value, strands::ToolError>>());
    let model = MockModel::from_turns([
        tool_use_turn("work", "w1", json!({})),
        MockTurn::text("admitted"),
        MockTurn::text("again"),
    ]);
    let mut agent = Agent::builder()
        .model(model)
        .tools([pending])
        .background_tasks(BackgroundTasksConfig {
            always: Some(vec!["work".into()]),
            wait_for_completion: Some(false),
            ..Default::default()
        })
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(agent.invoke("Go").await.unwrap().to_string(), "admitted");
    let snapshot = agent.take_snapshot(strands::TakeSnapshotOptions::session()).unwrap();
    let outcome = Arc::new(Mutex::new(None));
    let seen = outcome.clone();
    agent.add_hook(move |event: &mut strands::BeforeInvocationEvent<'_>| {
        let result = event.agent_mut().load_snapshot(&snapshot);
        *seen.lock().unwrap() = Some(result.map_err(|error| error.to_string()));
    });

    let _ = agent.invoke("Again").await;

    assert_eq!(
        *outcome.lock().unwrap(),
        Some(Err(
            "Cannot load a snapshot while background tasks are still tracked".to_owned()
        ))
    );
}
