//! Middleware registry tests, against a crate-internal test stage.

use std::sync::{Arc, Mutex};

use futures::StreamExt;

use super::registry::{MiddlewareRegistry, StageRegistry};
use super::types::{
    Middleware, MiddlewareError, MiddlewareNext, MiddlewareStage, StageItem, StageStream, TerminalFn, private,
};
use crate::error::Error;
use crate::hooks::{AgentStreamEvent, MessageAddedEventData};
use crate::interrupt::Interrupt;
use crate::types::Message;

pub(crate) struct TestStage;

impl private::Sealed for TestStage {
    fn slot(registry: &MiddlewareRegistry) -> &StageRegistry<Self> {
        registry.test_stage()
    }
}

impl MiddlewareStage for TestStage {
    type Context = String;
    type Result = String;
    const NAME: &'static str = "test";
}

type Log = Arc<Mutex<Vec<String>>>;

fn event(data: &str) -> AgentStreamEvent {
    AgentStreamEvent::MessageAdded(MessageAddedEventData::new(Message::user(data)))
}

fn data(event: &AgentStreamEvent) -> String {
    match event {
        AgentStreamEvent::MessageAdded(added) => added.message.text(),
        other => panic!("unexpected event {other:?}"),
    }
}

fn terminal(f: impl Fn(String) -> StageStream<TestStage> + Send + Sync + 'static) -> TerminalFn<TestStage> {
    Arc::new(f)
}

fn done(output: &str) -> StageStream<TestStage> {
    StageStream::from_result(Ok(output.to_owned()))
}

fn failing(message: &'static str) -> StageStream<TestStage> {
    StageStream::from_result(Err(Error::other(message).into()))
}

fn emitting(events: &[&str], output: &str) -> StageStream<TestStage> {
    let mut items: Vec<StageItem<TestStage>> = events.iter().map(|data| StageItem::Event(event(data))).collect();
    items.push(StageItem::Done(Ok(output.to_owned())));
    StageStream::new(futures::stream::iter(items))
}

async fn collect(stream: StageStream<TestStage>) -> (Vec<String>, Result<String, MiddlewareError>) {
    let mut stream = stream;
    let mut events = Vec::new();
    while let Some(item) = stream.next().await {
        match item {
            StageItem::Event(event) => events.push(data(&event)),
            StageItem::Done(result) => return (events, result),
        }
    }
    panic!("stage stream ended without a result");
}

async fn run(stream: StageStream<TestStage>) {
    collect(stream).await.1.unwrap();
}

fn push(log: &Log, entry: &str) {
    log.lock().unwrap().push(entry.to_owned());
}

fn entries(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

fn recording(log: &Log, name: &'static str) -> Middleware<TestStage> {
    let log = log.clone();
    Middleware::wrap(move |context, next| {
        push(&log, name);
        next.call(context)
    })
}

/// A wrap handler that logs on entry, around its inner chain, and from a drop guard.
fn guarded(log: &Log, name: &'static str) -> Middleware<TestStage> {
    let log = log.clone();
    Middleware::wrap(move |context, next: MiddlewareNext<TestStage>| {
        let log = log.clone();
        StageStream::new(async_stream::stream! {
            let _finally = Finally(log.clone(), format!("{name}-finally"));
            push(&log, &format!("{name}-enter"));
            let mut inner = next.call(context);
            while let Some(item) = inner.next().await {
                yield item;
            }
        })
    })
}

struct Finally(Log, String);

impl Drop for Finally {
    fn drop(&mut self) {
        self.0.lock().unwrap().push(self.1.clone());
    }
}

#[tokio::test]
async fn stores_handlers_in_registration_order() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    registry.add(recording(&log, "1"));
    registry.add(recording(&log, "2"));
    let terminal_log = log.clone();
    let chain = registry.invoke(
        String::from("test"),
        terminal(move |_| {
            push(&terminal_log, "3");
            done("done")
        }),
    );
    run(chain).await;
    assert_eq!(entries(&log), ["1", "2", "3"]);
}

#[tokio::test]
async fn with_no_handlers_returns_terminal_equivalent_function() {
    let registry = MiddlewareRegistry::new();
    let chain = registry.invoke(
        String::from("hello"),
        terminal(|context| emitting(&[&format!("event-{context}")], &format!("result-{context}"))),
    );
    let (events, result) = collect(chain).await;
    assert_eq!(events, ["event-hello"]);
    assert_eq!(result.unwrap(), "result-hello");
}

