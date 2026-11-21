//! The `sleep` tool: pauses for a bounded number of seconds and stops at once when the call is
//! cancelled.

use serde_json::json;

use super::input::InputReader;
use super::{js_number, js_number_text, seconds};
use crate::cancel::CancelSignal;
use crate::error::{Error, Result};
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonSchema, JsonValue};

/// The default upper bound on `duration`, in seconds (`DEFAULT_MAX_DURATION`).
pub const DEFAULT_MAX_DURATION: f64 = 60.0;

/// The description of the default `sleep` tool (`SLEEP_DESCRIPTION`), with its 60-second cap.
pub const SLEEP_DESCRIPTION: &str = "Pauses execution for a specified number of seconds (max 60). Cooperative and cancellable: the sleep aborts immediately when the agent invocation is cancelled. Rejects negative, NaN, infinite, or non-numeric durations, and durations above 60.";

/// The model-facing description for a cap of `max_duration` seconds.
#[must_use]
pub fn sleep_description(max_duration: f64) -> String {
    let max = js_number_text(max_duration);
    format!(
        "Pauses execution for a specified number of seconds (max {max}). Cooperative and cancellable: the sleep aborts immediately when the agent invocation is cancelled. Rejects negative, NaN, infinite, or non-numeric durations, and durations above {max}."
    )
}

/// Options for [`make_sleep`] (`MakeSleepOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeSleepOptions {
    /// The largest `duration` accepted, in seconds; [`DEFAULT_MAX_DURATION`] when absent.
    pub max_duration: Option<f64>,
    /// The tool name; `sleep` when absent.
    pub name: Option<String>,
    /// The tool description; [`sleep_description`] of the cap when absent.
    pub description: Option<String>,
}

fn input_schema(max_duration: f64) -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "duration": {
                "type": "number",
                "minimum": 0,
                "maximum": js_number(max_duration),
                "description": format!(
                    "Seconds to pause. Must be finite, non-negative, and no larger than {}.",
                    js_number_text(max_duration)
                )
            }
        },
        "required": ["duration"],
        "additionalProperties": false
    })
}

/// The default `sleep` tool, capped at 60 seconds (`sleep`).
#[must_use]
pub fn sleep() -> FunctionTool {
    build(DEFAULT_MAX_DURATION, "sleep".to_owned(), SLEEP_DESCRIPTION.to_owned())
}

/// Creates a sleep tool with a configurable cap. The call returns
/// `Slept for <duration> seconds`, or fails at once when its cancel signal fires.
///
/// ```
/// use strands::vended_tools::sleep::{MakeSleepOptions, make_sleep};
///
/// let short_sleep = make_sleep(MakeSleepOptions::builder().max_duration(5.0).build())?;
/// assert!(strands::Tool::description(&short_sleep).contains("max 5"));
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// When `max_duration` is not a positive finite number.
pub fn make_sleep(options: MakeSleepOptions) -> Result<FunctionTool> {
    let max_duration = options.max_duration.unwrap_or(DEFAULT_MAX_DURATION);
    if !max_duration.is_finite() || max_duration <= 0.0 {
        return Err(Error::other(format!(
            "maxDuration must be a positive, finite number, got {}",
            js_number_text(max_duration)
        )));
    }
    let name = options.name.unwrap_or_else(|| "sleep".to_owned());
    let description = options.description.unwrap_or_else(|| sleep_description(max_duration));
    Ok(build(max_duration, name, description))
}

fn build(max_duration: f64, name: String, description: String) -> FunctionTool {
    FunctionTool::builder(name, description)
        .input_schema(input_schema(max_duration))
        .callback(move |input, context| {
            let signal = context.cancel_signal().clone();
            async move { run(&input, max_duration, &signal).await }
        })
}

/// Sleeps `duration` seconds; a duration too long for a
/// [`Duration`](std::time::Duration) never ends.
async fn sleep_for(duration: f64) {
    match seconds(duration) {
        Some(duration) => tokio::time::sleep(duration).await,
        None => std::future::pending().await,
    }
}

fn cancelled(signal: &CancelSignal, fallback: &str) -> ToolError {
    ToolError::msg(signal.reason().unwrap_or_else(|| fallback.to_owned()))
}

