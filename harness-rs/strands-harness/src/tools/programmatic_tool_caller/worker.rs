//! The subprocess engine: one `monty` worker per run, reached through `monty-pool`. A crash in the
//! worker ends only the worker, and the session's memory limit is a hard cap on its allocations.
//! Dropping the run (a timeout or cancel) kills it.

use std::path::Path;

use futures::stream::FuturesUnordered;
use futures::{FutureExt, StreamExt};
use monty_pool::{Checkout, Pool, PoolConfig, PoolError, ReplConfig, ResumeValue, TurnEvent, on_print_sync};
use monty_types::{ExcType, MontyObject, NameLookupResult, PrintStream};

use super::{CallResult, Host, MAX_OUTPUT_CHARS, Pending, Stop, USER_CODE_FILENAME, cap, prepare_call};

/// Why a worker run did not complete.
pub(super) enum Failure {
    /// The worker did not start; no code ran.
    Unavailable(PoolError),
    /// The run started and ended early.
    Stopped(Stop),
}

/// Runs `code` in a fresh worker at `path`.
pub(super) async fn drive(host: &Host, code: &str, path: &Path) -> Result<(), Failure> {
    if tokio::runtime::Handle::try_current().is_err() {
        return Err(Failure::Unavailable(PoolError::Spawn("no Tokio runtime".to_owned())));
    }
    let mut config = PoolConfig::subprocess(path);
    config.min_processes = 0;
    config.max_processes = 1;
    config.max_checkouts_per_worker = Some(1);
    let pool = Pool::new(config).await.map_err(Failure::Unavailable)?;
    let repl = ReplConfig {
        script_name: USER_CODE_FILENAME.to_owned(),
        limits: Some(host.limits.resource_limits()),
        ..ReplConfig::default()
    };
    let checkout = pool.checkout(&repl).await.map_err(Failure::Unavailable)?;
    let outcome = Session { host, checkout }.run(code).await;
    pool.close().await;
    outcome.map_err(Failure::Stopped)
}

struct Session<'a> {
    host: &'a Host,
    checkout: Checkout,
}

impl Session<'_> {
    async fn run(mut self, code: &str) -> Result<(), Stop> {
        let output = self.host.output.clone();
        let mut on_print = on_print_sync(move |_: PrintStream, text: &str| output.write(text));
        let mut event = match self
            .checkout
            .feed(code, Vec::new(), Vec::new(), false, &mut on_print)
            .await
        {
            Err(PoolError::Runtime(error)) if error.exc_type() == ExcType::SyntaxError => {
                return Err(Stop::Failed(cap(&format!("Syntax error:\n{error}"), MAX_OUTPUT_CHARS)));
            }
            other => other.map_err(|error| self.failed(&error))?,
        };
        let mut pending: Pending = FuturesUnordered::new();
        loop {
            let next = match event {
                TurnEvent::Complete(_) => break,
                TurnEvent::NameLookup { name, .. } => {
                    let result = self
                        .host
                        .lookup(&name)
                        .map_or(NameLookupResult::Undefined, NameLookupResult::Value);
                    self.checkout.resume_name_lookup(result, &mut on_print).await
                }
                TurnEvent::FunctionCall {
                    function_name,
                    args,
                    call_id,
                    ..
                } => {
                    let answer = match prepare_call(&self.host.functions, &function_name, &args) {
                        Ok((tool_name, input)) => {
                            pending.push(self.host.call_future(call_id, tool_name, input));
                            ResumeValue::Future
                        }
                        Err(error) => ResumeValue::Error(error),
                    };
                    self.checkout.resume(answer, &mut on_print).await
                }
                TurnEvent::OsCall {
                    call_id,
                    allow_eager_await,
                    system_sleep: Some(delay),
                    ..
                } if allow_eager_await => {
                    pending.push(
                        async move {
                            tokio::time::sleep(delay).await;
                            (call_id, Ok(MontyObject::none()))
                        }
                        .boxed(),
                    );
                    self.checkout.resume(ResumeValue::Future, &mut on_print).await
                }
                TurnEvent::OsCall {
                    system_sleep: Some(delay),
                    ..
                } => {
                    tokio::time::sleep(delay).await;
                    self.checkout
                        .resume(ResumeValue::Return(MontyObject::none()), &mut on_print)
                        .await
                }
                TurnEvent::OsCall { .. } => self.checkout.resume(ResumeValue::NotHandled, &mut on_print).await,
                TurnEvent::ResolveFutures { pending_call_ids, .. } => {
                    let Some(first) = pending.next().await else {
                        return Err(self.stuck());
                    };
                    let mut results = vec![first];
                    while let Some(Some(result)) = pending.next().now_or_never() {
                        results.push(result);
                    }
                    let results: Vec<(u32, ResumeValue)> = results
                        .into_iter()
                        .filter(|(call_id, _)| pending_call_ids.contains(call_id))
                        .map(|(call_id, result)| (call_id, resume_value(result)))
                        .collect();
                    self.checkout.resume_futures(results, &mut on_print).await
                }
            };
            event = next.map_err(|error| self.failed(&error))?;
        }
        if let Err(error) = self.checkout.finish().await {
            tracing::debug!("error=<{error}> | monty worker did not reset after the run");
        }
        Ok(())
    }

    /// The run's error, after whatever the code printed: a Python exception as its traceback,
    /// anything else (a crash, a protocol failure) as the pool reports it.
    fn failed(&self, error: &PoolError) -> Stop {
        let message = match error {
            PoolError::Runtime(exception) => format!("Execution error:\n{exception}"),
            error => format!("Execution error: {error}"),
        };
        Stop::Failed(self.host.output.with_error(&message))
    }

    fn stuck(&self) -> Stop {
        Stop::Failed(
            self.host
                .output
                .with_error("Execution error:\nRuntimeError: awaited a call that will never complete"),
        )
    }
}

fn resume_value(result: CallResult) -> ResumeValue {
    match result {
        Ok(value) => ResumeValue::Return(value),
        Err(error) => ResumeValue::Error(error),
    }
}
