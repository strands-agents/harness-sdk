//! An extractor that asks a model for facts.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;

use super::{ExtractionResult, Extractor, ExtractorContext};
use crate::error::{Error, Result};
use crate::models::model_proxy::{ModelProxy, prepare_request_for};
use crate::models::{AggregatedEvent, Model, ModelRequest, StreamAggregatedResult};
use crate::telemetry::{EndModelSpanOptions, StartModelInvokeSpanOptions};
use crate::types::{ContentBlock, JsonValue, Message, Role, SystemPrompt};

/// Default guidance on what counts as a fact; a custom `system_prompt` replaces it.
const DEFAULT_SYSTEM_PROMPT: &str = "You extract durable facts worth remembering across future conversations from a transcript.

Each entry is one discrete, self-contained fact (a preference, decision, or stable detail about the user or task). Do not include transient chit-chat, questions, or anything already obvious.";

/// The response shape the parser needs, appended after every system prompt.
const OUTPUT_FORMAT: &str = r#"Return ONLY a JSON array of objects, each: {"content": string}. If there is nothing worth remembering, return []."#;

/// Options for [`ModelExtractor`] (`ModelExtractorOptions`).
#[derive(Clone, Default, bon::Builder)]
pub struct ModelExtractorOptions {
    /// The model that extracts facts. Resolution order: `this model > agent.aux_model >
    /// agent.model`.
    #[builder(into)]
    pub model: Option<Arc<dyn Model>>,
    /// What counts as a fact, replacing the default guidance. The JSON output format is always
    /// appended after it.
    #[builder(into)]
    pub system_prompt: Option<String>,
}

impl fmt::Debug for ModelExtractorOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModelExtractorOptions")
            .field("model", &self.model.as_ref().map(|model| model.model_id()))
            .field("system_prompt", &self.system_prompt)
            .finish()
    }
}

/// An [`Extractor`] that asks a model to distill messages into discrete facts
/// (`ModelExtractor`). Malformed model output yields no entries (logged), never an error.
#[derive(Clone)]
pub struct ModelExtractor {
    model: Option<Arc<dyn Model>>,
    system_prompt: String,
}

impl ModelExtractor {
    /// Creates the extractor.
    #[must_use]
    pub fn new(options: ModelExtractorOptions) -> Self {
        let guidance = options.system_prompt.as_deref().unwrap_or(DEFAULT_SYSTEM_PROMPT);
        Self {
            model: options.model,
            system_prompt: format!("{guidance}\n\n{OUTPUT_FORMAT}"),
        }
    }

    /// The system prompt the model receives.
    #[must_use]
    pub fn system_prompt(&self) -> &str {
        &self.system_prompt
    }
}

impl Default for ModelExtractor {
    fn default() -> Self {
        Self::new(ModelExtractorOptions::default())
    }
}

impl fmt::Debug for ModelExtractor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModelExtractor")
            .field("model", &self.model.as_ref().map(|model| model.model_id()))
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl Extractor for ModelExtractor {
    async fn extract(&self, messages: &[Message], context: ExtractorContext) -> Result<Vec<ExtractionResult>> {
        let Some(model) = self.model.clone().or(context.default_model) else {
            return Err(Error::other(
                "ModelExtractor: no model configured and no default model available",
            ));
        };
        if messages.is_empty() {
            return Ok(Vec::new());
        }
        // One user turn, so the system prompt governs extraction instead of the model continuing
        // the transcript's roles.
        let transcript = messages.iter().map(render_message).collect::<Vec<_>>().join("\n");
        let prompt = vec![Message::user(format!(
            "Extract facts from the following transcript:\n\n{transcript}"
        ))];
        let system_prompt = SystemPrompt::from(self.system_prompt.as_str());
        let model_id = model.model_id();
        let span = context.tracer.as_ref().map(|tracer| {
            tracer.start_model_invoke_span(StartModelInvokeSpanOptions {
                messages: &prompt,
                model_id: model_id.as_deref(),
                system_prompt: Some(&system_prompt),
            })
        });
        let request = ModelRequest {
            messages: prompt.clone(),
            system_prompt: Some(system_prompt.clone()),
            ..ModelRequest::default()
        };
        let result = match aggregate(model.as_ref(), request).await {
            Ok(result) => result,
            Err(error) => {
                if let Some(span) = span {
                    let message = error.to_string();
                    span.end(EndModelSpanOptions {
                        error: Some(&message),
                        ..EndModelSpanOptions::default()
                    });
                }
                return Err(error);
            }
        };
        let metadata = result.metadata.as_ref();
        if let Some(span) = span {
            span.end(EndModelSpanOptions {
                usage: metadata.and_then(|metadata| metadata.usage.as_ref()),
                metrics: metadata.and_then(|metadata| metadata.metrics.as_ref()),
                error: None,
                output: Some(&result.message),
                stop_reason: Some(result.stop_reason.as_str()),
            });
        }
        if let Some(invocation_context) = &context.invocation_context {
            ModelProxy::record(
                metadata.and_then(|metadata| metadata.usage.as_ref()),
                invocation_context,
            );
        }
        let text: String = result
            .message
            .content
            .iter()
            .filter_map(ContentBlock::as_text)
            .collect();
        Ok(parse_entries(text.trim(), &model_name(model.as_ref())))
    }

    fn name(&self) -> &str {
        "ModelExtractor"
    }
}

/// Streams `request` and returns the aggregated result.
async fn aggregate(model: &dyn Model, request: ModelRequest) -> Result<StreamAggregatedResult> {
    let request = prepare_request_for(model, request);
    let mut stream = model.stream_aggregated(request);
    while let Some(event) = stream.next().await {
        if let AggregatedEvent::Done(result) = event? {
            return Ok(result);
        }
    }
    Err(Error::other("ModelExtractor: model returned no response"))
}

fn model_name(model: &dyn Model) -> String {
    model.model_id().unwrap_or_else(|| "unknown".to_owned())
}

/// Renders one message as `role: text`, joining its text blocks.
fn render_message(message: &Message) -> String {
    let text = message
        .content
        .iter()
        .filter_map(ContentBlock::as_text)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let role = match message.role {
        Role::User => "user",
        _ => "assistant",
    };
    format!("{role}: {text}")
}

/// Parses the model's reply: the first `[` to the last `]`, tolerating prose
/// or a code fence around it.
fn parse_entries(text: &str, model_name: &str) -> Vec<ExtractionResult> {
    let Some(json) = extract_json_array(text) else {
        tracing::warn!("model=<{model_name}> | ModelExtractor: no JSON array in model output, skipping");
        return Vec::new();
    };
    let parsed = match serde_json::from_str::<JsonValue>(json) {
        Ok(parsed) => parsed,
        Err(error) => {
            tracing::warn!("model=<{model_name}>, error=<{error}> | ModelExtractor: failed to parse output");
            return Vec::new();
        }
    };
    let JsonValue::Array(items) = parsed else {
        return Vec::new();
    };
    items.iter().filter_map(entry_from).collect()
}

fn entry_from(item: &JsonValue) -> Option<ExtractionResult> {
    let content = item.get("content")?.as_str()?.trim();
    if content.is_empty() {
        return None;
    }
    let entry = ExtractionResult::new(content);
    Some(match item.get("metadata").and_then(JsonValue::as_object) {
        Some(metadata) => entry.with_metadata(metadata.clone()),
        None => entry,
    })
}

fn extract_json_array(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    (end >= start).then(|| &text[start..=end])
}

#[cfg(test)]
mod tests;
