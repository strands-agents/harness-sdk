//! Background extraction.
//!
//! Every message the agent adds is copied into one shared buffer under a sequence number that only
//! grows; the agent may drop old messages to fit its context window, the buffer keeps them until
//! saved. Each store remembers the highest number it saved (its mark) and saves only newer
//! messages. Saves of one store are chained, so they never overlap or reorder. A store that fails
//! [`SAVE_FAILURES_BEFORE_BACKOFF`] times in a row backs off to one probe every
//! [`BACKOFF_PROBE_INTERVAL`] requests until a save succeeds.

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared, join_all};
use tracing::Instrument;

use super::resolve::ResolvedExtractionConfig;
use super::{ExtractorContext, MemoryContentBlockType, MemoryMessageFilter};
use crate::agent::InvocationContext;
use crate::background_tasks::panic_message;
use crate::error::{Error, Result};
use crate::memory::{AddMessagesContext, AggregateError, MemoryStore};
use crate::models::Model;
use crate::telemetry::{AgentSpanContext, EndMemoryExtractSpanOptions, StartMemoryExtractSpanOptions, Tracer};
use crate::types::Message;

/// Consecutive failures after which a store backs off.
pub(crate) const SAVE_FAILURES_BEFORE_BACKOFF: u32 = 10;

/// While backed off, a store retries once every this many requests.
pub(crate) const BACKOFF_PROBE_INTERVAL: u32 = 3;

/// A store with its resolved extraction config (`ExtractionBinding`).
#[derive(Clone)]
pub(crate) struct ExtractionBinding {
    pub(crate) store: Arc<dyn MemoryStore>,
    pub(crate) config: ResolvedExtractionConfig,
}

#[derive(Clone)]
struct Buffered {
    seq: u64,
    message: Message,
}

type Save = Shared<BoxFuture<'static, ()>>;

#[derive(Default)]
struct StoreState {
    /// The highest sequence number saved; `None` before the first save.
    mark: Option<u64>,
    chain: Option<Save>,
    /// Bumped on every queued save, so `flush` can tell when no new save started.
    generation: u64,
    consecutive_failures: u32,
    backoff_counter: u32,
}

#[derive(Default)]
struct State {
    pending: Vec<Buffered>,
    next_seq: u64,
    stores: Vec<StoreState>,
}

struct Inner {
    bindings: Vec<ExtractionBinding>,
    default_model: Arc<dyn Model>,
    tracer: Arc<Tracer>,
    state: Mutex<State>,
}

/// Saves conversation messages to memory stores in the background (`ExtractionCoordinator`).
/// Stores are addressed by their index in the bindings.
#[derive(Clone)]
pub(crate) struct ExtractionCoordinator {
    inner: Arc<Inner>,
}

fn is_fresh(seq: u64, mark: Option<u64>) -> bool {
    mark.is_none_or(|mark| seq > mark)
}

/// Strips excluded blocks and drops messages left empty, keeping each message's number.
fn filter_messages(buffered: &[Buffered], filter: &MemoryMessageFilter) -> Vec<Buffered> {
    buffered
        .iter()
        .filter_map(|entry| {
            let mut message = entry.message.clone();
            message
                .content
                .retain(|block| MemoryContentBlockType::of(block).is_none_or(|kind| !filter.exclude.contains(&kind)));
            (!message.content.is_empty()).then_some(Buffered {
                seq: entry.seq,
                message,
            })
        })
        .collect()
}

