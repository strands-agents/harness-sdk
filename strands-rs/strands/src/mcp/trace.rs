//! W3C trace context in MCP tool call arguments.

use crate::types::{JsonObject, JsonValue};

/// Reads the trace context to propagate: `Ok(None)` without an active span, `Err` when
/// propagation fails.
pub(crate) type TraceCarrierFn = fn() -> Result<Option<JsonObject>, String>;

/// The active OpenTelemetry context, injected through the global text map propagator.
#[cfg(feature = "otel")]
pub(crate) fn current_trace_carrier() -> Result<Option<JsonObject>, String> {
    use std::collections::HashMap;

    use opentelemetry::trace::TraceContextExt;
    use tracing_opentelemetry::OpenTelemetrySpanExt;

    let context = tracing::Span::current().context();
    if !context.span().span_context().is_valid() {
        return Ok(None);
    }
    let mut carrier: HashMap<String, String> = HashMap::new();
    opentelemetry::global::get_text_map_propagator(|propagator| propagator.inject_context(&context, &mut carrier));
    let mut keys: Vec<_> = carrier.into_iter().collect();
    keys.sort();
    Ok(Some(
        keys.into_iter()
            .map(|(key, value)| (key, JsonValue::String(value)))
            .collect(),
    ))
}

/// Without the `otel` feature there is no OpenTelemetry context to propagate.
#[cfg(not(feature = "otel"))]
pub(crate) fn current_trace_carrier() -> Result<Option<JsonObject>, String> {
    Ok(None)
}

/// Adds the trace context to `args._meta`, merged over an existing `_meta` object. Arguments
/// stay unchanged without an active span or when propagation fails.
pub(crate) fn inject_trace_context(mut args: JsonObject, carrier: TraceCarrierFn) -> JsonObject {
    let carrier = match carrier() {
        Ok(Some(carrier)) => carrier,
        Ok(None) => return args,
        Err(error) => {
            tracing::warn!("error=<{error}> | failed to inject trace context into mcp tool call args");
            return args;
        }
    };
    let meta = match args.get("_meta") {
        Some(JsonValue::Object(existing)) => {
            let mut merged = existing.clone();
            merged.extend(carrier);
            merged
        }
        _ => carrier,
    };
    args.insert("_meta".to_owned(), JsonValue::Object(meta));
    args
}
