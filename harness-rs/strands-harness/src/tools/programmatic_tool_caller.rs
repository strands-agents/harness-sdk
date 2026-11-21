//! `programmatic_tool_caller`: lets the agent orchestrate its other tools with Python code.
//!
//! The model calls this tool with a `code` string; the code runs in a [Monty](https://github.com/pydantic/monty)
//! interpreter with every other registered tool exposed as an `async` function taking keyword
//! arguments, so the model can chain, loop over, filter and parallelize tool calls in one turn.
//! Only text the code passes to `print()` is returned to the model.
//!
//! Monty's VM implements no host operations: no filesystem, environment, network or process
//! access exists in the bytecode, and time and recursion limits are enforced by the VM. The only
//! way out is the tool functions handed in here, so the code reaches exactly what the agent's
//! tools reach.
//!
//! # Isolation
//!
//! The interpreter runs in a separate worker process when one is available, so a crash inside it
//! (a stack overflow, an allocator abort) ends only the worker, and the memory limit is a hard cap
//! on the worker's allocations. The worker is the `monty` binary of `monty-runtime` at the exact
//! version this crate pins ([`MONTY_WORKER_VERSION`]):
//!
//! ```text
//! cargo install monty-runtime --version 1.5.0 --locked
//! ```
//!
//! [`Isolation::Auto`] (the default) looks for the binary in this order: the `MONTY_BIN`
//! environment variable when it names a file, then `monty` on `PATH`, then a `target/debug` or
//! `target/release` build in the cargo workspace of the running executable.
//! [`Isolation::Subprocess`] names the binary explicitly. Without one, or when a found binary
//! other than `MONTY_BIN` cannot start, the interpreter runs in this process with a warning.
//! In-process, each interpreter step runs on its own thread with a 256 MiB stack and arguments are
//! converted at most 128 levels deep, so nested data cannot overflow the host's stack; the memory
//! limit then only bounds single allocations (the VM checks each one against it, not the process
//! total), so for a hard cap use a worker. The subprocess transport needs the `monty-pool` feature
//! (on by default).
//!
//! Inner calls run through [`ToolAgent::call_tool_without_interrupts`], the agent's full
//! per-tool pipeline (hooks, interventions, middleware): a denied call raises a catchable
//! `RuntimeError` in the code, and a call that needs approval is refused the same way, since the
//! code cannot wait for a human. The outer call still completes, and is never run again on
//! resume.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::stream::FuturesUnordered;
use monty_types::{CallArgs, ExcType, MontyException, MontyObject, ObjectRef, PrintWriterCallback, ResourceLimits};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;
use strands::interrupt::{InterruptError, InterruptSource};
use strands::types::{JsonValue, ToolResultBlock, ToolResultContent, ToolResultStatus, ToolSpec};
use strands::{CancelSignal, RefusedCall, Tool, ToolAgent, ToolContext, ToolOutcome, ToolStream};
use tokio::sync::Semaphore;

use crate::env::Env;

mod in_process;
#[cfg(feature = "monty-pool")]
mod worker;

/// The description shown to the model (`DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION`).
pub const DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION: &str = concat!(
    "Execute Python code that orchestrates the agent's other tools, each exposed as an async function ",
    "taking keyword arguments -- always `await` them, e.g. `result = await read(path=\"/etc/hosts\")`. ",
    "The code runs in an async context, so `await` and `asyncio.gather(...)` work without boilerplate. ",
    "A tool result that is structured content or JSON text (an object or array) arrives parsed, as a ",
    "dict/list; anything else arrives as a string. A tool that fails raises RuntimeError, which you can ",
    "catch. ",
    "Only text sent to `print()` is returned to you: a tool's return value stays in the code's local ",
    "scope unless you print it. A tool whose name is not a valid Python identifier (for example ",
    "`fetch-url` or `ns.fetch`) is also available with those characters replaced by underscores ",
    "(`fetch_url`, `ns_fetch`). The code runs in a sandboxed Python subset: `asyncio`, `json`, `re`, ",
    "`math`, `datetime`, `collections`, `itertools`, `functools`, `dataclasses`, `typing`, `base64` ",
    "are importable; filesystem, network, and subprocess access do not exist -- use the agent's tools ",
    "for those. Generators (`yield`), class inheritance, `match`, and `del` are not supported. Use this ",
    "to chain, loop over, filter, or parallelize tool calls in a single turn instead of one tool call ",
    "per model round-trip, keeping large intermediate results out of the conversation."
);

