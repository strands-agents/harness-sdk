//! OpenTelemetry setup. The process-wide provider slots and environment are injected, so each test
//! has its own.

use std::collections::BTreeMap;
use std::sync::Mutex;

use opentelemetry::baggage::{Baggage, BaggageExt};
use opentelemetry::metrics::MeterProvider as _;
use opentelemetry::trace::{Span as _, Tracer as _, TracerProvider as _};
use opentelemetry::{Context, Key, KeyValue};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};

use crate::telemetry::config::{
    BaggageSpanProcessor, ExporterKind, InstalledMeter, ProviderSlot, exporter_kinds, install_meter, install_tracer,
    otel_resource,
};
use crate::telemetry::{BaggageKeyPredicate, BaggageProcessor, MeterConfig, TelemetryExporters, TracerConfig};
use crate::telemetry::{MeterGuard, TracerGuard};
use crate::test_support::capture_logs;

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
    let map: BTreeMap<String, String> = pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    move |key| map.get(key).cloned()
}

fn resource_attr(resource: &Resource, key: &str) -> Option<String> {
    resource
        .get(&Key::new(key.to_owned()))
        .map(|value| value.as_str().into_owned())
}

fn exporters(otlp: bool, console: bool) -> TelemetryExporters {
    TelemetryExporters { otlp, console }
}

#[test]
fn should_return_the_same_provider_instance_when_called_twice() {
    let slot = Mutex::new(None);
    let first = install_tracer(
        &slot,
        TracerConfig {
            exporters: exporters(false, true),
            ..TracerConfig::default()
        },
        &env(&[]),
    )
    .unwrap();
    let second = install_tracer(
        &slot,
        TracerConfig {
            exporters: exporters(false, false),
            ..TracerConfig::default()
        },
        &env(&[]),
    )
    .unwrap();
    assert!(first.registered);
    assert!(!second.registered);
    assert_eq!(format!("{:?}", first.provider), format!("{:?}", second.provider));
}

#[test]
fn should_log_a_warning_when_called_twice() {
    let slot = Mutex::new(None);
    let ((), logs) = capture_logs(|| {
        install_tracer(&slot, TracerConfig::default(), &env(&[])).unwrap();
        install_tracer(&slot, TracerConfig::default(), &env(&[])).unwrap();
    });
    assert!(logs.contains("tracer provider already initialized, returning existing provider"));
}

#[test]
fn should_use_strands_agents_as_default_service_name() {
    assert_eq!(
        resource_attr(&otel_resource(&env(&[])), "service.name").as_deref(),
        Some("strands-agents")
    );
}

#[test]
fn should_include_default_resource_attributes() {
    let resource = otel_resource(&env(&[]));
    assert_eq!(
        resource_attr(&resource, "service.name").as_deref(),
        Some("strands-agents")
    );
    assert_eq!(
        resource_attr(&resource, "service.namespace").as_deref(),
        Some("strands")
    );
    assert_eq!(
        resource_attr(&resource, "deployment.environment").as_deref(),
        Some("development")
    );
    assert_eq!(
        resource_attr(&resource, "telemetry.sdk.name").as_deref(),
        Some("opentelemetry")
    );
    assert_eq!(
        resource_attr(&resource, "telemetry.sdk.language").as_deref(),
        Some("rust")
    );
}

#[test]
fn should_build_an_sdk_provider_by_default() {
    let installed = install_tracer(&Mutex::new(None), TracerConfig::default(), &env(&[])).unwrap();
    assert!(installed.registered);
    assert!(!installed.custom);
}

#[test]
fn should_accept_a_custom_provider() {
    let custom = SdkTracerProvider::builder().build();
    let installed = install_tracer(
        &Mutex::new(None),
        TracerConfig {
            provider: Some(custom),
            ..TracerConfig::default()
        },
        &env(&[]),
    )
    .unwrap();
    assert!(installed.registered);
    assert!(installed.custom);
}

#[test]
fn should_add_otlp_exporter_when_exporters_otlp_is_true() {
    assert_eq!(exporter_kinds(exporters(true, false)), [ExporterKind::Otlp]);
    install_tracer(
        &Mutex::new(None),
        TracerConfig {
            exporters: exporters(true, false),
            ..TracerConfig::default()
        },
        &env(&[]),
    )
    .unwrap();
}

#[test]
fn should_add_console_exporter_when_exporters_console_is_true() {
    assert_eq!(exporter_kinds(exporters(false, true)), [ExporterKind::Console]);
}

#[test]
fn should_add_both_exporters_when_both_are_true() {
    assert_eq!(
        exporter_kinds(exporters(true, true)),
        [ExporterKind::Otlp, ExporterKind::Console]
    );
}

#[test]
fn should_add_no_exporters_when_both_are_false() {
    assert!(exporter_kinds(exporters(false, false)).is_empty());
}

#[test]
fn should_add_no_exporters_when_exporters_config_is_empty() {
    assert!(exporter_kinds(TelemetryExporters::default()).is_empty());
}

