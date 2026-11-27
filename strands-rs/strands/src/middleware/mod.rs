//! Middleware: handlers that wrap the model call
//! ([`InvokeModelStage`]) and each tool execution ([`ExecuteToolStage`]).
//!
//! Register a handler with [`Agent::add_middleware`](crate::Agent::add_middleware) (or
//! [`LocalAgent::add_middleware`](crate::LocalAgent::add_middleware) from a plugin). Three
//! phases exist:
//!
//! - **Input** handlers transform the context: `InvokeModelStage::input(|context| async move { .. })`.
//! - **Output** handlers transform the result: `InvokeModelStage::output(|result| async move { .. })`.
//! - **Wrap** handlers get the context and `next` and return the stage's [`StageStream`]: events,
//!   then the outcome, the same shape as a tool's stream. They may short-circuit, retry, filter
//!   or inject events.
//!
//! Handlers run Input, then Wrap, then Output, each phase in registration order, whatever order
//! they were added in. Hooks fire outside the chain, so they see one call per stage even when a
//! handler short-circuits or retries. Events a handler suppresses never reach hooks or the
//! agent's stream; events it injects do.
//!
//! ```
//! use std::sync::Arc;
//! use std::sync::atomic::{AtomicUsize, Ordering};
//! use strands::Agent;
//! use strands::middleware::{InvokeModelStage, StageStream};
//! use strands::testing::MockModel;
//!
//! # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
//! let mut agent = Agent::builder().model(MockModel::new().with_turn("Hello")).printer(false).build()?;
//! let calls = Arc::new(AtomicUsize::new(0));
//! let counter = calls.clone();
//! let cleanup = agent.add_middleware(InvokeModelStage::wrap(move |context, next| {
//!     counter.fetch_add(1, Ordering::Relaxed);
//!     next.call(context)
//! }));
//! agent.invoke("Hi").await?;
//! assert_eq!(calls.load(Ordering::Relaxed), 1);
//! cleanup.remove();
//! # Ok::<(), strands::Error>(())
//! # }).unwrap();
//! ```
//!
//! A Wrap handler that does more than pass through builds its stream by hand; forward the events of
//! `next` so hooks and the agent's stream still see them ([`StageStream::result`] and
//! [`StageStream::from_future`] drop them). [`StageStream::from_stream_future`] covers async work
//! before `next`; for anything else, `async_stream::stream!` (add `async-stream = "0.3"` to your
//! dependencies) writes the stream as straight-line async code. A handler that retries a failed
//! model call once:
//!
//! ```
//! use futures::StreamExt;
//! use strands::Agent;
//! use strands::middleware::{InvokeModelStage, StageItem, StageStream};
//! use strands::testing::{MockModel, MockTurn};
//!
//! # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
//! let model = MockModel::from_turns([MockTurn::error(|| strands::Error::other("flaky")), MockTurn::text("Hello")]);
//! let mut agent = Agent::builder().model(model).printer(false).build()?;
//! agent.add_middleware(InvokeModelStage::wrap(|context, next| {
//!     StageStream::new(async_stream::stream! {
//!         for attempt in 1..=2 {
//!             let mut stream = next.call(context.clone());
//!             while let Some(item) = stream.next().await {
//!                 if attempt == 1 && matches!(item, StageItem::Done(Err(_))) {
//!                     break;
//!                 }
//!                 let done = matches!(item, StageItem::Done(_));
//!                 yield item;
//!                 if done {
//!                     return;
//!                 }
//!             }
//!         }
//!     })
//! }));
//! assert_eq!(agent.invoke("Hi").await?.to_string(), "Hello");
//! # Ok::<(), strands::Error>(())
//! # }).unwrap();
//! ```

mod registry;
#[cfg(test)]
mod registry_tests;
mod stages;
mod types;

pub(crate) use registry::MiddlewareRegistry;
pub(crate) use stages::middleware_interrupt;
pub use stages::{
    ExecuteToolContext, ExecuteToolResult, ExecuteToolStage, InvokeModelContext, InvokeModelResult, InvokeModelStage,
    MiddlewareInterruptResult,
};
pub(crate) use types::TerminalFn;
pub use types::{
    Middleware, MiddlewareCleanup, MiddlewareError, MiddlewareNext, MiddlewarePhase, MiddlewareStage, StageItem,
    StageResult, StageStream,
};
