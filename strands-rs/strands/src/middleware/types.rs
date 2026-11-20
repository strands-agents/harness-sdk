//! Stage tokens, stage streams and the handler forms.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use futures::future::BoxFuture;
use futures::{FutureExt, Stream, StreamExt};

use super::registry::{MiddlewareRegistry, StageRegistry};
use crate::error::{BoxError, Error};
use crate::hooks::AgentStreamEvent;
use crate::interrupt::{Interrupt, InterruptError};
use crate::models::BoxStream;

pub(crate) mod private {
    use super::{MiddlewareRegistry, StageRegistry};

    /// Seals [`MiddlewareStage`](super::MiddlewareStage) to the SDK's stages and finds a stage's handlers.
    pub trait Sealed: Sized + 'static {
        #[doc(hidden)]
        fn slot(registry: &MiddlewareRegistry) -> &StageRegistry<Self>
        where
            Self: super::MiddlewareStage;
    }
}

/// A middleware interception point (`MiddlewareStage`), sealed to the SDK's stages:
/// [`InvokeModelStage`](super::InvokeModelStage) and [`ExecuteToolStage`](super::ExecuteToolStage).
pub trait MiddlewareStage: private::Sealed + Send + Sync {
    /// What handlers receive and pass to `next`.
    type Context: Send + 'static;
    /// What the stage produces.
    type Result: Send + 'static;
    /// The stage name (`invokeModel`, `executeTool`).
    const NAME: &'static str;
}

/// Why a stage did not produce a result.
///
/// Errors, interrupts and cancellation travel through the chain as values, so a Wrap handler can
/// see them and decide; `?` converts an [`Error`], an [`Interrupt`] or an [`InterruptError`] into
/// one.
#[derive(Debug)]
#[non_exhaustive]
pub enum MiddlewareError {
    /// The stage failed.
    Error(Error),
    /// A handler or the tool raised interrupts.
    Interrupt(InterruptError),
    /// The invocation was cancelled.
    Cancelled,
}

impl fmt::Display for MiddlewareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Error(error) => error.fmt(f),
            Self::Interrupt(interrupts) => interrupts.fmt(f),
            Self::Cancelled => f.write_str("Agent invocation cancelled"),
        }
    }
}

impl std::error::Error for MiddlewareError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Error(error) => Some(error),
            _ => None,
        }
    }
}

impl MiddlewareError {
    /// Recovers the typed error behind a boxed one, so a handler can `?` errors that only
    /// convert into a [`BoxError`]: an [`InterruptError`] stays an interrupt and a boxed
    /// [`Error`] is unwrapped; anything else is [`Error::Other`].
    ///
    /// ```
    /// use strands::BoxError;
    /// use strands::middleware::MiddlewareError;
    ///
    /// fn lookup() -> Result<u32, BoxError> {
    ///     Err("cache unavailable".into())
    /// }
    ///
    /// fn handler_step() -> Result<u32, MiddlewareError> {
    ///     lookup().map_err(MiddlewareError::from_boxed)
    /// }
    ///
    /// assert_eq!(handler_step().unwrap_err().to_string(), "cache unavailable");
    /// ```
    #[must_use]
    pub fn from_boxed(error: BoxError) -> Self {
        Error::from_boxed(error).into()
    }
}

impl From<Error> for MiddlewareError {
    fn from(error: Error) -> Self {
        match error {
            Error::Interrupt(interrupts) => Self::Interrupt(interrupts),
            error => Self::Error(error),
        }
    }
}

impl From<Interrupt> for MiddlewareError {
    fn from(interrupt: Interrupt) -> Self {
        Self::Interrupt(interrupt.into())
    }
}

impl From<InterruptError> for MiddlewareError {
    fn from(interrupts: InterruptError) -> Self {
        Self::Interrupt(interrupts)
    }
}

/// The outcome of a stage.
pub type StageResult<T> = std::result::Result<T, MiddlewareError>;

/// One item of a stage stream: an event, or the stage outcome that ends the stream.
#[allow(
    clippy::large_enum_variant,
    reason = "events are the common item and move straight to the agent's stream; boxing would allocate per model delta"
)]
#[non_exhaustive]
pub enum StageItem<S: MiddlewareStage> {
    /// A stream event, passed up through the outer handlers to the agent's stream.
    Event(AgentStreamEvent),
    /// The stage outcome; nothing follows it.
    Done(StageResult<S::Result>),
}

impl<S: MiddlewareStage> fmt::Debug for StageItem<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Event(event) => f.debug_tuple("Event").field(event).finish(),
            Self::Done(Ok(_)) => f.write_str("Done(Ok(..))"),
            Self::Done(Err(error)) => f.debug_tuple("Done").field(error).finish(),
        }
    }
}

/// The stream a Wrap handler and `next` return: events, then one [`StageItem::Done`]. A stream that
/// ends without one is a stage error.
pub struct StageStream<S: MiddlewareStage> {
    inner: BoxStream<'static, StageItem<S>>,
}

