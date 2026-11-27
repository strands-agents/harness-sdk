//! The typed hook registry.
//!
//! Each event type has its own list of callbacks. Sequential events borrow the agent
//! (`BeforeInvocationEvent<'a>`), so the registry is keyed by a `'static` marker: the event type
//! with `'static` for its lifetime (`BeforeInvocationEvent<'static>`). Per-tool events are
//! `'static` already and are their own marker. Callers never name markers except in
//! [`HookRegistry::add_async_hook`]'s turbofish, where `BeforeInvocationEvent<'_>` works.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, PoisonError, RwLock, Weak};

use async_trait::async_trait;
use futures::future::BoxFuture;

use super::events::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, AfterToolsEvent, AgentResultEvent,
    BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, BeforeToolsEvent, ContentBlockEvent,
    InitializedEvent, InterruptEvent, MessageAddedEvent, ModelMessageEvent, ModelStreamUpdateEvent, ToolResultEvent,
    ToolStreamUpdateEvent,
};
use super::types::{HookCallbackOptions, HookCleanup};
use crate::error::{BoxError, Error, Result};
use crate::interrupt::{Interrupt, InterruptError};

type HookResult = std::result::Result<(), BoxError>;
type SyncCallback<K> = Arc<dyn for<'a, 'b> Fn(&'b mut <K as HookEvent>::Event<'a>) -> HookResult + Send + Sync>;
type AsyncCallback<K> =
    Arc<dyn for<'a, 'b> Fn(&'b mut <K as HookEvent>::Event<'a>) -> BoxFuture<'b, HookResult> + Send + Sync>;

mod private {
    use super::{HookEvent, HookRegistry, Slot};

    /// Seals [`HookEvent`] to the SDK's events and finds an event's slot in the registry.
    pub trait Sealed: Sized + 'static {
        #[doc(hidden)]
        fn slot(registry: &HookRegistry) -> &Slot<Self>
        where
            Self: HookEvent;
    }

    /// Seals [`HookOutput`](super::HookOutput).
    pub trait SealedOutput {}

    impl SealedOutput for () {}
    impl<E> SealedOutput for Result<(), E> {}

    /// Only the SDK can name it, so only the SDK implements the conversion traits.
    #[derive(Debug)]
    pub struct Token;
}

/// A hook event type, as the registry keys it (sealed).
///
/// Implemented by `'static` markers: per-tool events themselves and the `'static` form of
/// borrowing events, such as `BeforeInvocationEvent<'static>`. `Event<'a>` is the event type
/// callbacks receive.
pub trait HookEvent: private::Sealed {
    /// The event type for an agent borrow of lifetime `'a`.
    type Event<'a>: Send;

    /// Whether callbacks with the same order run in reverse registration order (`After*` events).
    #[doc(hidden)]
    const REVERSE: bool = false;

    /// Takes the interrupts raised on the event (only interruptible events raise any).
    #[doc(hidden)]
    fn take_interrupts(_event: &mut Self::Event<'_>) -> Vec<Interrupt> {
        Vec::new()
    }
}

/// Maps a concrete hook event type of any lifetime to its [`HookEvent`] marker.
#[doc(hidden)]
pub trait EventKind<'a>: Send + Sized {
    /// The marker.
    type Kind: HookEvent<Event<'a> = Self>;
}

/// What a hook returns (sealed): `()`, or `Result<(), E>` for any `E: Into<BoxError>`.
///
/// An `Err` fails the invocation with that error; the callbacks after it do not run. An
/// [`InterruptError`], such as the one the events' `interrupt` returns, is not a failure: it stops
/// the agent for human input once every callback has run.
pub trait HookOutput: private::SealedOutput {
    #[doc(hidden)]
    fn into_hook_result(self) -> HookResult;
}

impl HookOutput for () {
    fn into_hook_result(self) -> HookResult {
        Ok(())
    }
}

impl<E: Into<BoxError>> HookOutput for std::result::Result<(), E> {
    fn into_hook_result(self) -> HookResult {
        self.map_err(Into::into)
    }
}

/// A plain closure usable as a hook for the event `K` (`HookCallback`), sealed.
///
/// Implemented for every `Fn(&mut Event) -> R + Send + Sync + 'static` where `R` is a
/// [`HookOutput`]. Annotate the closure argument (`|event: &mut BeforeToolCallEvent| ..`) so the
/// event type can be inferred.
pub trait IntoSyncHook<K: HookEvent> {
    #[doc(hidden)]
    fn into_callback(self, token: private::Token) -> SyncCallback<K>;
}