impl ExtractionCoordinator {
    pub(crate) fn new(bindings: Vec<ExtractionBinding>, default_model: Arc<dyn Model>, tracer: Arc<Tracer>) -> Self {
        let state = State {
            stores: bindings.iter().map(|_| StoreState::default()).collect(),
            ..State::default()
        };
        Self {
            inner: Arc::new(Inner {
                bindings,
                default_model,
                tracer,
                state: Mutex::new(state),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds a message to the buffer.
    pub(crate) fn record(&self, message: Message) {
        let mut state = self.state();
        let seq = state.next_seq;
        state.next_seq += 1;
        state.pending.push(Buffered { seq, message });
    }

    /// Saves the store's unsaved messages in the background, queued behind its previous save.
    /// Failures are logged, never returned. The future is for tests and `flush`.
    pub(crate) fn process(&self, store: usize, invocation_context: Option<InvocationContext>) -> Save {
        if !self.should_attempt(store) {
            return async {}.boxed().shared();
        }
        // Captured now: the detached save may run after the span current here has ended.
        let link = self.inner.tracer.current_span_context();
        self.enqueue(store, link, invocation_context)
    }

    fn should_attempt(&self, store: usize) -> bool {
        let mut state = self.state();
        let Some(entry) = state.stores.get_mut(store) else {
            return false;
        };
        if entry.consecutive_failures < SAVE_FAILURES_BEFORE_BACKOFF {
            return true;
        }
        entry.backoff_counter += 1;
        entry.backoff_counter.is_multiple_of(BACKOFF_PROBE_INTERVAL)
    }

    fn enqueue(
        &self,
        store: usize,
        link: Option<AgentSpanContext>,
        invocation_context: Option<InvocationContext>,
    ) -> Save {
        let mut state = self.state();
        let Some(entry) = state.stores.get_mut(store) else {
            return async {}.boxed().shared();
        };
        let previous = entry.chain.take();
        let coordinator = self.clone();
        let save = async move {
            if let Some(previous) = previous {
                previous.await;
            }
            coordinator.extract(store, link, invocation_context).await;
        }
        .boxed()
        .shared();
        entry.chain = Some(save.clone());
        entry.generation += 1;
        drop(state);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(save.clone());
        }
        save
    }

    /// Saves every store's remaining messages and waits for all saves, including saves that start
    /// while waiting (`flush`). Bypasses backoff.
    pub(crate) async fn flush(&self) {
        for store in 0..self.inner.bindings.len() {
            drop(self.enqueue(store, None, None));
        }
        loop {
            let (saves, generations): (Vec<Option<Save>>, Vec<u64>) = {
                let state = self.state();
                state
                    .stores
                    .iter()
                    .map(|entry| (entry.chain.clone(), entry.generation))
                    .unzip()
            };
            join_all(saves.into_iter().flatten()).await;
            let unchanged = self.state().stores.iter().map(|entry| entry.generation).eq(generations);
            if unchanged {
                return;
            }
        }
    }

    async fn extract(
        &self,
        store: usize,
        link: Option<AgentSpanContext>,
        invocation_context: Option<InvocationContext>,
    ) {
        let Some(binding) = self.inner.bindings.get(store) else {
            return;
        };
        let (fresh, mark) = {
            let mut state = self.state();
            let mark = state.stores[store].mark;
            let fresh: Vec<Buffered> = state
                .pending
                .iter()
                .filter(|entry| is_fresh(entry.seq, mark))
                .cloned()
                .collect();
            let Some(highest) = fresh.last().map(|entry| entry.seq) else {
                return;
            };
            // Marked before saving so a queued save behind this one skips them; a failure resets it.
            state.stores[store].mark = Some(highest);
            (fresh, mark)
        };
        let filtered = filter_messages(&fresh, &binding.config.filter);
        let span = self
            .inner
            .tracer
            .start_memory_extract_span(StartMemoryExtractSpanOptions {
                store_name: binding.store.name(),
                message_count: filtered.len(),
                filtered_count: fresh.len() - filtered.len(),
                extractor: binding.config.extractor.as_ref().map(|extractor| extractor.name()),
                agent_span_context: link.as_ref(),
            });
        let outcome = if filtered.is_empty() {
            Ok(None)
        } else {
            // A panicking extractor or store counts as a failed save: a panic would poison the
            // store's shared save chain and every later save and flush behind it.
            AssertUnwindSafe(
                self.write(binding, &filtered, invocation_context)
                    .instrument(span.span()),
            )
            .catch_unwind()
            .await
            .unwrap_or_else(|payload| Err(Error::other(format!("panicked: {}", panic_message(payload.as_ref())))))
            .map(Some)
        };
        let error = outcome.as_ref().err().map(ToString::to_string);
        {
            let mut state = self.state();
            match &outcome {
                // Only a real write counts as recovery; a fully filtered turn leaves backoff alone.
                Ok(Some(_)) => {
                    state.stores[store].consecutive_failures = 0;
                    state.stores[store].backoff_counter = 0;
                }
                Ok(None) => {}
                Err(error) => on_save_failed(&mut state.stores[store], binding.store.name(), mark, error),
            }
            trim(&mut state);
        }
        let entry_count = match outcome {
            Ok(written) => Some(written.unwrap_or(0)),
            Err(_) => None,
        };
        self.inner.tracer.end_memory_extract_span(
            span,
            EndMemoryExtractSpanOptions {
                entry_count,
                error: error.as_deref(),
            },
        );
    }

    /// Writes the batch (`_write`): through the extractor and `add`, or as raw messages through
    /// `add_messages`, and returns the count of entries or messages written. Entry writes run
    /// concurrently; any failure retries the whole batch later.
    async fn write(
        &self,
        binding: &ExtractionBinding,
        buffered: &[Buffered],
        invocation_context: Option<InvocationContext>,
    ) -> Result<usize> {
        let messages: Vec<Message> = buffered.iter().map(|entry| entry.message.clone()).collect();
        let Some(extractor) = &binding.config.extractor else {
            let sequence_numbers = buffered.iter().map(|entry| entry.seq).collect();
            let context = AddMessagesContext::default().with_sequence_numbers(sequence_numbers);
            binding.store.add_messages(&messages, context).await?;
            return Ok(messages.len());
        };
        let context = ExtractorContext::default()
            .with_default_model(self.inner.default_model.clone())
            .with_invocation_context(InvocationContext::auxiliary(invocation_context.as_ref()))
            .with_tracer(self.inner.tracer.clone());
        let entries = extractor.extract(&messages, context).await?;
        let writes = entries
            .iter()
            .map(|entry| binding.store.add(&entry.content, entry.metadata.clone()));
        let failures: Vec<Error> = join_all(writes).await.into_iter().filter_map(Result::err).collect();
        if failures.is_empty() {
            return Ok(entries.len());
        }
        let message = format!(
            "failed to write {} of {} extracted entries",
            failures.len(),
            entries.len()
        );
        Err(Error::other(AggregateError::new(failures, message)))
    }

    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.state().pending.len()
    }
}

/// Resets the mark so the messages retry, and counts the failure.
fn on_save_failed(entry: &mut StoreState, name: &str, mark_before_save: Option<u64>, error: &Error) {
    entry.consecutive_failures += 1;
    entry.mark = mark_before_save;
    let failures = entry.consecutive_failures;
    if failures >= SAVE_FAILURES_BEFORE_BACKOFF {
        tracing::error!(
            "store=<{name}>, failures=<{failures}>, reason=<{error}> | memory store save failing repeatedly"
        );
    } else {
        tracing::warn!("store=<{name}>, reason=<{error}> | memory extraction failed");
    }
}

/// Drops buffered messages every store has saved (`_trim`).
fn trim(state: &mut State) {
    let Some(lowest) = state.stores.iter().map(|entry| entry.mark).min() else {
        return;
    };
    state.pending.retain(|entry| is_fresh(entry.seq, lowest));
}