impl<S: MiddlewareStage> StageStream<S> {
    /// Wraps any stream of stage items, such as one built with `async_stream::stream!`.
    pub fn new(stream: impl Stream<Item = StageItem<S>> + Send + 'static) -> Self {
        Self {
            inner: Box::pin(stream),
        }
    }

    /// A stream with no events that ends with `future`'s outcome.
    ///
    /// Events of any `next` stream the future drains with [`result`](Self::result) are dropped;
    /// to keep them while doing async work first, use
    /// [`from_stream_future`](Self::from_stream_future).
    pub fn from_future(future: impl Future<Output = StageResult<S::Result>> + Send + 'static) -> Self {
        Self::new(future.map(StageItem::Done).into_stream())
    }

    /// The stream `future` resolves to, with every event: for a Wrap handler that awaits
    /// something (a rate limiter, a cache lookup) before it calls `next`.
    ///
    /// ```
    /// use strands::middleware::{InvokeModelStage, StageStream};
    ///
    /// let throttled = InvokeModelStage::wrap(|context, next| {
    ///     StageStream::from_stream_future(async move {
    ///         tokio::task::yield_now().await;
    ///         next.call(context)
    ///     })
    /// });
    /// # let _ = throttled;
    /// ```
    pub fn from_stream_future(future: impl Future<Output = Self> + Send + 'static) -> Self {
        Self::new(future.into_stream().flatten())
    }

    /// A stream with no events that ends with `result` (a short-circuit).
    pub fn from_result(result: StageResult<S::Result>) -> Self {
        Self::new(futures::stream::once(std::future::ready(StageItem::Done(result))))
    }

    /// Forwards every event and passes the outcome through `f` (an Output-style transform that
    /// also sees errors).
    #[must_use]
    pub fn map_result<F, Fut>(self, f: F) -> Self
    where
        F: FnOnce(StageResult<S::Result>) -> Fut + Send + 'static,
        Fut: Future<Output = StageResult<S::Result>> + Send + 'static,
    {
        let mut inner = self;
        Self::new(async_stream::stream! {
            while let Some(item) = inner.next().await {
                match item {
                    StageItem::Event(event) => yield StageItem::Event(event),
                    StageItem::Done(result) => {
                        yield StageItem::Done(f(result).await);
                        return;
                    }
                }
            }
            yield StageItem::Done(f(Err(ended_without_result())).await);
        })
    }

    /// Drains the stream and returns the outcome. Its events are dropped: they reach neither
    /// hooks nor the agent's stream. Forward them instead when they matter (see the retry
    /// example in the [module docs](super)).
    pub async fn result(mut self) -> StageResult<S::Result> {
        while let Some(item) = self.next().await {
            if let StageItem::Done(result) = item {
                return result;
            }
        }
        Err(ended_without_result())
    }
}

pub(crate) fn ended_without_result() -> MiddlewareError {
    MiddlewareError::Error(Error::other("middleware stream ended without a result"))
}

impl<S: MiddlewareStage> Stream for StageStream<S> {
    type Item = StageItem<S>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

impl<S: MiddlewareStage> fmt::Debug for StageStream<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StageStream")
            .field("stage", &S::NAME)
            .finish_non_exhaustive()
    }
}

pub(crate) type InputFn<S> = Arc<
    dyn Fn(<S as MiddlewareStage>::Context) -> BoxFuture<'static, StageResult<<S as MiddlewareStage>::Context>>
        + Send
        + Sync,
>;
pub(crate) type OutputFn<S> = Arc<
    dyn Fn(<S as MiddlewareStage>::Result) -> BoxFuture<'static, StageResult<<S as MiddlewareStage>::Result>>
        + Send
        + Sync,
>;
pub(crate) type WrapFn<S> =
    Arc<dyn Fn(<S as MiddlewareStage>::Context, MiddlewareNext<S>) -> StageStream<S> + Send + Sync>;
pub(crate) type TerminalFn<S> = Arc<dyn Fn(<S as MiddlewareStage>::Context) -> StageStream<S> + Send + Sync>;

/// The phase a handler runs in (`MiddlewarePhaseKind`). The chain composes Input outermost, then
/// Output, then Wrap next to the stage, so handlers run Input, Wrap, Output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[non_exhaustive]
pub enum MiddlewarePhase {
    /// Transforms the context before the stage runs (`input`).
    Input,
    /// Transforms the result after the stage runs (`output`).
    Output,
    /// Wraps the stage: may short-circuit, retry, filter or inject events (`wrap`).
    Wrap,
}

pub(crate) enum Handler<S: MiddlewareStage> {
    Input(InputFn<S>),
    Output(OutputFn<S>),
    Wrap(WrapFn<S>),
}

impl<S: MiddlewareStage> Clone for Handler<S> {
    fn clone(&self) -> Self {
        match self {
            Self::Input(f) => Self::Input(f.clone()),
            Self::Output(f) => Self::Output(f.clone()),
            Self::Wrap(f) => Self::Wrap(f.clone()),
        }
    }
}

impl<S: MiddlewareStage> Handler<S> {
    pub(crate) fn phase(&self) -> MiddlewarePhase {
        match self {
            Self::Input(_) => MiddlewarePhase::Input,
            Self::Output(_) => MiddlewarePhase::Output,
            Self::Wrap(_) => MiddlewarePhase::Wrap,
        }
    }

