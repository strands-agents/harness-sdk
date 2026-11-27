//! What the agent sends a model: renders blocks a provider cannot take, sends deferred tools the
//! way the model takes them, and records each call's usage on the request.
//!
//! Deferred tools take one of two paths, by the model's `deferred_tool_loading`. With `Native`, the
//! call's `deferred_tools` and every tool reference reach the provider as they are, and the
//! provider sends them its API's way. With `Stubs`, each deferred spec becomes a stub: its name,
//! its description with a pointer to `load_tools`, and an open schema, so the model can call the
//! tool before it loads the schema. Every model but a `Native` one gets each tool reference as the
//! parameters of the call's tool with that name, in text.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::json;

use super::model::{CountTokensOptions, Model, ModelRequest, latest_user_index};
use super::model_info::DeferredToolLoading;
use super::tool_references::{has_tool_references, with_tool_reference_schemas, with_tool_reference_text};
use crate::agent::{InvocationContext, LocalAgent};
use crate::error::Result;
use crate::models::streaming::Usage;
use crate::tools::LOAD_TOOLS_TOOL_NAME;
use crate::types::{ContentBlock, Message, TextBlock, ToolResultBlock, ToolResultContent, ToolSpec};

const UNSUPPORTED_CONTENT_PLACEHOLDER: &str = "[unsupported content omitted]";

/// The tools of one model call: its specs and the names of the ones it defers.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct CallTools {
    pub(crate) tool_specs: Vec<ToolSpec>,
    pub(crate) deferred_tools: HashSet<String>,
}

/// Where an agent's latest model call records its tools, before any stubs.
pub(crate) type CallToolsRecord = Arc<Mutex<Option<CallTools>>>;

/// Wraps the model the agent calls (`ModelProxy`).
pub(crate) struct ModelProxy {
    model: Arc<dyn Model>,
    record: Option<CallToolsRecord>,
}

/// The rendered messages and the number of blocks at the end of the latest user message that
/// change between calls.
pub(crate) struct Rendered {
    pub(crate) messages: Vec<Message>,
    pub(crate) dynamic_trailing_blocks: usize,
}

impl ModelProxy {
    pub(crate) fn new(model: Arc<dyn Model>) -> Self {
        Self { model, record: None }
    }

    /// A proxy for an agent's own model calls, which records the tools each call sends so a
    /// summary can replay them and share the call's prompt cache.
    pub(crate) fn with_call_tools_record(mut self, record: CallToolsRecord) -> Self {
        self.record = Some(record);
        self
    }

    /// Renders the request's messages for the model, sends its deferred specs as stubs to a model
    /// that takes them, and keeps the cache point ahead of injected text, which the next call no
    /// longer sends.
    pub(crate) fn prepare_request(&self, request: ModelRequest) -> ModelRequest {
        if let Some(record) = &self.record {
            *record.lock().unwrap_or_else(PoisonError::into_inner) = Some(CallTools {
                tool_specs: request.tool_specs.clone(),
                deferred_tools: request.deferred_tools.clone(),
            });
        }
        prepare_request_for(self.model.as_ref(), request)
    }

    /// Records a finished call's usage on the request (`_record`).
    pub(crate) fn record(usage: Option<&Usage>, invocation_context: &InvocationContext) {
        if let Some(usage) = usage {
            invocation_context.record_usage(usage);
        }
    }

    /// Counts the tokens of the messages as they would be sent.
    pub(crate) async fn count_tokens(&self, messages: &[Message], options: CountTokensOptions) -> Result<u64> {
        let rendered = self.prepare(messages.to_vec(), &options.tool_specs);
        self.model.count_tokens(&rendered.messages, options).await
    }

    pub(crate) fn prepare(&self, messages: Vec<Message>, tool_specs: &[ToolSpec]) -> Rendered {
        prepare_for(self.model.as_ref(), messages, tool_specs)
    }
}

/// [`ModelProxy::prepare_request`] for a model borrowed as `&M`, such as a provider's own
/// `summarize`.
pub(crate) fn prepare_request_for<M: Model + ?Sized>(model: &M, mut request: ModelRequest) -> ModelRequest {
    let rendered = prepare_for(model, std::mem::take(&mut request.messages), &request.tool_specs);
    request.messages = rendered.messages;
    if rendered.dynamic_trailing_blocks > request.dynamic_trailing_blocks.unwrap_or(0) {
        request.dynamic_trailing_blocks = Some(rendered.dynamic_trailing_blocks);
    }
    with_stubs(model, request)
}

/// Sends each of the call's deferred specs as a stub with an open schema when the model takes
/// stubs.
fn with_stubs<M: Model + ?Sized>(model: &M, mut request: ModelRequest) -> ModelRequest {
    if request.deferred_tools.is_empty() || request.tool_specs.is_empty() {
        return request;
    }
    if model.model_info().capabilities.deferred_tool_loading != Some(DeferredToolLoading::Stubs) {
        return request;
    }
    for spec in &mut request.tool_specs {
        if request.deferred_tools.contains(&spec.name) {
            *spec = stub(spec);
        }
    }
    request
}

fn stub_hint() -> String {
    format!("Call {LOAD_TOOLS_TOOL_NAME} with this name for its parameters first.")
}

/// A deferred tool's spec as a model that takes stubs receives it: its name and description, and
/// an open schema.
fn stub(spec: &ToolSpec) -> ToolSpec {
    ToolSpec::new(&spec.name, format!("{}\n{}", spec.description, stub_hint()))
        .with_input_schema(json!({"type": "object"}))
}

