//! OpenTelemetry setup: [`setup_tracer`] and [`setup_meter`] build providers with OTLP HTTP and
//! console exporters configured from the environment, and register them globally.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use opentelemetry::baggage::BaggageExt;
use opentelemetry::propagation::TextMapCompositePropagator;
use opentelemetry::trace::{Span as _, TracerProvider as _};
use opentelemetry::{Context, KeyValue, global};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::propagation::{BaggagePropagator, TraceContextPropagator};
use opentelemetry_sdk::resource::TelemetryResourceDetector;
use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider, Span, SpanData, SpanProcessor};
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;

use super::utils::{EnvLookup, process_env, service_meter, service_name, service_name_from};
use crate::error::{Error, Result};

const DEFAULT_SERVICE_NAMESPACE: &str = "strands";
const DEFAULT_DEPLOYMENT_ENVIRONMENT: &str = "development";

static TRACER_PROVIDER: ProviderSlot<SdkTracerProvider> = Mutex::new(None);
static METER_PROVIDER: ProviderSlot<SdkMeterProvider> = Mutex::new(None);
static NEXT_REGISTRATION: AtomicU64 = AtomicU64::new(0);

/// A provider registered by `setup_*`, with the id its guards release it by.
pub(crate) struct Registration<P> {
    id: u64,
    provider: P,
}

/// Where `setup_*` keeps the provider it registered.
pub(crate) type ProviderSlot<P> = Mutex<Option<Registration<P>>>;

/// Empties the slot if it still holds registration `id`, so the next `setup_*` builds a new
/// provider instead of returning a stopped one.
pub(crate) fn release<P>(slot: &ProviderSlot<P>, id: u64) {
    let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
    if slot.as_ref().is_some_and(|registration| registration.id == id) {
        *slot = None;
    }
}

fn register<P: Clone>(slot: &mut Option<Registration<P>>, provider: &P) -> u64 {
    let id = NEXT_REGISTRATION.fetch_add(1, Ordering::Relaxed);
    *slot = Some(Registration {
        id,
        provider: provider.clone(),
    });
    id
}

/// Which exporters a provider gets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, bon::Builder)]
pub struct TelemetryExporters {
    /// OTLP over HTTP, configured by the `OTEL_EXPORTER_OTLP_*` variables (endpoint, headers,
    /// protocol, timeout).
    #[builder(default)]
    pub otlp: bool,
    /// Prints to stdout, for debugging.
    #[builder(default)]
    pub console: bool,
}

crate::callback::callback! {
    /// Selects baggage keys for the baggage span processor (`BaggageKeyPredicate`).
    pub struct BaggageKeyPredicate(Fn(&str) -> bool);
}

/// The predicates of [`BaggageProcessor::Predicates`] (`BaggageKeyPredicates`); a key is stamped
/// when any of them selects it.
pub type BaggageKeyPredicates = Vec<BaggageKeyPredicate>;

/// Which baggage entries the tracer stamps onto every span as attributes.
///
/// ```
/// use strands::telemetry::BaggageProcessor;
///
/// let tenant_keys = BaggageProcessor::predicate(|key| key.starts_with("tenant."));
/// # let _ = tenant_keys;
/// ```
#[derive(Clone)]
#[non_exhaustive]
pub enum BaggageProcessor {
    /// Every key.
    AllKeys,
    /// The keys any predicate selects.
    Predicates(BaggageKeyPredicates),
}

impl BaggageProcessor {
    /// The keys one predicate selects.
    pub fn predicate(predicate: impl Fn(&str) -> bool + Send + Sync + 'static) -> Self {
        Self::Predicates(vec![BaggageKeyPredicate::new(predicate)])
    }

    fn selects(&self, key: &str) -> bool {
        match self {
            Self::AllKeys => true,
            Self::Predicates(predicates) => predicates.iter().any(|predicate| predicate(key)),
        }
    }
}

impl fmt::Debug for BaggageProcessor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AllKeys => f.write_str("AllKeys"),
            Self::Predicates(predicates) => f.debug_tuple("Predicates").field(&predicates.len()).finish(),
        }
    }
}