#[test]
fn should_use_otel_service_name_when_set() {
    let resource = otel_resource(&env(&[("OTEL_SERVICE_NAME", "my-custom-service")]));
    assert_eq!(
        resource_attr(&resource, "service.name").as_deref(),
        Some("my-custom-service")
    );
}

#[test]
fn should_use_otel_service_namespace_when_set() {
    let resource = otel_resource(&env(&[("OTEL_SERVICE_NAMESPACE", "my-namespace")]));
    assert_eq!(
        resource_attr(&resource, "service.namespace").as_deref(),
        Some("my-namespace")
    );
}

#[test]
fn should_use_otel_deployment_environment_when_set() {
    let resource = otel_resource(&env(&[("OTEL_DEPLOYMENT_ENVIRONMENT", "production")]));
    assert_eq!(
        resource_attr(&resource, "deployment.environment").as_deref(),
        Some("production")
    );
}

#[test]
fn should_merge_otel_resource_attributes_with_defaults() {
    let resource = otel_resource(&env(&[(
        "OTEL_RESOURCE_ATTRIBUTES",
        "service.version=1.0.0,custom.team=platform",
    )]));
    assert_eq!(resource_attr(&resource, "service.version").as_deref(), Some("1.0.0"));
    assert_eq!(resource_attr(&resource, "custom.team").as_deref(), Some("platform"));
    assert_eq!(
        resource_attr(&resource, "service.name").as_deref(),
        Some("strands-agents")
    );
}

#[test]
fn should_allow_otel_resource_attributes_to_override_defaults() {
    let resource = otel_resource(&env(&[(
        "OTEL_RESOURCE_ATTRIBUTES",
        "service.name=custom-service,deployment.environment=production",
    )]));
    assert_eq!(
        resource_attr(&resource, "service.name").as_deref(),
        Some("custom-service")
    );
    assert_eq!(
        resource_attr(&resource, "deployment.environment").as_deref(),
        Some("production")
    );
}

#[test]
fn decodes_percent_encoded_resource_attributes() {
    let resource = otel_resource(&env(&[("OTEL_RESOURCE_ATTRIBUTES", "team=a%2Cb%20c")]));
    assert_eq!(resource_attr(&resource, "team").as_deref(), Some("a,b c"));
}

#[test]
fn returns_the_same_meter_provider_instance_when_called_twice() {
    let slot = Mutex::new(None);
    let first = install_meter(
        &slot,
        MeterConfig {
            exporters: exporters(false, true),
            ..MeterConfig::default()
        },
        &env(&[]),
    )
    .unwrap();
    let second = install_meter(
        &slot,
        MeterConfig {
            exporters: exporters(true, false),
            ..MeterConfig::default()
        },
        &env(&[]),
    )
    .unwrap();
    assert!(first.registered);
    assert!(!second.registered);
}

#[test]
fn logs_a_warning_when_meter_setup_is_called_twice() {
    let slot = Mutex::new(None);
    let ((), logs) = capture_logs(|| {
        install_meter(&slot, MeterConfig::default(), &env(&[])).unwrap();
        install_meter(&slot, MeterConfig::default(), &env(&[])).unwrap();
    });
    assert!(logs.contains("meter provider already initialized, returning existing provider"));
}

fn recording_meter_provider(resource: Option<Resource>) -> (SdkMeterProvider, InMemoryMetricExporter) {
    let exporter = InMemoryMetricExporter::default();
    let mut builder = SdkMeterProvider::builder().with_reader(PeriodicReader::builder(exporter.clone()).build());
    if let Some(resource) = resource {
        builder = builder.with_resource(resource);
    }
    (builder.build(), exporter)
}

#[test]
fn accepts_a_custom_meter_provider() {
    let (custom, exporter) = recording_meter_provider(None);
    let InstalledMeter {
        provider, registered, ..
    } = install_meter(
        &Mutex::new(None),
        MeterConfig {
            provider: Some(custom),
            ..MeterConfig::default()
        },
        &env(&[]),
    )
    .unwrap();
    assert!(registered);
    provider.meter("test").u64_counter("probe").build().add(1, &[]);
    provider.force_flush().unwrap();
    assert!(!exporter.get_finished_metrics().unwrap().is_empty());
}

#[test]
fn meter_should_use_otel_service_name_when_set() {
    let resource = Resource::builder_empty()
        .with_attribute(KeyValue::new("service.name", "my-meter-service"))
        .build();
    let (custom, exporter) = recording_meter_provider(Some(resource));
    let InstalledMeter { provider, .. } = install_meter(
        &Mutex::new(None),
        MeterConfig {
            provider: Some(custom),
            ..MeterConfig::default()
        },
        &env(&[]),
    )
    .unwrap();
    provider.meter("test").u64_counter("probe").build().add(1, &[]);
    provider.force_flush().unwrap();
    let metrics = exporter.get_finished_metrics().unwrap();
    assert_eq!(
        resource_attr(metrics.last().unwrap().resource(), "service.name").as_deref(),
        Some("my-meter-service")
    );
}