/// Inner tool calls in flight at once per run, so `asyncio.gather` over a long list does not fan
/// out unbounded against the same agent.
pub(crate) const MAX_CONCURRENT_TOOL_CALLS: usize = 10;

/// The wall-clock ceiling for a run, tool calls included, when none is configured.
pub const DEFAULT_PROGRAMMATIC_TOOL_CALLER_TIMEOUT: Duration = Duration::from_secs(900);

/// The `monty-runtime` version whose `monty` binary serves as the worker: the protocol must match
/// the `monty-pool` this crate links, so install exactly this version.
pub const MONTY_WORKER_VERSION: &str = "1.5.0";

/// The environment variable naming the worker binary for [`Isolation::Auto`], shared with Monty's
/// other language bindings.
pub const MONTY_WORKER_ENV: &str = "MONTY_BIN";

const DEFAULT_NAME: &str = "programmatic_tool_caller";

const USER_CODE_FILENAME: &str = "<programmatic_tool_caller>";

/// Cap on the text returned to the model, in characters.
const MAX_OUTPUT_CHARS: usize = 200_000;

/// How deep a value may nest when it crosses between the code and a tool, so converting it
/// never recurses deeper than this on the host's stack.
const MAX_VALUE_DEPTH: usize = 128;

const CODE_DESCRIPTION: &str = "Python code to execute. Use `await tool_name(...)` to call tools.";

const CANCELLED_CALL: &str = "programmatic_tool_caller was cancelled; no further tool calls are made.";

const NO_INNER_INTERRUPTS: &str = "Interrupts are not supported from programmatic_tool_caller.";

/// The interpreter limits (`LIMITS`). Guest duration counts interpreter time only (the clock
/// pauses while a tool call is in flight). Suspensions are host round trips: a sequentially
/// awaited tool call costs two, a gathered one about one.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Limits {
    max_duration: Duration,
    max_memory: usize,
    max_suspensions: usize,
}

impl Limits {
    fn resource_limits(self) -> ResourceLimits {
        ResourceLimits {
            max_feed_duration: Some(self.max_duration),
            max_memory: Some(self.max_memory),
            max_suspensions: self.max_suspensions,
            ..ResourceLimits::default()
        }
    }
}

const LIMITS: Limits = Limits {
    max_duration: Duration::from_secs(60),
    max_memory: 256 * 1024 * 1024,
    max_suspensions: 1_000,
};

/// Where the interpreter runs. See the [module docs](self#isolation).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum Isolation {
    /// The worker binary named by [`MONTY_WORKER_ENV`], else `monty` on `PATH`, else a build in
    /// the running executable's cargo workspace, else this process, with a warning. A worker
    /// from the environment variable that cannot start fails the run; one found elsewhere falls
    /// back to this process.
    #[default]
    Auto,
    /// This `monty` worker binary; a worker that cannot start fails the run. Needs the
    /// `monty-pool` feature.
    Subprocess(PathBuf),
    /// This process, each interpreter step on its own large-stack thread.
    InProcess,
}

