//! The interpreter isolation: code that nests data deeply, recurses, or exhausts a limit ends
//! with an error result and never takes the host down. Each case runs in-process and, with
//! `MONTY_BIN` naming a `monty` 1.5.0 binary, in a worker (`--ignored`).

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use strands::Tool;
use strands::tools::FunctionTool;
use strands::types::ToolResultStatus;

use super::super::{Isolation, LIMITS, ProgrammaticToolCaller, ProgrammaticToolCallerConfig, programmatic_tool_caller};
use super::{agent_with, run, text};

fn caller(isolation: Isolation) -> ProgrammaticToolCaller {
    programmatic_tool_caller(ProgrammaticToolCallerConfig::default()).with_limits(LIMITS, isolation, true)
}

fn worker() -> Isolation {
    let path = std::env::var_os(super::super::MONTY_WORKER_ENV)
        .expect("set MONTY_BIN to a monty 1.5.0 binary to run the worker cases");
    Isolation::Subprocess(PathBuf::from(path))
}

fn echo() -> Arc<dyn Tool> {
    Arc::new(
        FunctionTool::builder("echo", "Echoes its input.")
            .callback(|input, _| async move { Ok(input.to_string().into()) }),
    )
}

fn ignore() -> Arc<dyn Tool> {
    Arc::new(FunctionTool::builder("ign", "Ignores its input.").callback(|_, _| async { Ok("ok".into()) }))
}

fn deep() -> Arc<dyn Tool> {
    Arc::new(
        FunctionTool::builder("deep", "Returns deeply nested JSON.").callback(|_, _| async {
            let mut value = json!([]);
            for _ in 0..200 {
                value = json!([value]);
            }
            Ok(value)
        }),
    )
}

fn nested(depth: usize, then: &str) -> String {
    format!("x = []\nfor i in range({depth}):\n    x = [x]\nprint('built')\n{then}\n")
}

async fn rejects_a_deeply_nested_argument(isolation: Isolation) {
    for depth in [50_000, 300_000] {
        let mut agent = agent_with(caller(isolation.clone()), vec![echo()]);
        let result = run(&mut agent, &nested(depth, "r = await echo(a=x)\nprint(len(r))")).await;
        assert_eq!(result.status, ToolResultStatus::Error, "{}", text(&result));
        assert!(
            text(&result).starts_with("Error: built\n\nExecution error:"),
            "{}",
            text(&result)
        );
        assert!(text(&result).contains("TypeError"), "{}", text(&result));
    }
}

async fn rejects_a_deeply_nested_argument_the_tool_would_ignore(isolation: Isolation) {
    let mut agent = agent_with(caller(isolation), vec![ignore()]);
    let code = nested(
        50_000,
        "try:\n    await ign(a=x)\nexcept TypeError as e:\n    print('caught', e)",
    );
    let result = run(&mut agent, &code).await;
    assert_eq!(
        text(&result),
        "built\ncaught ign() argument is nested more than 128 levels deep"
    );
}

async fn survives_the_repr_of_a_deeply_nested_list(isolation: Isolation) {
    for (depth, then) in [(50_000, "print(len(repr(x)))"), (300_000, "print(x)")] {
        let mut agent = agent_with(caller(isolation.clone()), vec![echo()]);
        let result = run(&mut agent, &nested(depth, then)).await;
        assert!(
            text(&result).starts_with("built") || text(&result).starts_with("Error: built"),
            "{}",
            text(&result)
        );
    }
}

async fn stops_unbounded_recursion(isolation: Isolation) {
    let mut agent = agent_with(caller(isolation), vec![echo()]);
    let result = run(&mut agent, "def f(n):\n    return f(n + 1)\nf(0)").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("RecursionError"), "{}", text(&result));
}

async fn enforces_the_suspension_limit(isolation: Isolation) {
    let mut agent = agent_with(caller(isolation), vec![echo()]);
    let code = "n = 0\nwhile n < 3000:\n    try:\n        await echo(a=1)\n    except Exception as e:\n        pass\n    n += 1\nprint('survived', n)";
    let result = run(&mut agent, code).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(
        text(&result).contains("suspension limit 1000 exceeded"),
        "{}",
        text(&result)
    );
    assert!(!text(&result).contains("survived"));
}

async fn rejects_a_deeply_nested_tool_result(isolation: Isolation) {
    let mut agent = agent_with(caller(isolation), vec![deep()]);
    let result = run(
        &mut agent,
        "try:\n    await deep()\nexcept RuntimeError as e:\n    print(e)",
    )
    .await;
    assert_eq!(
        text(&result),
        "Tool 'deep' returned a result nested more than 128 levels deep"
    );
}

async fn runs_tool_calls_and_sleeps(isolation: Isolation) {
    let mut agent = agent_with(caller(isolation), vec![echo()]);
    let code = "import asyncio\nrs = await asyncio.gather(echo(a=1), echo(a=2))\nawait asyncio.sleep(0.01)\nprint(rs[0]['a'] + rs[1]['a'])";
    let result = run(&mut agent, code).await;
    assert_eq!(text(&result), "3");
}

async fn reports_syntax_and_runtime_errors(isolation: Isolation) {
    let mut agent = agent_with(caller(isolation.clone()), vec![echo()]);
    let result = run(&mut agent, "def broken(:\n    pass").await;
    assert!(text(&result).starts_with("Error: Syntax error:"), "{}", text(&result));
    let result = run(&mut agent, "print('step 1')\nraise ValueError('late')").await;
    assert!(
        text(&result).starts_with("Error: step 1\n\nExecution error:\nTraceback"),
        "{}",
        text(&result)
    );
    let result = run(&mut agent, "await echo(1)").await;
    assert!(
        text(&result).contains("echo() takes keyword arguments only"),
        "{}",
        text(&result)
    );
}