/// Copies the parent context's baggage onto each span as attributes (`BaggageSpanProcessor`).
#[derive(Debug)]
pub(crate) struct BaggageSpanProcessor {
    keys: BaggageProcessor,
}

impl BaggageSpanProcessor {
    pub(crate) fn new(keys: BaggageProcessor) -> Self {
        Self { keys }
    }
}

impl SpanProcessor for BaggageSpanProcessor {
    fn on_start(&self, span: &mut Span, cx: &Context) {
        for (key, (value, _)) in cx.baggage() {
            if self.keys.selects(key.as_str()) {
                span.set_attribute(KeyValue::new(key.clone(), value.to_string()));
            }
        }
    }

    fn on_end(&self, _span: SpanData) {}

    fn force_flush(&self) -> opentelemetry_sdk::error::OTelSdkResult {
        Ok(())
    }

    fn shutdown_with_timeout(&self, _timeout: std::time::Duration) -> opentelemetry_sdk::error::OTelSdkResult {
        Ok(())
    }
}

/// Configuration for [`setup_tracer`] (`TracerConfig`).
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct TracerConfig {
    /// A provider the caller built; it is registered as is, and `exporters` and
    /// `baggage_processor` are ignored. Defaults to one with the [`exporters`](Self::exporters).
    pub provider: Option<SdkTracerProvider>,
    /// The exporters of the provider the SDK builds.
    #[builder(default)]
    pub exporters: TelemetryExporters,
    /// Stamps baggage entries onto spans as attributes.
    pub baggage_processor: Option<BaggageProcessor>,
}

/// Configuration for [`setup_meter`] (`MeterConfig`).
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct MeterConfig {
    /// A provider the caller built; it is registered as is and `exporters` is ignored.
    pub provider: Option<SdkMeterProvider>,
    /// The exporters (periodic readers) of the provider the SDK builds.
    #[builder(default)]
    pub exporters: TelemetryExporters,
}

/// The tracer provider [`setup_tracer`] registered. Dropping the guard flushes the provider;
/// [`shutdown`](Self::shutdown) flushes and stops it.
///
/// Every call of [`setup_tracer`] returns a guard; the guards of repeat calls share the first
/// call's provider. Shutting any of them down stops that provider for all and clears the
/// registration, so the next [`setup_tracer`] builds and registers a new one.
#[must_use = "dropping the guard flushes the provider; keep it for the life of the program"]
pub struct TracerGuard {
    provider: SdkTracerProvider,
    stopped: bool,
    slot: &'static ProviderSlot<SdkTracerProvider>,
    registration: u64,
}

impl fmt::Debug for TracerGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TracerGuard")
            .field("provider", &self.provider)
            .field("stopped", &self.stopped)
            .finish_non_exhaustive()
    }
}

impl TracerGuard {
    /// The registered provider.
    #[must_use]
    pub fn provider(&self) -> &SdkTracerProvider {
        &self.provider
    }

    /// The `tracing` layer that exports the agent's spans through the provider. Add it to the
    /// application's subscriber, or let [`try_init_subscriber`](Self::try_init_subscriber) do it.
    ///
    /// The layer does not export the code location, target, thread or busy/idle time attributes
    /// `tracing-opentelemetry` adds by default, so spans carry the SDK's attributes only. The SDK's
    /// spans are `INFO` spans with target `strands::telemetry`: a filter in front of the layer
    /// (an `EnvFilter` on the registry, for example) must let them through, or the layer exports
    /// nothing. Give the layer its own filter instead to keep other layers quieter:
    ///
    /// ```no_run
    /// use strands::telemetry::tracing_subscriber::filter::LevelFilter;
    /// use strands::telemetry::tracing_subscriber::layer::{Layer, SubscriberExt};
    /// use strands::telemetry::tracing_subscriber::util::SubscriberInitExt;
    /// use strands::telemetry::{TelemetryExporters, TracerConfig, setup_tracer};
    ///
    /// let telemetry = setup_tracer(TracerConfig {
    ///     exporters: TelemetryExporters { otlp: true, console: false },
    ///     ..Default::default()
    /// })?;
    /// strands::telemetry::tracing_subscriber::registry()
    ///     .with(telemetry.layer())
    ///     .with(strands::telemetry::tracing_subscriber::fmt::layer().with_filter(LevelFilter::WARN))
    ///     .init();
    /// # Ok::<(), strands::Error>(())
    /// ```
    #[must_use]
    pub fn layer<S>(&self) -> OpenTelemetryLayer<S, SdkTracer>
    where
        S: tracing::Subscriber + for<'span> LookupSpan<'span>,
    {
        otel_layer(self.provider.tracer(service_name()))
    }