    fn run(&self, context: S::Context, next: MiddlewareNext<S>) -> StageStream<S> {
        match self {
            Self::Wrap(wrap) => wrap(context, next),
            Self::Input(input) => {
                let input = input.clone();
                StageStream::new(async_stream::stream! {
                    match input(context).await {
                        Ok(context) => {
                            let mut inner = next.call(context);
                            while let Some(item) = inner.next().await {
                                yield item;
                            }
                        }
                        Err(error) => yield StageItem::Done(Err(error)),
                    }
                })
            }
            Self::Output(output) => {
                let output = output.clone();
                next.call(context).map_result(move |result| async move {
                    match result {
                        Ok(result) => output(result).await,
                        Err(error) => Err(error),
                    }
                })
            }
        }
    }
}

/// A middleware handler for the stage `S`, ready for
/// [`Agent::add_middleware`](crate::Agent::add_middleware). Build one with the stage's `input`,
/// `output` or `wrap`, for example [`InvokeModelStage::input`](super::InvokeModelStage::input).
pub struct Middleware<S: MiddlewareStage> {
    pub(crate) handler: Handler<S>,
}

impl<S: MiddlewareStage> Middleware<S> {
    /// An Input handler: transforms the context before the stage runs (`Stage.Input`).
    pub fn input<F, Fut>(handler: F) -> Self
    where
        F: Fn(S::Context) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = StageResult<S::Context>> + Send + 'static,
    {
        Self {
            handler: Handler::Input(Arc::new(move |context| Box::pin(handler(context)))),
        }
    }

    /// An Output handler: transforms the result after the stage runs (`Stage.Output`). It does not
    /// see events or failures.
    pub fn output<F, Fut>(handler: F) -> Self
    where
        F: Fn(S::Result) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = StageResult<S::Result>> + Send + 'static,
    {
        Self {
            handler: Handler::Output(Arc::new(move |result| Box::pin(handler(result)))),
        }
    }

    /// A Wrap handler: gets the context and `next`, and returns the stage's stream (`Stage` or
    /// `Stage.Wrap`). Return `next.call(context)` to pass through; skip `next` to short-circuit.
    pub fn wrap<F>(handler: F) -> Self
    where
        F: Fn(S::Context, MiddlewareNext<S>) -> StageStream<S> + Send + Sync + 'static,
    {
        Self {
            handler: Handler::Wrap(Arc::new(handler)),
        }
    }

    /// The phase the handler runs in.
    #[must_use]
    pub fn phase(&self) -> MiddlewarePhase {
        self.handler.phase()
    }
}

impl<S: MiddlewareStage> fmt::Debug for Middleware<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Middleware")
            .field("stage", &S::NAME)
            .field("phase", &self.phase())
            .finish()
    }
}

/// The rest of the chain a Wrap handler calls (`MiddlewareNext`). Cheap to clone; call it more
/// than once to retry.
pub struct MiddlewareNext<S: MiddlewareStage> {
    handlers: Arc<[Handler<S>]>,
    index: usize,
    terminal: TerminalFn<S>,
}

impl<S: MiddlewareStage> Clone for MiddlewareNext<S> {
    fn clone(&self) -> Self {
        Self {
            handlers: self.handlers.clone(),
            index: self.index,
            terminal: self.terminal.clone(),
        }
    }
}

impl<S: MiddlewareStage> MiddlewareNext<S> {
    pub(crate) fn new(handlers: Arc<[Handler<S>]>, terminal: TerminalFn<S>) -> Self {
        Self {
            handlers,
            index: 0,
            terminal,
        }
    }

    /// Runs the inner handlers and the stage with `context`.
    pub fn call(&self, context: S::Context) -> StageStream<S> {
        let Some(handler) = self.handlers.get(self.index) else {
            return (self.terminal)(context);
        };
        let next = Self {
            handlers: self.handlers.clone(),
            index: self.index + 1,
            terminal: self.terminal.clone(),
        };
        handler.run(context, next)
    }
}

impl<S: MiddlewareStage> fmt::Debug for MiddlewareNext<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MiddlewareNext")
            .field("stage", &S::NAME)
            .field("remaining", &(self.handlers.len() - self.index))
            .finish()
    }
}

/// Removes a registered middleware handler; [`Agent::add_middleware`](crate::Agent::add_middleware)
/// returns it.
///
/// [`remove`](Self::remove) is idempotent and leaves other registrations alone. Dropping the
/// handle keeps the handler registered.
#[derive(Clone)]
pub struct MiddlewareCleanup {
    remove: Arc<dyn Fn() + Send + Sync>,
}

impl MiddlewareCleanup {
    pub(crate) fn new(remove: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            remove: Arc::new(remove),
        }
    }

    /// Unregisters the handler. Calling it again does nothing.
    pub fn remove(&self) {
        (self.remove)();
    }
}

impl fmt::Debug for MiddlewareCleanup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MiddlewareCleanup").finish_non_exhaustive()
    }
}