/// The portable `builtinTools.programmatic_tool_caller` config (`ProgrammaticToolCallerConfig`).
///
/// ```
/// use strands_harness::tools::programmatic_tool_caller::ProgrammaticToolCallerConfig;
///
/// let config: ProgrammaticToolCallerConfig = serde_json::from_str(r#"{"allowedTools": ["read"], "timeout": null}"#)?;
/// assert_eq!(config.allowed_tools, Some(vec!["read".to_owned()]));
/// assert_eq!(config.timeout, Some(None));
/// # Ok::<(), serde_json::Error>(())
/// ```
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, bon::Builder)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgrammaticToolCallerConfig {
    /// Names of the agent's other tools the code may call; `None` (or JSON `null`) for all of
    /// them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    /// Wall-clock bound in seconds for one run, tool calls included: `None` (absent) for the
    /// default of 900, `Some(None)` (JSON `null`) for no bound.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub timeout: Option<Option<f64>>,
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Options for [`make_programmatic_tool_caller`] (`MakeProgrammaticToolCallerOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeProgrammaticToolCallerOptions {
    /// Registry names of the tools to expose to the code; every other registered tool when
    /// absent. No programmatic tool caller is ever exposed, this one or another, even if named.
    pub allowed_tools: Option<Vec<String>>,
    /// The tool name; `programmatic_tool_caller` when absent.
    pub name: Option<String>,
    /// The description shown to the model; [`DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION`]
    /// when absent.
    pub description: Option<String>,
    /// Wall-clock ceiling for a run, tool calls included: `None` for
    /// [`DEFAULT_PROGRAMMATIC_TOOL_CALLER_TIMEOUT`], `Some(None)` for no bound.
    pub timeout: Option<Option<Duration>>,
    /// Where the interpreter runs (Rust-only); [`Isolation::Auto`] by default.
    #[builder(default)]
    pub isolation: Isolation,
}

/// The `programmatic_tool_caller` tool: runs model-written Python with the agent's other tools
/// exposed as async functions.
///
/// Cloning shares the instance; a clone is the same caller and is never exposed to code either.
#[derive(Clone)]
pub struct ProgrammaticToolCaller {
    inner: Arc<Inner>,
}

struct Inner {
    name: String,
    spec: ToolSpec,
    allowed_tools: Option<Vec<String>>,
    timeout: Option<Duration>,
    isolation: Isolation,
    limits: Limits,
    threaded: bool,
}

/// Every live caller; none is exposed to another's code (two callers exposing each other would
/// recurse). A tool is identified by the address of its name, which a caller's name keeps on its
/// shared heap allocation, so no downcasting is needed.
static INSTANCES: Mutex<Vec<Weak<Inner>>> = Mutex::new(Vec::new());

fn register(inner: &Arc<Inner>) {
    let mut instances = INSTANCES.lock().unwrap_or_else(PoisonError::into_inner);
    instances.retain(|instance| instance.strong_count() > 0);
    instances.push(Arc::downgrade(inner));
}

fn is_caller(tool: &dyn Tool) -> bool {
    let name = tool.name().as_ptr();
    INSTANCES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .filter_map(Weak::upgrade)
        .any(|inner| std::ptr::eq(inner.name.as_ptr(), name))
}

/// Builds the tool from the portable config: the timeout is in seconds, and a negative or
/// non-finite one ends every run at once.
///
/// ```
/// use strands_harness::tools::programmatic_tool_caller::{ProgrammaticToolCallerConfig, programmatic_tool_caller};
///
/// let caller = programmatic_tool_caller(ProgrammaticToolCallerConfig::default());
/// let agent = strands::Agent::builder().tools([caller]).printer(false).build()?;
/// assert!(agent.tool_registry().get("programmatic_tool_caller").is_some());
/// # Ok::<(), strands::Error>(())
/// ```
#[must_use]
pub fn programmatic_tool_caller(config: ProgrammaticToolCallerConfig) -> ProgrammaticToolCaller {
    let timeout = config
        .timeout
        .map(|timeout| timeout.map(|seconds| Duration::try_from_secs_f64(seconds).unwrap_or(Duration::ZERO)));
    make_programmatic_tool_caller(MakeProgrammaticToolCallerOptions {
        allowed_tools: config.allowed_tools,
        timeout,
        ..MakeProgrammaticToolCallerOptions::default()
    })
}

/// Creates a programmatic tool caller.
///
/// ```
/// use std::time::Duration;
/// use strands::Tool;
/// use strands_harness::tools::programmatic_tool_caller::{
///     Isolation, MakeProgrammaticToolCallerOptions, make_programmatic_tool_caller,
/// };
///
/// let caller = make_programmatic_tool_caller(
///     MakeProgrammaticToolCallerOptions::builder()
///         .name("run_code")
///         .allowed_tools(vec!["read".to_owned()])
///         .timeout(Some(Duration::from_secs(60)))
///         .isolation(Isolation::InProcess)
///         .build(),
/// );
/// assert_eq!(caller.name(), "run_code");
/// ```
#[must_use]
pub fn make_programmatic_tool_caller(options: MakeProgrammaticToolCallerOptions) -> ProgrammaticToolCaller {
    let name = options.name.unwrap_or_else(|| DEFAULT_NAME.to_owned());
    let description = options
        .description
        .unwrap_or_else(|| DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION.to_owned());
    let schema = json!({
        "type": "object",
        "properties": {"code": {"type": "string", "description": CODE_DESCRIPTION}},
        "required": ["code"],
        "additionalProperties": false
    });
    let inner = Arc::new(Inner {
        spec: ToolSpec::new(&name, description).with_input_schema(schema),
        name,
        allowed_tools: options.allowed_tools,
        timeout: options
            .timeout
            .unwrap_or(Some(DEFAULT_PROGRAMMATIC_TOOL_CALLER_TIMEOUT)),
        isolation: options.isolation,
        limits: LIMITS,
        threaded: true,
    });
    register(&inner);
    ProgrammaticToolCaller { inner }
}

impl ProgrammaticToolCaller {
    /// A caller with other interpreter limits and isolation; `threaded: false` runs in-process
    /// steps inline, so paused-clock tests see no thread time.
    #[cfg(test)]
    fn with_limits(self, limits: Limits, isolation: Isolation, threaded: bool) -> Self {
        let inner = Arc::new(Inner {
            name: self.inner.name.clone(),
            spec: self.inner.spec.clone(),
            allowed_tools: self.inner.allowed_tools.clone(),
            timeout: self.inner.timeout,
            isolation,
            limits,
            threaded,
        });
        register(&inner);
        Self { inner }
    }
}

impl fmt::Debug for ProgrammaticToolCaller {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProgrammaticToolCaller")
            .field("name", &self.inner.name)
            .field("allowed_tools", &self.inner.allowed_tools)
            .field("timeout", &self.inner.timeout)
            .field("isolation", &self.inner.isolation)
            .finish_non_exhaustive()
    }
}

impl Tool for ProgrammaticToolCaller {
    fn name(&self) -> &str {
        &self.inner.name
    }

    fn description(&self) -> &str {
        &self.inner.spec.description
    }

    fn tool_spec(&self) -> ToolSpec {
        self.inner.spec.clone()
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let inner = self.inner.clone();
        ToolStream::from_future(async move {
            let tool_use_id = context.tool_use().tool_use_id.clone();
            let result = match inner.execute(&context).await {
                Ok(text) => ToolResultBlock::success(&tool_use_id, vec![ToolResultContent::text(text)]),
                Err(message) => {
                    ToolResultBlock::error(&tool_use_id, vec![ToolResultContent::text(format!("Error: {message}"))])
                }
            };
            ToolOutcome::from(result)
        })
    }
}

/// How a run ended early.
enum Stop {
    Cancelled,
    TimedOut,
    Failed(String),
}

/// Where one run's interpreter runs, resolved from [`Isolation`] when the run starts.
enum Engine {
    InProcess,
    Worker { path: PathBuf, explicit: bool },
}

static WARNED_IN_PROCESS: AtomicBool = AtomicBool::new(false);

fn warn_in_process(reason: &str) {
    if !WARNED_IN_PROCESS.swap(true, Ordering::Relaxed) {
        tracing::warn!(
            "reason=<{reason}> | programmatic_tool_caller runs the interpreter in-process with no crash isolation and no cap on its total memory, install the worker with cargo install monty-runtime --version {MONTY_WORKER_VERSION} --locked or set {MONTY_WORKER_ENV}"
        );
    }
}

/// Where [`Isolation::Auto`] looks for a worker: the process `PATH` and the running executable.
struct WorkerSearch<'a> {
    path: Option<&'a std::ffi::OsStr>,
    exe: Option<&'a Path>,
}