    /// Installs a global subscriber with only [`layer`](Self::layer), for programs that have no
    /// subscriber of their own; any other layers belong on a registry the program builds.
    ///
    /// ```no_run
    /// use strands::telemetry::{TelemetryExporters, TracerConfig, setup_tracer};
    ///
    /// let telemetry = setup_tracer(TracerConfig {
    ///     exporters: TelemetryExporters { otlp: true, console: false },
    ///     ..Default::default()
    /// })?;
    /// telemetry.try_init_subscriber()?;
    /// # Ok::<(), strands::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// A global subscriber is already set.
    pub fn try_init_subscriber(&self) -> Result<()> {
        tracing_subscriber::registry()
            .with(self.layer())
            .try_init()
            .map_err(Error::other)
    }

    /// Flushes and stops the provider, and clears its registration.
    ///
    /// # Errors
    ///
    /// The provider failed to export what it held or was already stopped.
    pub fn shutdown(mut self) -> Result<()> {
        self.stopped = true;
        release(self.slot, self.registration);
        self.provider.shutdown().map_err(Error::other)
    }
}

impl Drop for TracerGuard {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        if let Err(error) = self.provider.force_flush() {
            tracing::warn!("error=<{error}> | failed to flush tracer provider on exit");
        }
    }
}

/// The meter provider [`setup_meter`] registered. Dropping the guard flushes the provider;
/// [`shutdown`](Self::shutdown) flushes and stops it.
///
/// Every call of [`setup_meter`] returns a guard; the guards of repeat calls share the first
/// call's provider. Shutting any of them down stops that provider for all and clears the
/// registration, so the next [`setup_meter`] builds and registers a new one.
#[must_use = "dropping the guard flushes the provider; keep it for the life of the program"]
pub struct MeterGuard {
    provider: SdkMeterProvider,
    stopped: bool,
    slot: &'static ProviderSlot<SdkMeterProvider>,
    registration: u64,
}

impl fmt::Debug for MeterGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MeterGuard")
            .field("provider", &self.provider)
            .field("stopped", &self.stopped)
            .finish_non_exhaustive()
    }
}

impl MeterGuard {
    /// The registered provider.
    #[must_use]
    pub fn provider(&self) -> &SdkMeterProvider {
        &self.provider
    }

    /// Flushes and stops the provider, and clears its registration.
    ///
    /// # Errors
    ///
    /// The provider failed to export what it held or was already stopped.
    pub fn shutdown(mut self) -> Result<()> {
        self.stopped = true;
        release(self.slot, self.registration);
        self.provider.shutdown().map_err(Error::other)
    }
}

impl Drop for MeterGuard {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        if let Err(error) = self.provider.force_flush() {
            tracing::warn!("error=<{error}> | failed to flush meter provider on exit");
        }
    }
}

/// The layer the SDK's spans export through: without the location, target, thread and timing
/// attributes `tracing-opentelemetry` adds by default, so spans carry the SDK's attributes only.
pub(crate) fn otel_layer<S>(tracer: SdkTracer) -> OpenTelemetryLayer<S, SdkTracer>
where
    S: tracing::Subscriber + for<'span> LookupSpan<'span>,
{
    tracing_opentelemetry::layer()
        .with_tracer(tracer)
        .with_location(false)
        .with_target(false)
        .with_threads(false)
        .with_tracked_inactivity(false)
}

/// A tracer from the global provider, scoped to the service name, for custom spans.
#[must_use]
pub fn get_tracer() -> global::BoxedTracer {
    global::tracer(service_name())
}

/// A meter from the global provider, scoped to the service name, for custom metrics; a no-op
/// until a provider is registered.
#[must_use]
pub fn get_meter() -> opentelemetry::metrics::Meter {
    service_meter()
}

