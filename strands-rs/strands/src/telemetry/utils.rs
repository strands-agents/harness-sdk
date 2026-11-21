//! Shared telemetry settings: the service name and the tracer's environment reads.

const DEFAULT_SERVICE_NAME: &str = "strands-agents";

/// Reads an environment variable; tests pass a map instead of the process environment.
pub(crate) type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

pub(crate) fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// `OTEL_SERVICE_NAME`, or `strands-agents` when it is unset or empty.
pub(crate) fn service_name_from(env: EnvLookup<'_>) -> String {
    env("OTEL_SERVICE_NAME")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVICE_NAME.to_owned())
}

/// The service name the SDK's tracer and meter are scoped to.
#[cfg(feature = "otel")]
pub(crate) fn service_name() -> String {
    service_name_from(&process_env)
}

/// A meter from the global provider scoped to the service name.
#[cfg(feature = "otel")]
pub(crate) fn service_meter() -> opentelemetry::metrics::Meter {
    opentelemetry::global::meter_provider()
        .meter_with_scope(opentelemetry::InstrumentationScope::builder(service_name()).build())
}

/// Milliseconds since the Unix epoch (`Date.now()`).
pub(crate) fn now_ms() -> u64 {
    u64::try_from(jiff::Timestamp::now().as_millisecond()).unwrap_or(0)
}

/// The span conventions the environment selects, read once per tracer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TracerSettings {
    pub(crate) service_name: String,
    /// `gen_ai_latest_experimental`: `gen_ai.provider.name` and one operation details event.
    pub(crate) use_latest_conventions: bool,
    /// `gen_ai_tool_definitions`: the tool schemas on the agent span.
    pub(crate) include_tool_definitions: bool,
    /// The OTLP endpoint is Langfuse.
    pub(crate) is_langfuse: bool,
    /// Langfuse or `gen_ai_span_attributes_only`: aggregated message content becomes span
    /// attributes instead of events.
    pub(crate) span_attributes_only: bool,
}

impl TracerSettings {
    pub(crate) fn from_env() -> Self {
        Self::from_lookup(&process_env)
    }

    pub(crate) fn from_lookup(env: EnvLookup<'_>) -> Self {
        let opt_in = env("OTEL_SEMCONV_STABILITY_OPT_IN").unwrap_or_default();
        let has = |value: &str| opt_in.split(',').map(str::trim).any(|entry| entry == value);
        let is_langfuse = detect_langfuse(env);
        Self {
            service_name: service_name_from(env),
            use_latest_conventions: has("gen_ai_latest_experimental"),
            include_tool_definitions: has("gen_ai_tool_definitions"),
            is_langfuse,
            span_attributes_only: is_langfuse || has("gen_ai_span_attributes_only"),
        }
    }
}

/// Whether Langfuse is the OTLP endpoint.
fn detect_langfuse(env: EnvLookup<'_>) -> bool {
    if env("LANGFUSE_BASE_URL").is_some_and(|url| !url.is_empty()) {
        return true;
    }
    ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]
        .into_iter()
        .any(|key| env(key).is_some_and(|endpoint| endpoint.contains("langfuse")))
}
