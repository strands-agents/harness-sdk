//! Test fixtures for the context manager: a model with scripted token counts, utilization and
//! summaries that records its calls, and message helpers.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use futures::StreamExt;

use crate::agent::LocalAgent;
use crate::error::{Error, Result};
use crate::models::streaming::{ModelStreamEvent, Usage};
use crate::models::{
    BaseModelConfig, BoxStream, CountTokensOptions, Model, ModelInfo, ModelRequest, SummarizeOptions, SummarizeResult,
    summarize_client_side,
};
use crate::testing::{MockModel, MockTurn};
use crate::types::{
    ContentBlock, JsonObject, JsonValue, Message, MessageMetadata, OffloadMethod, Offloaded, Role, SummaryBlock,
    ToolResultBlock, ToolResultContent,
};

type CountFn = Box<dyn Fn(&[Message]) -> u64 + Send + Sync>;
type UtilizationFn = Box<dyn Fn(u64) -> f64 + Send + Sync>;
type StreamHook = Arc<dyn Fn() + Send + Sync>;

/// A scripted `summarize` reply.
#[derive(Clone)]
pub(crate) enum Reply {
    Result(SummarizeResult),
    Error(String),
}

#[derive(Default)]
struct State {
    once: VecDeque<Reply>,
    always: Option<Reply>,
    summarize_calls: Vec<(Vec<Message>, SummarizeOptions)>,
    count_calls: Vec<Vec<Message>>,
    count_options: Vec<CountTokensOptions>,
}

/// A test model: token counts and utilization are closures, `summarize` replies come from a
/// script (once, then always) and otherwise run the client-side default over the inner
/// [`MockModel`].
pub(crate) struct TestModel {
    inner: MockModel,
    count: CountFn,
    utilization: UtilizationFn,
    count_fails: bool,
    stream_hook: Mutex<Option<StreamHook>>,
    state: Mutex<State>,
}

/// A heuristic token count: text at 4 bytes per token, other blocks at 2 bytes of JSON per token.
pub(crate) fn heuristic_count_tokens(messages: &[Message]) -> u64 {
    let ceil = |length: usize, per: usize| length.div_ceil(per) as u64;
    let mut total = 0;
    for message in messages {
        for block in &message.content {
            total += match block {
                ContentBlock::Text(text) => ceil(text.text.len(), 4),
                ContentBlock::ToolResult(result) => result
                    .content
                    .iter()
                    .map(|content| match content {
                        ToolResultContent::Text(text) => ceil(text.text.len(), 4),
                        other => ceil(json_len(other), 2),
                    })
                    .sum(),
                other => ceil(json_len(other), 2),
            };
        }
    }
    total
}

fn json_len(value: &impl serde::Serialize) -> usize {
    serde_json::to_string(value).map_or(0, |json| json.len())
}

impl TestModel {
    pub(crate) fn new() -> Self {
        Self {
            inner: MockModel::new().with_turn(MockTurn::text("Summary of content.").with_usage(stream_usage())),
            count: Box::new(heuristic_count_tokens),
            utilization: Box::new(|_| 0.0),
            count_fails: false,
            stream_hook: Mutex::new(None),
            state: Mutex::new(State::default()),
        }
    }

    /// Every token count is `tokens`.
    pub(crate) fn with_count(mut self, count: impl Fn(&[Message]) -> u64 + Send + Sync + 'static) -> Self {
        self.count = Box::new(count);
        self
    }

    /// Every token count fails.
    pub(crate) fn with_failing_count(mut self) -> Self {
        self.count_fails = true;
        self
    }

    pub(crate) fn with_utilization(mut self, utilization: impl Fn(u64) -> f64 + Send + Sync + 'static) -> Self {
        self.utilization = Box::new(utilization);
        self
    }

    pub(crate) fn with_server_side_summary(self, supported: bool) -> Self {
        self.with_model_info(|info| info.capabilities.server_side_summary = Some(supported))
    }

