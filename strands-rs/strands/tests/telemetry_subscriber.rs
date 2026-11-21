//! `TracerGuard::try_init_subscriber` installs the process-wide subscriber, so it runs in its own
//! test binary.
#![cfg(feature = "otel")]

use strands::Agent;
use strands::telemetry::opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use strands::telemetry::{TracerConfig, setup_tracer};
use strands::testing::MockModel;

#[tokio::test]
async fn try_init_subscriber_exports_the_agent_spans_and_refuses_a_second_subscriber() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let guard = setup_tracer(TracerConfig {
        provider: Some(provider),
        ..Default::default()
    })
    .unwrap();
    guard.try_init_subscriber().unwrap();
    assert!(guard.try_init_subscriber().is_err());

    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("x").await.unwrap();
    guard.provider().force_flush().unwrap();
    let names: Vec<String> = exporter
        .get_finished_spans()
        .unwrap()
        .into_iter()
        .map(|span| span.name.into_owned())
        .collect();
    assert!(names.contains(&"invoke_agent Strands Agent".to_owned()), "{names:?}");
    assert!(names.contains(&"chat".to_owned()), "{names:?}");
}