/// Sets up and registers the global tracer provider.
///
/// Without a custom provider this builds one with the configured exporters and the service
/// resource, and registers the W3C trace context and baggage propagators. A second call logs a
/// warning and returns a guard for the provider already registered; once a guard has been
/// [shut down](TracerGuard::shutdown), the next call registers a new provider.
///
/// # Errors
///
/// The OTLP exporter could not be built from the environment.
pub fn setup_tracer(config: TracerConfig) -> Result<TracerGuard> {
    let installed = install_tracer(&TRACER_PROVIDER, config, &process_env)?;
    if installed.registered {
        global::set_tracer_provider(installed.provider.clone());
    }
    if installed.registered && !installed.custom {
        global::set_text_map_propagator(TextMapCompositePropagator::new(vec![
            Box::new(TraceContextPropagator::new()),
            Box::new(BaggagePropagator::new()),
        ]));
    }
    Ok(TracerGuard::new(installed, &TRACER_PROVIDER))
}

impl TracerGuard {
    pub(crate) fn new(installed: InstalledTracer, slot: &'static ProviderSlot<SdkTracerProvider>) -> Self {
        Self {
            provider: installed.provider,
            stopped: false,
            slot,
            registration: installed.registration,
        }
    }
}

/// Sets up and registers the global meter provider. A second call logs a warning
/// and returns a guard for the provider already registered; once a guard has been
/// [shut down](MeterGuard::shutdown), the next call registers a new provider.
///
/// # Errors
///
/// The OTLP exporter could not be built from the environment.
pub fn setup_meter(config: MeterConfig) -> Result<MeterGuard> {
    let installed = install_meter(&METER_PROVIDER, config, &process_env)?;
    if installed.registered {
        global::set_meter_provider(installed.provider.clone());
    }
    Ok(MeterGuard::new(installed, &METER_PROVIDER))
}

impl MeterGuard {
    pub(crate) fn new(installed: InstalledMeter, slot: &'static ProviderSlot<SdkMeterProvider>) -> Self {
        Self {
            provider: installed.provider,
            stopped: false,
            slot,
            registration: installed.registration,
        }
    }
}

pub(crate) struct InstalledTracer {
    pub(crate) provider: SdkTracerProvider,
    /// The provider is new, not the one an earlier call registered.
    pub(crate) registered: bool,
    pub(crate) custom: bool,
    pub(crate) registration: u64,
}

pub(crate) struct InstalledMeter {
    pub(crate) provider: SdkMeterProvider,
    /// The provider is new, not the one an earlier call registered.
    pub(crate) registered: bool,
    pub(crate) registration: u64,
}

pub(crate) fn install_tracer(
    slot: &ProviderSlot<SdkTracerProvider>,
    config: TracerConfig,
    env: EnvLookup<'_>,
) -> Result<InstalledTracer> {
    let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(existing) = slot.as_ref() {
        tracing::warn!("tracer provider already initialized, returning existing provider");
        return Ok(InstalledTracer {
            provider: existing.provider.clone(),
            registered: false,
            custom: false,
            registration: existing.id,
        });
    }
    let custom = config.provider.is_some();
    let provider = match config.provider {
        Some(provider) => {
            if config.baggage_processor.is_some() {
                tracing::warn!(
                    "baggage_processor=<ignored> | custom provider is owned by the caller, add BaggageSpanProcessor to it"
                );
            }
            provider
        }
        None => build_tracer_provider(config.exporters, config.baggage_processor, env)?,
    };
    let registration = register(&mut slot, &provider);
    Ok(InstalledTracer {
        provider,
        registered: true,
        custom,
        registration,
    })
}

pub(crate) fn install_meter(
    slot: &ProviderSlot<SdkMeterProvider>,
    config: MeterConfig,
    env: EnvLookup<'_>,
) -> Result<InstalledMeter> {
    let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(existing) = slot.as_ref() {
        tracing::warn!("meter provider already initialized, returning existing provider");
        return Ok(InstalledMeter {
            provider: existing.provider.clone(),
            registered: false,
            registration: existing.id,
        });
    }
    let provider = match config.provider {
        Some(provider) => provider,
        None => build_meter_provider(config.exporters, env)?,
    };
    let registration = register(&mut slot, &provider);
    Ok(InstalledMeter {
        provider,
        registered: true,
        registration,
    })
}

