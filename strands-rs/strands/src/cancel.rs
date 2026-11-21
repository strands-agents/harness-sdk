//! Cooperative cancellation: [`CancelHandle`], [`CancelSignal`] and [`CancelOptions`].
//!
//! The handle requests cancellation and the signal, which can be cloned freely, observes it.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use tokio_util::sync::CancellationToken;

/// Options for [`CancelHandle::cancel`] (`CancelOptions`).
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
pub struct CancelOptions {
    /// Final assistant message for the cancelled invocation. When several callers set one, the
    /// last write wins; a cancel without a message keeps a previously stored one.
    #[builder(into)]
    pub message: Option<String>,
    /// Defer cancellation until the running tool batch finishes, so sibling tools complete
    /// normally instead of seeing the signal fire. Only the agent loop acts on the deferral: it
    /// stops after the batch. Until then [`CancelSignal::is_cancelled`] stays `false` for every
    /// other observer.
    #[builder(default)]
    pub after_current_tools: bool,
    /// Also cancel every queued, working or input-required background task of the agent
    /// immediately, even with `after_current_tools` and whether or not an invocation is running
    /// (`cancelBackgroundTasks`). Background tasks keep running by default, and a
    /// `cancel_signal` passed into an invocation never cancels them. Their cancelled results are
    /// delivered like a cancel the model requested. If the invocation was only waiting for its
    /// background tasks, it ends with its natural stop reason and the results are delivered on the
    /// next invocation. Only an agent's own handle acts on it.
    #[builder(default)]
    pub cancel_background_tasks: bool,
}

/// Cancels an agent's background tasks; installed on the agent's own handle.
pub(crate) type BackgroundCancelFn = Arc<dyn Fn() + Send + Sync>;

struct Shared {
    token: Mutex<CancellationToken>,
    deferred: AtomicBool,
    message: Mutex<Option<String>>,
    /// Set for an agent's own handle: a cancel only counts while an invocation runs.
    active: Option<AtomicBool>,
    background_cancel: Mutex<Option<BackgroundCancelFn>>,
}

impl Shared {
    fn token(&self) -> CancellationToken {
        self.token.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn message(&self) -> Option<String> {
        self.message.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

/// Requests cancellation of the work observing its [`CancelSignal`].
///
/// Cheap to clone; clones control the same signal.
///
/// ```
/// use strands::{CancelHandle, CancelOptions};
///
/// let handle = CancelHandle::new();
/// let signal = handle.signal();
/// handle.cancel(CancelOptions { message: Some("stopped".into()), ..Default::default() });
/// assert!(signal.is_cancelled());
/// assert_eq!(signal.reason().as_deref(), Some("stopped"));
/// ```
#[derive(Clone)]
pub struct CancelHandle {
    shared: Arc<Shared>,
}

impl CancelHandle {
    /// Creates a handle whose signal has not fired.
    pub fn new() -> Self {
        Self::with_gate(None)
    }

    /// An agent's own handle: cancels are ignored while no invocation runs, and each invocation
    /// starts with a fresh signal.
    pub(crate) fn for_agent() -> Self {
        Self::with_gate(Some(AtomicBool::new(false)))
    }

    fn with_gate(active: Option<AtomicBool>) -> Self {
        Self {
            shared: Arc::new(Shared {
                token: Mutex::new(CancellationToken::new()),
                deferred: AtomicBool::new(false),
                message: Mutex::new(None),
                active,
                background_cancel: Mutex::new(None),
            }),
        }
    }

    /// The signal this handle controls.
    #[must_use]
    pub fn signal(&self) -> CancelSignal {
        CancelSignal {
            sources: Arc::from([Source {
                shared: Arc::clone(&self.shared),
                token: self.shared.token(),
            }]),
        }
    }

    /// Requests cancellation. Idempotent.
    ///
    /// With `after_current_tools` the request is recorded but the signal does not fire; the agent
    /// stops once the running tool batch finishes. Otherwise the signal fires now. On an agent's
    /// handle ([`Agent::cancel_handle`](crate::Agent::cancel_handle)) a cancel while the agent is
    /// idle does nothing, except that `cancel_background_tasks` still applies.
    pub fn cancel(&self, options: CancelOptions) {
        if options.cancel_background_tasks {
            let background_cancel = self
                .shared
                .background_cancel
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if let Some(background_cancel) = background_cancel {
                background_cancel();
            }
        }
        if let Some(active) = &self.shared.active
            && !active.load(Ordering::SeqCst)
        {
            return;
        }
        if let Some(message) = options.message {
            *self.shared.message.lock().unwrap_or_else(PoisonError::into_inner) = Some(message);
        }
        if options.after_current_tools {
            self.shared.deferred.store(true, Ordering::SeqCst);
            return;
        }
        self.shared.token().cancel();
    }

    /// Starts a fresh signal: clears the message and the deferred flag. Signals taken before keep
    /// their state.
    pub(crate) fn reset(&self) {
        *self.shared.token.lock().unwrap_or_else(PoisonError::into_inner) = CancellationToken::new();
        self.shared.deferred.store(false, Ordering::SeqCst);
        *self.shared.message.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Installs what `cancel_background_tasks` runs: the agent's background tasks, once they are
    /// attached.
    pub(crate) fn set_background_cancel(&self, background_cancel: BackgroundCancelFn) {
        *self
            .shared
            .background_cancel
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(background_cancel);
    }

    /// Marks whether an invocation runs, for an agent's own handle.
    pub(crate) fn set_active(&self, value: bool) {
        if let Some(active) = &self.shared.active {
            active.store(value, Ordering::SeqCst);
        }
    }
}

impl Default for CancelHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for CancelHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CancelHandle")
            .field("cancelled", &self.shared.token().is_cancelled())
            .finish_non_exhaustive()
    }
}

struct Source {
    shared: Arc<Shared>,
    token: CancellationToken,
}

/// Observes cancellation requested through a [`CancelHandle`].
///
/// Cheap to clone; every clone sees the same state. Pass one as `InvokeOptions::cancel_signal`
/// to cancel an invocation from outside the agent, or read it in tools and providers to stop
/// in-flight work.
#[derive(Clone)]
pub struct CancelSignal {
    sources: Arc<[Source]>,
}

impl CancelSignal {
    /// A signal that fires when either signal fires. Its reason and deferral come from the first
    /// signal that has one.
    pub(crate) fn any(first: &Self, second: &Self) -> Self {
        let sources: Vec<Source> = first
            .sources
            .iter()
            .chain(second.sources.iter())
            .map(|source| Source {
                shared: Arc::clone(&source.shared),
                token: source.token.clone(),
            })
            .collect();
        Self {
            sources: Arc::from(sources),
        }
    }

    /// Whether cancellation has fired (`aborted`).
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.sources.iter().any(|source| source.token.is_cancelled())
    }

    /// Completes when cancellation fires; immediately if it already has.
    pub async fn cancelled(&self) {
        let waits = self.sources.iter().map(|source| Box::pin(source.token.cancelled()));
        futures::future::select_all(waits).await;
    }

    /// The message passed with the latest cancel that carried one.
    #[must_use]
    pub fn reason(&self) -> Option<String> {
        self.sources.iter().find_map(|source| source.shared.message())
    }

    /// Whether a cancel deferred until the running tool batch finishes is pending.
    pub(crate) fn is_deferred(&self) -> bool {
        self.sources
            .iter()
            .any(|source| source.shared.deferred.load(Ordering::SeqCst))
    }
}

impl fmt::Debug for CancelSignal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CancelSignal")
            .field("cancelled", &self.is_cancelled())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn a_new_signal_has_not_fired() {
        let signal = CancelHandle::new().signal();
        assert!(!signal.is_cancelled());
        assert_eq!(signal.reason(), None);
        assert!(!signal.is_deferred());
    }

