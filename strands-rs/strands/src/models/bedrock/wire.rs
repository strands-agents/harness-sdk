//! AWS SDK response types to Converse JSON, the shape the response mapping reads.
//!
//! Each converter writes the Converse member names, omits absent members and base64-encodes
//! blobs. Document values come from the SDK's unordered map, so their key order is the SDK's.

use aws_sdk_bedrockruntime::error::SdkError;
use aws_sdk_bedrockruntime::operation::converse::ConverseOutput;
use aws_sdk_bedrockruntime::types as bt;
use aws_sdk_bedrockruntime::types::error::ConverseStreamOutputError;
use aws_smithy_types::{Document, Number};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;

use super::transport::BedrockError;
use crate::types::{JsonObject, JsonValue};

/// A JSON object built member by member, skipping absent ones.
#[derive(Default)]
struct Obj(JsonObject);

impl Obj {
    fn set(mut self, key: &str, value: impl Into<JsonValue>) -> Self {
        self.0.insert(key.to_owned(), value.into());
        self
    }

    fn opt<T: Into<JsonValue>>(self, key: &str, value: Option<T>) -> Self {
        match value {
            Some(value) => self.set(key, value),
            None => self,
        }
    }

    fn done(self) -> JsonValue {
        JsonValue::Object(self.0)
    }
}

fn single(key: &str, value: JsonValue) -> JsonObject {
    let mut object = JsonObject::new();
    object.insert(key.to_owned(), value);
    object
}

fn blob(blob: &aws_smithy_types::Blob) -> JsonValue {
    JsonValue::String(STANDARD.encode(blob.as_ref()))
}

fn strings(values: &[String]) -> JsonValue {
    json!(values)
}

/// Converts an SDK document to JSON.
pub(super) fn document_to_json(document: &Document) -> JsonValue {
    match document {
        Document::Object(map) => JsonValue::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), document_to_json(value)))
                .collect(),
        ),
        Document::Array(items) => JsonValue::Array(items.iter().map(document_to_json).collect()),
        Document::Number(Number::PosInt(value)) => json!(value),
        Document::Number(Number::NegInt(value)) => json!(value),
        Document::Number(Number::Float(value)) => json!(value),
        Document::String(value) => json!(value),
        Document::Bool(value) => json!(value),
        Document::Null => JsonValue::Null,
    }
}

fn role(role: &bt::ConversationRole) -> JsonValue {
    json!(role.as_str())
}

fn usage(usage: &bt::TokenUsage) -> JsonValue {
    Obj::default()
        .set("inputTokens", usage.input_tokens)
        .set("outputTokens", usage.output_tokens)
        .set("totalTokens", usage.total_tokens)
        .opt("cacheReadInputTokens", usage.cache_read_input_tokens)
        .opt("cacheWriteInputTokens", usage.cache_write_input_tokens)
        .opt(
            "cacheDetails",
            usage.cache_details.as_ref().map(|details| {
                details
                    .iter()
                    .map(|detail| json!({"ttl": detail.ttl.as_str(), "inputTokens": detail.input_tokens}))
                    .collect::<Vec<_>>()
            }),
        )
        .done()
}

fn citation_location(location: &bt::CitationLocation) -> JsonValue {
    let range = |index_key: &str, index: Option<i32>, start: Option<i32>, end: Option<i32>| {
        Obj::default()
            .opt(index_key, index)
            .opt("start", start)
            .opt("end", end)
            .done()
    };
    match location {
        bt::CitationLocation::DocumentChar(loc) => {
            json!({"documentChar": range("documentIndex", loc.document_index, loc.start, loc.end)})
        }
        bt::CitationLocation::DocumentPage(loc) => {
            json!({"documentPage": range("documentIndex", loc.document_index, loc.start, loc.end)})
        }
        bt::CitationLocation::DocumentChunk(loc) => {
            json!({"documentChunk": range("documentIndex", loc.document_index, loc.start, loc.end)})
        }
        bt::CitationLocation::SearchResultLocation(loc) => {
            json!({"searchResultLocation": range("searchResultIndex", loc.search_result_index, loc.start, loc.end)})
        }
        bt::CitationLocation::Web(loc) => {
            json!({"web": Obj::default().opt("url", loc.url.clone()).opt("domain", loc.domain.clone()).done()})
        }
        _ => json!({}),
    }
}