#[test]
fn returns_a_provider_that_produces_real_metrics_via_its_own_meter() {
    let (custom, exporter) = recording_meter_provider(None);
    let InstalledMeter {
        provider, registered, ..
    } = install_meter(
        &Mutex::new(None),
        MeterConfig {
            provider: Some(custom),
            ..MeterConfig::default()
        },
        &env(&[]),
    )
    .unwrap();
    assert!(registered);
    provider
        .meter("test-registration")
        .u64_counter("test_registration_counter")
        .build()
        .add(42, &[]);
    provider.force_flush().unwrap();
    let metrics = exporter.get_finished_metrics().unwrap();
    let metric = metrics
        .last()
        .unwrap()
        .scope_metrics()
        .flat_map(|scope| scope.metrics())
        .find(|metric| metric.name() == "test_registration_counter")
        .unwrap();
    let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() else {
        panic!("expected a u64 sum");
    };
    assert_eq!(sum.data_points().map(|point| point.value()).sum::<u64>(), 42);
}

/// Starts a span under baggage `{tenant.id, session.id, other}` and returns its attributes.
fn stamped_attributes(processor: Option<BaggageProcessor>) -> Vec<(String, String)> {
    let exporter = InMemorySpanExporter::default();
    let mut builder = SdkTracerProvider::builder();
    if let Some(keys) = processor {
        builder = builder.with_span_processor(BaggageSpanProcessor::new(keys));
    }
    let provider = builder.with_simple_exporter(exporter.clone()).build();
    let mut baggage = Baggage::new();
    baggage.insert("tenant.id", "acme");
    baggage.insert("session.id", "s-1");
    baggage.insert("other", "x");
    let cx = Context::new().with_baggage(baggage);
    provider.tracer("test").start_with_context("probe", &cx).end();
    let mut attributes: Vec<(String, String)> = exporter.get_finished_spans().unwrap()[0]
        .attributes
        .iter()
        .map(|kv| (kv.key.to_string(), kv.value.as_str().into_owned()))
        .collect();
    attributes.sort();
    attributes
}

fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = expected
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    pairs.sort();
    pairs
}

#[test]
fn stamps_baggage_selected_by_true_onto_spans() {
    assert_eq!(
        stamped_attributes(Some(BaggageProcessor::AllKeys)),
        pairs(&[("tenant.id", "acme"), ("session.id", "s-1"), ("other", "x")])
    );
}

#[test]
fn stamps_baggage_selected_by_a_single_predicate_onto_spans() {
    assert_eq!(
        stamped_attributes(Some(BaggageProcessor::predicate(|key| key.starts_with("tenant.")))),
        pairs(&[("tenant.id", "acme")])
    );
}

#[test]
fn stamps_baggage_selected_by_a_predicate_list_onto_spans() {
    let processor = BaggageProcessor::Predicates(vec![
        BaggageKeyPredicate::new(|key: &str| key == "session.id"),
        BaggageKeyPredicate::new(|key: &str| key.starts_with("tenant.")),
    ]);
    assert_eq!(
        stamped_attributes(Some(processor)),
        pairs(&[("tenant.id", "acme"), ("session.id", "s-1")])
    );
}

#[test]
fn warns_that_it_is_ignored_when_a_custom_provider_is_passed() {
    let (installed, logs) = capture_logs(|| {
        install_tracer(
            &Mutex::new(None),
            TracerConfig {
                provider: Some(SdkTracerProvider::builder().build()),
                baggage_processor: Some(BaggageProcessor::AllKeys),
                ..TracerConfig::default()
            },
            &env(&[]),
        )
        .unwrap()
    });
    assert!(installed.custom);
    assert!(logs.contains("baggage_processor=<ignored>"));
    assert!(stamped_attributes(None).is_empty());
}

fn leaked_slot<P>() -> &'static ProviderSlot<P> {
    Box::leak(Box::new(Mutex::new(None)))
}

/// A stopped provider is not handed out again: shutting a guard down clears its registration,
/// so the next setup builds and registers a new provider.
#[test]
fn registers_a_new_tracer_provider_after_a_guard_shuts_down() {
    let slot = leaked_slot();
    let first = install_tracer(slot, TracerConfig::default(), &env(&[])).unwrap();
    let repeat = install_tracer(slot, TracerConfig::default(), &env(&[])).unwrap();
    assert!(!repeat.registered);
    TracerGuard::new(first, slot).shutdown().unwrap();
    let next = install_tracer(slot, TracerConfig::default(), &env(&[])).unwrap();
    assert!(next.registered);
    next.provider.force_flush().unwrap();
    assert!(TracerGuard::new(repeat, slot).shutdown().is_err());
    assert!(
        !install_tracer(slot, TracerConfig::default(), &env(&[]))
            .unwrap()
            .registered
    );
}

#[test]
fn registers_a_new_meter_provider_after_a_guard_shuts_down() {
    let slot = leaked_slot();
    let first = install_meter(slot, MeterConfig::default(), &env(&[])).unwrap();
    MeterGuard::new(first, slot).shutdown().unwrap();
    let next = install_meter(slot, MeterConfig::default(), &env(&[])).unwrap();
    assert!(next.registered);
    next.provider.force_flush().unwrap();
}
