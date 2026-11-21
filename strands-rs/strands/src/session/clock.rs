//! Injectable snapshot-id source, so session code is deterministic under test. The clock is
//! [`crate::clock::Clock`].

use std::fmt;
use std::sync::Arc;

/// New UUID v7 snapshot ids. [`UuidV7Source::system`] uses the time-ordered generator.
#[derive(Clone)]
pub(crate) struct UuidV7Source(Arc<dyn Fn() -> uuid::Uuid + Send + Sync>);

impl UuidV7Source {
    pub(crate) fn system() -> Self {
        Self(Arc::new(uuid::Uuid::now_v7))
    }

    /// Ids `00000000-0001-7000-8000-000000000000`, `...0002-...` and so on, in ascending order.
    #[cfg(test)]
    pub(crate) fn sequence() -> Self {
        let counter = Arc::new(std::sync::atomic::AtomicU64::new(0));
        Self(Arc::new(move || {
            let index = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let millis = index & 0xFFFF_FFFF_FFFF;
            uuid::Builder::from_unix_timestamp_millis(millis, &[0; 10]).into_uuid()
        }))
    }

    pub(crate) fn next_id(&self) -> String {
        (self.0)().to_string()
    }
}

impl Default for UuidV7Source {
    fn default() -> Self {
        Self::system()
    }
}

impl fmt::Debug for UuidV7Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("UuidV7Source")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::validation::validate_uuid_v7;

    #[test]
    fn id_sources_produce_valid_ascending_uuid_v7s() {
        let sequence = UuidV7Source::sequence();
        let first = sequence.next_id();
        let second = sequence.next_id();
        assert_eq!(first, "00000000-0001-7000-8000-000000000000");
        assert!(second > first);
        validate_uuid_v7(&second).unwrap();
        let system = UuidV7Source::system();
        validate_uuid_v7(&system.next_id()).unwrap();
    }
}