/// An async closure usable as a hook for the event `K`: it returns `Box::pin(async move { .. })`
/// whose output is a [`HookOutput`].
///
/// Implemented for every such closure; name the event with
/// [`add_async_hook::<E>`](HookRegistry::add_async_hook).
pub trait IntoAsyncHook<K: HookEvent>:
    for<'a, 'b> Fn(&'b mut K::Event<'a>) -> BoxFuture<'b, <Self as IntoAsyncHook<K>>::Output> + Send + Sync + 'static
{
    /// What the closure's future returns.
    type Output: HookOutput;
}

impl<K, F, R> IntoAsyncHook<K> for F
where
    K: HookEvent,
    F: for<'a, 'b> Fn(&'b mut K::Event<'a>) -> BoxFuture<'b, R> + Send + Sync + 'static,
    R: HookOutput,
{
    type Output = R;
}

/// A [`Hook`] implementation usable for the event `K`, sealed.
///
/// Implemented for every `H: Hook<Event>`. When a type implements [`Hook`] for several events,
/// name the event: `add_hook_impl::<BeforeToolCallEvent>(hook)`.
pub trait IntoHookImpl<K: HookEvent> {
    #[doc(hidden)]
    fn into_callback(self, token: private::Token) -> AsyncCallback<K>;
}

/// A reusable or stateful hook (`HookCallback` as an object).
///
/// Return `Ok(())`, or an error to fail the invocation (see [`HookOutput`]). Implementations
/// for events that borrow the agent name the lifetime: `impl<'a> Hook<BeforeInvocationEvent<'a>>`
/// with `event: &mut BeforeInvocationEvent<'a>`; eliding it (`Hook<BeforeInvocationEvent<'_>>`)
/// implements the trait for one lifetime only, and registration then fails to compile.
///
/// ```
/// use strands::BoxError;
/// use strands::hooks::{BeforeInvocationEvent, BeforeToolCallEvent, Hook, HookRegistry};
///
/// struct Audit;
///
/// #[strands::async_trait]
/// impl<'a> Hook<BeforeInvocationEvent<'a>> for Audit {
///     async fn handle(&self, event: &mut BeforeInvocationEvent<'a>) -> Result<(), BoxError> {
///         event.set_cancel("closed for maintenance");
///         Ok(())
///     }
/// }
///
/// #[strands::async_trait]
/// impl Hook<BeforeToolCallEvent> for Audit {
///     async fn handle(&self, event: &mut BeforeToolCallEvent) -> Result<(), BoxError> {
///         if event.tool_use().name == "shell" {
///             return Err("shell is disabled".into());
///         }
///         Ok(())
///     }
/// }
///
/// let hooks = HookRegistry::new();
/// hooks.add_hook_impl::<BeforeInvocationEvent<'_>>(Audit);
/// hooks.add_hook_impl::<BeforeToolCallEvent>(Audit);
/// ```
#[async_trait]
pub trait Hook<E: Send>: Send + Sync + 'static {
    /// Handles the event.
    ///
    /// # Errors
    ///
    /// Any error fails the invocation; an [`InterruptError`] stops it for human input.
    async fn handle(&self, event: &mut E) -> std::result::Result<(), BoxError>;
}

enum Callback<K: HookEvent> {
    Sync(SyncCallback<K>),
    Async(AsyncCallback<K>),
}

impl<K: HookEvent> Clone for Callback<K> {
    fn clone(&self) -> Self {
        match self {
            Self::Sync(callback) => Self::Sync(callback.clone()),
            Self::Async(callback) => Self::Async(callback.clone()),
        }
    }
}

struct Entry<K: HookEvent> {
    id: u64,
    order: i32,
    callback: Callback<K>,
}

/// The callbacks registered for one event type.
#[doc(hidden)]
pub struct Slot<K: HookEvent> {
    entries: Arc<RwLock<Vec<Entry<K>>>>,
}

impl<K: HookEvent> Default for Slot<K> {
    fn default() -> Self {
        Self {
            entries: Arc::default(),
        }
    }
}

