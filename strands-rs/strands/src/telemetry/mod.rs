//! Telemetry: spans, metrics and the local [`AgentMetrics`] and [`AgentTrace`] an
//! [`AgentResult`](crate::AgentResult) carries.
//!
//! The agent records `tracing` spans: `invoke_agent <name>` for an invocation,
//! `execute_agent_loop_cycle` for each cycle, `chat` for each model call and `execute_tool <tool>`
//! for each tool call, with `gen_ai.*` attributes as span fields. `OTEL_SEMCONV_STABILITY_OPT_IN`
//! selects the conventions (`gen_ai_latest_experimental`, `gen_ai_tool_definitions`,
//! `gen_ai_span_attributes_only`), and a Langfuse endpoint records message content as span
//! attributes. Any `tracing` subscriber sees the spans.
//!
//! Span fields carry names, ids and token counts only, so a `fmt` subscriber's log lines stay
//! small. Message content (prompts, messages, tool arguments and results, tool definitions) is
//! recorded only on spans an OpenTelemetry layer exports.
//!
//! With the `otel` feature the spans also carry that content, their message events, custom
//! [`trace_attributes`](crate::AgentConfig::trace_attributes) and exception records, the agent's
//! [`baggage_attributes`](crate::AgentConfig::baggage_attributes) apply, and the meter records
//! the `gen_ai.agent.*` counters and histograms through the global meter provider.
//! [`setup_tracer`] and [`setup_meter`] build and register providers with OTLP HTTP and console
//! exporters; [`TracerGuard::try_init_subscriber`] installs a subscriber that exports the spans,
//! or add [`TracerGuard::layer`] to the application's own subscriber:
//!
//! ```no_run
//! # #[cfg(feature = "otel")]
//! # fn main() -> strands::Result<()> {
//! use strands::telemetry::{MeterConfig, TelemetryExporters, TracerConfig, setup_meter, setup_tracer};
//!
//! let exporters = TelemetryExporters { otlp: true, console: false };
//! let tracer = setup_tracer(TracerConfig { exporters, ..Default::default() })?;
//! let meter = setup_meter(MeterConfig { exporters, ..Default::default() })?;
//! tracer.try_init_subscriber()?;
//! // ... run agents; the guards flush when dropped.
//! # Ok(())
//! # }
//! # #[cfg(not(feature = "otel"))]
//! # fn main() {}
//! ```
//!
//! The spans are `INFO` spans with target `strands::telemetry`; a filter in front of the layer
//! (an `EnvFilter` on the registry) must allow `strands::telemetry=info`, or give the layer a
//! filter of its own.
//!
//! # Versions
//!
//! The `otel` feature exposes [`opentelemetry`], [`opentelemetry_sdk`], [`tracing_opentelemetry`]
//! and [`tracing_subscriber`] types in the public API and re-exports those crates. A strands
//! release that moves any of them to a new semver-incompatible version (a new `0.x` minor) is a
//! breaking release of strands; use the re-exports rather than your own dependencies so the
//! versions always match.
//!
// The `otel` items exist only with the feature; without it the links go to the feature list.
#![cfg_attr(
    feature = "otel",
    doc = "[`setup_tracer`]: setup_tracer\n[`setup_meter`]: setup_meter\n\
           [`TracerGuard::try_init_subscriber`]: TracerGuard::try_init_subscriber\n\
           [`TracerGuard::layer`]: TracerGuard::layer\n[`opentelemetry`]: opentelemetry\n\
           [`opentelemetry_sdk`]: opentelemetry_sdk\n[`tracing_opentelemetry`]: tracing_opentelemetry\n\
           [`tracing_subscriber`]: tracing_subscriber"
)]
#![cfg_attr(
    not(feature = "otel"),
    doc = "[`setup_tracer`]: crate#features\n[`setup_meter`]: crate#features\n\
           [`TracerGuard::try_init_subscriber`]: crate#features\n[`TracerGuard::layer`]: crate#features\n\
           [`opentelemetry`]: crate#features\n[`opentelemetry_sdk`]: crate#features\n\
           [`tracing_opentelemetry`]: crate#features\n[`tracing_subscriber`]: crate#features"
)]

mod baggage;
#[cfg(feature = "otel")]
mod config;
mod meter;
mod span;
mod tracer;
mod types;
mod utils;

#[cfg(test)]
#[cfg(feature = "otel")]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

pub(crate) use baggage::{in_current_context, with_baggage};
#[cfg(feature = "otel")]
pub use config::{
    BaggageKeyPredicate, BaggageKeyPredicates, BaggageProcessor, MeterConfig, MeterGuard, TelemetryExporters,
    TracerConfig, TracerGuard, get_meter, get_tracer, setup_meter, setup_tracer,
};
pub use meter::{AgentLoopMetricsData, AgentMetrics, InvocationMetricsData, ToolMetricsData, ToolUsage};
pub(crate) use meter::{Cycle, Meter};
pub(crate) use span::InSpan;
pub use tracer::AgentTrace;
pub(crate) use tracer::{
    AgentSpan, AgentSpanContext, EndAgentSpanOptions, EndMemoryAddSpanOptions, EndMemoryExtractSpanOptions,
    EndMemoryInjectSpanOptions, EndMemorySearchSpanOptions, EndModelSpanOptions, EndToolCallSpanOptions, ModelSpan,
    StartAgentSpanOptions, StartMemoryAddSpanOptions, StartMemoryExtractSpanOptions, StartMemoryInjectSpanOptions,
    StartMemorySearchSpanOptions, StartModelInvokeSpanOptions, ToolSpan, Tracer,
};
pub use types::AttributeValue;

/// The `opentelemetry` crate the SDK is built against; use it (not your own dependency) for
/// contexts and values, so the versions match.
#[cfg(feature = "otel")]
pub use opentelemetry;
/// The `opentelemetry_sdk` crate the SDK is built against, for custom providers.
#[cfg(feature = "otel")]
pub use opentelemetry_sdk;
/// The `tracing-opentelemetry` crate the SDK is built against, for custom layers.
#[cfg(feature = "otel")]
pub use tracing_opentelemetry;
/// The `tracing-subscriber` crate the SDK's layer is built for, to compose the subscriber the
/// layer goes into.
#[cfg(feature = "otel")]
pub use tracing_subscriber;
