//! Per-invocation state shared by hooks and tools (`InvocationState`).

use std::fmt;
use std::sync::{Arc, PoisonError, RwLock};

/// Per-invocation state threaded through hooks and tools for one agent invocation
/// (`InvocationState`).
///
/// A typed map that holds one value per type, following `http::Extensions`, so callers can pass
/// live values (clients, pools, request ids) without serializing or downcasting them. Clones share
/// the same map: a value one hook inserts is visible to later hooks, tools and
/// [`AgentResult::invocation_state`](crate::AgentResult::invocation_state).
///
/// The state belongs to the caller; the SDK never stores its own data in it. It is never
/// serialized.
///
/// ```
/// use strands::InvocationState;
///
/// #[derive(Clone, Debug, PartialEq)]
/// struct RequestId(String);
///
/// let state = InvocationState::new();
/// let shared = state.clone();
/// shared.insert(RequestId("req-1".into()));
/// assert_eq!(state.get::<RequestId>(), Some(RequestId("req-1".into())));
/// ```
#[derive(Clone, Default)]
pub struct InvocationState {
    values: Arc<RwLock<http::Extensions>>,
}

impl InvocationState {
    /// Creates empty state.
    pub fn new() -> Self {
        Self::default()
    }

    /// A separate map holding the same values: later inserts on either side do not show on the
    /// other.
    pub(crate) fn copy(&self) -> Self {
        let values = self.values.read().unwrap_or_else(PoisonError::into_inner).clone();
        Self {
            values: Arc::new(RwLock::new(values)),
        }
    }

    /// Stores `value`, returning the previous value of the same type.
    pub fn insert<T: Clone + Send + Sync + 'static>(&self, value: T) -> Option<T> {
        self.values
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(value)
    }

    /// Returns a clone of the value of type `T`.
    #[must_use]
    pub fn get<T: Clone + Send + Sync + 'static>(&self) -> Option<T> {
        self.values
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get::<T>()
            .cloned()
    }

    /// Whether a value of type `T` is stored.
    #[must_use]
    pub fn contains<T: Clone + Send + Sync + 'static>(&self) -> bool {
        self.values
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get::<T>()
            .is_some()
    }

    /// Updates the value of type `T` in place, inserting `T::default()` first when it is absent,
    /// and returns what `update` returns. The map stays locked while `update` runs, so concurrent
    /// tools see each other's updates.
    pub fn update<T, R>(&self, update: impl FnOnce(&mut T) -> R) -> R
    where
        T: Clone + Default + Send + Sync + 'static,
    {
        let mut values = self.values.write().unwrap_or_else(PoisonError::into_inner);
        update(values.get_or_insert_default::<T>())
    }

    /// Removes and returns the value of type `T`.
    pub fn remove<T: Clone + Send + Sync + 'static>(&self) -> Option<T> {
        self.values
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .remove::<T>()
    }

    /// Whether no values are stored.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.values.read().unwrap_or_else(PoisonError::into_inner).is_empty()
    }

    /// The number of stored values.
    #[must_use]
    pub fn len(&self) -> usize {
        self.values.read().unwrap_or_else(PoisonError::into_inner).len()
    }

    /// Removes every value.
    pub fn clear(&self) {
        self.values.write().unwrap_or_else(PoisonError::into_inner).clear();
    }
}

impl fmt::Debug for InvocationState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InvocationState").field("len", &self.len()).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, Default, PartialEq)]
    struct Counter(u32);

    #[test]
    fn clones_share_values() {
        let state = InvocationState::new();
        let clone = state.clone();
        assert_eq!(clone.insert(Counter(1)), None);
        assert_eq!(state.get::<Counter>(), Some(Counter(1)));
        assert_eq!(state.insert(Counter(2)), Some(Counter(1)));
        assert!(clone.contains::<Counter>());
        assert_eq!(clone.len(), 1);
        assert_eq!(clone.remove::<Counter>(), Some(Counter(2)));
        assert!(state.is_empty());
    }

    #[test]
    fn update_inserts_a_default_and_mutates_in_place() {
        let state = InvocationState::new();
        state.update(|counter: &mut Counter| counter.0 += 1);
        let total = state.update(|counter: &mut Counter| {
            counter.0 += 1;
            counter.0
        });
        assert_eq!(total, 2);
        state.clear();
        assert_eq!(state.get::<Counter>(), None);
    }
}