impl<K: HookEvent> Slot<K> {
    fn insert(&self, id: u64, order: i32, callback: Callback<K>) -> HookCleanup {
        let mut entries = self.entries.write().unwrap_or_else(PoisonError::into_inner);
        let at = entries
            .iter()
            .position(|entry| entry.order > order)
            .unwrap_or(entries.len());
        entries.insert(at, Entry { id, order, callback });
        drop(entries);
        let weak: Weak<RwLock<Vec<Entry<K>>>> = Arc::downgrade(&self.entries);
        HookCleanup::new(move || {
            let Some(entries) = weak.upgrade() else {
                return;
            };
            entries
                .write()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|entry| entry.id != id);
        })
    }

    /// The callbacks in call order, copied out so none run under the lock.
    fn callbacks(&self) -> Vec<Callback<K>> {
        let entries = self.entries.read().unwrap_or_else(PoisonError::into_inner);
        if !K::REVERSE {
            return entries.iter().map(|entry| entry.callback.clone()).collect();
        }
        let mut reversed: Vec<(i32, Callback<K>)> = entries
            .iter()
            .rev()
            .map(|entry| (entry.order, entry.callback.clone()))
            .collect();
        reversed.sort_by_key(|(order, _)| *order);
        reversed.into_iter().map(|(_, callback)| callback).collect()
    }

    fn len(&self) -> usize {
        self.entries.read().unwrap_or_else(PoisonError::into_inner).len()
    }

    #[cfg(test)]
    fn orders(&self) -> Vec<i32> {
        let entries = self.entries.read().unwrap_or_else(PoisonError::into_inner);
        entries.iter().map(|entry| entry.order).collect()
    }
}

macro_rules! hook_events {
    (
        borrowing { $($borrowing:ident => $borrowing_slot:ident $(, $borrowing_flag:ident)*;)* }
        owned { $($owned:ident => $owned_slot:ident $(, $owned_flag:ident)*;)* }
    ) => {
        /// Registry of hook callbacks, one ordered list per event type (`HookRegistry`).
        ///
        /// Callbacks run in ascending `order`; within one order they run in registration order,
        /// reversed on `After*` events. Registration and removal take a short lock; callbacks
        /// run outside it, so a callback may register or remove hooks.
        #[derive(Default)]
        pub struct HookRegistry {
            next_id: AtomicU64,
            $($borrowing_slot: Slot<$borrowing<'static>>,)*
            $($owned_slot: Slot<$owned>,)*
        }

        impl HookRegistry {
            /// The number of callbacks registered across all events.
            #[must_use]
            pub fn len(&self) -> usize {
                0 $(+ self.$borrowing_slot.len())* $(+ self.$owned_slot.len())*
            }
        }

        $(
            impl private::Sealed for $borrowing<'static> {
                fn slot(registry: &HookRegistry) -> &Slot<Self> {
                    &registry.$borrowing_slot
                }
            }

            impl HookEvent for $borrowing<'static> {
                type Event<'a> = $borrowing<'a>;
                $(hook_events!(@flag $borrowing_flag);)*
            }

            impl<'a> EventKind<'a> for $borrowing<'a> {
                type Kind = $borrowing<'static>;
            }

            impl<F, R> IntoSyncHook<$borrowing<'static>> for F
            where
                F: for<'a, 'b> Fn(&'b mut $borrowing<'a>) -> R + Send + Sync + 'static,
                R: HookOutput,
            {
                fn into_callback(self, _: private::Token) -> SyncCallback<$borrowing<'static>> {
                    Arc::new(move |event| self(event).into_hook_result())
                }
            }

            impl<H> IntoHookImpl<$borrowing<'static>> for H
            where
                H: for<'a> Hook<$borrowing<'a>>,
            {
                fn into_callback(self, _: private::Token) -> AsyncCallback<$borrowing<'static>> {
                    let hook = Arc::new(self);
                    Arc::new(move |event| {
                        let hook = hook.clone();
                        Box::pin(async move { hook.handle(event).await })
                    })
                }
            }
        )*

        $(
            impl private::Sealed for $owned {
                fn slot(registry: &HookRegistry) -> &Slot<Self> {
                    &registry.$owned_slot
                }
            }

            impl HookEvent for $owned {
                type Event<'a> = $owned;
                $(hook_events!(@flag $owned_flag);)*
            }

            impl<'a> EventKind<'a> for $owned {
                type Kind = $owned;
            }

            impl<F, R> IntoSyncHook<$owned> for F
            where
                F: for<'b> Fn(&'b mut $owned) -> R + Send + Sync + 'static,
                R: HookOutput,
            {
                fn into_callback(self, _: private::Token) -> SyncCallback<$owned> {
                    Arc::new(move |event| self(event).into_hook_result())
                }
            }

            impl<H> IntoHookImpl<$owned> for H
            where
                H: Hook<$owned>,
            {
                fn into_callback(self, _: private::Token) -> AsyncCallback<$owned> {
                    let hook = Arc::new(self);
                    Arc::new(move |event| {
                        let hook = hook.clone();
                        Box::pin(async move { hook.handle(event).await })
                    })
                }
            }
        )*
    };
    (@flag reverse) => {
        const REVERSE: bool = true;
    };
    (@flag interruptible) => {
        fn take_interrupts(event: &mut Self::Event<'_>) -> Vec<Interrupt> {
            event.take_interrupts()
        }
    };
}

