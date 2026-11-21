//! Test fixtures for code built on strands.
//!
//! [`MockModel`] is a scripted model: give it assistant turns as content blocks, raw stream events
//! or errors, and it streams them back while recording every [`ModelRequest`] it receives.
//! [`test_agent`] builds an agent on one.
//! [`tool_context`] builds the context to run a tool on its own, [`invoke_model_context`] and
//! [`execute_tool_context`] the contexts of middleware handlers, [`injection_context`] the context
//! an injection callback receives, and [`HookRecorder`] records the hook events that fire.

mod agents;

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::Duration;

use crate::error::{Error, ModelThrottledError};
use crate::models::streaming::{
    CitationsDelta, ModelContentBlockDeltaEvent, ModelContentBlockStartEvent, ModelContentBlockStopEvent,
    ModelMessageStartEvent, ModelMessageStopEvent, ModelMetadataEvent, ModelStreamEvent, ReasoningContentDelta,
    TextDelta, ToolUseInputDelta, ToolUseStart, Usage,
};
use crate::models::{BaseModelConfig, BoxStream, Model, ModelRequest};
use crate::types::{ContentBlock, Role, StopReason};

pub use agents::{
    HookRecorder, execute_tool_context, injection_context, invoke_model_context, test_agent, tool_context,
};

type ErrorFactory = Arc<dyn Fn() -> Error + Send + Sync>;

#[derive(Clone)]
enum Script {
    Content {
        blocks: Vec<ContentBlock>,
        stop_reason: Option<StopReason>,
        usage: Option<Usage>,
    },
    Events(Vec<ModelStreamEvent>),
}

/// One scripted model response for [`MockModel`].
///
/// A content turn streams its blocks as an assistant message; its stop reason is `ToolUse` when it
/// holds a tool use and `EndTurn` otherwise, unless set. An event turn streams the given events
/// as they are. Either can end with an error, and an error turn streams nothing but its error.
#[derive(Clone)]
pub struct MockTurn {
    script: Script,
    error: Option<ErrorFactory>,
    delay: Option<Duration>,
}

impl MockTurn {
    /// A turn that streams `blocks` as an assistant message.
    pub fn content(blocks: impl IntoIterator<Item = impl Into<ContentBlock>>) -> Self {
        Self::from_script(Script::Content {
            blocks: blocks.into_iter().map(Into::into).collect(),
            stop_reason: None,
            usage: None,
        })
    }

    /// A turn that streams one text block.
    pub fn text(text: impl Into<String>) -> Self {
        Self::content([ContentBlock::text(text)])
    }

    /// A turn that streams `events` unchanged.
    pub fn events(events: impl IntoIterator<Item = impl Into<ModelStreamEvent>>) -> Self {
        Self::from_script(Script::Events(events.into_iter().map(Into::into).collect()))
    }

    /// A turn that fails with the error `error` builds, each time the turn is used.
    pub fn error(error: impl Fn() -> Error + Send + Sync + 'static) -> Self {
        Self::events(Vec::<ModelStreamEvent>::new()).with_error(error)
    }

    /// A turn that fails with a [`ModelThrottledError`].
    pub fn throttled(message: impl Into<String>) -> Self {
        let message = message.into();
        Self::error(move || ModelThrottledError::new(message.clone()).into())
    }

    /// Ends the turn with the error `error` builds, after its events.
    #[must_use]
    pub fn with_error(mut self, error: impl Fn() -> Error + Send + Sync + 'static) -> Self {
        self.error = Some(Arc::new(error));
        self
    }

    /// Sets the stop reason of a content turn.
    #[must_use]
    pub fn with_stop_reason(mut self, stop_reason: StopReason) -> Self {
        if let Script::Content { stop_reason: slot, .. } = &mut self.script {
            *slot = Some(stop_reason);
        }
        self
    }

    /// Adds a metadata event with `usage` after the message of a content turn.
    #[must_use]
    pub fn with_usage(mut self, usage: Usage) -> Self {
        if let Script::Content { usage: slot, .. } = &mut self.script {
            *slot = Some(usage);
        }
        self
    }

    /// Waits for `delay` on the tokio timer before streaming. Use `tokio::time::pause` in tests so
    /// no real time passes.
    #[must_use]
    pub fn with_delay(mut self, delay: Duration) -> Self {
        self.delay = Some(delay);
        self
    }

    fn from_script(script: Script) -> Self {
        Self {
            script,
            error: None,
            delay: None,
        }
    }

    fn stream_events(&self) -> Vec<ModelStreamEvent> {
        match &self.script {
            Script::Events(events) => events.clone(),
            Script::Content {
                blocks,
                stop_reason,
                usage,
            } => content_events(blocks, stop_reason.clone(), *usage),
        }
    }
}

