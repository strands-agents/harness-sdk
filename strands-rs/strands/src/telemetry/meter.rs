//! Agent loop metrics: the [`AgentMetrics`] snapshot and the OpenTelemetry counters and
//! histograms.

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use std::sync::{Arc, Mutex, PoisonError};

#[cfg(feature = "otel")]
use opentelemetry::metrics::{Counter, Histogram};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::tracer::{LoopSpan, Tracer};
use crate::models::streaming::{Metrics, Usage};
use crate::types::Message;

/// Per-tool execution metrics (`ToolMetricsData`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolMetricsData {
    /// Total number of calls to the tool.
    pub call_count: u64,
    /// Number of successful calls.
    pub success_count: u64,
    /// Number of failed calls.
    pub error_count: u64,
    /// Total execution time in milliseconds.
    pub total_time: u64,
}

impl ToolMetricsData {
    /// Sets the total number of calls.
    #[must_use]
    pub fn with_call_count(mut self, call_count: u64) -> Self {
        self.call_count = call_count;
        self
    }

    /// Sets the number of successful calls.
    #[must_use]
    pub fn with_success_count(mut self, success_count: u64) -> Self {
        self.success_count = success_count;
        self
    }

    /// Sets the number of failed calls.
    #[must_use]
    pub fn with_error_count(mut self, error_count: u64) -> Self {
        self.error_count = error_count;
        self
    }

    /// Sets the total execution time in milliseconds.
    #[must_use]
    pub fn with_total_time(mut self, total_time: u64) -> Self {
        self.total_time = total_time;
        self
    }
}

/// [`ToolMetricsData`] with computed averages, as returned by [`AgentMetrics::tool_usage`].
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct ToolUsage {
    /// The raw counts.
    pub metrics: ToolMetricsData,
    /// Average execution time in milliseconds, or 0 without calls.
    pub average_time: f64,
    /// Fraction of calls that succeeded, or 0 without calls.
    pub success_rate: f64,
}

/// Usage of one agent loop cycle (`AgentLoopMetricsData`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct AgentLoopMetricsData {
    /// Unique identifier of the cycle.
    pub cycle_id: String,
    /// Duration of the cycle in milliseconds.
    pub duration: u64,
    /// Token usage of the cycle.
    pub usage: Usage,
}

impl AgentLoopMetricsData {
    /// Creates cycle metrics.
    pub fn new(cycle_id: impl Into<String>, duration: u64, usage: Usage) -> Self {
        Self {
            cycle_id: cycle_id.into(),
            duration,
            usage,
        }
    }
}

/// Metrics of one invocation (`InvocationMetricsData`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct InvocationMetricsData {
    /// The cycles of the invocation.
    pub cycles: Vec<AgentLoopMetricsData>,
    /// Token usage accumulated over the invocation.
    pub usage: Usage,
}

impl InvocationMetricsData {
    /// Creates invocation metrics.
    pub fn new(cycles: Vec<AgentLoopMetricsData>, usage: Usage) -> Self {
        Self { cycles, usage }
    }
}

/// Read-only snapshot of an agent's aggregated loop metrics (`AgentMetrics`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct AgentMetrics {
    /// Total number of agent loop cycles across all invocations.
    #[serde(default)]
    pub cycle_count: u64,
    /// Token usage accumulated across all model calls.
    #[serde(default)]
    pub accumulated_usage: Usage,
    /// Performance metrics accumulated across all model calls.
    #[serde(default)]
    pub accumulated_metrics: Metrics,
    /// Metrics of the most recent invocations (at most 50).
    #[serde(default)]
    pub agent_invocations: Vec<InvocationMetricsData>,
    /// Per-tool metrics by tool name, in first-use order.
    #[serde(default, with = "named_metrics")]
    pub tool_metrics: Vec<(String, ToolMetricsData)>,
    /// Total duration of all cycles in milliseconds.
    #[serde(default)]
    pub total_duration: u64,
    /// The whole prompt of the last model call, cached tokens included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_context_size: Option<u64>,
    /// Projected context size of the next model call: the last prompt plus its output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projected_context_size: Option<u64>,
}

