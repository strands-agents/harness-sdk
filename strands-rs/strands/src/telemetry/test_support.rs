//! Span capture for telemetry tests: the SDK's layer over an in-memory exporter, as the current
//! thread's subscriber.

use std::sync::LazyLock;

use opentelemetry::trace::{Status, TracerProvider as _};
use opentelemetry::{KeyValue, Value};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
use tracing::Metadata;
use tracing::subscriber::DefaultGuard;
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{Layer, registry};

use super::config::{BaggageProcessor, BaggageSpanProcessor, otel_layer};

/// A second dispatcher keeps callsite interest from being cached as never enabled by another
/// test's thread (see `crate::test_support`).
static KEEP_INTEREST: LazyLock<tracing::Dispatch> = LazyLock::new(|| tracing::Dispatch::new(registry()));

/// Records the spans finished on this thread until it drops.
pub(crate) struct SpanCapture {
    exporter: InMemorySpanExporter,
    provider: SdkTracerProvider,
    _guard: DefaultGuard,
}

/// Captures every span the SDK records on this thread.
pub(crate) fn capture_spans() -> SpanCapture {
    capture_spans_except(|_| true)
}

/// Captures every span, with every baggage entry stamped on as an attribute.
pub(crate) fn capture_spans_with_baggage() -> SpanCapture {
    capture(|_| true, true)
}

/// Captures the spans `keep` lets through; the others are disabled, as a span whose start failed.
pub(crate) fn capture_spans_except(keep: impl Fn(&Metadata<'_>) -> bool + Send + Sync + 'static) -> SpanCapture {
    capture(keep, false)
}

fn capture(keep: impl Fn(&Metadata<'_>) -> bool + Send + Sync + 'static, baggage: bool) -> SpanCapture {
    LazyLock::force(&KEEP_INTEREST);
    let exporter = InMemorySpanExporter::default();
    let mut builder = SdkTracerProvider::builder();
    if baggage {
        builder = builder.with_span_processor(BaggageSpanProcessor::new(BaggageProcessor::AllKeys));
    }
    let provider = builder.with_simple_exporter(exporter.clone()).build();
    let layer = otel_layer(provider.tracer("test")).with_filter(filter_fn(move |metadata| keep(metadata)));
    let guard = tracing::subscriber::set_default(registry().with(layer));
    tracing::callsite::rebuild_interest_cache();
    SpanCapture {
        exporter,
        provider,
        _guard: guard,
    }
}

impl SpanCapture {
    /// The finished spans, in end order.
    pub(crate) fn spans(&self) -> Vec<SpanData> {
        let _ = self.provider.force_flush();
        self.exporter.get_finished_spans().unwrap_or_default()
    }

    /// Forgets the spans finished so far.
    pub(crate) fn reset(&self) {
        let _ = self.provider.force_flush();
        self.exporter.reset();
    }

    /// The finished spans with `name`.
    pub(crate) fn named(&self, name: &str) -> Vec<SpanData> {
        self.spans().into_iter().filter(|span| span.name == name).collect()
    }

    /// The one finished span with `name`.
    pub(crate) fn span(&self, name: &str) -> SpanData {
        let mut spans = self.named(name);
        assert_eq!(spans.len(), 1, "expected one `{name}` span, got {}", spans.len());
        spans.remove(0)
    }
}

/// An attribute of a span.
pub(crate) fn attr(span: &SpanData, key: &str) -> Option<Value> {
    find(&span.attributes, key)
}

/// A string attribute of a span.
pub(crate) fn attr_str(span: &SpanData, key: &str) -> Option<String> {
    attr(span, key).map(|value| value.as_str().into_owned())
}

/// An integer attribute of a span.
pub(crate) fn attr_i64(span: &SpanData, key: &str) -> Option<i64> {
    match attr(span, key)? {
        Value::I64(value) => Some(value),
        other => panic!("attribute {key} is not an integer: {other:?}"),
    }
}

fn find(attributes: &[KeyValue], key: &str) -> Option<Value> {
    let mut matching = attributes.iter().filter(|kv| kv.key.as_str() == key);
    let found = matching.next().map(|kv| kv.value.clone());
    assert!(matching.next().is_none(), "attribute {key} recorded twice");
    found
}

/// The events of a span with `name`.
pub(crate) fn events(span: &SpanData, name: &str) -> Vec<opentelemetry::trace::Event> {
    span.events.iter().filter(|event| event.name == name).cloned().collect()
}

/// A string attribute of an event.
pub(crate) fn event_attr(event: &opentelemetry::trace::Event, key: &str) -> String {
    find(&event.attributes, key)
        .unwrap_or_else(|| panic!("event {} has no attribute {key}", event.name))
        .as_str()
        .into_owned()
}

/// A JSON string attribute of an event, parsed.
pub(crate) fn event_json(event: &opentelemetry::trace::Event, key: &str) -> serde_json::Value {
    serde_json::from_str(&event_attr(event, key)).unwrap()
}

/// Whether a span ended with an error status carrying `message`.
pub(crate) fn is_error(span: &SpanData, message: &str) -> bool {
    matches!(&span.status, Status::Error { description } if description == message)
}

/// The exception event messages of a span.
pub(crate) fn exceptions(span: &SpanData) -> Vec<String> {
    events(span, "exception")
        .iter()
        .map(|event| event_attr(event, "exception.message"))
        .collect()
}