impl fmt::Debug for MockTurn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MockTurn")
            .field("events", &self.stream_events())
            .field("error", &self.error.as_ref().map(|_| "Fn() -> Error"))
            .field("delay", &self.delay)
            .finish()
    }
}

impl From<ContentBlock> for MockTurn {
    fn from(block: ContentBlock) -> Self {
        Self::content([block])
    }
}

impl From<Vec<ContentBlock>> for MockTurn {
    fn from(blocks: Vec<ContentBlock>) -> Self {
        Self::content(blocks)
    }
}

impl From<&str> for MockTurn {
    fn from(text: &str) -> Self {
        Self::text(text)
    }
}

impl From<String> for MockTurn {
    fn from(text: String) -> Self {
        Self::text(text)
    }
}

fn content_events(
    blocks: &[ContentBlock],
    stop_reason: Option<StopReason>,
    usage: Option<Usage>,
) -> Vec<ModelStreamEvent> {
    let stop_reason = stop_reason.unwrap_or_else(|| {
        if blocks.iter().any(|block| matches!(block, ContentBlock::ToolUse(_))) {
            StopReason::ToolUse
        } else {
            StopReason::EndTurn
        }
    });
    let mut events = vec![ModelMessageStartEvent::new(Role::Assistant).into()];
    for block in blocks {
        events.extend(block_events(block));
    }
    events.push(ModelMessageStopEvent::new(stop_reason).into());
    if let Some(usage) = usage {
        events.push(ModelMetadataEvent::new().with_usage(usage).into());
    }
    events
}

fn block_events(block: &ContentBlock) -> Vec<ModelStreamEvent> {
    let start = || ModelStreamEvent::from(ModelContentBlockStartEvent::new());
    let stop = || ModelStreamEvent::from(ModelContentBlockStopEvent::new());
    let delta = |delta: crate::models::streaming::ContentBlockDelta| {
        ModelStreamEvent::from(ModelContentBlockDeltaEvent::new(delta))
    };
    match block {
        ContentBlock::Text(text) => vec![start(), delta(TextDelta::new(text.text.clone()).into()), stop()],
        ContentBlock::ToolUse(tool_use) => {
            let start = ModelContentBlockStartEvent::new()
                .with_start(ToolUseStart::new(tool_use.name.clone(), tool_use.tool_use_id.clone()));
            let input = ToolUseInputDelta::new(tool_use.input.to_string());
            vec![start.into(), delta(input.into()), stop()]
        }
        ContentBlock::Reasoning(reasoning) => {
            let reasoning = ReasoningContentDelta {
                text: reasoning.text.clone(),
                signature: reasoning.signature.clone(),
                redacted_content: reasoning.redacted_content.clone(),
            };
            vec![start(), delta(reasoning.into()), stop()]
        }
        ContentBlock::CachePoint(_) => vec![start(), stop()],
        ContentBlock::Citations(citations) => {
            let citations = CitationsDelta::new(citations.citations.clone(), citations.content.clone());
            vec![start(), delta(citations.into()), stop()]
        }
        _ => Vec::new(),
    }
}

#[derive(Default)]
struct MockState {
    turns: Vec<MockTurn>,
    next: usize,
    requests: Vec<ModelRequest>,
}

/// A scripted model for tests.
///
/// With one turn, every call replays it. With several, each call takes the next one, and a call
/// after the last fails with `All turns have been consumed`. Every request is recorded. A call
/// takes its turn and records its request when its stream is first polled, not when
/// [`Model::stream`] returns.
///
/// ```
/// use futures::StreamExt;
/// use strands::Model;
/// use strands::models::AggregatedEvent;
/// use strands::testing::{MockModel, MockTurn};
///
/// let model = MockModel::new();
/// model.add_turn("Hello").add_turn(MockTurn::throttled("slow down"));
///
/// futures::executor::block_on(async {
///     let mut stream = model.stream_aggregated(Default::default());
///     let mut text = String::new();
///     while let Some(item) = stream.next().await {
///         if let AggregatedEvent::Done(result) = item.unwrap() {
///             text = result.message.text();
///         }
///     }
///     assert_eq!(text, "Hello");
/// });
/// assert_eq!(model.call_count(), 1);
/// ```
pub struct MockModel {
    config: RwLock<BaseModelConfig>,
    state: Arc<Mutex<MockState>>,
}