/// How many ancestor directories of the executable are searched for a cargo workspace.
const WORKSPACE_SEARCH_DEPTH: usize = 6;

fn worker_binary_name() -> String {
    format!("monty{}", std::env::consts::EXE_SUFFIX)
}

/// The `monty` binary on `PATH`.
fn worker_on_path(path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let binary = worker_binary_name();
    std::env::split_paths(path?)
        .map(|dir| dir.join(&binary))
        .find(|candidate| candidate.is_file())
}

/// A `target/debug` (preferred) or `target/release` `monty` build in the nearest cargo workspace
/// above the executable that has one.
fn worker_in_workspace(exe: Option<&Path>) -> Option<PathBuf> {
    let binary = worker_binary_name();
    exe?.ancestors()
        .skip(1)
        .take(WORKSPACE_SEARCH_DEPTH)
        .filter(|dir| dir.join("Cargo.toml").is_file())
        .flat_map(|dir| ["debug", "release"].map(|profile| dir.join("target").join(profile).join(&binary)))
        .find(|candidate| candidate.is_file())
}

impl Isolation {
    fn engine(&self, env: &Env, search: &WorkerSearch<'_>) -> Engine {
        match self {
            Self::InProcess => Engine::InProcess,
            Self::Subprocess(path) => Engine::Worker {
                path: path.clone(),
                explicit: true,
            },
            Self::Auto => auto_engine(env, search),
        }
    }
}