impl AgentMetrics {
    /// Creates empty metrics.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the latest context size.
    #[must_use]
    pub fn with_latest_context_size(mut self, size: u64) -> Self {
        self.latest_context_size = Some(size);
        self
    }

    /// Sets the projected context size.
    #[must_use]
    pub fn with_projected_context_size(mut self, size: u64) -> Self {
        self.projected_context_size = Some(size);
        self
    }

    /// The most recent invocation.
    #[must_use]
    pub fn latest_agent_invocation(&self) -> Option<&InvocationMetricsData> {
        self.agent_invocations.last()
    }

    /// Accumulated usage and performance metrics together.
    #[must_use]
    pub fn accumulated_data(&self) -> (&Usage, &Metrics) {
        (&self.accumulated_usage, &self.accumulated_metrics)
    }

    /// Average cycle duration in milliseconds, or 0 without cycles.
    #[must_use]
    #[allow(clippy::cast_precision_loss, reason = "millisecond totals stay far below 2^52")]
    pub fn average_cycle_time(&self) -> f64 {
        if self.cycle_count == 0 {
            return 0.0;
        }
        self.total_duration as f64 / self.cycle_count as f64
    }

    /// Metrics of one tool by name.
    #[must_use]
    pub fn tool(&self, name: &str) -> Option<&ToolMetricsData> {
        self.tool_metrics
            .iter()
            .find_map(|(tool, metrics)| (tool == name).then_some(metrics))
    }

    /// Per-tool statistics with averages and success rates.
    #[must_use]
    #[allow(
        clippy::cast_precision_loss,
        reason = "call counts and millisecond totals stay far below 2^52"
    )]
    pub fn tool_usage(&self) -> Vec<(String, ToolUsage)> {
        self.tool_metrics
            .iter()
            .map(|(name, metrics)| {
                let calls = metrics.call_count as f64;
                let (average_time, success_rate) = if metrics.call_count == 0 {
                    (0.0, 0.0)
                } else {
                    (metrics.total_time as f64 / calls, metrics.success_count as f64 / calls)
                };
                let usage = ToolUsage {
                    metrics: *metrics,
                    average_time,
                    success_rate,
                };
                (name.clone(), usage)
            })
            .collect()
    }
}

mod named_metrics {
    use super::*;

    pub(super) fn serialize<S: Serializer>(
        metrics: &[(String, ToolMetricsData)],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(metrics.len()))?;
        for (name, data) in metrics {
            map.serialize_entry(name, data)?;
        }
        map.end()
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<(String, ToolMetricsData)>, D::Error> {
        deserializer.deserialize_map(NamedVisitor)
    }

    struct NamedVisitor;

    impl<'de> Visitor<'de> for NamedVisitor {
        type Value = Vec<(String, ToolMetricsData)>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a map of tool metrics by tool name")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
            let mut metrics = Vec::new();
            while let Some(entry) = access.next_entry()? {
                metrics.push(entry);
            }
            Ok(metrics)
        }
    }
}

const MAX_INVOCATION_HISTORY: usize = 50;

/// The kind of an OpenTelemetry instrument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstrumentKind {
    Counter,
    Histogram,
}

/// One OpenTelemetry instrument the meter records, with its name, description and unit.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "the instruments read the names under otel; the conformance test reads all"
    )
)]
pub(crate) struct InstrumentSpec {
    pub(crate) kind: InstrumentKind,
    pub(crate) name: &'static str,
    pub(crate) description: &'static str,
    pub(crate) unit: Option<&'static str>,
}

const fn counter(name: &'static str, description: &'static str) -> InstrumentSpec {
    InstrumentSpec {
        kind: InstrumentKind::Counter,
        name,
        description,
        unit: None,
    }
}

const fn histogram(name: &'static str, description: &'static str, unit: &'static str) -> InstrumentSpec {
    InstrumentSpec {
        kind: InstrumentKind::Histogram,
        name,
        description,
        unit: Some(unit),
    }
}