impl MockModel {
    /// A model with no turns and the model id `test-model`.
    pub fn new() -> Self {
        Self {
            config: RwLock::new(BaseModelConfig {
                model_id: Some("test-model".to_owned()),
                ..BaseModelConfig::default()
            }),
            state: Arc::default(),
        }
    }

    /// A model scripted with `turns`.
    pub fn from_turns(turns: impl IntoIterator<Item = impl Into<MockTurn>>) -> Self {
        turns.into_iter().fold(Self::new(), Self::with_turn)
    }

    /// Adds a turn to the script, by value, for building a model in one expression.
    #[must_use]
    pub fn with_turn(self, turn: impl Into<MockTurn>) -> Self {
        self.add_turn(turn);
        self
    }

    /// Adds a turn to the script of a model that is already shared.
    pub fn add_turn(&self, turn: impl Into<MockTurn>) -> &Self {
        self.lock().turns.push(turn.into());
        self
    }

    /// The number of multi-turn calls made so far; a single-turn script does not
    /// advance it.
    #[must_use]
    pub fn call_count(&self) -> usize {
        self.lock().next
    }

    /// Every request received, in order.
    #[must_use]
    pub fn requests(&self) -> Vec<ModelRequest> {
        self.lock().requests.clone()
    }

    fn lock(&self) -> MutexGuard<'_, MockState> {
        lock_state(&self.state)
    }
}

fn lock_state(state: &Mutex<MockState>) -> MutexGuard<'_, MockState> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

impl MockState {
    /// Records `request` and takes the turn that answers it.
    fn next_turn(&mut self, request: ModelRequest) -> Option<MockTurn> {
        self.requests.push(request);
        let index = if self.turns.len() == 1 { 0 } else { self.next };
        if self.turns.len() > 1 {
            self.next += 1;
        }
        self.turns.get(index).cloned()
    }
}

impl Default for MockModel {
    fn default() -> Self {
        Self::new()
    }
}

/// Clones share the script and the recorded requests, so a test can keep one clone to inspect
/// while the agent holds another.
impl Clone for MockModel {
    fn clone(&self) -> Self {
        Self {
            config: RwLock::new(self.get_config()),
            state: Arc::clone(&self.state),
        }
    }
}

impl fmt::Debug for MockModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = self.lock();
        f.debug_struct("MockModel")
            .field("turns", &state.turns.len())
            .field("call_count", &state.next)
            .finish_non_exhaustive()
    }
}

