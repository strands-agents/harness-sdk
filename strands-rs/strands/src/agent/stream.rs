//! [`AgentStream`]: the agent loop as a stream of event records.
//!
//! The loop is an ordinary `async fn` that hands each record to an [`Emitter`] and suspends until
//! the consumer takes it, so the loop advances only as the stream is polled. Dropping the stream
//! drops the loop's future; the loop's drop guard then repairs history.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};

use futures::Stream;

use super::result::AgentResult;
use crate::error::Result;
use crate::hooks::AgentStreamEvent;

type Slot = Arc<Mutex<Option<AgentStreamEvent>>>;
type LoopFuture<'a> = Pin<Box<dyn Future<Output = Result<AgentResult>> + Send + 'a>>;

/// Hands records from the loop to its [`AgentStream`].
#[derive(Clone, Default)]
pub(crate) struct Emitter {
    slot: Slot,
}

impl Emitter {
    /// Yields `event` to the consumer; completes once the consumer has taken it.
    pub(crate) async fn emit(&self, event: AgentStreamEvent) {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(event);
        YieldOnce(false).await;
    }
}

struct YieldOnce(bool);

impl Future for YieldOnce {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            return Poll::Ready(());
        }
        self.0 = true;
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}

/// The stream of an agent invocation (`agent.stream()`): event records, ending with
/// [`AgentStreamEvent::AgentResult`]. An invocation a `BeforeInvocationEvent` hook cancelled ends
/// without that record; [`into_result`](Self::into_result) returns the result either way.
///
/// The loop runs as the stream is polled. It borrows the agent, so the agent cannot be invoked
/// again until the stream is finished or dropped. Dropping it early cancels the invocation: tool
/// tasks still running are aborted, history is closed with the cancel message, and the
/// `AfterInvocationEvent` hooks run at the start of the agent's next call.
///
/// An error ends the stream: it is the last item.
#[must_use = "streams do nothing unless polled"]
pub struct AgentStream<'a> {
    future: Option<LoopFuture<'a>>,
    slot: Slot,
    result: Option<AgentResult>,
}

impl<'a> AgentStream<'a> {
    pub(crate) fn new(emitter: &Emitter, future: impl Future<Output = Result<AgentResult>> + Send + 'a) -> Self {
        Self {
            future: Some(Box::pin(future)),
            slot: emitter.slot.clone(),
            result: None,
        }
    }

    /// Takes the invocation result once the stream has ended.
    pub(crate) fn take_result(&mut self) -> Option<AgentResult> {
        self.result.take()
    }

    /// The invocation's result, once the stream has ended.
    /// `None` while it is still running and when the invocation failed.
    ///
    /// ```
    /// use futures::StreamExt;
    /// use strands::Agent;
    /// use strands::hooks::BeforeInvocationEvent;
    /// use strands::testing::MockModel;
    ///
    /// # tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
    /// let mut agent = Agent::builder().model(MockModel::new()).printer(false).build()?;
    /// agent.add_hook(|event: &mut BeforeInvocationEvent<'_>| event.set_cancel("closed"));
    /// let mut stream = agent.stream("Hi");
    /// while let Some(event) = stream.next().await {
    ///     event?;
    /// }
    /// let result = stream.into_result().expect("the stream ended");
    /// assert_eq!(result.to_string(), "closed");
    /// # Ok::<(), strands::Error>(())
    /// # }).unwrap();
    /// ```
    #[must_use]
    pub fn into_result(mut self) -> Option<AgentResult> {
        self.result.take()
    }

    fn take_event(&self) -> Option<AgentStreamEvent> {
        self.slot.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

impl Stream for AgentStream<'_> {
    type Item = Result<AgentStreamEvent>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let Some(future) = self.future.as_mut() else {
            return Poll::Ready(None);
        };
        let polled = future.as_mut().poll(cx);
        if let Some(event) = self.take_event() {
            if let Poll::Ready(output) = polled {
                self.finish(output);
            }
            return Poll::Ready(Some(Ok(event)));
        }
        match polled {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Ok(result)) => {
                self.future = None;
                self.result = Some(result);
                Poll::Ready(None)
            }
            Poll::Ready(Err(error)) => {
                self.future = None;
                Poll::Ready(Some(Err(error)))
            }
        }
    }
}

impl AgentStream<'_> {
    fn finish(&mut self, output: Result<AgentResult>) {
        self.future = None;
        if let Ok(result) = output {
            self.result = Some(result);
        }
    }
}

impl fmt::Debug for AgentStream<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AgentStream")
            .field("finished", &self.future.is_none())
            .finish_non_exhaustive()
    }
}

/// The stream and emitter mechanics.
#[cfg(test)]
mod tests;