/// The span exporters a configuration asks for, OTLP first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExporterKind {
    Otlp,
    Console,
}

pub(crate) fn exporter_kinds(exporters: TelemetryExporters) -> Vec<ExporterKind> {
    let mut kinds = Vec::new();
    if exporters.otlp {
        kinds.push(ExporterKind::Otlp);
    }
    if exporters.console {
        kinds.push(ExporterKind::Console);
    }
    kinds
}

fn build_tracer_provider(
    exporters: TelemetryExporters,
    baggage_processor: Option<BaggageProcessor>,
    env: EnvLookup<'_>,
) -> Result<SdkTracerProvider> {
    let mut builder = SdkTracerProvider::builder().with_resource(otel_resource(env));
    if let Some(keys) = baggage_processor {
        tracing::info!("enabling baggage span processor");
        builder = builder.with_span_processor(BaggageSpanProcessor::new(keys));
    }
    for kind in exporter_kinds(exporters) {
        builder = match kind {
            ExporterKind::Otlp => builder.with_batch_exporter(
                opentelemetry_otlp::SpanExporter::builder()
                    .with_http()
                    .build()
                    .map_err(Error::other)?,
            ),
            ExporterKind::Console => builder.with_simple_exporter(opentelemetry_stdout::SpanExporter::default()),
        };
    }
    Ok(builder.build())
}

fn build_meter_provider(exporters: TelemetryExporters, env: EnvLookup<'_>) -> Result<SdkMeterProvider> {
    let mut builder = SdkMeterProvider::builder().with_resource(otel_resource(env));
    for kind in exporter_kinds(exporters) {
        builder = match kind {
            ExporterKind::Otlp => builder.with_periodic_exporter(
                opentelemetry_otlp::MetricExporter::builder()
                    .with_http()
                    .build()
                    .map_err(Error::other)?,
            ),
            ExporterKind::Console => builder.with_periodic_exporter(opentelemetry_stdout::MetricExporter::default()),
        };
    }
    Ok(builder.build())
}

/// The service resource: the SDK defaults, then `OTEL_RESOURCE_ATTRIBUTES`
/// and `OTEL_SERVICE_NAME` over them.
pub(crate) fn otel_resource(env: EnvLookup<'_>) -> Resource {
    let namespace = env("OTEL_SERVICE_NAMESPACE")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVICE_NAMESPACE.to_owned());
    let environment = env("OTEL_DEPLOYMENT_ENVIRONMENT")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DEPLOYMENT_ENVIRONMENT.to_owned());
    Resource::builder_empty()
        .with_detector(Box::new(TelemetryResourceDetector))
        .with_attributes([
            KeyValue::new("service.name", service_name_from(env)),
            KeyValue::new("service.namespace", namespace),
            KeyValue::new("deployment.environment", environment),
            KeyValue::new("telemetry.sdk.name", "opentelemetry"),
            KeyValue::new("telemetry.sdk.language", "rust"),
        ])
        .with_attributes(env_resource_attributes(env))
        .build()
}

/// `OTEL_RESOURCE_ATTRIBUTES` (`key=value` pairs, comma separated, percent-encoded) and
/// `OTEL_SERVICE_NAME`, as the OpenTelemetry environment detector reads them.
fn env_resource_attributes(env: EnvLookup<'_>) -> Vec<KeyValue> {
    let mut attributes: Vec<KeyValue> = env("OTEL_RESOURCE_ATTRIBUTES")
        .unwrap_or_default()
        .split(',')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let key = key.trim();
            (!key.is_empty()).then(|| KeyValue::new(percent_decode(key), percent_decode(value.trim())))
        })
        .collect();
    if let Some(name) = env("OTEL_SERVICE_NAME").filter(|name| !name.is_empty()) {
        attributes.push(KeyValue::new("service.name", name));
    }
    attributes
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = (bytes[index] == b'%')
            .then(|| text.get(index + 1..index + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match escaped {
            Some(byte) => {
                decoded.push(byte);
                index += 3;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}