    #[test]
    fn cancel_fires_every_clone_of_the_signal() {
        let handle = CancelHandle::new();
        let signal = handle.signal();
        let clone = signal.clone();
        let other = handle.clone();
        other.cancel(CancelOptions::default());
        assert!(signal.is_cancelled());
        assert!(clone.is_cancelled());
        assert!(handle.signal().is_cancelled());
    }

    #[test]
    fn a_deferred_cancel_records_the_request_without_firing() {
        let handle = CancelHandle::new();
        let signal = handle.signal();
        handle.cancel(CancelOptions::builder().after_current_tools(true).build());
        assert!(!signal.is_cancelled());
        assert!(signal.is_deferred());
        handle.cancel(CancelOptions::default());
        assert!(signal.is_cancelled());
    }

    #[test]
    fn the_last_message_wins_and_a_cancel_without_one_keeps_it() {
        let handle = CancelHandle::new();
        let signal = handle.signal();
        handle.cancel(CancelOptions::builder().message("first").build());
        handle.cancel(CancelOptions::builder().message("second").build());
        handle.cancel(CancelOptions::default());
        assert_eq!(signal.reason().as_deref(), Some("second"));
    }

    #[tokio::test]
    async fn cancelled_completes_when_the_signal_fires() {
        let handle = CancelHandle::new();
        let signal = handle.signal();
        let waiter = tokio::spawn(async move { signal.cancelled().await });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        handle.cancel(CancelOptions::default());
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn cancelled_completes_at_once_after_cancellation() {
        let handle = CancelHandle::new();
        handle.cancel(CancelOptions::default());
        handle.signal().cancelled().await;
    }

    #[test]
    fn an_agent_handle_ignores_cancels_while_idle() {
        let handle = CancelHandle::for_agent();
        handle.cancel(CancelOptions::default());
        assert!(!handle.signal().is_cancelled());
        handle.set_active(true);
        handle.cancel(CancelOptions::builder().message("stop").build());
        assert!(handle.signal().is_cancelled());
    }

    #[test]
    fn reset_starts_a_fresh_signal_and_keeps_old_signals_cancelled() {
        let handle = CancelHandle::new();
        let old = handle.signal();
        handle.cancel(CancelOptions::builder().message("stop").build());
        handle.reset();
        assert!(old.is_cancelled());
        assert!(!handle.signal().is_cancelled());
        assert_eq!(handle.signal().reason(), None);
    }

    #[tokio::test]
    async fn any_fires_when_either_signal_fires() {
        let own = CancelHandle::new();
        let external = CancelHandle::new();
        let merged = CancelSignal::any(&own.signal(), &external.signal());
        assert!(!merged.is_cancelled());
        external.cancel(
            CancelOptions::builder()
                .message("outside")
                .after_current_tools(true)
                .build(),
        );
        assert!(merged.is_deferred());
        assert_eq!(merged.reason().as_deref(), Some("outside"));
        external.cancel(CancelOptions::default());
        merged.cancelled().await;
        assert!(merged.is_cancelled());
    }
}