fn text_items<T>(items: &[T], text: impl Fn(&T) -> Option<&String>) -> JsonValue {
    JsonValue::Array(
        items
            .iter()
            .map(|item| Obj::default().opt("text", text(item).cloned()).done())
            .collect(),
    )
}

fn citation(citation: &bt::Citation) -> JsonValue {
    Obj::default()
        .opt("title", citation.title.clone())
        .opt("source", citation.source.clone())
        .opt(
            "sourceContent",
            citation
                .source_content
                .as_deref()
                .map(|items| text_items(items, |item| item.as_text().ok())),
        )
        .opt("location", citation.location.as_ref().map(citation_location))
        .done()
}

fn citations_content(block: &bt::CitationsContentBlock) -> JsonValue {
    Obj::default()
        .opt(
            "content",
            block
                .content
                .as_deref()
                .map(|items| text_items(items, |item| item.as_text().ok())),
        )
        .opt(
            "citations",
            block
                .citations
                .as_ref()
                .map(|citations| citations.iter().map(citation).collect::<Vec<_>>()),
        )
        .done()
}

fn reasoning_content(block: &bt::ReasoningContentBlock) -> JsonValue {
    match block {
        bt::ReasoningContentBlock::ReasoningText(text) => json!({
            "reasoningText": Obj::default().set("text", text.text.clone()).opt("signature", text.signature.clone()).done()
        }),
        bt::ReasoningContentBlock::RedactedContent(redacted) => json!({"redactedContent": blob(redacted)}),
        _ => json!({}),
    }
}