    /// The model info reports `limit` as its context window.
    pub(crate) fn with_context_window(self, limit: u64) -> Self {
        self.with_model_info(|info| info.limits.context_window = Some(limit))
    }

    fn with_model_info(self, change: impl FnOnce(&mut ModelInfo)) -> Self {
        let mut info = self.inner.get_config().model_info.unwrap_or_default();
        change(&mut info);
        self.inner
            .update_config(BaseModelConfig {
                model_info: Some(info),
                ..BaseModelConfig::default()
            })
            .unwrap();
        self
    }

    /// Every `summarize` call replies with `reply`.
    pub(crate) fn summarizing(self, reply: Reply) -> Self {
        self.lock().always = Some(reply);
        self
    }

    /// The next `summarize` call replies with `reply`.
    pub(crate) fn summarizing_once(self, reply: Reply) -> Self {
        self.lock().once.push_back(reply);
        self
    }

    /// Runs `hook` when a stream starts.
    pub(crate) fn on_stream(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.stream_hook.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(hook));
    }

    pub(crate) fn mock(&self) -> &MockModel {
        &self.inner
    }

    pub(crate) fn summarize_calls(&self) -> Vec<(Vec<Message>, SummarizeOptions)> {
        self.lock().summarize_calls.clone()
    }

    pub(crate) fn count_calls(&self) -> Vec<Vec<Message>> {
        self.lock().count_calls.clone()
    }

    /// The options of every token count, in order.
    pub(crate) fn count_options(&self) -> Vec<CountTokensOptions> {
        self.lock().count_options.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[async_trait]
impl Model for TestModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        let hook = self.stream_hook.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let mut inner = self.inner.stream(request);
        Box::pin(async_stream::stream! {
            let mut first = true;
            while let Some(event) = inner.next().await {
                yield event;
                if first {
                    if let Some(hook) = &hook {
                        hook();
                    }
                    first = false;
                }
            }
        })
    }

    fn get_config(&self) -> BaseModelConfig {
        self.inner.get_config()
    }

    fn update_config(&self, config: BaseModelConfig) -> crate::Result<()> {
        self.inner.update_config(config)
    }

    async fn count_tokens(&self, messages: &[Message], options: CountTokensOptions) -> Result<u64> {
        {
            let mut state = self.lock();
            state.count_calls.push(messages.to_vec());
            state.count_options.push(options);
        }
        if self.count_fails {
            return Err(crate::Error::other("count failed"));
        }
        Ok((self.count)(messages))
    }

    async fn summarize(&self, messages: Vec<Message>, options: SummarizeOptions) -> Result<SummarizeResult> {
        let reply = {
            let mut state = self.lock();
            state.summarize_calls.push((messages.clone(), options.clone()));
            state.once.pop_front().or_else(|| state.always.clone())
        };
        match reply {
            Some(Reply::Result(result)) => Ok(result),
            Some(Reply::Error(message)) => Err(Error::other(message)),
            None => summarize_client_side(self, messages, options).await,
        }
    }

    fn estimate_utilization(&self, input_tokens: u64) -> f64 {
        (self.utilization)(input_tokens)
    }
}

pub(crate) fn stream_usage() -> Usage {
    Usage::new(10, 5, 15)
}

/// A summary result.
pub(crate) fn summary_result(text: &str, provider: Option<&str>) -> Reply {
    let mut summary = SummaryBlock::new(text);
    if let Some(provider) = provider {
        summary = summary.with_provider(provider);
    }
    Reply::Result(SummarizeResult::new(vec![ContentBlock::Summary(summary)]))
}

/// An agent on `model` holding `messages`.
pub(crate) fn agent_with(model: Arc<dyn Model>, messages: Vec<Message>) -> LocalAgent {
    let mut agent = LocalAgent::new("test-agent", model);
    *agent.messages_mut() = messages;
    agent
}