#[tokio::test]
async fn executes_handlers_in_registration_order_outermost_first() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    for name in ["outer", "inner"] {
        let log = log.clone();
        registry.add(Middleware::<TestStage>::wrap(move |context, next| {
            push(&log, &format!("{name}-before"));
            let log = log.clone();
            next.call(context).map_result(move |result| async move {
                push(&log, &format!("{name}-after"));
                result
            })
        }));
    }
    let terminal_log = log.clone();
    run(registry.invoke(
        String::new(),
        terminal(move |_| {
            push(&terminal_log, "terminal");
            done("done")
        }),
    ))
    .await;
    assert_eq!(
        entries(&log),
        ["outer-before", "inner-before", "terminal", "inner-after", "outer-after"]
    );
}

#[tokio::test]
async fn does_not_call_next_handlers_or_terminal_when_middleware_does_not_call_next() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    registry.add(Middleware::<TestStage>::wrap(|_, _| {
        emitting(&["synthetic"], "short-circuited")
    }));
    registry.add(recording(&log, "inner"));
    let terminal_log = log.clone();
    let (events, result) = collect(registry.invoke(
        String::new(),
        terminal(move |_| {
            push(&terminal_log, "terminal");
            done("terminal")
        }),
    ))
    .await;
    assert!(entries(&log).is_empty());
    assert_eq!(events, ["synthetic"]);
    assert_eq!(result.unwrap(), "short-circuited");
}

#[tokio::test]
async fn forwards_all_events_from_terminal_and_returns_terminal_result() {
    let registry = MiddlewareRegistry::new();
    registry.add(Middleware::<TestStage>::wrap(|context, next| next.call(context)));
    let (events, result) = collect(registry.invoke(
        String::new(),
        terminal(|_| emitting(&["event-1", "event-2", "event-3"], "terminal-result")),
    ))
    .await;
    assert_eq!(events, ["event-1", "event-2", "event-3"]);
    assert_eq!(result.unwrap(), "terminal-result");
}

#[tokio::test]
async fn only_yields_events_matching_a_predicate() {
    let registry = MiddlewareRegistry::new();
    registry.add(Middleware::<TestStage>::wrap(|context, next| {
        let inner = next.call(context);
        StageStream::new(inner.filter(|item| {
            let keep = match item {
                StageItem::Event(event) => data(event).contains("keep"),
                StageItem::Done(_) => true,
            };
            std::future::ready(keep)
        }))
    }));
    let (events, result) = collect(registry.invoke(
        String::new(),
        terminal(|_| emitting(&["keep-1", "drop-1", "keep-2", "drop-2"], "done")),
    ))
    .await;
    assert_eq!(events, ["keep-1", "keep-2"]);
    assert_eq!(result.unwrap(), "done");
}

#[tokio::test]
async fn terminal_receives_modified_context() {
    let registry = MiddlewareRegistry::new();
    registry.add(Middleware::<TestStage>::wrap(|_, next| {
        next.call("modified".to_owned())
    }));
    let received = Log::default();
    let seen = received.clone();
    let (_, result) = collect(registry.invoke(
        "original".to_owned(),
        terminal(move |context| {
            push(&seen, &context);
            done(&context)
        }),
    ))
    .await;
    assert_eq!(entries(&received), ["modified"]);
    assert_eq!(result.unwrap(), "modified");
}

#[tokio::test]
async fn each_middleware_can_further_modify_context() {
    let registry = MiddlewareRegistry::new();
    for suffix in ["-first", "-second"] {
        registry.add(Middleware::<TestStage>::wrap(move |context, next| {
            next.call(context + suffix)
        }));
    }
    let (_, result) = collect(registry.invoke("start".to_owned(), terminal(|context| done(&context)))).await;
    assert_eq!(result.unwrap(), "start-first-second");
}

#[tokio::test]
async fn errors_from_terminal_reach_middleware() {
    let registry = MiddlewareRegistry::new();
    let caught = Log::default();
    let log = caught.clone();
    registry.add(Middleware::<TestStage>::wrap(move |context, next| {
        let log = log.clone();
        next.call(context).map_result(move |result| async move {
            match result {
                Err(error) => {
                    push(&log, &error.to_string());
                    Ok("recovered".to_owned())
                }
                ok => ok,
            }
        })
    }));
    let (_, result) = collect(registry.invoke(String::new(), terminal(|_| failing("terminal error")))).await;
    assert_eq!(entries(&caught), ["terminal error"]);
    assert_eq!(result.unwrap(), "recovered");
}