hook_events! {
    borrowing {
        InitializedEvent => initialized;
        BeforeInvocationEvent => before_invocation;
        AfterInvocationEvent => after_invocation, reverse;
        MessageAddedEvent => message_added;
        BeforeModelCallEvent => before_model_call;
        AfterModelCallEvent => after_model_call, reverse;
        ModelStreamUpdateEvent => model_stream_update;
        ContentBlockEvent => content_block;
        ModelMessageEvent => model_message;
        BeforeToolsEvent => before_tools, interruptible;
        AfterToolsEvent => after_tools, reverse;
        AgentResultEvent => agent_result;
        InterruptEvent => interrupt;
    }
    owned {
        BeforeToolCallEvent => before_tool_call, interruptible;
        AfterToolCallEvent => after_tool_call, reverse;
        ToolStreamUpdateEvent => tool_stream_update;
        ToolResultEvent => tool_result;
    }
}

impl HookRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether no callbacks are registered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn insert<K: HookEvent>(&self, order: i32, callback: Callback<K>) -> HookCleanup {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        K::slot(self).insert(id, order, callback)
    }

    /// Registers a plain closure. Annotate the argument so the event type is
    /// inferred. The closure returns `()` or a `Result` (see [`HookOutput`]).
    ///
    /// ```
    /// use strands::hooks::{BeforeInvocationEvent, BeforeToolCallEvent, HookRegistry};
    ///
    /// let registry = HookRegistry::new();
    /// let cleanup = registry.add_hook(|event: &mut BeforeToolCallEvent| {
    ///     if event.tool_use().name == "shell" {
    ///         event.set_cancel("shell is disabled");
    ///     }
    /// });
    /// cleanup.remove();
    /// registry.add_hook(|event: &mut BeforeInvocationEvent<'_>| -> Result<(), strands::Error> {
    ///     let limit: Option<u32> = event.agent().app_state().get("limit")?;
    ///     if limit == Some(0) {
    ///         event.set_cancel("limit reached");
    ///     }
    ///     Ok(())
    /// });
    /// ```
    pub fn add_hook<K: HookEvent>(&self, callback: impl IntoSyncHook<K>) -> HookCleanup {
        self.add_hook_with(callback, HookCallbackOptions::default())
    }

    /// Registers a plain closure with options such as the order.
    pub fn add_hook_with<K: HookEvent>(
        &self,
        callback: impl IntoSyncHook<K>,
        options: HookCallbackOptions,
    ) -> HookCleanup {
        self.insert(options.order, Callback::Sync(callback.into_callback(private::Token)))
    }

    /// Registers a closure that awaits while borrowing the event. Name the event type, and return
    /// `Box::pin(async move { .. })`; the block's value is `()` or a `Result` (see
    /// [`HookOutput`]).
    ///
    /// ```
    /// use strands::BoxError;
    /// use strands::hooks::{BeforeInvocationEvent, BeforeToolCallEvent, HookRegistry};
    ///
    /// let registry = HookRegistry::new();
    /// registry.add_async_hook::<BeforeToolCallEvent>(|event| {
    ///     Box::pin(async move {
    ///         tokio::task::yield_now().await;
    ///         event.set_cancel(true);
    ///     })
    /// });
    /// registry.add_async_hook::<BeforeInvocationEvent<'_>>(|event| {
    ///     Box::pin(async move {
    ///         let turns: Option<u32> = event.agent().app_state().get("turns")?;
    ///         if turns.is_some() {
    ///             event.agent_mut().messages_mut().clear();
    ///         }
    ///         Ok::<(), BoxError>(())
    ///     })
    /// });
    /// ```
    pub fn add_async_hook<K: HookEvent>(&self, callback: impl IntoAsyncHook<K>) -> HookCleanup {
        self.add_async_hook_with::<K>(callback, HookCallbackOptions::default())
    }

    /// Registers an async closure with options such as the order.
    pub fn add_async_hook_with<K: HookEvent>(
        &self,
        callback: impl IntoAsyncHook<K>,
        options: HookCallbackOptions,
    ) -> HookCleanup {
        let callback: AsyncCallback<K> = Arc::new(move |event| {
            let future = callback(event);
            Box::pin(async move { future.await.into_hook_result() })
        });
        self.insert(options.order, Callback::Async(callback))
    }

    /// Registers a [`Hook`] implementation.
    pub fn add_hook_impl<K: HookEvent>(&self, hook: impl IntoHookImpl<K>) -> HookCleanup {
        self.add_hook_impl_with(hook, HookCallbackOptions::default())
    }

    /// Registers a [`Hook`] implementation with options such as the order.
    pub fn add_hook_impl_with<K: HookEvent>(
        &self,
        hook: impl IntoHookImpl<K>,
        options: HookCallbackOptions,
    ) -> HookCleanup {
        self.insert(options.order, Callback::Async(hook.into_callback(private::Token)))
    }

    /// Runs every callback for `event` in order. Interrupts, raised on the
    /// event or returned as an [`InterruptError`], are collected across callbacks; any other error
    /// stops at once.
    ///
    /// # Errors
    ///
    /// The first callback error; [`Error::Interrupt`] with every raised interrupt once all
    /// callbacks ran; `interrupt_names=<a, b> | duplicate interrupt names` when two raised
    /// interrupts share a name.
    /// The orders of the callbacks registered for `K`, in registration-sorted order.
    #[cfg(test)]
    pub(crate) fn orders<K: HookEvent>(&self) -> Vec<i32> {
        K::slot(self).orders()
    }

    pub(crate) fn invoke<'f, 'a, E: EventKind<'a>>(&'f self, event: &'f mut E) -> BoxFuture<'f, Result<()>>
    where
        'a: 'f,
    {
        self.invoke_from::<<E as EventKind<'a>>::Kind>(event, 0, None)
    }

    /// [`invoke`](Self::invoke) that skips the `progress` callbacks that already ran and counts
    /// each one that finishes, so a run cut short by a dropped stream resumes at the callback it
    /// interrupted. A callback that fails is not counted. The caller resets `progress` once the
    /// event is done.
    pub(crate) fn invoke_tracked<'f, 'a, E: EventKind<'a>>(
        &'f self,
        event: &'f mut E,
        progress: &'f AtomicUsize,
    ) -> BoxFuture<'f, Result<()>>
    where
        'a: 'f,
    {
        let start = progress.load(Ordering::SeqCst);
        self.invoke_from::<<E as EventKind<'a>>::Kind>(event, start, Some(progress))
    }

    fn invoke_from<'f, 'a, K: HookEvent>(
        &'f self,
        event: &'f mut K::Event<'a>,
        start: usize,
        progress: Option<&'f AtomicUsize>,
    ) -> BoxFuture<'f, Result<()>>
    where
        'a: 'f,
    {
        let callbacks = K::slot(self).callbacks();
        Box::pin(async move {
            let mut returned = Vec::new();
            for (index, callback) in callbacks.into_iter().enumerate().skip(start) {
                let outcome = match callback {
                    Callback::Sync(callback) => callback(event),
                    Callback::Async(callback) => callback(event).await,
                };
                let finished = match outcome {
                    Ok(()) => Ok(()),
                    Err(error) => match Error::from_boxed(error) {
                        Error::Interrupt(interrupts) => {
                            returned.extend(interrupts.into_interrupts());
                            Ok(())
                        }
                        error => Err(error),
                    },
                };
                finished?;
                if let Some(progress) = progress {
                    progress.store(index + 1, Ordering::SeqCst);
                }
            }
            let mut interrupts = K::take_interrupts(event);
            for interrupt in returned {
                if !interrupts.iter().any(|recorded| recorded.id == interrupt.id) {
                    interrupts.push(interrupt);
                }
            }
            if interrupts.is_empty() {
                return Ok(());
            }
            check_duplicate_names(&interrupts)?;
            Err(Error::Interrupt(InterruptError::new(interrupts)))
        })
    }
}

fn check_duplicate_names(interrupts: &[Interrupt]) -> Result<()> {
    let mut duplicates: Vec<&str> = Vec::new();
    for (index, interrupt) in interrupts.iter().enumerate() {
        let repeated = interrupts[..index].iter().any(|earlier| earlier.name == interrupt.name);
        if repeated && !duplicates.contains(&interrupt.name.as_str()) {
            duplicates.push(&interrupt.name);
        }
    }
    if duplicates.is_empty() {
        return Ok(());
    }
    Err(Error::other(format!(
        "interrupt_names=<{}> | duplicate interrupt names",
        duplicates.join(", ")
    )))
}

impl std::fmt::Debug for HookRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookRegistry").field("len", &self.len()).finish()
    }
}

#[cfg(test)]
mod tests;
