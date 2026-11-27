//! OTEL tracing for a harness agent.
//!
//! The SDK already instruments the agent; a plain agent just has nowhere to send the spans. The
//! harness wires an exporter only when asked through the standard `OTEL_TRACES_EXPORTER`
//! selector (`otlp`, `console`, `none`). Unset means off: the harness does not honor OTEL's
//! spec default of `otlp`, so it never silently stands up an exporter. Endpoint, headers and
//! protocol come from the usual `OTEL_EXPORTER_OTLP_*` variables. Tracing is process-global, so
//! setup runs at most once per process. Exporting needs the `otel` feature.
//!
//! The SDK's spans are `tracing` spans, so they reach the exporter only through a global
//! subscriber that carries the SDK's OpenTelemetry layer. The harness installs that subscriber
//! when the program has none; a program that installed its own owns tracing, and the harness
//! leaves it alone.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::env::Env;
use crate::logging::warn_once;

/// The standard exporter selector (`TRACES_EXPORTER_ENV_VAR`).
pub(crate) const TRACES_EXPORTER_ENV_VAR: &str = "OTEL_TRACES_EXPORTER";

const SUPPORTED_EXPORTERS: [&str; 2] = ["otlp", "console"];

static CONFIGURED: AtomicBool = AtomicBool::new(false);

/// The exporters to wire.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Exporters {
    pub(crate) otlp: bool,
    pub(crate) console: bool,
}

impl Exporters {
    fn any(self) -> bool {
        self.otlp || self.console
    }
}