#[tokio::test]
async fn errors_from_middleware_reach_caller() {
    let registry = MiddlewareRegistry::new();
    registry.add(Middleware::<TestStage>::wrap(|_, _| failing("middleware error")));
    let (_, result) = collect(registry.invoke(String::new(), terminal(|_| done("done")))).await;
    assert_eq!(result.unwrap_err().to_string(), "middleware error");
}

#[tokio::test]
async fn middleware_can_transform_errors_from_next() {
    let registry = MiddlewareRegistry::new();
    registry.add(Middleware::<TestStage>::wrap(|context, next| {
        next.call(context)
            .map_result(|result| async move { result.map_err(|_| Error::other("transformed error").into()) })
    }));
    let (_, result) = collect(registry.invoke(String::new(), terminal(|_| failing("original error")))).await;
    assert_eq!(result.unwrap_err().to_string(), "transformed error");
}

fn pass_through() -> Middleware<TestStage> {
    Middleware::wrap(|context, next| next.call(context))
}

#[tokio::test]
async fn cancelled_error_propagates_without_being_swallowed() {
    let registry = MiddlewareRegistry::new();
    registry.add(pass_through());
    let (_, result) = collect(registry.invoke(
        String::new(),
        terminal(|_| StageStream::from_result(Err(MiddlewareError::Cancelled))),
    ))
    .await;
    assert!(matches!(result, Err(MiddlewareError::Cancelled)));
}

#[tokio::test]
async fn interrupt_error_propagates_without_being_swallowed() {
    let registry = MiddlewareRegistry::new();
    registry.add(pass_through());
    let (_, result) = collect(registry.invoke(
        String::new(),
        terminal(|_| StageStream::from_result(Err(Interrupt::new("test-id", "test-interrupt").into()))),
    ))
    .await;
    let Err(MiddlewareError::Interrupt(interrupt)) = result else {
        panic!("expected an interrupt");
    };
    assert_eq!(interrupt.interrupts[0].name, "test-interrupt");
}

#[tokio::test]
async fn cancelled_error_propagates_through_multiple_middleware_layers() {
    let registry = MiddlewareRegistry::new();
    registry.add(pass_through());
    registry.add(pass_through());
    let (_, result) = collect(registry.invoke(
        String::new(),
        terminal(|_| StageStream::from_result(Err(MiddlewareError::Cancelled))),
    ))
    .await;
    assert!(matches!(result, Err(MiddlewareError::Cancelled)));
}

#[tokio::test]
async fn interrupt_error_propagates_through_multiple_middleware_layers() {
    let registry = MiddlewareRegistry::new();
    registry.add(pass_through());
    registry.add(pass_through());
    let (_, result) = collect(registry.invoke(
        String::new(),
        terminal(|_| StageStream::from_result(Err(Interrupt::new("multi-id", "multi-layer").into()))),
    ))
    .await;
    assert!(matches!(result, Err(MiddlewareError::Interrupt(interrupt)) if interrupt.interrupts[0].id == "multi-id"));
}

#[tokio::test]
async fn outer_finally_runs_when_inner_middleware_throws() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    registry.add(guarded(&log, "outer"));
    let inner_log = log.clone();
    registry.add(Middleware::<TestStage>::wrap(move |_, _| {
        push(&inner_log, "inner-throw");
        failing("inner exploded")
    }));
    let (_, result) = collect(registry.invoke(String::new(), terminal(|_| done("unreachable")))).await;
    assert_eq!(result.unwrap_err().to_string(), "inner exploded");
    assert_eq!(entries(&log), ["outer-enter", "inner-throw", "outer-finally"]);
}

#[tokio::test]
async fn inner_finally_runs_when_terminal_throws() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    registry.add(guarded(&log, "outer"));
    registry.add(guarded(&log, "inner"));
    let terminal_log = log.clone();
    let mut chain = registry.invoke(
        String::new(),
        terminal(move |_| {
            push(&terminal_log, "terminal-throw");
            failing("terminal exploded")
        }),
    );
    let mut outcome = None;
    while let Some(item) = chain.next().await {
        if let StageItem::Done(result) = item {
            outcome = Some(result);
        }
    }
    drop(chain);
    assert_eq!(outcome.unwrap().unwrap_err().to_string(), "terminal exploded");
    assert_eq!(
        entries(&log),
        [
            "outer-enter",
            "inner-enter",
            "terminal-throw",
            "inner-finally",
            "outer-finally"
        ]
    );
}