const CYCLE_COUNT: InstrumentSpec = counter("gen_ai.agent.cycle.count", "Number of agent loop cycles executed");
const INVOCATION_COUNT: InstrumentSpec = counter("gen_ai.agent.invocation.count", "Number of agent invocations");
const CYCLE_DURATION: InstrumentSpec = histogram(
    "gen_ai.agent.cycle.duration",
    "Duration of agent loop cycles in milliseconds",
    "ms",
);
const TOOL_CALL_COUNT: InstrumentSpec = counter("gen_ai.agent.tool.call.count", "Number of tool calls");
const TOOL_ERROR_COUNT: InstrumentSpec = counter("gen_ai.agent.tool.error.count", "Number of failed tool calls");
const TOOL_DURATION: InstrumentSpec = histogram(
    "gen_ai.agent.tool.duration",
    "Duration of tool calls in milliseconds",
    "ms",
);
const TOKENS_INPUT: InstrumentSpec = counter("gen_ai.agent.tokens.input", "Input tokens consumed");
const TOKENS_OUTPUT: InstrumentSpec = counter("gen_ai.agent.tokens.output", "Output tokens consumed");
const MODEL_LATENCY: InstrumentSpec = histogram(
    "gen_ai.agent.model.latency",
    "Model invocation latency in milliseconds",
    "ms",
);
// OTel GenAI semconv requires seconds for this metric, unlike the SDK-internal histograms.
const TIME_TO_FIRST_TOKEN: InstrumentSpec = histogram(
    "gen_ai.server.time_to_first_token",
    "Time to generate first token for successful responses",
    "s",
);

/// The instruments in the order the meter creates them.
#[cfg_attr(not(test), allow(dead_code, reason = "the conformance test reads the table"))]
pub(crate) const INSTRUMENTS: [InstrumentSpec; 10] = [
    CYCLE_COUNT,
    INVOCATION_COUNT,
    CYCLE_DURATION,
    TOOL_CALL_COUNT,
    TOOL_ERROR_COUNT,
    TOOL_DURATION,
    TOKENS_INPUT,
    TOKENS_OUTPUT,
    MODEL_LATENCY,
    TIME_TO_FIRST_TOKEN,
];

/// The OpenTelemetry instruments of a meter; no-ops until a meter provider is registered.
#[cfg(feature = "otel")]
#[derive(Debug)]
struct Instruments {
    cycle_count: Counter<u64>,
    invocation_count: Counter<u64>,
    cycle_duration: Histogram<f64>,
    tool_call_count: Counter<u64>,
    tool_error_count: Counter<u64>,
    tool_duration: Histogram<f64>,
    tokens_input: Counter<u64>,
    tokens_output: Counter<u64>,
    model_latency: Histogram<f64>,
    time_to_first_token: Histogram<f64>,
}

#[cfg(feature = "otel")]
impl Instruments {
    fn new(meter: &opentelemetry::metrics::Meter) -> Self {
        let counter = |spec: InstrumentSpec| meter.u64_counter(spec.name).with_description(spec.description).build();
        let histogram = |spec: InstrumentSpec| {
            let builder = meter.f64_histogram(spec.name).with_description(spec.description);
            match spec.unit {
                Some(unit) => builder.with_unit(unit).build(),
                None => builder.build(),
            }
        };
        Self {
            cycle_count: counter(CYCLE_COUNT),
            invocation_count: counter(INVOCATION_COUNT),
            cycle_duration: histogram(CYCLE_DURATION),
            tool_call_count: counter(TOOL_CALL_COUNT),
            tool_error_count: counter(TOOL_ERROR_COUNT),
            tool_duration: histogram(TOOL_DURATION),
            tokens_input: counter(TOKENS_INPUT),
            tokens_output: counter(TOKENS_OUTPUT),
            model_latency: histogram(MODEL_LATENCY),
            time_to_first_token: histogram(TIME_TO_FIRST_TOKEN),
        }
    }
}

#[allow(clippy::cast_precision_loss, reason = "millisecond durations stay far below 2^52")]
#[cfg(feature = "otel")]
fn as_f64(value: u64) -> f64 {
    value as f64
}

/// Accumulates the loop metrics of an agent. With the `otel` feature it also records the
/// OpenTelemetry counters and histograms through the global meter provider at construction.
#[derive(Debug)]
pub(crate) struct Meter {
    metrics: AgentMetrics,
    #[cfg(feature = "otel")]
    instruments: Instruments,
}

impl Default for Meter {
    fn default() -> Self {
        Self::new()
    }
}

