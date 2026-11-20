//! OpenTelemetry export of the agent's spans and metrics. Spans print to stdout; set
//! `OTEL_EXPORTER_OTLP_ENDPOINT` (for example `http://localhost:4318`) to also send them and the
//! metrics to an OTLP collector.
//!
//! ```text
//! cargo run -p strands --features otel --example telemetry
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use strands::telemetry::{MeterConfig, TelemetryExporters, TracerConfig, setup_meter, setup_tracer};
use strands::{Agent, ToolError, tool};

const AWS_HELP: &str = "This example calls Amazon Bedrock. Configure AWS credentials (for example \
`aws configure` or AWS_PROFILE) and a region where the default model is enabled (AWS_REGION, \
default us-west-2).";

/// Get the current time in a city.
#[tool]
async fn current_time(
    /// The city.
    city: String,
) -> Result<String, ToolError> {
    Ok(format!("It is 09:30 in {city}"))
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

async fn run() -> strands::Result<()> {
    let otlp = std::env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT").is_some();
    let tracer = setup_tracer(TracerConfig {
        exporters: TelemetryExporters { otlp, console: true },
        ..TracerConfig::default()
    })?;
    let _meter = setup_meter(MeterConfig {
        exporters: TelemetryExporters { otlp, console: false },
        ..MeterConfig::default()
    })?;
    tracer.try_init_subscriber()?;

    let mut agent = Agent::builder()
        .name("clock")
        .tools([CurrentTime])
        .trace_attributes([("example", "telemetry")])
        .printer(false)
        .build()?;
    let result = agent.invoke("What time is it in Tokyo?").await?;
    println!("{result}");
    agent.shutdown().await
    // The tracer and meter guards flush their exporters when they drop.
}
