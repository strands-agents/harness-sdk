//! Recording attributes, events and status on the SDK's `tracing` spans.
//!
//! Attributes with a field the span declares (names, ids, token counts) are recorded as `tracing`
//! fields, which every subscriber sees and `tracing-opentelemetry` exports under the same name.
//! Other keys (message content, custom trace attributes), span events and exception records need
//! the `otel` feature: they go to the OpenTelemetry span through `tracing-opentelemetry`, and are
//! dropped without it. Content is built only for a span an OpenTelemetry layer [`exports`].

use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};

use futures::Stream;
use indexmap::IndexMap;
#[cfg(feature = "otel")]
use opentelemetry::KeyValue;
#[cfg(feature = "otel")]
use opentelemetry::trace::TraceContextExt;
use tracing::Span;
#[cfg(feature = "otel")]
use tracing_opentelemetry::OpenTelemetrySpanExt;

use super::types::AttributeValue;
use crate::clock::iso_timestamp;

/// Span attributes in insertion order; a later insert of the same key replaces the value in
/// place.
#[derive(Debug, Default, Clone)]
pub(crate) struct Attributes(IndexMap<String, AttributeValue>);

impl Attributes {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn set(&mut self, key: &str, value: impl Into<AttributeValue>) {
        self.0.insert(key.to_owned(), value.into());
    }

    pub(crate) fn extend<'a>(&mut self, attributes: impl IntoIterator<Item = &'a (String, AttributeValue)>) {
        for (key, value) in attributes {
            self.0.insert(key.clone(), value.clone());
        }
    }
}

/// Whether an OpenTelemetry layer records `span` (it has a valid OpenTelemetry span context), so
/// its content attributes and events are worth building.
#[cfg(feature = "otel")]
pub(crate) fn exports(span: &Span) -> bool {
    !span.is_disabled() && span.context().span().span_context().is_valid()
}

/// Without the `otel` feature nothing records content.
#[cfg(not(feature = "otel"))]
pub(crate) fn exports(_span: &Span) -> bool {
    false
}

/// Records attributes on a span, each once.
pub(crate) fn record_attributes(span: &Span, attributes: Attributes) {
    for (key, value) in attributes.0 {
        record_attribute(span, &key, value);
    }
}

fn record_attribute(span: &Span, key: &str, value: AttributeValue) {
    if !span.has_field(key) {
        set_otel_attribute(span, key, value);
        return;
    }
    match value {
        AttributeValue::String(value) => {
            span.record(key, value.as_str());
        }
        AttributeValue::Bool(value) => {
            span.record(key, value);
        }
        AttributeValue::I64(value) => {
            span.record(key, value);
        }
        AttributeValue::F64(value) => {
            span.record(key, value);
        }
        array => set_otel_attribute(span, key, array),
    }
}

#[cfg(feature = "otel")]
fn set_otel_attribute(span: &Span, key: &str, value: AttributeValue) {
    span.set_attribute(key.to_owned(), opentelemetry::Value::from(value));
}

#[cfg(not(feature = "otel"))]
fn set_otel_attribute(_span: &Span, _key: &str, _value: AttributeValue) {}

/// Records the start attributes and `gen_ai.event.start_time`.
pub(crate) fn start_span(span: &Span, mut attributes: Attributes) {
    attributes.set("gen_ai.event.start_time", iso_timestamp());
    record_attributes(span, attributes);
}

/// Records the end attributes, the status and an exception for `error`.
pub(crate) fn end_span(span: &Span, attributes: Attributes, error: Option<&str>) {
    let mut end = Attributes::new();
    end.set("gen_ai.event.end_time", iso_timestamp());
    end.0.extend(attributes.0);
    record_attributes(span, end);
    let Some(message) = error else {
        span.record("otel.status_code", "ok");
        return;
    };
    span.record("otel.status_code", "error");
    span.record("otel.status_description", message);
    add_otel_event(span, "exception", vec![("exception.message", message.to_owned())]);
}

/// Adds an event, or records its attributes on the span instead when `to_span_attributes` is set.
pub(crate) fn add_event(
    span: &Span,
    name: &'static str,
    attributes: Vec<(&'static str, String)>,
    to_span_attributes: bool,
) {
    if !to_span_attributes {
        add_otel_event(span, name, attributes);
        return;
    }
    let mut recorded = Attributes::new();
    for (key, value) in attributes {
        recorded.set(key, value);
    }
    record_attributes(span, recorded);
}

#[cfg(feature = "otel")]
fn add_otel_event(span: &Span, name: &'static str, attributes: Vec<(&'static str, String)>) {
    let attributes = attributes
        .into_iter()
        .map(|(key, value)| KeyValue::new(key, value))
        .collect();
    span.add_event(name, attributes);
}

#[cfg(not(feature = "otel"))]
fn add_otel_event(_span: &Span, _name: &'static str, _attributes: Vec<(&'static str, String)>) {}

/// A stream polled inside a span, so code it runs sees the span as current.
pub(crate) struct InSpan<S> {
    stream: S,
    span: Span,
}

impl<S> InSpan<S> {
    pub(crate) fn new(stream: S, span: Span) -> Self {
        Self { stream, span }
    }
}

impl<S: Stream + Unpin> Stream for InSpan<S> {
    type Item = S::Item;

    fn poll_next(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let _entered = this.span.enter();
        Pin::new(&mut this.stream).poll_next(cx)
    }
}