fn auto_engine(env: &Env, search: &WorkerSearch<'_>) -> Engine {
    if let Some(named) = env.get(MONTY_WORKER_ENV).filter(|named| !named.is_empty()) {
        let path = PathBuf::from(named);
        if path.is_file() {
            return Engine::Worker { path, explicit: true };
        }
        tracing::debug!(
            "{MONTY_WORKER_ENV}=<{}> | no file at the named monty worker",
            path.display()
        );
    }
    let found = worker_on_path(search.path).or_else(|| worker_in_workspace(search.exe));
    match found {
        Some(path) => Engine::Worker { path, explicit: false },
        None => Engine::InProcess,
    }
}

impl Inner {
    /// Runs the code; `Ok` is the printed output, `Err` the error message.
    async fn execute(&self, context: &ToolContext) -> Result<String, String> {
        let Some(code) = context.tool_use().input.get("code").and_then(JsonValue::as_str) else {
            return Err("Invalid input: expected string for \"code\".".to_owned());
        };
        let cancel = context.cancel_signal().clone();
        let output = Arc::new(Output::default());
        let host = Host {
            agent: context.agent().clone(),
            functions: Arc::new(self.functions(context.agent())),
            slots: Arc::new(Semaphore::new(MAX_CONCURRENT_TOOL_CALLS)),
            output: output.clone(),
            cancel: cancel.clone(),
            limits: self.limits,
        };
        let deadline = async {
            match self.timeout {
                Some(timeout) => tokio::time::sleep(timeout).await,
                None => futures::future::pending().await,
            }
        };
        let outcome = if cancel.is_cancelled() {
            Err(Stop::Cancelled)
        } else {
            tokio::select! {
                biased;
                () = cancel.cancelled() => Err(Stop::Cancelled),
                () = deadline => Err(Stop::TimedOut),
                outcome = self.drive(&host, code.to_owned()) => outcome,
            }
        };
        match outcome {
            Ok(()) => {
                let text = output.text();
                Ok(if text.is_empty() {
                    "(no output)".to_owned()
                } else {
                    text
                })
            }
            Err(Stop::Cancelled) => Err("Execution cancelled.".to_owned()),
            Err(Stop::TimedOut) => {
                let seconds = self.timeout.map_or(0.0, |timeout| timeout.as_secs_f64());
                Err(output.with_error(&format!("Execution error: timed out after {seconds} seconds.")))
            }
            Err(Stop::Failed(message)) => Err(message),
        }
    }

    /// Runs the code in a worker when one is available, else in this process.
    async fn drive(&self, host: &Host, code: String) -> Result<(), Stop> {
        let path = std::env::var_os("PATH");
        let exe = std::env::current_exe().ok();
        let search = WorkerSearch {
            path: path.as_deref(),
            exe: exe.as_deref(),
        };
        match self.isolation.engine(&Env::process(), &search) {
            Engine::InProcess => {
                if self.isolation == Isolation::Auto {
                    warn_in_process("no monty worker found");
                }
                in_process::drive(host, code, self.threaded).await
            }
            Engine::Worker { path, explicit } => self.drive_worker(host, code, &path, explicit).await,
        }
    }

    #[cfg(feature = "monty-pool")]
    async fn drive_worker(&self, host: &Host, code: String, path: &Path, explicit: bool) -> Result<(), Stop> {
        match worker::drive(host, &code, path).await {
            Err(worker::Failure::Unavailable(error)) if !explicit => {
                warn_in_process(&format!(
                    "the monty worker at {} did not start: {error}",
                    path.display()
                ));
                in_process::drive(host, code, self.threaded).await
            }
            Err(worker::Failure::Unavailable(error)) => Err(Stop::Failed(host.output.with_error(&format!(
                "Execution error: the monty worker at {} did not start: {error}",
                path.display()
            )))),
            Err(worker::Failure::Stopped(stop)) => Err(stop),
            Ok(()) => Ok(()),
        }
    }

    #[cfg(not(feature = "monty-pool"))]
    async fn drive_worker(&self, host: &Host, code: String, path: &Path, explicit: bool) -> Result<(), Stop> {
        if explicit {
            return Err(Stop::Failed(format!(
                "Execution error: running the interpreter in the monty worker at {} needs the strands-harness feature \"monty-pool\".",
                path.display()
            )));
        }
        warn_in_process("the strands-harness feature \"monty-pool\" is off");
        in_process::drive(host, code, self.threaded).await
    }