#[tokio::test]
async fn all_finally_blocks_run_in_reverse_order_when_terminal_throws() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    for name in ["a", "b", "c"] {
        registry.add(guarded(&log, name));
    }
    let (_, result) = collect(registry.invoke(String::new(), terminal(|_| failing("boom")))).await;
    assert_eq!(result.unwrap_err().to_string(), "boom");
    assert_eq!(
        entries(&log),
        ["a-enter", "b-enter", "c-enter", "c-finally", "b-finally", "a-finally"]
    );
}

#[tokio::test]
async fn finally_runs_even_when_caller_abandons_the_generator_mid_stream() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    registry.add(guarded(&log, "middleware"));
    let mut chain = registry.invoke(
        String::new(),
        terminal(|_| emitting(&["event-1", "event-2", "event-3"], "done")),
    );
    chain.next().await;
    drop(chain);
    assert_eq!(entries(&log), ["middleware-enter", "middleware-finally"]);
}

#[tokio::test]
async fn finally_runs_in_both_middleware_when_caller_abandons_mid_stream() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    registry.add(guarded(&log, "outer"));
    registry.add(guarded(&log, "inner"));
    let mut chain = registry.invoke(String::new(), terminal(|_| emitting(&["event-1", "event-2"], "done")));
    chain.next().await;
    drop(chain);
    assert_eq!(
        entries(&log),
        ["outer-enter", "inner-enter", "inner-finally", "outer-finally"]
    );
}

#[tokio::test]
async fn removes_a_handler_so_it_no_longer_runs() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    registry.add(recording(&log, "1")).remove();
    let terminal_log = log.clone();
    run(registry.invoke(
        String::new(),
        terminal(move |_| {
            push(&terminal_log, "2");
            done("done")
        }),
    ))
    .await;
    assert_eq!(entries(&log), ["2"]);
}

#[tokio::test]
async fn only_removes_the_first_occurrence_of_a_duplicate_handler() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    let first = registry.add(recording(&log, "call"));
    registry.add(recording(&log, "call"));
    first.remove();
    first.remove();
    run(registry.invoke(String::new(), terminal(|_| done("done")))).await;
    assert_eq!(entries(&log), ["call"]);
}

#[test]
fn is_a_no_op_when_handler_was_never_registered() {
    let registry = MiddlewareRegistry::new();
    let other = MiddlewareRegistry::new();
    let cleanup = other.add(pass_through());
    drop(other);
    cleanup.remove();
    assert_eq!(registry.len::<TestStage>(), 0);
}

#[test]
fn is_a_no_op_when_stage_has_no_handlers() {
    let registry = MiddlewareRegistry::new();
    let cleanup = registry.add(pass_through());
    cleanup.remove();
    cleanup.remove();
    assert_eq!(registry.len::<TestStage>(), 0);
}

#[tokio::test]
async fn input_and_output_handlers_run_around_wrap_whatever_the_registration_order() {
    let registry = MiddlewareRegistry::new();
    let log = Log::default();
    let output_log = log.clone();
    registry.add(Middleware::<TestStage>::output(move |result| {
        let log = output_log.clone();
        async move {
            push(&log, "output");
            Ok(format!("{result}-output"))
        }
    }));
    registry.add(recording(&log, "wrap"));
    let input_log = log.clone();
    registry.add(Middleware::<TestStage>::input(move |context| {
        let log = input_log.clone();
        async move {
            push(&log, "input");
            Ok(format!("{context}-input"))
        }
    }));
    let (_, result) = collect(registry.invoke("start".to_owned(), terminal(|context| done(&context)))).await;
    assert_eq!(result.unwrap(), "start-input-output");
    assert_eq!(entries(&log), ["input", "wrap", "output"]);
}

#[tokio::test]
async fn a_stream_that_ends_without_a_result_is_an_error() {
    let stream: StageStream<TestStage> = StageStream::new(futures::stream::iter([StageItem::Event(event("x"))]));
    let result = stream.result().await;
    assert_eq!(
        result.unwrap_err().to_string(),
        "middleware stream ended without a result"
    );
}
