//! Loop metrics, and the instruments checked against `conformance/fixtures/metrics.json`.
//! Durations are integer milliseconds on the tokio clock, so the tests run on a paused runtime.

use std::time::Duration;

use serde_json::json;
use tokio::time::{Instant, advance};

use crate::models::streaming::{Metrics, Usage};
use crate::telemetry::meter::{INSTRUMENTS, InstrumentKind};
use crate::telemetry::{AgentLoopMetricsData, AgentMetrics, InvocationMetricsData, Meter, ToolMetricsData};

fn usage(input: u64, output: u64, total: u64) -> Usage {
    Usage::new(input, output, total)
}

fn tool(call_count: u64, success_count: u64, error_count: u64, total_time: u64) -> ToolMetricsData {
    ToolMetricsData::default()
        .with_call_count(call_count)
        .with_success_count(success_count)
        .with_error_count(error_count)
        .with_total_time(total_time)
}

fn cycle(cycle_id: &str, duration: u64, usage: Usage) -> AgentLoopMetricsData {
    AgentLoopMetricsData::new(cycle_id, duration, usage)
}

#[test]
fn returns_zeroed_snapshot_for_fresh_instance() {
    assert_eq!(Meter::new().metrics(), AgentMetrics::new());
}

#[tokio::test(start_paused = true)]
async fn returns_complete_snapshot_after_a_realistic_agent_execution() {
    let mut meter = Meter::new();
    meter.start_new_invocation();
    let (_, start) = meter.start_cycle();
    meter.update_cycle(Some(&usage(10, 5, 15)), Some(&Metrics::new(100)));
    meter.end_tool_call("search", 1, true);
    advance(Duration::from_millis(3000)).await;
    meter.end_cycle(start);

    advance(Duration::from_millis(97_000)).await;
    let (_, start) = meter.start_cycle();
    meter.update_cycle(Some(&usage(20, 10, 30)), Some(&Metrics::new(250)));
    meter.end_tool_call("search", 1, false);
    advance(Duration::from_millis(5000)).await;
    meter.end_cycle(start);

    let snapshot = meter.metrics();
    assert_eq!(snapshot.cycle_count, 2);
    assert_eq!(snapshot.total_duration, 8000);
    assert_eq!(snapshot.accumulated_usage, usage(30, 15, 45));
    assert_eq!(snapshot.accumulated_metrics, Metrics::new(350));
    assert_eq!(snapshot.tool_metrics, vec![("search".to_owned(), tool(2, 1, 1, 2))]);
    assert_eq!(
        snapshot.agent_invocations,
        vec![InvocationMetricsData::new(
            vec![
                cycle("cycle-1", 3000, usage(10, 5, 15)),
                cycle("cycle-2", 5000, usage(20, 10, 30)),
            ],
            usage(30, 15, 45),
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn tracks_multiple_invocations_independently() {
    let mut meter = Meter::new();
    meter.start_new_invocation();
    meter.start_cycle();
    meter.update_cycle(Some(&usage(10, 5, 15)), None);
    meter.start_new_invocation();
    meter.start_cycle();
    meter.update_cycle(Some(&usage(20, 10, 30)), None);
    assert_eq!(
        meter.metrics().agent_invocations,
        vec![
            InvocationMetricsData::new(vec![cycle("cycle-1", 0, usage(10, 5, 15))], usage(10, 5, 15)),
            InvocationMetricsData::new(vec![cycle("cycle-2", 0, usage(20, 10, 30))], usage(20, 10, 30)),
        ]
    );
}

#[test]
fn appends_an_invocation_with_empty_cycles_and_zeroed_usage() {
    let mut meter = Meter::new();
    meter.start_new_invocation();
    assert_eq!(
        meter.metrics().agent_invocations,
        vec![InvocationMetricsData::default()]
    );
}

#[test]
fn latest_agent_invocation_returns_the_most_recently_added_invocation() {
    let mut meter = Meter::new();
    meter.start_new_invocation();
    meter.start_new_invocation();
    let snapshot = meter.metrics();
    assert_eq!(snapshot.agent_invocations.len(), 2);
    assert!(std::ptr::eq(
        snapshot.latest_agent_invocation().unwrap(),
        &snapshot.agent_invocations[1]
    ));
}

#[tokio::test(start_paused = true)]
async fn evicts_oldest_entries_when_exceeding_max_history_cap() {
    let mut meter = Meter::new();
    for _ in 0..60 {
        meter.start_new_invocation();
        meter.start_cycle();
    }
    let invocations = meter.metrics().agent_invocations;
    assert_eq!(invocations.len(), 50);
    assert_eq!(invocations[0].cycles[0].cycle_id, "cycle-11");
    assert_eq!(invocations[49].cycles[0].cycle_id, "cycle-60");
}

#[tokio::test(start_paused = true)]
async fn returns_cycle_id_and_start_time() {
    let mut meter = Meter::new();
    let (cycle_id, start) = meter.start_cycle();
    assert_eq!(cycle_id, "cycle-1");
    assert_eq!(start, Instant::now());
    assert_eq!(meter.metrics().cycle_count, 1);
}

#[tokio::test(start_paused = true)]
async fn adds_cycle_entry_to_the_latest_invocation() {
    let mut meter = Meter::new();
    meter.start_new_invocation();
    meter.start_cycle();
    assert_eq!(
        meter.metrics().latest_agent_invocation().unwrap().cycles,
        vec![cycle("cycle-1", 0, Usage::default())]
    );
}

#[tokio::test(start_paused = true)]
async fn start_cycle_does_not_fail_when_no_invocation_exists() {
    let mut meter = Meter::new();
    assert_eq!(meter.start_cycle().0, "cycle-1");
    assert!(meter.metrics().agent_invocations.is_empty());
}

#[tokio::test(start_paused = true)]
async fn records_duration_on_the_latest_cycle() {
    let mut meter = Meter::new();
    let start = Instant::now();
    advance(Duration::from_millis(100_000)).await;
    meter.start_new_invocation();
    meter.start_cycle();
    meter.end_cycle(start);
    assert_eq!(
        meter.metrics().latest_agent_invocation().unwrap().cycles[0].duration,
        100_000
    );
}

#[tokio::test(start_paused = true)]
async fn end_cycle_does_not_fail_when_no_invocation_exists() {
    let mut meter = Meter::new();
    let (_, start) = meter.start_cycle();
    meter.end_cycle(start);
    assert!(meter.metrics().agent_invocations.is_empty());
}

#[tokio::test(start_paused = true)]
async fn does_not_fail_when_invocation_has_no_cycles() {
    let mut meter = Meter::new();
    meter.start_new_invocation();
    meter.end_cycle(Instant::now());
    assert!(meter.metrics().latest_agent_invocation().unwrap().cycles.is_empty());
}

#[test]
fn records_success() {
    let mut meter = Meter::new();
    meter.end_tool_call("myTool", 15, true);
    assert_eq!(
        meter.metrics().tool_metrics,
        vec![("myTool".to_owned(), tool(1, 1, 0, 15))]
    );
}

#[test]
fn records_failure() {
    let mut meter = Meter::new();
    meter.end_tool_call("myTool", 5, false);
    assert_eq!(
        meter.metrics().tool_metrics,
        vec![("myTool".to_owned(), tool(1, 0, 1, 5))]
    );
}

#[test]
fn accumulates_across_multiple_calls_to_the_same_tool() {
    let mut meter = Meter::new();
    meter.end_tool_call("myTool", 1, true);
    meter.end_tool_call("myTool", 2, false);
    assert_eq!(
        meter.metrics().tool_metrics,
        vec![("myTool".to_owned(), tool(2, 1, 1, 3))]
    );
}

#[test]
fn tracks_different_tools_independently() {
    let mut meter = Meter::new();
    meter.end_tool_call("toolA", 1, true);
    meter.end_tool_call("toolB", 2, false);
    assert_eq!(
        meter.metrics().tool_metrics,
        vec![
            ("toolA".to_owned(), tool(1, 1, 0, 1)),
            ("toolB".to_owned(), tool(1, 0, 1, 2))
        ]
    );
}

fn context_sizes(updates: &[Usage]) -> (Option<u64>, Option<u64>) {
    let mut meter = Meter::new();
    for usage in updates {
        meter.update_cycle(Some(usage), None);
    }
    let metrics = meter.metrics();
    (metrics.latest_context_size, metrics.projected_context_size)
}

#[test]
fn latest_context_size_is_undefined_when_no_invocations_have_occurred() {
    assert_eq!(context_sizes(&[]), (None, None));
}

#[test]
fn returns_the_most_recent_input_tokens_after_a_model_call() {
    assert_eq!(context_sizes(&[usage(100, 50, 150)]), (Some(100), Some(150)));
}

#[test]
fn updates_across_multiple_cycles() {
    assert_eq!(
        context_sizes(&[usage(100, 50, 150), usage(200, 80, 280)]),
        (Some(200), Some(280))
    );
}

#[tokio::test(start_paused = true)]
async fn updates_across_multiple_invocations() {
    let mut meter = Meter::new();
    meter.start_new_invocation();
    meter.start_cycle();
    meter.update_cycle(Some(&usage(100, 50, 150)), None);
    meter.start_new_invocation();
    meter.start_cycle();
    meter.update_cycle(Some(&usage(300, 100, 400)), None);
    assert_eq!(meter.metrics().latest_context_size, Some(300));
}

#[test]
fn remains_undefined_when_metadata_has_no_usage() {
    let mut meter = Meter::new();
    meter.update_cycle(None, Some(&Metrics::new(100)));
    assert_eq!(meter.metrics().latest_context_size, None);
}

#[test]
fn remains_undefined_when_update_cycle_is_called_with_undefined() {
    let mut meter = Meter::new();
    meter.update_cycle(None, None);
    assert_eq!(meter.metrics().latest_context_size, None);
}

#[test]
fn counts_cache_reads_on_disjoint_providers_where_they_add_to_input_tokens() {
    assert_eq!(
        context_sizes(&[usage(10, 4, 5862).with_cache_read_input_tokens(5848)]),
        (Some(5858), Some(5862))
    );
}

#[test]
fn does_not_double_count_cache_reads_on_subset_providers() {
    assert_eq!(
        context_sizes(&[usage(12936, 10, 12946).with_cache_read_input_tokens(6457)]),
        (Some(12936), Some(12946))
    );
}

#[test]
fn accumulates_usage_and_latency_from_metadata() {
    let mut meter = Meter::new();
    meter.update_cycle(Some(&usage(5, 3, 8)), Some(&Metrics::new(100)));
    meter.update_cycle(Some(&usage(10, 7, 17)), Some(&Metrics::new(200)));
    let metrics = meter.metrics();
    assert_eq!(metrics.accumulated_usage, usage(15, 10, 25));
    assert_eq!(metrics.accumulated_metrics, Metrics::new(300));
}

#[test]
fn accumulates_cache_tokens_across_calls() {
    let mut meter = Meter::new();
    meter.update_cycle(
        Some(
            &usage(10, 5, 15)
                .with_cache_read_input_tokens(3)
                .with_cache_write_input_tokens(2),
        ),
        None,
    );
    meter.update_cycle(Some(&usage(5, 2, 7).with_cache_read_input_tokens(4)), None);
    assert_eq!(
        serde_json::to_value(meter.metrics().accumulated_usage).unwrap(),
        json!({"inputTokens": 15, "outputTokens": 7, "totalTokens": 22, "cacheReadInputTokens": 7, "cacheWriteInputTokens": 2})
    );
}

#[test]
fn handles_usage_only_metadata() {
    let mut meter = Meter::new();
    meter.update_cycle(Some(&usage(10, 5, 15)), None);
    let metrics = meter.metrics();
    assert_eq!(metrics.accumulated_usage, usage(10, 5, 15));
    assert_eq!(metrics.accumulated_metrics, Metrics::new(0));
}

#[test]
fn handles_metrics_only_metadata() {
    let mut meter = Meter::new();
    meter.update_cycle(None, Some(&Metrics::new(250)));
    let metrics = meter.metrics();
    assert_eq!(metrics.accumulated_usage, Usage::default());
    assert_eq!(metrics.accumulated_metrics, Metrics::new(250));
}

#[tokio::test(start_paused = true)]
async fn propagates_usage_to_invocation_and_current_cycle() {
    let mut meter = Meter::new();
    meter.start_new_invocation();
    meter.start_cycle();
    meter.update_cycle(Some(&usage(10, 5, 15)), None);
    assert_eq!(
        meter.metrics().latest_agent_invocation().cloned(),
        Some(InvocationMetricsData::new(
            vec![cycle("cycle-1", 0, usage(10, 5, 15))],
            usage(10, 5, 15)
        ))
    );
}

#[test]
fn is_a_no_op_when_metadata_has_neither_usage_nor_metrics() {
    let mut meter = Meter::new();
    meter.update_cycle(None, None);
    assert_eq!(meter.metrics(), AgentMetrics::new());
}

#[test]
fn update_cycle_does_not_fail_when_no_invocation_exists() {
    let mut meter = Meter::new();
    meter.update_cycle(Some(&usage(10, 5, 15)), None);
    assert_eq!(meter.metrics().accumulated_usage, usage(10, 5, 15));
}

#[test]
fn returns_complete_zeroed_data_for_default_instance() {
    assert_eq!(
        serde_json::to_value(AgentMetrics::new()).unwrap(),
        json!({
            "cycleCount": 0,
            "accumulatedUsage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
            "accumulatedMetrics": {"latencyMs": 0},
            "agentInvocations": [],
            "toolMetrics": {},
            "totalDuration": 0,
        })
    );
}

fn sample_metrics() -> AgentMetrics {
    AgentMetrics {
        cycle_count: 2,
        total_duration: 8000,
        tool_metrics: vec![("search".to_owned(), tool(2, 1, 1, 2))],
        accumulated_usage: usage(30, 15, 45),
        accumulated_metrics: Metrics::new(350),
        agent_invocations: vec![InvocationMetricsData::new(
            vec![
                cycle("cycle-1", 3000, usage(10, 5, 15)),
                cycle("cycle-2", 5000, usage(20, 10, 30)),
            ],
            usage(30, 15, 45),
        )],
        ..AgentMetrics::new()
    }
}

#[test]
fn returns_data_from_provided_metrics() {
    assert_eq!(
        serde_json::to_value(sample_metrics()).unwrap(),
        json!({
            "cycleCount": 2,
            "accumulatedUsage": {"inputTokens": 30, "outputTokens": 15, "totalTokens": 45},
            "accumulatedMetrics": {"latencyMs": 350},
            "agentInvocations": [{
                "cycles": [
                    {"cycleId": "cycle-1", "duration": 3000, "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}},
                    {"cycleId": "cycle-2", "duration": 5000, "usage": {"inputTokens": 20, "outputTokens": 10, "totalTokens": 30}},
                ],
                "usage": {"inputTokens": 30, "outputTokens": 15, "totalTokens": 45},
            }],
            "toolMetrics": {"search": {"callCount": 2, "successCount": 1, "errorCount": 1, "totalTime": 2}},
            "totalDuration": 8000,
        })
    );
}

#[test]
fn includes_latest_context_size_when_set() {
    let json = serde_json::to_value(AgentMetrics::new().with_latest_context_size(42)).unwrap();
    assert_eq!(json["latestContextSize"], 42);
}

#[test]
fn omits_latest_context_size_when_undefined() {
    let json = serde_json::to_value(AgentMetrics::new()).unwrap();
    assert!(json.get("latestContextSize").is_none());
}

#[test]
fn reconstructs_equivalent_agent_metrics_from_serialized_data() {
    let original = AgentMetrics {
        tool_metrics: vec![
            ("search".to_owned(), tool(2, 2, 0, 15)),
            ("calc".to_owned(), tool(1, 0, 1, 3)),
        ],
        ..sample_metrics()
    };
    let restored: AgentMetrics = serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
    assert_eq!(restored, original);
}

#[test]
fn latest_agent_invocation_returns_the_last_invocation() {
    let metrics = AgentMetrics {
        agent_invocations: vec![
            InvocationMetricsData::new(Vec::new(), usage(10, 5, 15)),
            InvocationMetricsData::new(Vec::new(), usage(20, 10, 30)),
        ],
        ..AgentMetrics::new()
    };
    assert!(std::ptr::eq(
        metrics.latest_agent_invocation().unwrap(),
        &metrics.agent_invocations[1]
    ));
}

#[test]
fn latest_agent_invocation_returns_undefined_when_empty() {
    assert!(AgentMetrics::new().latest_agent_invocation().is_none());
}

#[test]
fn accumulated_data_returns_usage_and_metrics_together() {
    let metrics = sample_metrics();
    assert_eq!(metrics.accumulated_data(), (&usage(30, 15, 45), &Metrics::new(350)));
}

#[test]
fn average_cycle_time_computes_average() {
    assert!((sample_metrics().average_cycle_time() - 4000.0).abs() < f64::EPSILON);
}

#[test]
fn average_cycle_time_returns_0_when_no_cycles() {
    assert!(AgentMetrics::new().average_cycle_time().abs() < f64::EPSILON);
}

#[test]
fn tool_usage_adds_computed_average_time_and_success_rate() {
    let usage = sample_metrics().tool_usage();
    assert_eq!(usage[0].0, "search");
    assert_eq!(usage[0].1.metrics, tool(2, 1, 1, 2));
    assert!((usage[0].1.average_time - 1.0).abs() < f64::EPSILON);
    assert!((usage[0].1.success_rate - 0.5).abs() < f64::EPSILON);
}

#[test]
fn tool_usage_returns_0_for_average_time_and_success_rate_when_call_count_is_0() {
    let metrics = AgentMetrics {
        tool_metrics: vec![("broken".to_owned(), ToolMetricsData::default())],
        ..AgentMetrics::new()
    };
    let usage = metrics.tool_usage();
    assert!(usage[0].1.average_time.abs() < f64::EPSILON);
    assert!(usage[0].1.success_rate.abs() < f64::EPSILON);
}

/// The fixture records each instrument created during a reference agent run.
#[test]
fn instruments_match_the_conformance_fixture() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../conformance/fixtures/metrics.json")).unwrap();
    let case = |name: &str| -> serde_json::Value {
        let json = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap()["json"]
            .as_str()
            .unwrap()
            .to_owned();
        serde_json::from_str(&json).unwrap()
    };
    let instruments: Vec<serde_json::Value> = INSTRUMENTS
        .iter()
        .map(|spec| {
            let kind = match spec.kind {
                InstrumentKind::Counter => "counter",
                InstrumentKind::Histogram => "histogram",
            };
            let mut entry = json!({"kind": kind, "name": spec.name, "description": spec.description});
            if let Some(unit) = spec.unit {
                entry["unit"] = json!(unit);
            }
            entry
        })
        .collect();
    assert_eq!(serde_json::Value::Array(instruments), case("metric_instruments"));
    let names: Vec<&str> = INSTRUMENTS.iter().map(|spec| spec.name).collect();
    assert_eq!(json!(names), case("metric_names"));
}

#[cfg(feature = "otel")]
mod instruments {
    //! The `OTEL instrument emission` cases: the meter records through an SDK provider with an
    //! in-memory exporter.

    use opentelemetry::KeyValue;
    use opentelemetry::metrics::MeterProvider as _;
    use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
    use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};

    use super::*;

    struct Recorded {
        provider: SdkMeterProvider,
        exporter: InMemoryMetricExporter,
    }

    fn recording_meter() -> (Meter, Recorded) {
        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(exporter.clone()).build())
            .build();
        let meter = Meter::with_otel_meter(&provider.meter("test"));
        (meter, Recorded { provider, exporter })
    }

    /// The data points of an instrument: value (sum for histograms) and attributes.
    fn points(recorded: &Recorded, name: &str) -> Vec<(f64, Vec<KeyValue>)> {
        recorded.provider.force_flush().unwrap();
        let metrics = recorded.exporter.get_finished_metrics().unwrap();
        let Some(last) = metrics.last() else {
            return Vec::new();
        };
        let Some(metric) = last
            .scope_metrics()
            .flat_map(|scope| scope.metrics())
            .find(|metric| metric.name() == name)
        else {
            return Vec::new();
        };
        #[allow(clippy::cast_precision_loss)]
        match metric.data() {
            AggregatedMetrics::U64(MetricData::Sum(sum)) => sum
                .data_points()
                .map(|point| (point.value() as f64, point.attributes().cloned().collect()))
                .collect(),
            AggregatedMetrics::F64(MetricData::Histogram(histogram)) => histogram
                .data_points()
                .map(|point| (point.sum(), point.attributes().cloned().collect()))
                .collect(),
            other => panic!("unexpected data for {name}: {other:?}"),
        }
    }

    fn total(recorded: &Recorded, name: &str) -> f64 {
        points(recorded, name).iter().map(|(value, _)| value).sum()
    }

    fn search() -> Vec<KeyValue> {
        vec![KeyValue::new("gen_ai.tool.name", "search")]
    }

    #[test]
    fn emits_invocation_counter_on_start_new_invocation() {
        let (mut meter, recorded) = recording_meter();
        meter.start_new_invocation();
        assert!((total(&recorded, "gen_ai.agent.invocation.count") - 1.0).abs() < f64::EPSILON);
    }

    #[tokio::test(start_paused = true)]
    async fn emits_cycle_counter_on_start_cycle() {
        let (mut meter, recorded) = recording_meter();
        meter.start_cycle();
        assert!((total(&recorded, "gen_ai.agent.cycle.count") - 1.0).abs() < f64::EPSILON);
    }

    #[tokio::test(start_paused = true)]
    async fn emits_cycle_duration_histogram_on_end_cycle() {
        let (mut meter, recorded) = recording_meter();
        let start = Instant::now();
        advance(Duration::from_millis(2000)).await;
        meter.end_cycle(start);
        assert!((total(&recorded, "gen_ai.agent.cycle.duration") - 2000.0).abs() < f64::EPSILON);
    }

    #[test]
    fn emits_tool_call_counter_and_duration_on_successful_end_tool_call() {
        let (mut meter, recorded) = recording_meter();
        meter.end_tool_call("search", 150, true);
        assert_eq!(points(&recorded, "gen_ai.agent.tool.call.count"), vec![(1.0, search())]);
        assert_eq!(points(&recorded, "gen_ai.agent.tool.duration"), vec![(150.0, search())]);
        assert!(points(&recorded, "gen_ai.agent.tool.error.count").is_empty());
    }

    #[test]
    fn emits_tool_call_counter_error_counter_and_duration_on_failed_end_tool_call() {
        let (mut meter, recorded) = recording_meter();
        meter.end_tool_call("search", 50, false);
        assert_eq!(points(&recorded, "gen_ai.agent.tool.call.count"), vec![(1.0, search())]);
        assert_eq!(
            points(&recorded, "gen_ai.agent.tool.error.count"),
            vec![(1.0, search())]
        );
        assert_eq!(points(&recorded, "gen_ai.agent.tool.duration"), vec![(50.0, search())]);
    }

    #[test]
    fn emits_input_token_counter_output_token_counter_and_model_latency_on_update_cycle() {
        let (mut meter, recorded) = recording_meter();
        meter.update_cycle(Some(&usage(100, 50, 150)), Some(&Metrics::new(200)));
        assert!((total(&recorded, "gen_ai.agent.tokens.input") - 100.0).abs() < f64::EPSILON);
        assert!((total(&recorded, "gen_ai.agent.tokens.output") - 50.0).abs() < f64::EPSILON);
        assert!((total(&recorded, "gen_ai.agent.model.latency") - 200.0).abs() < f64::EPSILON);
    }

    #[test]
    fn does_not_emit_token_counters_or_latency_when_update_cycle_has_no_usage_or_metrics() {
        let (mut meter, recorded) = recording_meter();
        meter.update_cycle(None, None);
        for name in [
            "gen_ai.agent.tokens.input",
            "gen_ai.agent.tokens.output",
            "gen_ai.agent.model.latency",
        ] {
            assert!(points(&recorded, name).is_empty(), "{name}");
        }
    }

    fn ttfb(time_to_first_byte_ms: Option<u64>) -> Vec<(f64, Vec<KeyValue>)> {
        let (mut meter, recorded) = recording_meter();
        let mut metrics = Metrics::new(500);
        metrics.time_to_first_byte_ms = time_to_first_byte_ms;
        meter.update_cycle(None, Some(&metrics));
        points(&recorded, "gen_ai.server.time_to_first_token")
    }

    #[test]
    fn emits_time_to_first_token_histogram_in_seconds_when_time_to_first_byte_ms_is_provided() {
        let points = ttfb(Some(150));
        assert_eq!(points.len(), 1);
        assert!((points[0].0 - 0.15).abs() < 1e-9);
    }

    #[test]
    fn does_not_emit_time_to_first_token_histogram_when_time_to_first_byte_ms_is_undefined() {
        assert!(ttfb(None).is_empty());
    }

    #[test]
    fn does_not_emit_time_to_first_token_histogram_when_time_to_first_byte_ms_is_zero() {
        assert!(ttfb(Some(0)).is_empty());
    }
}