/// Converts a response content block. Blocks the provider does not read keep their member name
/// with an empty body, so the mapping can name what it skips.
fn content_block(block: &bt::ContentBlock) -> JsonValue {
    let (key, value) = match block {
        bt::ContentBlock::Text(text) => ("text", json!(text)),
        bt::ContentBlock::ToolUse(tool_use) => (
            "toolUse",
            Obj::default()
                .set("toolUseId", tool_use.tool_use_id.clone())
                .set("name", tool_use.name.clone())
                .set("input", document_to_json(&tool_use.input))
                .opt("type", tool_use.r#type.as_ref().map(|kind| kind.as_str().to_owned()))
                .done(),
        ),
        bt::ContentBlock::ReasoningContent(reasoning) => ("reasoningContent", reasoning_content(reasoning)),
        bt::ContentBlock::CitationsContent(citations) => ("citationsContent", citations_content(citations)),
        bt::ContentBlock::Image(_) => ("image", json!({})),
        bt::ContentBlock::Document(_) => ("document", json!({})),
        bt::ContentBlock::Video(_) => ("video", json!({})),
        bt::ContentBlock::Audio(_) => ("audio", json!({})),
        bt::ContentBlock::ToolResult(_) => ("toolResult", json!({})),
        bt::ContentBlock::GuardContent(_) => ("guardContent", json!({})),
        bt::ContentBlock::CachePoint(_) => ("cachePoint", json!({})),
        bt::ContentBlock::SearchResult(_) => ("searchResult", json!({})),
        _ => ("unknown", json!({})),
    };
    JsonValue::Object(single(key, value))
}

fn content_block_delta(delta: &bt::ContentBlockDelta) -> JsonValue {
    let (key, value) = match delta {
        bt::ContentBlockDelta::Text(text) => ("text", json!(text)),
        bt::ContentBlockDelta::ToolUse(tool_use) => ("toolUse", json!({"input": tool_use.input})),
        bt::ContentBlockDelta::ReasoningContent(reasoning) => (
            "reasoningContent",
            match reasoning {
                bt::ReasoningContentBlockDelta::Text(text) => json!({"text": text}),
                bt::ReasoningContentBlockDelta::Signature(signature) => json!({"signature": signature}),
                bt::ReasoningContentBlockDelta::RedactedContent(redacted) => json!({"redactedContent": blob(redacted)}),
                _ => json!({}),
            },
        ),
        bt::ContentBlockDelta::Citation(citation) => (
            "citation",
            Obj::default()
                .opt("title", citation.title.clone())
                .opt("source", citation.source.clone())
                .opt(
                    "sourceContent",
                    citation
                        .source_content
                        .as_deref()
                        .map(|items| text_items(items, |item| item.text.as_ref())),
                )
                .opt("location", citation.location.as_ref().map(citation_location))
                .done(),
        ),
        bt::ContentBlockDelta::Image(_) => ("image", json!({})),
        bt::ContentBlockDelta::ToolResult(_) => ("toolResult", json!({})),
        _ => ("unknown", json!({})),
    };
    JsonValue::Object(single(key, value))
}

fn content_block_start(start: &bt::ContentBlockStart) -> JsonValue {
    match start {
        bt::ContentBlockStart::ToolUse(tool_use) => json!({
            "toolUse": Obj::default()
                .set("toolUseId", tool_use.tool_use_id.clone())
                .set("name", tool_use.name.clone())
                .opt("type", tool_use.r#type.as_ref().map(|kind| kind.as_str().to_owned()))
                .done()
        }),
        bt::ContentBlockStart::ToolResult(result) => json!({"toolResult": {"toolUseId": result.tool_use_id}}),
        bt::ContentBlockStart::Image(image) => json!({"image": {"format": image.format.as_str()}}),
        _ => json!({}),
    }
}

/// Converts one ConverseStream event to its single-key chunk.
pub(super) fn stream_event_to_json(event: &bt::ConverseStreamOutput) -> JsonObject {
    match event {
        bt::ConverseStreamOutput::MessageStart(start) => single("messageStart", json!({"role": role(&start.role)})),
        bt::ConverseStreamOutput::ContentBlockStart(start) => single(
            "contentBlockStart",
            Obj::default()
                .opt("start", start.start.as_ref().map(content_block_start))
                .set("contentBlockIndex", start.content_block_index)
                .done(),
        ),
        bt::ConverseStreamOutput::ContentBlockDelta(delta) => single(
            "contentBlockDelta",
            Obj::default()
                .opt("delta", delta.delta.as_ref().map(content_block_delta))
                .set("contentBlockIndex", delta.content_block_index)
                .done(),
        ),
        bt::ConverseStreamOutput::ContentBlockStop(stop) => single(
            "contentBlockStop",
            json!({"contentBlockIndex": stop.content_block_index}),
        ),
        bt::ConverseStreamOutput::MessageStop(stop) => single(
            "messageStop",
            Obj::default()
                .set("stopReason", stop.stop_reason.as_str())
                .opt(
                    "additionalModelResponseFields",
                    stop.additional_model_response_fields.as_ref().map(document_to_json),
                )
                .done(),
        ),
        bt::ConverseStreamOutput::Metadata(metadata) => single(
            "metadata",
            Obj::default()
                .opt("usage", metadata.usage.as_ref().map(usage))
                .opt(
                    "metrics",
                    metadata
                        .metrics
                        .as_ref()
                        .map(|metrics| json!({"latencyMs": metrics.latency_ms})),
                )
                .opt(
                    "trace",
                    metadata
                        .trace
                        .as_ref()
                        .map(|trace| trace_json(trace.guardrail.as_ref(), trace.prompt_router.as_ref())),
                )
                .opt(
                    "performanceConfig",
                    metadata.performance_config.as_ref().map(performance_config),
                )
                .opt("serviceTier", metadata.service_tier.as_ref().map(service_tier))
                .done(),
        ),
        _ => single("unknown", json!({})),
    }
}

/// Converts a stream error: Bedrock's in-stream exceptions become their chunks, which the mapping
/// rethrows; anything else fails the stream.
pub(super) fn stream_error_to_chunk<R>(
    error: SdkError<ConverseStreamOutputError, R>,
) -> Result<JsonObject, BedrockError>
where
    R: std::fmt::Debug + Send + Sync + 'static,
{
    let key = match error.as_service_error() {
        Some(ConverseStreamOutputError::ThrottlingException(_)) => "throttlingException",
        Some(ConverseStreamOutputError::ValidationException(_)) => "validationException",
        Some(ConverseStreamOutputError::InternalServerException(_)) => "internalServerException",
        Some(ConverseStreamOutputError::ModelStreamErrorException(_)) => "modelStreamErrorException",
        Some(ConverseStreamOutputError::ServiceUnavailableException(_)) => "serviceUnavailableException",
        _ => return Err(BedrockError::from_sdk(error)),
    };
    let message = error
        .as_service_error()
        .and_then(aws_sdk_bedrockruntime::error::ProvideErrorMetadata::message)
        .map(str::to_owned);
    Ok(single(key, Obj::default().opt("message", message).done()))
}

fn performance_config(config: &bt::PerformanceConfiguration) -> JsonValue {
    json!({"latency": config.latency.as_str()})
}

fn service_tier(tier: &bt::ServiceTier) -> JsonValue {
    json!({"type": tier.r#type.as_str()})
}

fn trace_json(
    guardrail: Option<&bt::GuardrailTraceAssessment>,
    prompt_router: Option<&bt::PromptRouterTrace>,
) -> JsonValue {
    Obj::default()
        .opt("guardrail", guardrail.map(guardrail_trace))
        .opt(
            "promptRouter",
            prompt_router.map(|router| {
                Obj::default()
                    .opt("invokedModelId", router.invoked_model_id.clone())
                    .done()
            }),
        )
        .done()
}

/// Converts a Converse output to JSON.
pub(super) fn converse_output_to_json(output: &ConverseOutput) -> JsonObject {
    let message = output
        .output
        .as_ref()
        .and_then(|output| output.as_message().ok())
        .map(|message| {
            json!({
                "role": role(&message.role),
                "content": message.content.iter().map(content_block).collect::<Vec<_>>()
            })
        });
    let JsonValue::Object(object) = Obj::default()
        .opt("output", message.map(|message| json!({"message": message})))
        .set("stopReason", output.stop_reason.as_str())
        .opt("usage", output.usage.as_ref().map(usage))
        .opt(
            "metrics",
            output
                .metrics
                .as_ref()
                .map(|metrics| json!({"latencyMs": metrics.latency_ms})),
        )
        .opt(
            "additionalModelResponseFields",
            output.additional_model_response_fields.as_ref().map(document_to_json),
        )
        .opt(
            "trace",
            output
                .trace
                .as_ref()
                .map(|trace| trace_json(trace.guardrail.as_ref(), trace.prompt_router.as_ref())),
        )
        .opt(
            "performanceConfig",
            output.performance_config.as_ref().map(performance_config),
        )
        .opt("serviceTier", output.service_tier.as_ref().map(service_tier))
        .done()
    else {
        return JsonObject::new();
    };
    object
}

fn guardrail_trace(trace: &bt::GuardrailTraceAssessment) -> JsonValue {
    Obj::default()
        .opt("modelOutput", trace.model_output.as_deref().map(strings))
        .opt(
            "inputAssessment",
            trace.input_assessment.as_ref().map(|assessments| {
                assessments
                    .iter()
                    .map(|(key, assessment)| (key.clone(), guardrail_assessment(assessment)))
                    .collect::<JsonObject>()
            }),
        )
        .opt(
            "outputAssessments",
            trace.output_assessments.as_ref().map(|assessments| {
                assessments
                    .iter()
                    .map(|(key, list)| {
                        (
                            key.clone(),
                            JsonValue::Array(list.iter().map(guardrail_assessment).collect()),
                        )
                    })
                    .collect::<JsonObject>()
            }),
        )
        .opt("actionReason", trace.action_reason.clone())
        .done()
}

fn policy_entry(action: &str, detected: Option<bool>, fields: Obj) -> JsonValue {
    fields.set("action", action).opt("detected", detected).done()
}

fn guardrail_assessment(assessment: &bt::GuardrailAssessment) -> JsonValue {
    Obj::default()
        .opt("topicPolicy", assessment.topic_policy.as_ref().map(topic_policy))
        .opt("contentPolicy", assessment.content_policy.as_ref().map(content_policy))
        .opt("wordPolicy", assessment.word_policy.as_ref().map(word_policy))
        .opt(
            "sensitiveInformationPolicy",
            assessment
                .sensitive_information_policy
                .as_ref()
                .map(sensitive_information_policy),
        )
        .opt(
            "contextualGroundingPolicy",
            assessment
                .contextual_grounding_policy
                .as_ref()
                .map(contextual_grounding_policy),
        )
        .opt(
            "automatedReasoningPolicy",
            assessment
                .automated_reasoning_policy
                .as_ref()
                .map(automated_reasoning_policy),
        )
        .opt(
            "invocationMetrics",
            assessment.invocation_metrics.as_ref().map(invocation_metrics),
        )
        .opt(
            "appliedGuardrailDetails",
            assessment
                .applied_guardrail_details
                .as_ref()
                .map(applied_guardrail_details),
        )
        .done()
}

fn topic_policy(policy: &bt::GuardrailTopicPolicyAssessment) -> JsonValue {
    let topics: Vec<JsonValue> = policy
        .topics
        .iter()
        .map(|topic| {
            let fields = Obj::default()
                .set("name", topic.name.clone())
                .set("type", topic.r#type.as_str());
            policy_entry(topic.action.as_str(), topic.detected, fields)
        })
        .collect();
    json!({"topics": topics})
}

fn content_policy(policy: &bt::GuardrailContentPolicyAssessment) -> JsonValue {
    let filters: Vec<JsonValue> = policy
        .filters
        .iter()
        .map(|filter| {
            let fields = Obj::default()
                .set("type", filter.r#type.as_str())
                .set("confidence", filter.confidence.as_str())
                .opt(
                    "filterStrength",
                    filter
                        .filter_strength
                        .as_ref()
                        .map(|strength| strength.as_str().to_owned()),
                );
            policy_entry(filter.action.as_str(), filter.detected, fields)
        })
        .collect();
    json!({"filters": filters})
}

fn word_policy(policy: &bt::GuardrailWordPolicyAssessment) -> JsonValue {
    let custom_words: Vec<JsonValue> = policy
        .custom_words
        .iter()
        .map(|word| {
            policy_entry(
                word.action.as_str(),
                word.detected,
                Obj::default().set("match", word.r#match.clone()),
            )
        })
        .collect();
    let managed_word_lists: Vec<JsonValue> = policy
        .managed_word_lists
        .iter()
        .map(|word| {
            let fields = Obj::default()
                .set("match", word.r#match.clone())
                .set("type", word.r#type.as_str());
            policy_entry(word.action.as_str(), word.detected, fields)
        })
        .collect();
    json!({"customWords": custom_words, "managedWordLists": managed_word_lists})
}

fn sensitive_information_policy(policy: &bt::GuardrailSensitiveInformationPolicyAssessment) -> JsonValue {
    let pii_entities: Vec<JsonValue> = policy
        .pii_entities
        .iter()
        .map(|entity| {
            let fields = Obj::default()
                .set("match", entity.r#match.clone())
                .set("type", entity.r#type.as_str());
            policy_entry(entity.action.as_str(), entity.detected, fields)
        })
        .collect();
    let regexes: Vec<JsonValue> = policy
        .regexes
        .iter()
        .map(|regex| {
            let fields = Obj::default()
                .opt("name", regex.name.clone())
                .opt("match", regex.r#match.clone())
                .opt("regex", regex.regex.clone());
            policy_entry(regex.action.as_str(), regex.detected, fields)
        })
        .collect();
    json!({"piiEntities": pii_entities, "regexes": regexes})
}

fn contextual_grounding_policy(policy: &bt::GuardrailContextualGroundingPolicyAssessment) -> JsonValue {
    let filters = policy.filters.as_ref().map(|filters| {
        filters
            .iter()
            .map(|filter| {
                let fields = Obj::default()
                    .set("type", filter.r#type.as_str())
                    .set("threshold", filter.threshold)
                    .set("score", filter.score);
                policy_entry(filter.action.as_str(), filter.detected, fields)
            })
            .collect::<Vec<_>>()
    });
    Obj::default().opt("filters", filters).done()
}

/// Automated reasoning findings keep only their kind: their translations are deeply nested and
/// carry no action the provider reads.
fn automated_reasoning_policy(policy: &bt::GuardrailAutomatedReasoningPolicyAssessment) -> JsonValue {
    let findings = policy.findings.as_ref().map(|findings| {
        findings
            .iter()
            .map(|finding| {
                let kind = match finding {
                    bt::GuardrailAutomatedReasoningFinding::Valid(_) => "valid",
                    bt::GuardrailAutomatedReasoningFinding::Invalid(_) => "invalid",
                    bt::GuardrailAutomatedReasoningFinding::Satisfiable(_) => "satisfiable",
                    bt::GuardrailAutomatedReasoningFinding::Impossible(_) => "impossible",
                    bt::GuardrailAutomatedReasoningFinding::TranslationAmbiguous(_) => "translationAmbiguous",
                    bt::GuardrailAutomatedReasoningFinding::TooComplex(_) => "tooComplex",
                    bt::GuardrailAutomatedReasoningFinding::NoTranslations(_) => "noTranslations",
                    _ => "unknown",
                };
                JsonValue::Object(single(kind, json!({})))
            })
            .collect::<Vec<_>>()
    });
    Obj::default().opt("findings", findings).done()
}

fn invocation_metrics(metrics: &bt::GuardrailInvocationMetrics) -> JsonValue {
    let usage = metrics.usage.as_ref().map(|usage| {
        Obj::default()
            .set("topicPolicyUnits", usage.topic_policy_units)
            .set("contentPolicyUnits", usage.content_policy_units)
            .set("wordPolicyUnits", usage.word_policy_units)
            .set(
                "sensitiveInformationPolicyUnits",
                usage.sensitive_information_policy_units,
            )
            .set(
                "sensitiveInformationPolicyFreeUnits",
                usage.sensitive_information_policy_free_units,
            )
            .set(
                "contextualGroundingPolicyUnits",
                usage.contextual_grounding_policy_units,
            )
            .opt("contentPolicyImageUnits", usage.content_policy_image_units)
            .opt("automatedReasoningPolicyUnits", usage.automated_reasoning_policy_units)
            .opt("automatedReasoningPolicies", usage.automated_reasoning_policies)
            .done()
    });
    let coverage = metrics.guardrail_coverage.as_ref().map(|coverage| {
        let pair = |guarded: Option<i32>, total: Option<i32>| {
            Obj::default().opt("guarded", guarded).opt("total", total).done()
        };
        Obj::default()
            .opt(
                "textCharacters",
                coverage
                    .text_characters
                    .as_ref()
                    .map(|text| pair(text.guarded, text.total)),
            )
            .opt(
                "images",
                coverage
                    .images
                    .as_ref()
                    .map(|images| pair(images.guarded, images.total)),
            )
            .done()
    });
    Obj::default()
        .opt("guardrailProcessingLatency", metrics.guardrail_processing_latency)
        .opt("usage", usage)
        .opt("guardrailCoverage", coverage)
        .done()
}

fn applied_guardrail_details(details: &bt::AppliedGuardrailDetails) -> JsonValue {
    Obj::default()
        .opt("guardrailId", details.guardrail_id.clone())
        .opt("guardrailVersion", details.guardrail_version.clone())
        .opt("guardrailArn", details.guardrail_arn.clone())
        .opt(
            "guardrailOrigin",
            details
                .guardrail_origin
                .as_ref()
                .map(|origins| origins.iter().map(|origin| json!(origin.as_str())).collect::<Vec<_>>()),
        )
        .opt(
            "guardrailOwnership",
            details
                .guardrail_ownership
                .as_ref()
                .map(|ownership| ownership.as_str().to_owned()),
        )
        .done()
}
