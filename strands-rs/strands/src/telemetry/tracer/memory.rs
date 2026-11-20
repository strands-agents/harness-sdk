//! The memory spans: `memory.search`, `memory.add`, `memory.inject` and `memory.extract`.
//!
//! Queries, contents and results are span events, built only for a span an OpenTelemetry layer
//! exports; counts, store names and flags are span fields.

#[cfg(feature = "otel")]
use opentelemetry::trace::{SpanContext, TraceContextExt};
use tracing::Span;
use tracing::field::Empty;
#[cfg(feature = "otel")]
use tracing_opentelemetry::OpenTelemetrySpanExt;

use super::parts::to_json;
use super::{TARGET, Tracer};
use crate::memory::MemoryEntry;
use crate::telemetry::span::{Attributes, add_event, end_span, exports, start_span};
use crate::telemetry::types::AttributeValue;

macro_rules! memory_span {
    ($root:expr, $name:literal $(, $field:literal)* $(,)?) => {
        if $root {
            tracing::info_span!(
                target: TARGET, parent: None, $name,
                "otel.status_code" = Empty, "otel.status_description" = Empty,
                "gen_ai.event.start_time" = Empty, "gen_ai.event.end_time" = Empty,
                "gen_ai.operation.name" = Empty, "gen_ai.system" = Empty, "gen_ai.provider.name" = Empty,
                $($field = Empty),*
            )
        } else {
            tracing::info_span!(
                target: TARGET, $name,
                "otel.status_code" = Empty, "otel.status_description" = Empty,
                "gen_ai.event.start_time" = Empty, "gen_ai.event.end_time" = Empty,
                "gen_ai.operation.name" = Empty, "gen_ai.system" = Empty, "gen_ai.provider.name" = Empty,
                $($field = Empty),*
            )
        }
    };
}

/// The span context of the agent run that scheduled an extraction, linked from its
/// `memory.extract` span. Without the `otel` feature there is none.
#[derive(Debug, Clone)]
pub(crate) struct AgentSpanContext {
    #[cfg(feature = "otel")]
    context: SpanContext,
}

impl AgentSpanContext {
    #[cfg(all(test, feature = "otel"))]
    pub(crate) fn new(context: SpanContext) -> Self {
        Self { context }
    }

    #[cfg(feature = "otel")]
    fn valid(&self) -> Option<&SpanContext> {
        self.context.is_valid().then_some(&self.context)
    }
}

/// An open memory span; the matching `end_memory_*_span` ends it. [`MemorySpan::none`] is a span
/// whose start failed: ending it does nothing.
#[derive(Debug)]
pub(crate) struct MemorySpan {
    span: Option<Span>,
}

impl MemorySpan {
    /// No span.
    #[cfg(test)]
    pub(crate) fn none() -> Self {
        Self { span: None }
    }

    /// The span, to run nested work in it.
    pub(crate) fn span(&self) -> Span {
        self.span.clone().unwrap_or_else(Span::none)
    }
}

/// Options for [`Tracer::start_memory_search_span`] (`StartMemorySearchSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StartMemorySearchSpanOptions<'a> {
    pub(crate) query: &'a str,
    pub(crate) store_names: &'a [String],
    pub(crate) max_search_results: Option<usize>,
}

/// Options for [`Tracer::end_memory_search_span`] (`EndMemorySearchSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct EndMemorySearchSpanOptions<'a> {
    pub(crate) entries: &'a [MemoryEntry],
    pub(crate) store_failure_count: usize,
    pub(crate) error: Option<&'a str>,
}

/// Options for [`Tracer::start_memory_add_span`] (`StartMemoryAddSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StartMemoryAddSpanOptions<'a> {
    pub(crate) content: &'a str,
    pub(crate) store_names: &'a [String],
    pub(crate) force_root: bool,
}

/// Options for [`Tracer::end_memory_add_span`] (`EndMemoryAddSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct EndMemoryAddSpanOptions<'a> {
    pub(crate) store_failure_count: usize,
    pub(crate) error: Option<&'a str>,
}

/// Options for [`Tracer::start_memory_inject_span`] (`StartMemoryInjectSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StartMemoryInjectSpanOptions {
    pub(crate) max_entries: Option<usize>,
}