macro_rules! on_both_engines {
    ($($case:ident),* $(,)?) => {$(
        mod $case {
            #[tokio::test]
            async fn in_process() {
                super::$case(super::Isolation::InProcess).await;
            }

            #[tokio::test]
            #[ignore = "needs MONTY_BIN naming a monty 1.5.0 binary"]
            async fn worker() {
                super::$case(super::worker()).await;
            }
        }
    )*};
}

on_both_engines!(
    rejects_a_deeply_nested_argument,
    rejects_a_deeply_nested_argument_the_tool_would_ignore,
    survives_the_repr_of_a_deeply_nested_list,
    stops_unbounded_recursion,
    enforces_the_suspension_limit,
    rejects_a_deeply_nested_tool_result,
    runs_tool_calls_and_sleeps,
    reports_syntax_and_runtime_errors,
);

/// In a worker the memory limit caps the process total, not just each allocation.
#[tokio::test]
#[ignore = "needs MONTY_BIN naming a monty 1.5.0 binary"]
async fn caps_the_total_memory_of_a_worker() {
    let mut agent = agent_with(caller(worker()), vec![echo()]);
    let code = "xs = []\nfor i in range(5):\n    xs.append(str(i) * (100 * 2**20))\nprint(len(xs))";
    let result = run(&mut agent, code).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("MemoryError"), "{}", text(&result));
}

/// A worker that cannot start fails the run when it was named explicitly.
#[cfg(feature = "monty-pool")]
#[tokio::test]
async fn fails_the_run_when_a_named_worker_cannot_start() {
    let missing = Isolation::Subprocess(PathBuf::from("/nonexistent/monty"));
    let mut agent = agent_with(caller(missing), vec![echo()]);
    let result = run(&mut agent, "print(1)").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(
        text(&result).starts_with("Error: Execution error: the monty worker at /nonexistent/monty did not start"),
        "{}",
        text(&result)
    );
}

#[cfg(not(feature = "monty-pool"))]
#[tokio::test]
async fn names_the_feature_a_named_worker_needs() {
    let mut agent = agent_with(caller(Isolation::Subprocess(PathBuf::from("/opt/monty"))), vec![echo()]);
    let result = run(&mut agent, "print(1)").await;
    assert_eq!(
        text(&result),
        "Error: Execution error: running the interpreter in the monty worker at /opt/monty needs the strands-harness feature \"monty-pool\"."
    );
}

fn worker_file(dir: &std::path::Path) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let binary = dir.join(format!("monty{}", std::env::consts::EXE_SUFFIX));
    std::fs::write(&binary, "").unwrap();
    binary
}

fn engine(
    isolation: &Isolation,
    vars: &[(&str, &str)],
    path: Option<&std::ffi::OsStr>,
    exe: Option<&std::path::Path>,
) -> super::super::Engine {
    let env = crate::test_support::env(vars);
    isolation.engine(&env, &super::super::WorkerSearch { path, exe })
}

fn worker_path(engine: super::super::Engine) -> Option<(PathBuf, bool)> {
    match engine {
        super::super::Engine::Worker { path, explicit } => Some((path, explicit)),
        super::super::Engine::InProcess => None,
    }
}

#[test]
fn resolves_auto_from_the_environment_then_the_path_then_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let named = worker_file(&dir.path().join("named"));
    let on_path = worker_file(&dir.path().join("bin"));
    let path = std::env::join_paths([dir.path().join("bin")]).unwrap();
    let workspace = dir.path().join("ws");
    std::fs::create_dir_all(workspace.join("target/debug/deps")).unwrap();
    std::fs::write(workspace.join("Cargo.toml"), "").unwrap();
    let built = worker_file(&workspace.join("target/debug"));
    let exe = workspace.join("target/debug/deps/app");
    let named_var = [(super::super::MONTY_WORKER_ENV, named.to_str().unwrap())];
    let missing_var = [(super::super::MONTY_WORKER_ENV, "/nonexistent/monty")];

    let auto = |vars: &[(&str, &str)], path: Option<&std::ffi::OsStr>| {
        worker_path(engine(&Isolation::Auto, vars, path, Some(&exe)))
    };
    assert_eq!(auto(&named_var, Some(&path)), Some((named.clone(), true)));
    assert_eq!(auto(&missing_var, Some(&path)), Some((on_path.clone(), false)));
    assert_eq!(auto(&[], Some(&path)), Some((on_path, false)));
    assert_eq!(auto(&[], None), Some((built.clone(), false)));
    assert_eq!(
        auto(&[(super::super::MONTY_WORKER_ENV, "")], None),
        Some((built, false))
    );
    assert_eq!(worker_path(engine(&Isolation::Auto, &[], None, None)), None);
    assert_eq!(
        worker_path(engine(&Isolation::InProcess, &named_var, Some(&path), Some(&exe))),
        None
    );
}

#[test]
fn prefers_a_debug_workspace_build_and_falls_back_to_release() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("Cargo.toml"), "").unwrap();
    let exe = dir.path().join("target/release/app");
    let release = worker_file(&dir.path().join("target/release"));
    assert_eq!(
        worker_path(engine(&Isolation::Auto, &[], None, Some(&exe))),
        Some((release, false))
    );
    let debug = worker_file(&dir.path().join("target/debug"));
    assert_eq!(
        worker_path(engine(&Isolation::Auto, &[], None, Some(&exe))),
        Some((debug, false))
    );
}

#[test]
fn skips_a_workspace_without_a_worker_build() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("Cargo.toml"), "").unwrap();
    let exe = dir.path().join("target/debug/app");
    assert_eq!(worker_path(engine(&Isolation::Auto, &[], None, Some(&exe))), None);
}
