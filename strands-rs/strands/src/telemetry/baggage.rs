//! Agent baggage: an invocation runs with the agent's `baggage_attributes` merged into the
//! OpenTelemetry baggage active when it starts, and work spawned onto its own task keeps the
//! caller's span and context.

use std::collections::BTreeMap;
use std::future::Future;

#[cfg(feature = "otel")]
use futures::future::Either;
#[cfg(feature = "otel")]
use opentelemetry::Context;
#[cfg(feature = "otel")]
use opentelemetry::baggage::{Baggage, BaggageExt};
#[cfg(feature = "otel")]
use opentelemetry::trace::FutureExt;
use tracing::{Instrument, Span};

/// Runs `future` with `entries` merged over the caller's baggage, attached on every poll so the
/// spans, hooks and tools of the invocation see it and nothing outside does. Without entries the
/// future runs unchanged.
#[cfg(feature = "otel")]
pub(crate) fn with_baggage<F>(future: F, entries: BTreeMap<String, String>) -> impl Future<Output = F::Output> + Send
where
    F: Future + Send,
{
    if entries.is_empty() {
        return Either::Left(future);
    }
    Either::Right(async move {
        let context = merged_baggage(&Context::current(), &entries);
        future.with_context(context).await
    })
}

/// Without the `otel` feature there is no OpenTelemetry context to carry baggage.
#[cfg(not(feature = "otel"))]
pub(crate) fn with_baggage<F>(future: F, _entries: BTreeMap<String, String>) -> F
where
    F: Future + Send,
{
    future
}

/// Runs `future` in the span current where it is created and, with `otel`, in the OpenTelemetry
/// context current there (baggage and active span), so a task spawned for it sees what the
/// caller saw.
///
/// The span is entered outside the context: entering a span an OpenTelemetry layer records
/// attaches that span's own context, which lacks baggage added after it started.
pub(crate) fn in_current_context<F: Future>(future: F) -> impl Future<Output = F::Output> {
    #[cfg(feature = "otel")]
    let future = future.with_current_context();
    future.instrument(Span::current())
}

#[cfg(feature = "otel")]
fn merged_baggage(context: &Context, entries: &BTreeMap<String, String>) -> Context {
    let mut baggage = Baggage::new();
    for (key, (value, metadata)) in context.baggage() {
        baggage.insert_with_metadata(key.clone(), value.clone(), metadata.clone());
    }
    for (key, value) in entries {
        baggage.insert(key.clone(), value.clone());
    }
    context.with_baggage(baggage)
}