async fn run(input: &JsonValue, max_duration: f64, signal: &CancelSignal) -> std::result::Result<JsonValue, ToolError> {
    let mut reader = InputReader::new(input);
    let duration = reader.number("duration");
    if let Some(duration) = duration {
        if duration < 0.0 {
            reader.issue("duration", "duration must be non-negative");
        } else if duration > max_duration {
            let message = format!("duration exceeds maximum of {} seconds", js_number_text(max_duration));
            reader.issue("duration", message);
        }
    }
    reader.finish()?;
    let duration = duration.unwrap_or_default();
    if signal.is_cancelled() {
        return Err(cancelled(signal, "Sleep cancelled before it started"));
    }
    tokio::select! {
        () = sleep_for(duration) => {}
        () = signal.cancelled() => return Err(cancelled(signal, "Sleep cancelled")),
    }
    Ok(format!("Slept for {} seconds", js_number_text(duration)).into())
}

#[cfg(test)]
mod tests {
    //! Time is paused, so no test waits for real.

    use std::time::Duration;

    use super::*;
    use crate::cancel::{CancelHandle, CancelOptions};
    use crate::types::ToolResultStatus;
    use crate::vended_tools::test_support::{agent, error_text, ok_text, run_with_signal, text};

    async fn rejects(tool: &FunctionTool, duration: JsonValue) -> String {
        error_text(tool, json!({"duration": duration}), &agent()).await
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_negative_durations() {
        assert!(rejects(&sleep(), json!(-0.1)).await.contains("non-negative"));
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_non_numeric_input_via_schema() {
        let message = rejects(&sleep(), json!("one")).await;
        assert!(message.contains("expected number, received string"), "{message}");
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_boolean_input_via_schema() {
        rejects(&sleep(), json!(true)).await;
        rejects(&sleep(), json!(false)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_duration_above_default_maximum() {
        let message = rejects(&sleep(), json!(DEFAULT_MAX_DURATION + 1.0)).await;
        assert!(message.contains("duration exceeds maximum of 60 seconds"), "{message}");
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_duration_above_configured_maximum() {
        let capped = make_sleep(MakeSleepOptions::builder().max_duration(0.5).build()).unwrap();
        assert!(rejects(&capped, json!(0.6)).await.contains("exceeds maximum"));
    }

    #[test]
    fn rejects_invalid_max_duration() {
        for value in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let error = make_sleep(MakeSleepOptions::builder().max_duration(value).build()).unwrap_err();
            assert!(error.to_string().contains("positive"), "{error}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn aborts_immediately_when_cancel_signal_fires_mid_sleep() {
        let handle = CancelHandle::new();
        let canceller = handle.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            canceller.cancel(CancelOptions::default());
        });
        let started = tokio::time::Instant::now();
        let result = run_with_signal(&sleep(), json!({"duration": 5}), &agent(), handle.signal()).await;
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(result.status, ToolResultStatus::Error);
        assert_eq!(text(&result), "Error: Sleep cancelled");
    }

    #[tokio::test(start_paused = true)]
    async fn sleeps_until_cancelled_when_the_duration_is_too_long_for_a_timer() {
        let capped = make_sleep(MakeSleepOptions::builder().max_duration(1e300).build()).unwrap();
        let handle = CancelHandle::new();
        let canceller = handle.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            canceller.cancel(CancelOptions::default());
        });
        let result = run_with_signal(&capped, json!({"duration": 1e300}), &agent(), handle.signal()).await;
        assert_eq!(text(&result), "Error: Sleep cancelled");
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_synchronously_when_the_signal_is_already_aborted() {
        let handle = CancelHandle::new();
        handle.cancel(CancelOptions {
            message: Some("stop now".to_owned()),
            ..CancelOptions::default()
        });
        let result = run_with_signal(&sleep(), json!({"duration": 1}), &agent(), handle.signal()).await;
        assert_eq!(text(&result), "Error: stop now");
    }

    #[tokio::test(start_paused = true)]
    async fn returns_the_expected_message_after_a_short_sleep() {
        let started = tokio::time::Instant::now();
        assert_eq!(
            ok_text(&sleep(), json!({"duration": 0.05}), &agent()).await,
            "Slept for 0.05 seconds"
        );
        assert!(started.elapsed() >= Duration::from_millis(50));
    }

    #[tokio::test(start_paused = true)]
    async fn accepts_zero_duration() {
        assert_eq!(
            ok_text(&sleep(), json!({"duration": 0}), &agent()).await,
            "Slept for 0 seconds"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn drives_the_timer_with_the_requested_duration() {
        let started = tokio::time::Instant::now();
        assert_eq!(
            ok_text(&sleep(), json!({"duration": 2}), &agent()).await,
            "Slept for 2 seconds"
        );
        assert_eq!(started.elapsed(), Duration::from_secs(2));
    }

    #[test]
    fn describes_the_configured_cap() {
        assert_eq!(sleep_description(DEFAULT_MAX_DURATION), SLEEP_DESCRIPTION);
    }
}