    /// The host functions by Python name, each naming its registry tool: every exposed tool,
    /// plus an alias for each tool whose name is not a valid identifier, with every
    /// non-identifier character replaced by `_`. An alias that would shadow a real tool name or
    /// another tool's alias is dropped rather than guessed.
    fn functions(&self, agent: &ToolAgent) -> HashMap<String, String> {
        let available: Vec<String> = agent
            .tool_registry()
            .list()
            .into_iter()
            .filter(|tool| !is_caller(tool.as_ref()))
            .map(|tool| tool.name().to_owned())
            .filter(|name| self.allowed_tools.as_ref().is_none_or(|allowed| allowed.contains(name)))
            .collect();
        let mut functions: HashMap<String, String> =
            available.iter().map(|name| (name.clone(), name.clone())).collect();
        let mut sorted = available.clone();
        sorted.sort();
        let mut aliases: BTreeMap<String, String> = BTreeMap::new();
        let mut ambiguous: HashSet<String> = HashSet::new();
        for name in sorted {
            if is_identifier(&name) {
                continue;
            }
            let alias: String = name
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
                .collect();
            if !is_identifier(&alias) || available.contains(&alias) {
                continue;
            }
            if aliases.contains_key(&alias) {
                ambiguous.insert(alias);
                continue;
            }
            aliases.insert(alias, name);
        }
        for alias in &ambiguous {
            aliases.remove(alias);
            tracing::warn!("alias=<{alias}> | multiple tools normalize to the alias, no alias injected");
        }
        functions.extend(aliases);
        functions
    }
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// What an inner call answers the code with: the value, or the exception it raises.
type CallResult = Result<MontyObject, MontyException>;

type Pending = FuturesUnordered<BoxFuture<'static, (u32, CallResult)>>;

/// What one run hands the code, whichever engine runs it: the tool functions, the concurrency
/// slots, the output and the cancel signal.
struct Host {
    agent: ToolAgent,
    functions: Arc<HashMap<String, String>>,
    slots: Arc<Semaphore>,
    output: Arc<Output>,
    cancel: CancelSignal,
    limits: Limits,
}

impl Host {
    /// One inner call through the agent's tool pipeline, holding a concurrency slot.
    fn call_future(&self, call_id: u32, tool_name: String, input: JsonValue) -> BoxFuture<'static, (u32, CallResult)> {
        let agent = self.agent.clone();
        let slots = self.slots.clone();
        let cancel = self.cancel.clone();
        async move {
            let _slot = slots.acquire_owned().await;
            // A cancelled run makes no further real tool calls behind the model's back.
            if cancel.is_cancelled() {
                return (call_id, Err(runtime_error(CANCELLED_CALL)));
            }
            let refused_name = tool_name.clone();
            let result = agent
                .call_tool_without_interrupts(&tool_name, input, move |error| approval_refusal(&refused_name, error))
                .await;
            (call_id, call_result(&tool_name, result))
        }
        .boxed()
    }

    /// Resolves a name the code reads: a tool function, or undefined.
    fn lookup(&self, name: &str) -> Option<MontyObject> {
        self.functions
            .contains_key(name)
            .then(|| MontyObject::function(name.to_owned(), None))
    }
}

/// The registry tool and input for a call, or the exception the code sees.
fn prepare_call(
    functions: &HashMap<String, String>,
    function: &str,
    args: &CallArgs,
) -> Result<(String, JsonValue), MontyException> {
    let Some(tool_name) = functions.get(function) else {
        return Err(MontyException::new(
            ExcType::NameError,
            Some(format!("name '{function}' is not defined")),
        ));
    };
    if args.args().next().is_some() {
        return Err(type_error(format!(
            "{function}() takes keyword arguments only, e.g. {function}(key=value)"
        )));
    }
    let mut input = serde_json::Map::new();
    for (key, value) in args.kwargs() {
        let value = to_json(value, 0).ok_or_else(|| {
            type_error(format!(
                "{function}() argument is nested more than {MAX_VALUE_DEPTH} levels deep"
            ))
        })?;
        input.insert(key.as_str().map_or_else(|| key.to_string(), str::to_owned), value);
    }
    Ok((tool_name.clone(), JsonValue::Object(input)))
}