/// Options for [`Tracer::end_memory_inject_span`] (`EndMemoryInjectSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct EndMemoryInjectSpanOptions {
    pub(crate) injected: bool,
    pub(crate) entry_count: usize,
    pub(crate) format_error: bool,
}

/// Options for [`Tracer::start_memory_extract_span`] (`StartMemoryExtractSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StartMemoryExtractSpanOptions<'a> {
    pub(crate) store_name: &'a str,
    pub(crate) message_count: usize,
    pub(crate) filtered_count: usize,
    pub(crate) extractor: Option<&'a str>,
    pub(crate) agent_span_context: Option<&'a AgentSpanContext>,
}

/// Options for [`Tracer::end_memory_extract_span`] (`EndMemoryExtractSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct EndMemoryExtractSpanOptions<'a> {
    pub(crate) entry_count: Option<usize>,
    pub(crate) error: Option<&'a str>,
}

fn count(value: usize) -> AttributeValue {
    AttributeValue::from(u64::try_from(value).unwrap_or(u64::MAX))
}

impl Tracer {
    /// Starts a `memory.search` span under the current span, with the query as a `memory.query`
    /// event. Memory payloads may hold personal data; suppress span
    /// content at the exporter or processor when that matters.
    pub(crate) fn start_memory_search_span(&self, options: StartMemorySearchSpanOptions<'_>) -> MemorySpan {
        let span = memory_span!(
            false,
            "memory.search",
            "memory.store.names",
            "memory.store.count",
            "memory.max_search_results",
            "memory.result.count",
            "memory.store.failure_count",
        );
        if !span.is_disabled() {
            let mut attributes = self.store_attributes("memory.search", options.store_names);
            if let Some(max) = options.max_search_results {
                attributes.set("memory.max_search_results", count(max));
            }
            start_span(&span, attributes);
            self.add_content_event(&span, "memory.query", options.query);
        }
        MemorySpan { span: Some(span) }
    }

    /// Ends a `memory.search` span with the result and store failure counts, and the entries as a
    /// `memory.results` event unless the search failed. Store failures are
    /// logged and skipped, so only `error` marks the span failed.
    pub(crate) fn end_memory_search_span(&self, span: MemorySpan, options: EndMemorySearchSpanOptions<'_>) {
        let Some(span) = span.span.filter(|span| !span.is_disabled()) else {
            return;
        };
        let mut attributes = Attributes::new();
        attributes.set("memory.result.count", count(options.entries.len()));
        attributes.set("memory.store.failure_count", count(options.store_failure_count));
        if options.error.is_none() {
            self.add_content_event(&span, "memory.results", &to_json(options.entries));
        }
        end_span(&span, attributes, options.error);
    }

    /// Starts a `memory.add` span, under the current span or as a trace root for a detached write,
    /// with the content as a `memory.content` event.
    pub(crate) fn start_memory_add_span(&self, options: StartMemoryAddSpanOptions<'_>) -> MemorySpan {
        let span = memory_span!(
            options.force_root,
            "memory.add",
            "memory.store.names",
            "memory.store.count",
            "memory.store.failure_count",
        );
        if !span.is_disabled() {
            start_span(&span, self.store_attributes("memory.add", options.store_names));
            self.add_content_event(&span, "memory.content", options.content);
        }
        MemorySpan { span: Some(span) }
    }

    /// Ends a `memory.add` span with the count of failed store writes.
    pub(crate) fn end_memory_add_span(&self, span: MemorySpan, options: EndMemoryAddSpanOptions<'_>) {
        let Some(span) = span.span.filter(|span| !span.is_disabled()) else {
            return;
        };
        let mut attributes = Attributes::new();
        attributes.set("memory.store.failure_count", count(options.store_failure_count));
        end_span(&span, attributes, options.error);
    }

    /// Starts a `memory.inject` span under the current span.
    pub(crate) fn start_memory_inject_span(&self, options: StartMemoryInjectSpanOptions) -> MemorySpan {
        let span = memory_span!(
            false,
            "memory.inject",
            "memory.max_entries",
            "memory.injected",
            "memory.entry.count",
            "memory.inject.format_error",
        );
        if !span.is_disabled() {
            let mut attributes = self.common_attributes("memory.inject");
            if let Some(max) = options.max_entries {
                attributes.set("memory.max_entries", count(max));
            }
            start_span(&span, attributes);
        }
        MemorySpan { span: Some(span) }
    }