/// The exporters the selector names; unset or `none` is none. An
/// unsupported name is warned about and skipped.
pub(crate) fn resolve_exporters(selector: Option<&str>) -> Exporters {
    let requested: Vec<String> = selector
        .unwrap_or_default()
        .split(',')
        .map(|name| name.trim().to_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    if requested.is_empty() || requested.iter().any(|name| name == "none") {
        return Exporters::default();
    }
    for name in requested
        .iter()
        .filter(|name| !SUPPORTED_EXPORTERS.contains(&name.as_str()))
    {
        warn_once(&format!(
            "{TRACES_EXPORTER_ENV_VAR} names '{name}', which the harness does not support; skipping it. Supported values: otlp, console, none."
        ));
    }
    Exporters {
        otlp: requested.iter().any(|name| name == "otlp"),
        console: requested.iter().any(|name| name == "console"),
    }
}

/// Wires the exporters at most once per `configured` flag; `setup` installs them.
pub(crate) fn setup_telemetry_with(
    configured: &AtomicBool,
    selector: Option<&str>,
    setup: impl FnOnce(Exporters) -> strands::Result<()>,
) -> strands::Result<()> {
    if configured.load(Ordering::SeqCst) {
        return Ok(());
    }
    let exporters = resolve_exporters(selector);
    if !exporters.any() {
        return Ok(());
    }
    setup(exporters)?;
    configured.store(true, Ordering::SeqCst);
    Ok(())
}

/// Wires the SDK's span exporters once per process from `OTEL_TRACES_EXPORTER`.
pub(crate) fn setup_telemetry(env: &Env) -> strands::Result<()> {
    setup_telemetry_with(&CONFIGURED, env.get(TRACES_EXPORTER_ENV_VAR).as_deref(), install)
}

#[cfg(feature = "otel")]
fn install(exporters: Exporters) -> strands::Result<()> {
    install_unless_subscribed(exporters, tracing::dispatcher::has_been_set(), install_tracer)
}

/// Leaves tracing to a global subscriber the program installed, with a warning; otherwise
/// `install` wires the exporters.
#[cfg(any(feature = "otel", test))]
pub(crate) fn install_unless_subscribed(
    exporters: Exporters,
    subscribed: bool,
    install: impl FnOnce(Exporters) -> strands::Result<()>,
) -> strands::Result<()> {
    if subscribed {
        warn_once(&format!(
            "{TRACES_EXPORTER_ENV_VAR} is set, but the program already installed a global tracing subscriber, so the harness leaves tracing to it. Add the layer from strands::telemetry::setup_tracer (TracerGuard::layer) to that subscriber to export the agent's spans."
        ));
        return Ok(());
    }
    install(exporters)
}

/// Registers the provider and a global subscriber that exports the SDK's spans through it.
#[cfg(feature = "otel")]
fn install_tracer(exporters: Exporters) -> strands::Result<()> {
    use std::sync::OnceLock;

    use strands::telemetry::{TelemetryExporters, TracerConfig, TracerGuard, setup_tracer};

    // The guard lives for the process: dropping it would flush and detach the provider.
    static GUARD: OnceLock<TracerGuard> = OnceLock::new();
    let config = TracerConfig {
        exporters: TelemetryExporters {
            otlp: exporters.otlp,
            console: exporters.console,
        },
        ..Default::default()
    };
    let guard = setup_tracer(config)?;
    // Another thread can install a global subscriber between the check and this call.
    if let Err(error) = guard.try_init_subscriber() {
        tracing::warn!("error=<{error}> | could not install the tracing subscriber, spans are not exported");
    }
    let _ = GUARD.set(guard);
    Ok(())
}

#[cfg(not(feature = "otel"))]
fn install(_exporters: Exporters) -> strands::Result<()> {
    warn_once(&format!(
        "{TRACES_EXPORTER_ENV_VAR} is set, but strands-harness was built without the \"otel\" feature; tracing stays off."
    ));
    Ok(())
}

/// The SDK's `setup_tracer` is replaced by a recorder so these pin the harness's gating, not the
/// exporter wiring.
#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::test_support::record_logs;

    fn setup(selector: Option<&str>) -> Vec<Exporters> {
        let configured = AtomicBool::new(false);
        let calls = RefCell::new(Vec::new());
        setup_telemetry_with(&configured, selector, |exporters| {
            calls.borrow_mut().push(exporters);
            Ok(())
        })
        .unwrap();
        calls.into_inner()
    }

    #[test]
    fn configures_nothing_without_a_selector() {
        assert!(setup(None).is_empty());
    }

    #[test]
    fn does_not_enable_tracing_from_an_endpoint_alone() {
        let env = crate::test_support::env(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")]);
        assert!(setup(env.get(TRACES_EXPORTER_ENV_VAR).as_deref()).is_empty());
    }

    #[test]
    fn wires_the_otlp_exporter_from_the_selector() {
        assert_eq!(
            setup(Some("otlp")),
            [Exporters {
                otlp: true,
                console: false
            }]
        );
    }

    #[test]
    fn wires_the_console_exporter_from_the_selector() {
        assert_eq!(
            setup(Some("console")),
            [Exporters {
                otlp: false,
                console: true
            }]
        );
    }

    #[test]
    fn wires_both_when_the_selector_lists_them() {
        assert_eq!(
            setup(Some("otlp, console")),
            [Exporters {
                otlp: true,
                console: true
            }]
        );
    }

    #[test]
    fn disables_tracing_when_the_selector_is_none() {
        assert!(setup(Some("none")).is_empty());
    }

    #[test]
    fn warns_and_skips_an_unsupported_exporter() {
        let (logs, _guard) = record_logs();
        assert!(setup(Some("zipkin")).is_empty());
        assert!(logs.lines("WARN").iter().any(|line| line.contains("zipkin")));
    }

    #[test]
    fn still_wires_the_supported_exporters_alongside_an_unsupported_one() {
        assert_eq!(
            setup(Some("zipkin,otlp")),
            [Exporters {
                otlp: true,
                console: false
            }]
        );
    }

    #[test]
    fn installs_the_exporters_when_the_program_has_no_subscriber() {
        let mut installed = Vec::new();
        install_unless_subscribed(
            Exporters {
                otlp: true,
                console: false,
            },
            false,
            |exporters| {
                installed.push(exporters);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            installed,
            [Exporters {
                otlp: true,
                console: false
            }]
        );
    }

    #[test]
    fn leaves_tracing_to_a_subscriber_the_program_installed() {
        let (logs, _guard) = record_logs();
        install_unless_subscribed(
            Exporters {
                otlp: true,
                console: false,
            },
            true,
            |_| panic!("the program's subscriber owns tracing"),
        )
        .unwrap();
        assert!(
            logs.lines("WARN")
                .iter()
                .any(|line| line.contains("already installed a global tracing subscriber"))
        );
    }

    #[test]
    fn runs_once_per_process() {
        let configured = AtomicBool::new(false);
        let mut calls = 0;
        for _ in 0..3 {
            setup_telemetry_with(&configured, Some("otlp"), |_| {
                calls += 1;
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(calls, 1);
    }
}