fn type_error(message: String) -> MontyException {
    MontyException::new(ExcType::TypeError, Some(message))
}

fn runtime_error(message: impl Into<String>) -> MontyException {
    MontyException::new(ExcType::RuntimeError, Some(message.into()))
}

/// What the code receives for an inner call: the unwrapped result, or a `RuntimeError`.
fn call_result(tool_name: &str, result: Result<ToolResultBlock, RefusedCall>) -> CallResult {
    let result = match result {
        Ok(result) => result,
        Err(refused) => return Err(runtime_error(refusal(tool_name, &refused))),
    };
    if result.status == ToolResultStatus::Error {
        let text = extract_text(&result.content);
        let text = if text.is_empty() {
            "Unknown error".to_owned()
        } else {
            text
        };
        return Err(runtime_error(format!("Tool '{tool_name}' error: {text}")));
    }
    to_monty(&unwrap_result(&result), 0).ok_or_else(|| {
        runtime_error(format!(
            "Tool '{tool_name}' returned a result nested more than {MAX_VALUE_DEPTH} levels deep"
        ))
    })
}

/// What the code sees for an inner call that stopped for human input: the refusal
/// `AfterToolCallEvent` left for an approval a hook or intervention asked for, else the refusal of
/// an interrupt from middleware or the tool itself.
fn refusal(tool_name: &str, refused: &RefusedCall) -> String {
    let text = match &refused.result {
        Some(result) => extract_text(&result.content),
        None => String::new(),
    };
    let text = if !text.is_empty() {
        text
    } else if refused.result.is_some() {
        approval_refusal(tool_name, &refused.interrupts)
    } else {
        interrupt_refusal(tool_name, &refused.interrupts)
    };
    format!("Failed to execute tool '{tool_name}': {text}")
}

/// The refusal of an interrupt that middleware or the inner tool raised.
fn interrupt_refusal(tool_name: &str, error: &InterruptError) -> String {
    match error.interrupts.first() {
        Some(interrupt) if interrupt.source != InterruptSource::Tool => approval_refusal(tool_name, error),
        _ => NO_INNER_INTERRUPTS.to_owned(),
    }
}

/// The refusal of an approval an inner call needs, which the inner call's `AfterToolCallEvent`
/// sees as its error result.
fn approval_refusal(tool_name: &str, error: &InterruptError) -> String {
    let approval = match error
        .interrupts
        .first()
        .map(|interrupt| (&interrupt.reason, &interrupt.name))
    {
        Some((Some(JsonValue::String(reason)), _)) => reason.clone(),
        Some((Some(JsonValue::Null) | None, name)) => name.clone(),
        Some((Some(reason), _)) => reason.to_string(),
        None => "no reason given".to_owned(),
    };
    format!(
        "Tool '{tool_name}' needs approval ({approval}), which programmatic_tool_caller cannot prompt for; call it as a normal tool call instead."
    )
}