    /// Ends a `memory.inject` span. Injection fails open, so a format
    /// failure ends the span OK with `memory.inject.format_error`.
    pub(crate) fn end_memory_inject_span(&self, span: MemorySpan, options: EndMemoryInjectSpanOptions) {
        let Some(span) = span.span.filter(|span| !span.is_disabled()) else {
            return;
        };
        let mut attributes = Attributes::new();
        attributes.set("memory.injected", options.injected);
        attributes.set("memory.entry.count", count(options.entry_count));
        if options.format_error {
            attributes.set("memory.inject.format_error", true);
        }
        end_span(&span, attributes, None);
    }

    /// Starts a `memory.extract` span as a trace root: extraction runs
    /// detached from the invocation that scheduled it, so the span links to that run's agent span
    /// and records its ids as `memory.parent.trace_id` and `memory.parent.span_id` for backends
    /// that do not show links.
    pub(crate) fn start_memory_extract_span(&self, options: StartMemoryExtractSpanOptions<'_>) -> MemorySpan {
        let span = memory_span!(
            true,
            "memory.extract",
            "memory.store.name",
            "memory.message.count",
            "memory.message.filtered_count",
            "memory.extractor",
            "memory.parent.trace_id",
            "memory.parent.span_id",
            "memory.entry.count",
        );
        if !span.is_disabled() {
            let mut attributes = self.common_attributes("memory.extract");
            attributes.set("memory.store.name", options.store_name);
            attributes.set("memory.message.count", count(options.message_count));
            attributes.set("memory.message.filtered_count", count(options.filtered_count));
            if let Some(extractor) = options.extractor {
                attributes.set("memory.extractor", extractor);
            }
            link_agent_span(&span, &mut attributes, options.agent_span_context);
            start_span(&span, attributes);
        }
        MemorySpan { span: Some(span) }
    }

    /// Ends a `memory.extract` span with the count of entries written.
    pub(crate) fn end_memory_extract_span(&self, span: MemorySpan, options: EndMemoryExtractSpanOptions<'_>) {
        let Some(span) = span.span.filter(|span| !span.is_disabled()) else {
            return;
        };
        let mut attributes = Attributes::new();
        if let Some(entry_count) = options.entry_count {
            attributes.set("memory.entry.count", count(entry_count));
        }
        end_span(&span, attributes, options.error);
    }

    /// The span context of the current span, when it is recorded with a valid context.
    #[cfg(feature = "otel")]
    pub(crate) fn current_span_context(&self) -> Option<AgentSpanContext> {
        let span = Span::current();
        if span.is_disabled() {
            return None;
        }
        let context = span.context().span().span_context().clone();
        context.is_valid().then_some(AgentSpanContext { context })
    }

    /// Without the `otel` feature there is no span context to link.
    #[cfg(not(feature = "otel"))]
    pub(crate) fn current_span_context(&self) -> Option<AgentSpanContext> {
        None
    }

    fn store_attributes(&self, operation_name: &str, store_names: &[String]) -> Attributes {
        let mut attributes = self.common_attributes(operation_name);
        attributes.set("memory.store.names", to_json(store_names));
        attributes.set("memory.store.count", count(store_names.len()));
        attributes
    }

    fn add_content_event(&self, span: &Span, name: &'static str, content: &str) {
        if exports(span) {
            add_event(
                span,
                name,
                vec![("content", content.to_owned())],
                self.settings.span_attributes_only,
            );
        }
    }
}

#[cfg(feature = "otel")]
fn link_agent_span(span: &Span, attributes: &mut Attributes, agent_span_context: Option<&AgentSpanContext>) {
    let Some(context) = agent_span_context.and_then(AgentSpanContext::valid) else {
        return;
    };
    attributes.set("memory.parent.trace_id", context.trace_id().to_string());
    attributes.set("memory.parent.span_id", context.span_id().to_string());
    span.add_link(context.clone());
}

#[cfg(not(feature = "otel"))]
fn link_agent_span(_span: &Span, _attributes: &mut Attributes, _agent_span_context: Option<&AgentSpanContext>) {}

#[cfg(test)]
mod tests;
