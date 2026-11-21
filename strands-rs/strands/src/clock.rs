//! Wall-clock timestamps in the persisted ISO 8601 form: [`iso_timestamp`] with a crate-internal
//! test override so snapshot and background-task tests can match cross-SDK fixtures byte for byte,
//! and the injectable [`Clock`] the session and memory code take.

use std::fmt;
use std::sync::Arc;

use jiff::Timestamp;
use jiff::tz::Offset;

/// The current UTC time with milliseconds (`new Date().toISOString()`), for example
/// `2026-11-11T12:00:00.000Z`.
pub(crate) fn iso_timestamp() -> String {
    #[cfg(test)]
    if let Some(fixed) = test_clock::fixed() {
        return fixed;
    }
    to_iso_string(Timestamp::now())
}

/// The current time. [`Clock::system`] reads the system clock.
#[derive(Clone)]
pub(crate) struct Clock(Arc<dyn Fn() -> Timestamp + Send + Sync>);

impl Clock {
    pub(crate) fn system() -> Self {
        Self(Arc::new(Timestamp::now))
    }

    #[cfg(test)]
    pub(crate) fn fixed(timestamp: Timestamp) -> Self {
        Self(Arc::new(move || timestamp))
    }

    #[cfg(test)]
    pub(crate) fn from_fn(now: impl Fn() -> Timestamp + Send + Sync + 'static) -> Self {
        Self(Arc::new(now))
    }

    pub(crate) fn now(&self) -> Timestamp {
        (self.0)()
    }

    /// The current time as an ISO 8601 UTC string with milliseconds.
    pub(crate) fn now_iso(&self) -> String {
        to_iso_string(self.now())
    }
}

impl Default for Clock {
    fn default() -> Self {
        Self::system()
    }
}

impl fmt::Debug for Clock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Clock")
    }
}

/// `2026-11-11T12:00:00.000Z`: UTC, milliseconds truncated, as the other Strands SDKs persist it.
pub(crate) fn to_iso_string(timestamp: Timestamp) -> String {
    let at = Offset::UTC.to_datetime(timestamp);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        at.month(),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}

#[cfg(test)]
pub(crate) mod test_clock {
    use std::cell::RefCell;

    thread_local! {
        static FIXED: RefCell<Option<String>> = const { RefCell::new(None) };
    }

    pub(super) fn fixed() -> Option<String> {
        FIXED.with(|fixed| fixed.borrow().clone())
    }

    /// Makes [`super::iso_timestamp`] return `timestamp` on this thread until the guard drops.
    pub(crate) fn fix(timestamp: &str) -> Guard {
        FIXED.with(|fixed| *fixed.borrow_mut() = Some(timestamp.to_owned()));
        Guard
    }

    pub(crate) struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            FIXED.with(|fixed| *fixed.borrow_mut() = None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_timestamps_like_js_to_iso_string() {
        let at: Timestamp = "2026-11-11T12:00:00Z".parse().unwrap();
        assert_eq!(to_iso_string(at), "2026-11-11T12:00:00.000Z");
        let at: Timestamp = "2024-01-01T00:00:00.999999999Z".parse().unwrap();
        assert_eq!(to_iso_string(at), "2024-01-01T00:00:00.999Z");
        let at: Timestamp = "1969-12-31T23:59:59.5Z".parse().unwrap();
        assert_eq!(to_iso_string(at), "1969-12-31T23:59:59.500Z");
    }

    #[test]
    fn a_fixed_clock_returns_its_time() {
        let at: Timestamp = "2025-06-01T00:00:00Z".parse().unwrap();
        assert_eq!(Clock::fixed(at).now_iso(), "2025-06-01T00:00:00.000Z");
        assert!(Clock::system().now() > at);
    }
}