fn extract_text(content: &[ToolResultContent]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ToolResultContent::Text(text) => Some(text.text.clone()),
            ToolResultContent::Json(json) => Some(json.json.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The value the code receives for a tool result: a lone JSON block, or a lone
/// text block that is a JSON object or array, as data; otherwise the text blocks joined.
fn unwrap_result(result: &ToolResultBlock) -> JsonValue {
    if let [ToolResultContent::Json(json)] = result.content.as_slice() {
        return json.json.clone();
    }
    let text = extract_text(&result.content);
    if result.content.len() == 1
        && (text.starts_with('{') || text.starts_with('['))
        && let Ok(value) = serde_json::from_str(&text)
    {
        return value;
    }
    JsonValue::String(text)
}

/// `value` as a Python value, or `None` when it nests deeper than [`MAX_VALUE_DEPTH`].
fn to_monty(value: &JsonValue, depth: usize) -> Option<MontyObject> {
    if depth > MAX_VALUE_DEPTH {
        return None;
    }
    Some(match value {
        JsonValue::Null => MontyObject::none(),
        JsonValue::Bool(value) => MontyObject::bool(*value),
        JsonValue::Number(number) => number.as_i64().map_or_else(
            || MontyObject::float(number.as_f64().unwrap_or(f64::NAN)),
            MontyObject::int,
        ),
        JsonValue::String(text) => MontyObject::string(text.clone()),
        JsonValue::Array(items) => MontyObject::list(
            items
                .iter()
                .map(|item| to_monty(item, depth + 1))
                .collect::<Option<Vec<_>>>()?,
        ),
        JsonValue::Object(map) => MontyObject::dict(
            map.iter()
                .map(|(key, value)| Some((MontyObject::string(key.clone()), to_monty(value, depth + 1)?)))
                .collect::<Option<Vec<_>>>()?,
        ),
    })
}

/// A Python value as JSON, or `None` when it nests deeper than [`MAX_VALUE_DEPTH`].
fn to_json(value: ObjectRef<'_>, depth: usize) -> Option<JsonValue> {
    if depth > MAX_VALUE_DEPTH {
        return None;
    }
    let number = |value: Option<f64>| {
        value
            .and_then(serde_json::Number::from_f64)
            .map_or(JsonValue::Null, JsonValue::Number)
    };
    Some(match value.type_name() {
        "NoneType" => JsonValue::Null,
        "bool" => value.as_bool().map_or(JsonValue::Null, JsonValue::Bool),
        "int" => value.as_int().map_or_else(|| number(value.as_float()), JsonValue::from),
        "float" => number(value.as_float()),
        "str" => JsonValue::String(value.as_str().unwrap_or_default().to_owned()),
        "dict" if value.pairs().is_some() => JsonValue::Object(
            value
                .pairs()
                .into_iter()
                .flatten()
                .map(|(key, value)| {
                    let key = key.as_str().map_or_else(|| key.to_string(), str::to_owned);
                    Some((key, to_json(value, depth + 1)?))
                })
                .collect::<Option<_>>()?,
        ),
        _ => match value.items() {
            Some(items) => JsonValue::Array(
                items
                    .into_iter()
                    .map(|item| to_json(item, depth + 1))
                    .collect::<Option<_>>()?,
            ),
            None => JsonValue::String(value.to_string()),
        },
    })
}

/// Collects the code's `print()` output (`Output`), keeping one character past the cap so
/// [`cap`] still sees that it overflowed.
#[derive(Debug, Default)]
struct Output {
    buffer: Mutex<OutputBuffer>,
}

#[derive(Debug, Default)]
struct OutputBuffer {
    text: String,
    chars: usize,
}

impl Output {
    fn write(&self, text: &str) {
        let mut buffer = self.buffer.lock().unwrap_or_else(PoisonError::into_inner);
        let room = (MAX_OUTPUT_CHARS + 1).saturating_sub(buffer.chars);
        if room == 0 {
            return;
        }
        let kept: String = text.chars().take(room).collect();
        buffer.chars += kept.chars().count();
        buffer.text.push_str(&kept);
    }

    fn raw(&self) -> String {
        self.buffer.lock().unwrap_or_else(PoisonError::into_inner).text.clone()
    }

    fn text(&self) -> String {
        cap(&self.raw(), MAX_OUTPUT_CHARS)
    }

    /// The error message preceded by whatever the code printed before failing. Both share the
    /// cap: the error keeps at least half, the output the rest.
    fn with_error(&self, message: &str) -> String {
        let raw = self.raw();
        let raw_chars = raw.chars().count();
        let message_limit = MAX_OUTPUT_CHARS.saturating_sub(raw_chars).max(MAX_OUTPUT_CHARS / 2);
        let capped = cap(message, message_limit);
        let printed = cap(&raw, MAX_OUTPUT_CHARS - capped.chars().count().min(message_limit));
        if printed.is_empty() {
            capped
        } else {
            format!("{printed}\n\n{capped}")
        }
    }
}

/// The print callback for one interpreter step, writing into the run's shared [`Output`].
struct Printer(Arc<Output>);

impl PrintWriterCallback for Printer {
    fn stdout_write(&mut self, output: Cow<'_, str>) -> Result<(), MontyException> {
        self.0.write(&output);
        Ok(())
    }

    fn stdout_push(&mut self, end: char) -> Result<(), MontyException> {
        self.0.write(end.encode_utf8(&mut [0; 4]));
        Ok(())
    }
}

/// `raw` trimmed when it fits in `limit` characters, else its first `limit` characters trimmed
/// with a truncation marker.
fn cap(raw: &str, limit: usize) -> String {
    if raw.chars().count() <= limit {
        return raw.trim().to_owned();
    }
    let kept: String = raw.chars().take(limit).collect();
    format!("{}\n[output truncated at {limit} characters]", kept.trim())
}

#[cfg(test)]
mod tests;