impl Model for MockModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, crate::Result<ModelStreamEvent>> {
        let state = Arc::clone(&self.state);
        Box::pin(async_stream::stream! {
            let turn = lock_state(&state).next_turn(request);
            let Some(turn) = turn else {
                yield Err(Error::other("All turns have been consumed"));
                return;
            };
            if let Some(delay) = turn.delay {
                tokio::time::sleep(delay).await;
            }
            for event in turn.stream_events() {
                yield Ok(event);
            }
            if let Some(error) = &turn.error {
                yield Err(error());
            }
        })
    }

    fn get_config(&self) -> BaseModelConfig {
        self.config.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn update_config(&self, config: BaseModelConfig) -> crate::Result<()> {
        self.config
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .merge(config);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;
    use serde_json::json;

    use super::*;
    use crate::models::AggregatedEvent;
    use crate::types::{ReasoningBlock, ToolUseBlock};

    async fn collect(model: &MockModel) -> Vec<crate::Result<ModelStreamEvent>> {
        model.stream(ModelRequest::default()).collect().await
    }

    async fn events(model: &MockModel) -> Vec<serde_json::Value> {
        collect(model)
            .await
            .into_iter()
            .map(|event| serde_json::to_value(event.unwrap()).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn streams_text_and_derives_end_turn() {
        let model = MockModel::new();
        model.add_turn("Hello");
        assert_eq!(
            events(&model).await,
            [
                json!({"type": "modelMessageStartEvent", "role": "assistant"}),
                json!({"type": "modelContentBlockStartEvent"}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hello"}}),
                json!({"type": "modelContentBlockStopEvent"}),
                json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"}),
            ]
        );
    }

    #[tokio::test]
    async fn streams_tool_use_with_json_input_and_derives_tool_use() {
        let model = MockModel::new();
        model.add_turn(MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(
            "calc",
            "t1",
            json!({"a": 1}),
        ))]));
        let events = events(&model).await;
        assert_eq!(
            events[1],
            json!({"type": "modelContentBlockStartEvent", "start": {"type": "toolUseStart", "name": "calc", "toolUseId": "t1"}})
        );
        assert_eq!(
            events[2],
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "toolUseInputDelta", "input": "{\"a\":1}"}})
        );
        assert_eq!(
            events[4],
            json!({"type": "modelMessageStopEvent", "stopReason": "toolUse"})
        );
    }

    #[tokio::test]
    async fn streams_reasoning_and_usage_with_an_explicit_stop_reason() {
        let model = MockModel::new();
        model.add_turn(
            MockTurn::content([ContentBlock::Reasoning(ReasoningBlock::new().with_text("hmm"))])
                .with_stop_reason(StopReason::MaxTokens)
                .with_usage(Usage::new(10, 5, 15)),
        );
        let events = events(&model).await;
        assert_eq!(
            events[2],
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "reasoningContentDelta", "text": "hmm"}})
        );
        assert_eq!(
            events[4],
            json!({"type": "modelMessageStopEvent", "stopReason": "maxTokens"})
        );
        assert_eq!(
            events[5],
            json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}})
        );
    }

    #[tokio::test]
    async fn replays_a_single_turn_indefinitely() {
        let model = MockModel::new();
        model.add_turn("again");
        for _ in 0..3 {
            assert_eq!(events(&model).await.len(), 5);
        }
        assert_eq!(model.call_count(), 0);
        assert_eq!(model.requests().len(), 3);
    }

    #[tokio::test]
    async fn advances_through_turns_and_fails_when_they_run_out() {
        let model = MockModel::new();
        model.add_turn("one").add_turn(MockTurn::throttled("slow down"));
        assert!(collect(&model).await.iter().all(Result::is_ok));
        let second = collect(&model).await;
        let error = second.last().unwrap().as_ref().unwrap_err();
        assert_eq!(error.name(), "ModelThrottledError");
        assert_eq!(error.to_string(), "slow down");
        let third = collect(&model).await;
        assert_eq!(
            third.last().unwrap().as_ref().unwrap_err().to_string(),
            "All turns have been consumed"
        );
        assert_eq!(model.call_count(), 3);
    }

    #[tokio::test]
    async fn fails_after_scripted_events() {
        let model = MockModel::new();
        model.add_turn(
            MockTurn::events([ModelMessageStartEvent::new(Role::Assistant)]).with_error(|| Error::other("boom")),
        );
        let items = collect(&model).await;
        assert!(items[0].is_ok());
        assert_eq!(items[1].as_ref().unwrap_err().to_string(), "boom");
    }

    #[tokio::test]
    async fn takes_the_turn_when_the_stream_is_first_polled() {
        let model = MockModel::from_turns(["one", "two"]);
        let unpolled = model.stream(ModelRequest::default());
        assert_eq!(model.call_count(), 0);
        assert!(model.requests().is_empty());
        drop(unpolled);
        let mut stream = model.stream(ModelRequest::default());
        stream.next().await;
        assert_eq!(model.call_count(), 1);
        assert_eq!(model.requests().len(), 1);
    }

    #[tokio::test]
    async fn builds_a_script_by_value() {
        let model = MockModel::new().with_turn("one").with_turn(MockTurn::throttled("x"));
        assert!(collect(&model).await.iter().all(Result::is_ok));
        assert!(collect(&model).await.last().unwrap().is_err());
    }

    #[tokio::test]
    async fn records_requests() {
        let model = MockModel::new();
        model.add_turn("ok");
        let request = ModelRequest::builder()
            .messages(vec![crate::types::Message::user("hi")])
            .system_prompt("be brief")
            .build();
        let _: Vec<_> = model.stream_aggregated(request).collect().await;
        let requests = model.requests();
        assert_eq!(requests[0].messages[0].text(), "hi");
        assert_eq!(requests[0].system_prompt, Some("be brief".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn waits_for_the_turn_delay_on_the_tokio_timer() {
        let model = MockModel::new();
        model.add_turn(MockTurn::text("late").with_delay(Duration::from_secs(60)));
        let started = tokio::time::Instant::now();
        let items: Vec<_> = model.stream_aggregated(ModelRequest::default()).collect().await;
        assert!(started.elapsed() >= Duration::from_secs(60));
        assert!(matches!(items.last(), Some(Ok(AggregatedEvent::Done(_)))));
    }

    #[test]
    fn update_config_merges_into_the_test_model_id() {
        let model = MockModel::new();
        assert_eq!(model.model_id().as_deref(), Some("test-model"));
        model
            .update_config(BaseModelConfig::builder().max_tokens(10).build())
            .unwrap();
        assert_eq!(model.model_id().as_deref(), Some("test-model"));
        assert_eq!(model.get_config().max_tokens, Some(10));
        model
            .update_config(BaseModelConfig::builder().model_id("my-model").build())
            .unwrap();
        assert_eq!(model.model_id().as_deref(), Some("my-model"));
    }
}