pub(crate) fn text(role: Role, value: &str) -> Message {
    Message::new(role, vec![ContentBlock::text(value)])
}

pub(crate) fn user(value: &str) -> Message {
    text(Role::User, value)
}

pub(crate) fn assistant(value: &str) -> Message {
    text(Role::Assistant, value)
}

pub(crate) fn tool_result_message(text: &str, tool_use_id: &str) -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            tool_use_id,
            vec![ToolResultContent::text(text)],
        ))],
    )
}

pub(crate) fn tool_use_message(tool_use_id: &str, name: &str) -> Message {
    Message::new(
        Role::Assistant,
        vec![ContentBlock::ToolUse(crate::types::ToolUseBlock::new(
            name,
            tool_use_id,
            JsonValue::Object(JsonObject::new()),
        ))],
    )
}

pub(crate) fn pinned(mut message: Message) -> Message {
    let mut custom = JsonObject::new();
    custom.insert("pinned".to_owned(), JsonValue::Bool(true));
    message.metadata = Some(MessageMetadata::new().with_custom(custom));
    message
}

/// Role, content and pin of each message, without tracking ids (`turns`).
pub(crate) fn turns(messages: &[Message]) -> Vec<(Role, Vec<ContentBlock>, bool)> {
    messages
        .iter()
        .map(|message| {
            let is_pinned = message
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.custom.as_ref())
                .and_then(|custom| custom.get("pinned"))
                == Some(&JsonValue::Bool(true));
            (message.role, message.content.clone(), is_pinned)
        })
        .collect()
}

/// The offload method that left `block` as a placeholder, or `None` when it is not one
/// (`offloadedBy`).
pub(crate) fn offloaded_by(block: &ContentBlock) -> Option<OffloadMethod> {
    match block {
        ContentBlock::Text(text) => text.offloaded.as_ref().map(|offloaded| offloaded.method),
        _ => None,
    }
}

/// The offload method that left tool result content as a placeholder.
pub(crate) fn content_offloaded_by(content: &ToolResultContent) -> Option<OffloadMethod> {
    match content {
        ToolResultContent::Text(text) => text.offloaded.as_ref().map(|offloaded| offloaded.method),
        _ => None,
    }
}

/// What every placeholder in `messages` stands in for, including those inside tool results, in
/// history order (`placeholdersIn`).
pub(crate) fn placeholders_in(messages: &[Message]) -> Vec<Offloaded> {
    messages
        .iter()
        .flat_map(|message| &message.content)
        .flat_map(|block| match block {
            ContentBlock::ToolResult(result) => result
                .content
                .iter()
                .filter_map(|content| match content {
                    ToolResultContent::Text(text) => text.offloaded.clone(),
                    _ => None,
                })
                .collect(),
            ContentBlock::Text(text) => text.offloaded.clone().into_iter().collect(),
            _ => Vec::new(),
        })
        .collect()
}

/// A placeholder's provenance: its method and, when set, its size.
pub(crate) fn provenance(method: OffloadMethod, tokens: Option<u64>) -> Offloaded {
    let offloaded = Offloaded::new(method);
    match tokens {
        Some(tokens) => offloaded.with_tokens(tokens),
        None => offloaded,
    }
}

/// The text of each message's blocks (`textsOf`); a block without text reads as empty.
pub(crate) fn texts_of(messages: &[Message]) -> Vec<Vec<String>> {
    messages
        .iter()
        .map(|message| {
            message
                .content
                .iter()
                .map(|block| block.as_text().unwrap_or_default().to_owned())
                .collect()
        })
        .collect()
}

/// `turns` user/assistant pairs, `q1`/`a1` and on (`conversation`).
pub(crate) fn conversation(turns: usize) -> Vec<Message> {
    (1..=turns)
        .flat_map(|index| [user(&format!("q{index}")), assistant(&format!("a{index}"))])
        .collect()
}