/// A deferred tool's spec as the model sees it before loading it: a stub, or its name and
/// description.
fn unloaded_spec(spec: &ToolSpec, model: &dyn Model) -> ToolSpec {
    if model.model_info().capabilities.deferred_tool_loading == Some(DeferredToolLoading::Stubs) {
        return stub(spec);
    }
    ToolSpec::new(&spec.name, &spec.description).with_input_schema(json!({"type": "object"}))
}

/// Counts what the next request carries: the messages, plus the system prompt and tool specs that
/// occupy the same context window (`countRequestTokens`). A tool the request defers counts as the
/// model sees it before loading it, a stub or its name and description; each load in the messages
/// counts as the schema it brings in, whether the provider expands the reference or sends it as
/// text. A count of a single block or a subset calls `count_tokens` directly: including the system
/// prompt there would inflate every block against its threshold.
///
/// # Errors
///
/// The model's token count error.
pub(crate) async fn count_request_tokens(agent: &LocalAgent, messages: &[Message]) -> Result<u64> {
    let registered = agent.tool_registry().tool_specs();
    let model = agent.model().clone();
    let tools = agent.context_manager().map_or_else(
        || CallTools {
            tool_specs: registered.clone(),
            deferred_tools: HashSet::new(),
        },
        |manager| manager.call_tools(agent.id(), agent.tool_registry(), &registered, &model),
    );
    let tool_specs = tools
        .tool_specs
        .iter()
        .map(|spec| {
            if tools.deferred_tools.contains(&spec.name) {
                unloaded_spec(spec, model.as_ref())
            } else {
                spec.clone()
            }
        })
        .collect();
    let options = CountTokensOptions {
        system_prompt: agent.system_prompt().cloned(),
        tool_specs,
    };
    let messages = with_tool_reference_schemas(messages.to_vec(), &tools.tool_specs);
    ModelProxy::new(model).count_tokens(&messages, options).await
}

fn prepare_for<M: Model + ?Sized>(model: &M, messages: Vec<Message>, tool_specs: &[ToolSpec]) -> Rendered {
    let capabilities = model.model_info().capabilities;
    let messages = with_summary_text(messages, capabilities.server_side_summary == Some(true));
    let messages =
        if has_tool_references(&messages) && capabilities.deferred_tool_loading != Some(DeferredToolLoading::Native) {
            with_tool_reference_text(messages, tool_specs, &HashSet::new())
        } else {
            messages
        };
    let messages = with_unknown_only_tool_results_filled(messages);
    if !messages.iter().any(has_injected_block) || capabilities.temporary_messages == Some(true) {
        return Rendered {
            messages,
            dynamic_trailing_blocks: 0,
        };
    }
    render_injected_blocks(messages)
}

fn with_summary_text(messages: Vec<Message>, server_side_summary: bool) -> Vec<Message> {
    if server_side_summary {
        return messages;
    }
    messages
        .into_iter()
        .map(|mut message| {
            for block in &mut message.content {
                if let ContentBlock::Summary(summary) = block {
                    *block = ContentBlock::Text(TextBlock::new(summary.text.clone()));
                }
            }
            message
        })
        .collect()
}

fn is_unknown_only_tool_result(block: &ContentBlock) -> bool {
    let ContentBlock::ToolResult(result) = block else {
        return false;
    };
    !result.content.is_empty()
        && result
            .content
            .iter()
            .all(|content| matches!(content, ToolResultContent::Unknown(_)))
}

fn with_unknown_only_tool_results_filled(messages: Vec<Message>) -> Vec<Message> {
    messages
        .into_iter()
        .map(|mut message| {
            for block in &mut message.content {
                if !is_unknown_only_tool_result(block) {
                    continue;
                }
                let ContentBlock::ToolResult(result) = block else {
                    continue;
                };
                let filled = ToolResultBlock::new(
                    result.tool_use_id.clone(),
                    result.status,
                    vec![ToolResultContent::text(UNSUPPORTED_CONTENT_PLACEHOLDER)],
                );
                let error = result.error.take();
                *result = match error {
                    Some(error) => filled.with_error(error),
                    None => filled,
                };
            }
            message
        })
        .collect()
}

fn render_injected_blocks(messages: Vec<Message>) -> Rendered {
    let latest_user = latest_user_index(&messages);
    let mut dynamic_trailing_blocks = 0;
    let messages = messages
        .into_iter()
        .enumerate()
        .map(|(index, mut message)| {
            if !has_injected_block(&message) {
                return message;
            }
            if Some(index) != latest_user {
                message
                    .content
                    .retain(|block| !matches!(block, ContentBlock::Injected(_)));
                return message;
            }
            if let Some(first) = message
                .content
                .iter()
                .position(|block| matches!(block, ContentBlock::Injected(_)))
            {
                dynamic_trailing_blocks = message.content.len() - first;
            }
            for (position, block) in message.content.iter_mut().enumerate() {
                let ContentBlock::Injected(injected) = block else {
                    continue;
                };
                let text = if position > 0 && !injected.text.starts_with('\n') {
                    format!("\n\n{}", injected.text)
                } else {
                    injected.text.clone()
                };
                *block = ContentBlock::Text(TextBlock::new(text));
            }
            message
        })
        .collect();
    Rendered {
        messages,
        dynamic_trailing_blocks,
    }
}

fn has_injected_block(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::Injected(_)))
}

#[cfg(test)]
mod tests;
