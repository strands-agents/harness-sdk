//! The in-process engine: the `monty` crate's `MontyRun` driven step by step, every step on its
//! own large-stack thread.

use std::sync::Arc;

use futures::stream::FuturesUnordered;
use futures::{FutureExt, StreamExt};
use monty::{MontyRun, RunProgress};
use monty_types::{
    CompileOptions, ExtFunctionResult, MontyException, MontyObject, NameLookupResult, OsFunctionCall, PrintWriter,
    ResourceTracker,
};

use super::{
    CallResult, Host, MAX_OUTPUT_CHARS, Output, Pending, Printer, Stop, USER_CODE_FILENAME, cap, prepare_call,
};

/// The stack of an interpreter step's thread. The VM's container `repr`, `==` and value export
/// recurse once per nesting level up to its recursion limit, which overflows the 2 MiB of a
/// runtime worker thread; the memory is reserved, not committed.
const STEP_STACK_SIZE: usize = 256 * 1024 * 1024;

/// Runs `code` to completion; `threaded: false` runs every step inline.
pub(super) async fn drive(host: &Host, code: String, threaded: bool) -> Result<(), Stop> {
    let run = Run { host, threaded };
    let compiled = run
        .step(move |_| MontyRun::new(code, USER_CODE_FILENAME, Vec::new(), CompileOptions::default()))
        .await?;
    let runner = compiled.map_err(|error| Stop::Failed(cap(&format!("Syntax error:\n{error}"), MAX_OUTPUT_CHARS)))?;
    let tracker = ResourceTracker::new(host.limits.resource_limits());
    let mut progress = run.step(move |print| runner.start(Vec::new(), tracker, print)).await?;
    let mut pending: Pending = FuturesUnordered::new();
    let mut suspensions = 0usize;
    loop {
        let current =
            progress.map_err(|error| Stop::Failed(host.output.with_error(&format!("Execution error:\n{error}"))))?;
        if let RunProgress::Complete(_) = current {
            return Ok(());
        }
        if suspensions >= host.limits.max_suspensions {
            let exceeded = super::runtime_error(format!("suspension limit {} exceeded", host.limits.max_suspensions));
            progress = run.step(move |print| abort(current, exceeded, print)).await?;
            continue;
        }
        suspensions += 1;
        progress = run.answer(current, &mut pending).await?;
    }
}

struct Run<'a> {
    host: &'a Host,
    threaded: bool,
}

impl Run<'_> {
    /// Runs one synchronous interpreter step on its own thread, so guest compute never stalls
    /// the async runtime, the timeout and cancel can return during it, and the VM's recursion
    /// has the stack it needs.
    async fn step<R, F>(&self, work: F) -> Result<R, Stop>
    where
        R: Send + 'static,
        F: FnOnce(PrintWriter<'_>) -> R + Send + 'static,
    {
        let output: Arc<Output> = self.host.output.clone();
        let work = move || {
            let mut printer = Printer(output);
            work(PrintWriter::Callback(&mut printer))
        };
        if !self.threaded {
            return Ok(work());
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("programmatic-tool-caller".to_owned())
            .stack_size(STEP_STACK_SIZE)
            .spawn(move || {
                let _ = sender.send(work());
            })
            .map_err(|error| {
                Stop::Failed(format!(
                    "Execution error: the interpreter thread did not start: {error}"
                ))
            })?;
        receiver
            .await
            .map_err(|_| Stop::Failed("Execution error: the interpreter stopped unexpectedly.".to_owned()))
    }

    /// Answers one suspension and runs the interpreter to the next.
    async fn answer(
        &self,
        progress: RunProgress,
        pending: &mut Pending,
    ) -> Result<Result<RunProgress, MontyException>, Stop> {
        match progress {
            RunProgress::NameLookup(lookup) => {
                let result = self
                    .host
                    .lookup(&lookup.name)
                    .map_or(NameLookupResult::Undefined, NameLookupResult::Value);
                self.step(move |print| lookup.resume(result, print)).await
            }
            RunProgress::FunctionCall(call) => {
                match prepare_call(&self.host.functions, &call.function_name, &call.args) {
                    Ok((tool_name, input)) => {
                        pending.push(self.host.call_future(call.call_id, tool_name, input));
                        self.step(move |print| call.resume_pending(print)).await
                    }
                    Err(error) => self.step(move |print| call.resume(error, print)).await,
                }
            }
            RunProgress::OsCall(call) => match call.function_call {
                OsFunctionCall::AsyncSleep(delay) | OsFunctionCall::AsyncSystemSleep(delay) => {
                    let call_id = call.call_id;
                    pending.push(
                        async move {
                            tokio::time::sleep(delay).await;
                            (call_id, Ok(MontyObject::none()))
                        }
                        .boxed(),
                    );
                    self.step(move |print| call.resume(ExtFunctionResult::Future(call_id), print))
                        .await
                }
                OsFunctionCall::Sleep(delay) | OsFunctionCall::SystemSleep(delay) => {
                    tokio::time::sleep(delay).await;
                    self.step(move |print| call.resume(MontyObject::none(), print)).await
                }
                _ => {
                    self.step(move |print| call.resume_with(print, |function| function.no_handler_result()))
                        .await
                }
            },
            RunProgress::ResolveFutures(waiting) => {
                let Some(first) = pending.next().await else {
                    let stuck = MontyException::runtime_error("awaited a call that will never complete");
                    return self.step(move |print| waiting.abort(stuck, print)).await;
                };
                let mut results = vec![first];
                while let Some(Some(result)) = pending.next().now_or_never() {
                    results.push(result);
                }
                let ids = waiting.pending_call_ids().to_vec();
                let results: Vec<(u32, ExtFunctionResult)> = results
                    .into_iter()
                    .filter(|(call_id, _)| ids.contains(call_id))
                    .map(|(call_id, result)| (call_id, ext_result(result)))
                    .collect();
                self.step(move |print| waiting.resume(results, print)).await
            }
            RunProgress::Complete(value) => Ok(Ok(RunProgress::Complete(value))),
        }
    }
}

fn ext_result(result: CallResult) -> ExtFunctionResult {
    match result {
        Ok(value) => ExtFunctionResult::Return(value),
        Err(error) => ExtFunctionResult::Error(error),
    }
}

fn abort(progress: RunProgress, exc: MontyException, print: PrintWriter<'_>) -> Result<RunProgress, MontyException> {
    match progress {
        RunProgress::FunctionCall(call) => call.abort(exc, print),
        RunProgress::OsCall(call) => call.abort(exc, print),
        RunProgress::NameLookup(lookup) => lookup.abort(exc, print),
        RunProgress::ResolveFutures(waiting) => waiting.abort(exc, print),
        RunProgress::Complete(value) => Ok(RunProgress::Complete(value)),
    }
}
