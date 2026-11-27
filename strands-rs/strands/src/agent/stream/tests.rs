use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::StreamExt;

use super::{AgentStream, Emitter};
use crate::agent::AgentResult;
use crate::error::Error;
use crate::hooks::{AfterInvocationEventData, AgentStreamEvent, BeforeInvocationEventData};
use crate::types::{Message, StopReason};

fn before() -> AgentStreamEvent {
    AgentStreamEvent::BeforeInvocation(BeforeInvocationEventData::new())
}

fn after() -> AgentStreamEvent {
    AgentStreamEvent::AfterInvocation(AfterInvocationEventData::new())
}

fn result() -> AgentResult {
    AgentResult::new(StopReason::EndTurn, Message::assistant("done"))
}

fn assert_send_unpin<T: Send + Unpin>() {}

#[test]
fn agent_stream_is_send_and_unpin() {
    assert_send_unpin::<AgentStream<'static>>();
}

#[tokio::test]
async fn yields_emitted_records_in_order_then_ends_with_the_result() {
    let emitter = Emitter::default();
    let loop_emitter = emitter.clone();
    let mut stream = AgentStream::new(&emitter, async move {
        loop_emitter.emit(before()).await;
        loop_emitter.emit(after()).await;
        Ok(result())
    });
    let mut types = Vec::new();
    while let Some(item) = stream.next().await {
        types.push(item.unwrap().event_type());
    }
    assert_eq!(types, ["beforeInvocationEvent", "afterInvocationEvent"]);
    assert_eq!(stream.take_result().unwrap().stop_reason(), StopReason::EndTurn);
    assert!(stream.take_result().is_none());
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn an_error_is_the_last_item_and_leaves_no_result() {
    let emitter = Emitter::default();
    let loop_emitter = emitter.clone();
    let mut stream = AgentStream::new(&emitter, async move {
        loop_emitter.emit(before()).await;
        Err(Error::other("boom"))
    });
    assert!(stream.next().await.unwrap().is_ok());
    assert_eq!(stream.next().await.unwrap().unwrap_err().to_string(), "boom");
    assert!(stream.next().await.is_none());
    assert!(stream.take_result().is_none());
}

#[tokio::test]
async fn the_loop_advances_only_as_the_stream_is_polled() {
    let emitter = Emitter::default();
    let loop_emitter = emitter.clone();
    let progress = Arc::new(AtomicUsize::new(0));
    let seen = progress.clone();
    let mut stream = AgentStream::new(&emitter, async move {
        for _ in 0..3 {
            seen.fetch_add(1, Ordering::SeqCst);
            loop_emitter.emit(before()).await;
        }
        Ok(result())
    });
    assert_eq!(progress.load(Ordering::SeqCst), 0);
    stream.next().await.unwrap().unwrap();
    assert_eq!(progress.load(Ordering::SeqCst), 1);
    stream.next().await.unwrap().unwrap();
    assert_eq!(progress.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn dropping_the_stream_drops_the_loop_mid_run() {
    struct Guard(Arc<AtomicUsize>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let dropped = Arc::new(AtomicUsize::new(0));
    let emitter = Emitter::default();
    let loop_emitter = emitter.clone();
    let guard = Guard(dropped.clone());
    let mut stream = AgentStream::new(&emitter, async move {
        let _guard = guard;
        loop_emitter.emit(before()).await;
        loop_emitter.emit(after()).await;
        Ok(result())
    });
    stream.next().await.unwrap().unwrap();
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    drop(stream);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_loop_that_emits_nothing_ends_at_once_with_its_result() {
    let emitter = Emitter::default();
    let mut stream = AgentStream::new(&emitter, async { Ok(result()) });
    assert!(stream.next().await.is_none());
    assert!(stream.take_result().is_some());
}