fn elapsed_ms(start: tokio::time::Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

impl Meter {
    pub(crate) fn new() -> Self {
        Self {
            metrics: AgentMetrics::default(),
            #[cfg(feature = "otel")]
            instruments: Instruments::new(&super::utils::service_meter()),
        }
    }

    /// A meter recording into `meter` instead of the global provider's.
    #[cfg(all(test, feature = "otel"))]
    pub(crate) fn with_otel_meter(meter: &opentelemetry::metrics::Meter) -> Self {
        Self {
            metrics: AgentMetrics::default(),
            instruments: Instruments::new(meter),
        }
    }

    /// The metrics so far (`metrics`).
    pub(crate) fn metrics(&self) -> AgentMetrics {
        self.metrics.clone()
    }

    /// Opens the metrics of a new invocation.
    pub(crate) fn start_new_invocation(&mut self) {
        if self.metrics.agent_invocations.len() >= MAX_INVOCATION_HISTORY {
            self.metrics.agent_invocations.remove(0);
        }
        self.metrics.agent_invocations.push(InvocationMetricsData::default());
        #[cfg(feature = "otel")]
        self.instruments.invocation_count.add(1, &[]);
    }

    /// Opens a loop cycle: its id and start time. Timings read the tokio clock, so
    /// a paused test runtime controls them.
    pub(crate) fn start_cycle(&mut self) -> (String, tokio::time::Instant) {
        self.metrics.cycle_count = self.metrics.cycle_count.saturating_add(1);
        #[cfg(feature = "otel")]
        self.instruments.cycle_count.add(1, &[]);
        let cycle_id = format!("cycle-{}", self.metrics.cycle_count);
        if let Some(invocation) = self.metrics.agent_invocations.last_mut() {
            invocation
                .cycles
                .push(AgentLoopMetricsData::new(cycle_id.clone(), 0, Usage::default()));
        }
        (cycle_id, tokio::time::Instant::now())
    }

    /// Closes the latest cycle and records its duration.
    pub(crate) fn end_cycle(&mut self, start: tokio::time::Instant) {
        let duration = elapsed_ms(start);
        #[cfg(feature = "otel")]
        self.instruments.cycle_duration.record(as_f64(duration), &[]);
        self.metrics.total_duration = self.metrics.total_duration.saturating_add(duration);
        if let Some(last) = self
            .metrics
            .agent_invocations
            .last_mut()
            .and_then(|invocation| invocation.cycles.last_mut())
        {
            last.duration = duration;
        }
    }

    /// Records a finished tool call.
    pub(crate) fn end_tool_call(&mut self, tool_name: &str, duration_ms: u64, success: bool) {
        let index = match self.metrics.tool_metrics.iter().position(|(name, _)| name == tool_name) {
            Some(index) => index,
            None => {
                self.metrics
                    .tool_metrics
                    .push((tool_name.to_owned(), ToolMetricsData::default()));
                self.metrics.tool_metrics.len() - 1
            }
        };
        let entry = &mut self.metrics.tool_metrics[index].1;
        entry.call_count = entry.call_count.saturating_add(1);
        entry.total_time = entry.total_time.saturating_add(duration_ms);
        #[cfg(feature = "otel")]
        let attributes = [opentelemetry::KeyValue::new("gen_ai.tool.name", tool_name.to_owned())];
        #[cfg(feature = "otel")]
        {
            self.instruments.tool_call_count.add(1, &attributes);
            self.instruments.tool_duration.record(as_f64(duration_ms), &attributes);
        }
        if success {
            entry.success_count = entry.success_count.saturating_add(1);
        } else {
            entry.error_count = entry.error_count.saturating_add(1);
            #[cfg(feature = "otel")]
            self.instruments.tool_error_count.add(1, &attributes);
        }
    }

    /// Adds a model call's usage and latency.
    pub(crate) fn update_cycle(&mut self, usage: Option<&Usage>, metrics: Option<&Metrics>) {
        if let Some(usage) = usage {
            self.update_usage(usage);
        }
        let Some(metrics) = metrics else {
            return;
        };
        let total = &mut self.metrics.accumulated_metrics.latency_ms;
        *total = total.saturating_add(metrics.latency_ms);
        #[cfg(feature = "otel")]
        {
            self.instruments.model_latency.record(as_f64(metrics.latency_ms), &[]);
            if let Some(ttfb) = metrics.time_to_first_byte_ms.filter(|ttfb| *ttfb > 0) {
                self.instruments.time_to_first_token.record(as_f64(ttfb) / 1000.0, &[]);
            }
        }
    }

    fn update_usage(&mut self, usage: &Usage) {
        self.metrics.accumulated_usage.accumulate(usage);
        let prompt = usage.total_prompt_tokens();
        self.metrics.latest_context_size = Some(prompt);
        self.metrics.projected_context_size = Some(prompt.saturating_add(usage.output_tokens));
        #[cfg(feature = "otel")]
        {
            self.instruments.tokens_input.add(usage.input_tokens, &[]);
            self.instruments.tokens_output.add(usage.output_tokens, &[]);
        }
        let Some(invocation) = self.metrics.agent_invocations.last_mut() else {
            return;
        };
        invocation.usage.accumulate(usage);
        if let Some(cycle) = invocation.cycles.last_mut() {
            cycle.usage.accumulate(usage);
        }
    }
}

/// One loop cycle's telemetry: the meter cycle and the `execute_agent_loop_cycle` span. Closing
/// it records both once, however the cycle exits; dropping it closes it.
pub(crate) struct Cycle {
    meter: Arc<Mutex<Meter>>,
    start: tokio::time::Instant,
    span: Option<LoopSpan>,
}

impl Cycle {
    /// Starts a cycle on the meter and its span with the history at cycle start.
    pub(crate) fn start(meter: &Arc<Mutex<Meter>>, tracer: &Arc<Tracer>, messages: &[Message]) -> Self {
        let (cycle_id, start) = meter.lock().unwrap_or_else(PoisonError::into_inner).start_cycle();
        let span = tracer.start_agent_loop_span(&cycle_id, messages);
        Self {
            meter: meter.clone(),
            start,
            span: Some(span),
        }
    }

    /// Closes the cycle, with the error that ended it; closing it again does nothing.
    pub(crate) fn close(&mut self, error: Option<&str>) {
        let Some(span) = self.span.take() else {
            return;
        };
        self.meter
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .end_cycle(self.start);
        span.end(error);
    }
}

impl Drop for Cycle {
    fn drop(&mut self) {
        self.close(None);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn serializes_in_the_ts_to_json_order() {
        let metrics = AgentMetrics {
            tool_metrics: vec![(
                "calc".into(),
                ToolMetricsData::default()
                    .with_call_count(2)
                    .with_success_count(1)
                    .with_error_count(1)
                    .with_total_time(30),
            )],
            ..AgentMetrics::new().with_latest_context_size(5)
        };
        let json = serde_json::to_string(&metrics).unwrap();
        assert_eq!(
            json,
            r#"{"cycleCount":0,"accumulatedUsage":{"inputTokens":0,"outputTokens":0,"totalTokens":0},"accumulatedMetrics":{"latencyMs":0},"agentInvocations":[],"toolMetrics":{"calc":{"callCount":2,"successCount":1,"errorCount":1,"totalTime":30}},"totalDuration":0,"latestContextSize":5}"#
        );
        let restored: AgentMetrics = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, metrics);
    }

    #[test]
    fn computes_averages() {
        let metrics = AgentMetrics {
            cycle_count: 4,
            total_duration: 10,
            tool_metrics: vec![(
                "calc".into(),
                ToolMetricsData::default()
                    .with_call_count(4)
                    .with_success_count(3)
                    .with_error_count(1)
                    .with_total_time(20),
            )],
            ..AgentMetrics::new()
        };
        assert!((metrics.average_cycle_time() - 2.5).abs() < f64::EPSILON);
        let usage = metrics.tool_usage();
        assert!((usage[0].1.average_time - 5.0).abs() < f64::EPSILON);
        assert!((usage[0].1.success_rate - 0.75).abs() < f64::EPSILON);
        assert_eq!(metrics.tool("calc").map(|m| m.call_count), Some(4));
        assert!(AgentMetrics::new().latest_agent_invocation().is_none());
        assert_eq!(json!(AgentMetrics::new().average_cycle_time()), json!(0.0));
    }
}
