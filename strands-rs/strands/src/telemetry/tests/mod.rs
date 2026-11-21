//! Telemetry tests that span modules: the meter, the agent's spans and the provider setup.

#[cfg(feature = "otel")]
mod agent;
mod agent_local;
#[cfg(feature = "otel")]
mod config;
mod meter;
