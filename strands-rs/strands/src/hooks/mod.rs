//! Hooks: the 17 hook events, the typed [`HookRegistry`] and the stream records
//! ([`AgentStreamEvent`]).
//!
//! Register hooks on an agent, a [`LocalAgent`](crate::agent::LocalAgent) or a registry, in three
//! forms:
//!
//! - [`add_hook`](HookRegistry::add_hook) takes a plain closure; annotate its argument so the
//!   event type is inferred.
//! - [`add_async_hook::<E>`](HookRegistry::add_async_hook) takes a closure that returns
//!   `Box::pin(async move { .. })`, for hooks that await while borrowing the event.
//! - [`add_hook_impl`](HookRegistry::add_hook_impl) takes a [`Hook`] implementation.
//!
//! Each returns a [`HookCleanup`]; the `_with` variants take [`HookCallbackOptions`] with the
//! [`HookOrder`].
//!
//! # Errors and panics
//!
//! A hook returns `()` or `Result<(), E>` for any `E: Into<BoxError>` ([`HookOutput`]); a
//! [`Hook`] implementation returns `Result<(), BoxError>`. An error fails the invocation with it:
//! the callbacks after it do not run, and in a tool call it stops the
//! batch once `AfterToolsEvent` has fired. An [`InterruptError`](crate::InterruptError), such as
//! the one `BeforeToolCallEvent::interrupt` returns, is not a failure: the agent stops with
//! `StopReason::Interrupt` once every callback has run.
//!
//! A panicking hook is a bug and propagates to the caller of `invoke` or the stream's consumer,
//! also when it runs on a tool call's task. Only a panic inside a tool's body becomes an error
//! result the model sees.
//!
//! [`BoxError`]: crate::BoxError
//!
//! ```
//! use strands::hooks::{AfterToolCallEvent, BeforeToolCallEvent, HookCallbackOptions, HookOrder, HookRegistry};
//!
//! let hooks = HookRegistry::new();
//! hooks.add_hook(|event: &mut BeforeToolCallEvent| {
//!     if event.tool_use().name == "shell" {
//!         event.set_cancel("shell is disabled");
//!     }
//! });
//! hooks.add_hook_with(
//!     |event: &mut AfterToolCallEvent| event.set_retry(event.error().is_some()),
//!     HookCallbackOptions { order: HookOrder::SDK_LAST },
//! );
//! assert_eq!(hooks.len(), 2);
//! ```

mod events;
mod registry;
mod stream_events;
mod types;

pub use events::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, AfterToolsEvent, AgentResultEvent,
    BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, BeforeToolsEvent, Cancel, ContentBlockEvent,
    EndTurn, InitializedEvent, InterruptEvent, MessageAddedEvent, ModelMessageEvent, ModelStopResponse,
    ModelStreamUpdateEvent, ToolResultEvent, ToolStreamUpdateEvent, ToolUseData,
};
pub use registry::{EventKind, Hook, HookEvent, HookOutput, HookRegistry, IntoAsyncHook, IntoHookImpl, IntoSyncHook};
pub use stream_events::{
    AfterInvocationEventData, AfterModelCallEventData, AfterToolCallEventData, AfterToolsEventData, AgentStreamEvent,
    BeforeInvocationEventData, BeforeModelCallEventData, BeforeToolCallEventData, BeforeToolsEventData,
    ContentBlockEventData, ErrorData, InitializedEventData, InterruptEventData, MessageAddedEventData,
    ModelMessageEventData, ModelStreamUpdateEventData, ToolResultEventData, ToolStreamUpdateEventData,
};
pub use types::{HookCallbackOptions, HookCleanup, HookOrder};

pub use crate::models::Redaction;
