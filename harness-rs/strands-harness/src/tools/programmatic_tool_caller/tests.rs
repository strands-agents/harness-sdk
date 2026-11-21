//! The MCP cases run an in-process `rmcp` server over an in-memory duplex stream instead of a
//! stdio server.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::json;
use strands::agent::DirectToolCallOptions;
use strands::hooks::{AfterToolCallEvent, BeforeToolCallEvent};
use strands::interventions::{InterventionAction, InterventionHandler, InterventionResult, OnError};
use strands::testing::{MockModel, MockTurn, tool_context};
use strands::tools::{FunctionTool, ToolError};
use strands::types::{
    ContentBlock, JsonValue, ToolResultBlock, ToolResultContent, ToolResultStatus, ToolUse, ToolUseBlock,
};
use strands::{Agent, CancelHandle, CancelOptions, InvokeOptions, StopReason, Tool, ToolStreamItem};

use super::{
    DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION, Isolation, LIMITS, Limits, MAX_CONCURRENT_TOOL_CALLS,
    MAX_OUTPUT_CHARS, MakeProgrammaticToolCallerOptions, Output, ProgrammaticToolCaller, ProgrammaticToolCallerConfig,
    make_programmatic_tool_caller, programmatic_tool_caller,
};

mod isolation;

/// The default caller, in-process, so the suite does not depend on a worker binary on `PATH`.
fn default_caller() -> ProgrammaticToolCaller {
    programmatic_tool_caller(ProgrammaticToolCallerConfig::default()).with_limits(LIMITS, Isolation::InProcess, true)
}

/// A caller whose steps run inline, so paused-clock tests see no thread time.
fn inline(caller: ProgrammaticToolCaller) -> ProgrammaticToolCaller {
    caller.with_limits(LIMITS, Isolation::InProcess, false)
}

fn evaluate(expression: &str) -> String {
    let parts: Vec<&str> = expression.split_whitespace().collect();
    let number = |text: &str| text.parse::<i64>().unwrap();
    match parts.as_slice() {
        [value] => number(value).to_string(),
        [a, "+", b] => (number(a) + number(b)).to_string(),
        [a, "*", b] => (number(a) * number(b)).to_string(),
        _ => panic!("unsupported expression {expression}"),
    }
}

fn calculator() -> Arc<dyn Tool> {
    Arc::new(
        FunctionTool::builder("calculator", "Evaluate a simple arithmetic expression.")
            .input_schema(json!({"type": "object", "properties": {"expression": {"type": "string"}}}))
            .callback(|input, _| async move { Ok(evaluate(input["expression"].as_str().unwrap_or_default()).into()) }),
    )
}

fn boom() -> Arc<dyn Tool> {
    Arc::new(FunctionTool::builder("boom", "Always fails.").callback(|_, _| async { Err(ToolError::msg("kaboom")) }))
}

fn info() -> Arc<dyn Tool> {
    Arc::new(
        FunctionTool::builder("info", "Returns structured data.")
            .callback(|_, _| async { Ok(json!({"name": "demo", "tags": ["a", "b"]})) }),
    )
}

fn fetch_url() -> Arc<dyn Tool> {
    Arc::new(
        FunctionTool::builder("fetch-url", "A tool whose name is not a valid identifier.").callback(
            |input, _| async move { Ok(format!("dash:{}", input["value"].as_str().unwrap_or_default()).into()) },
        ),
    )
}

fn slow_value(delay: Duration, active: Arc<AtomicUsize>, peak: Arc<AtomicUsize>) -> Arc<dyn Tool> {
    Arc::new(
        FunctionTool::builder("slow", "Sleep, then return the value.").callback(move |input, _| {
            let active = active.clone();
            let peak = peak.clone();
            async move {
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(delay).await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(input["value"].to_string().into())
            }
        }),
    )
}

fn agent_with(caller: impl Tool, tools: Vec<Arc<dyn Tool>>) -> Agent {
    let mut all: Vec<Arc<dyn Tool>> = vec![Arc::new(caller)];
    all.extend(tools);
    Agent::builder()
        .model(MockModel::new())
        .tools(all)
        .printer(false)
        .build()
        .unwrap()
}

async fn run_named(agent: &mut Agent, code: &str, name: &str) -> ToolResultBlock {
    let options = DirectToolCallOptions {
        record_direct_tool_call: Some(false),
    };
    agent
        .tool(name)
        .invoke_with(json!({"code": code}), options)
        .await
        .unwrap()
}

async fn run(agent: &mut Agent, code: &str) -> ToolResultBlock {
    run_named(agent, code, "programmatic_tool_caller").await
}

fn text(result: &ToolResultBlock) -> String {
    result
        .content
        .iter()
        .map(|block| match block {
            ToolResultContent::Text(text) => text.text.clone(),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn stream_result(tool: &dyn Tool, context: strands::ToolContext) -> ToolResultBlock {
    use futures::StreamExt;
    let mut stream = tool.stream(context);
    while let Some(item) = stream.next().await {
        if let ToolStreamItem::Outcome(outcome) = item {
            return outcome.result().unwrap().clone();
        }
    }
    panic!("no outcome")
}

#[tokio::test]
async fn runs_a_single_tool_call() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, r#"print(await calculator(expression="10 * 2"))"#).await;
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(text(&result), "20");
}

#[tokio::test]
async fn loops_over_tool_calls() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(
        &mut agent,
        "for i in range(3):\n    print(await calculator(expression=f'{i} + 10'))",
    )
    .await;
    assert_eq!(text(&result), "10\n11\n12");
}

#[tokio::test(start_paused = true)]
async fn runs_tool_calls_concurrently_with_asyncio_gather() {
    let slow = slow_value(Duration::from_millis(300), Arc::default(), Arc::default());
    let mut agent = agent_with(inline(default_caller()), vec![slow]);
    let start = tokio::time::Instant::now();
    let result = run(
        &mut agent,
        "import asyncio\nprint(await asyncio.gather(*[slow(value=i) for i in range(4)]))",
    )
    .await;
    assert_eq!(text(&result), "['0', '1', '2', '3']");
    assert!(start.elapsed() < Duration::from_millis(1100));
}

#[tokio::test(start_paused = true)]
async fn bounds_how_many_inner_calls_run_at_once() {
    let peak = Arc::new(AtomicUsize::new(0));
    let slow = slow_value(Duration::from_millis(50), Arc::default(), peak.clone());
    let mut agent = agent_with(inline(default_caller()), vec![slow]);
    let count = MAX_CONCURRENT_TOOL_CALLS * 3;
    let code = format!("import asyncio\nprint(len(await asyncio.gather(*[slow(value=i) for i in range({count})])))");
    let result = run(&mut agent, &code).await;
    assert_eq!(text(&result), count.to_string());
    let peak = peak.load(Ordering::SeqCst);
    assert!(peak > 1);
    assert!(peak <= MAX_CONCURRENT_TOOL_CALLS);
}

#[tokio::test]
async fn returns_only_printed_output() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(
        &mut agent,
        "x = await calculator(expression=\"6 * 7\")\nprint(\"done\")",
    )
    .await;
    assert_eq!(text(&result), "done");
}

#[tokio::test]
async fn reports_no_output_for_code_that_prints_nothing() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, "# nothing here").await;
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(text(&result), "(no output)");
}

#[tokio::test]
async fn rejects_positional_arguments_with_a_hint() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, "print(await calculator(\"1 + 1\"))").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("keyword arguments only"));
    assert!(text(&result).contains("calculator(key=value)"));
}

#[tokio::test]
async fn parses_a_json_text_result_and_leaves_other_text_alone() {
    let json_text: Arc<dyn Tool> = Arc::new(
        FunctionTool::builder("json_text", "Returns JSON as text.")
            .callback(|_, _| async { Ok(r#"{"a": [1, 2]}"#.into()) }),
    );
    let mut agent = agent_with(default_caller(), vec![json_text, calculator()]);
    let code = "r = await json_text()\nprint(type(r).__name__, r[\"a\"][1])\ns = await calculator(expression=\"1 + 1\")\nprint(type(s).__name__, s)";
    assert_eq!(text(&run(&mut agent, code).await), "dict 2\nstr 2");
}

#[tokio::test]
async fn hands_structured_results_to_the_code_as_data() {
    let mut agent = agent_with(default_caller(), vec![info()]);
    let result = run(&mut agent, "r = await info()\nprint(type(r).__name__, r[\"tags\"][1])").await;
    assert_eq!(text(&result), "dict b");
}

#[tokio::test]
async fn keeps_the_host_unreachable() {
    let cases = [
        ("import os\nprint(os.listdir('/'))", "PermissionError"),
        ("print(open('/etc/passwd').read())", "PermissionError"),
        ("import subprocess", "ModuleNotFoundError"),
        ("import socket", "ModuleNotFoundError"),
        ("print(().__class__.__bases__)", "AttributeError"),
        ("print(__builtins__)", "NameError"),
    ];
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    for (code, expected) in cases {
        let result = run(&mut agent, code).await;
        assert_eq!(result.status, ToolResultStatus::Error, "{code}");
        assert!(text(&result).contains(expected), "{code}: {}", text(&result));
    }
}

#[tokio::test]
async fn bounds_a_synchronous_busy_loop_via_the_vm_duration_limit() {
    let limits = Limits {
        max_duration: Duration::from_millis(300),
        ..LIMITS
    };
    let mut agent = agent_with(
        default_caller().with_limits(limits, Isolation::InProcess, true),
        vec![calculator()],
    );
    let start = std::time::Instant::now();
    let result = run(&mut agent, "while True:\n    pass").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("TimeoutError"), "{}", text(&result));
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn enforces_the_memory_limit() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, "x = 'a' * 10**9\nprint(len(x))").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("MemoryError"), "{}", text(&result));
}

#[tokio::test]
async fn surfaces_a_tool_error_as_a_catchable_runtime_error() {
    let mut agent = agent_with(default_caller(), vec![boom()]);
    let result = run(
        &mut agent,
        "try:\n    await boom()\nexcept RuntimeError as e:\n    print('caught:', e)",
    )
    .await;
    assert_eq!(result.status, ToolResultStatus::Success);
    let text = text(&result);
    assert!(text.starts_with("caught: Tool 'boom' error: "), "{text}");
    assert!(text.contains("kaboom"));
}

#[tokio::test]
async fn keeps_output_printed_before_an_error() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, "print('step 1')\nraise ValueError('late')").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    let text = text(&result);
    assert!(
        text.starts_with("Error: step 1\n\nExecution error:\nTraceback"),
        "{text}"
    );
    assert!(text.contains("ValueError: late"));
}

#[tokio::test]
async fn reports_a_syntax_error() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, "def broken(:\n    pass").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("Syntax error:"));
    assert!(text(&result).contains("SyntaxError"), "{}", text(&result));
}

#[tokio::test]
async fn reports_a_runtime_error_with_the_user_line_number() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, "x = 1\ny = 2\nz = {}['missing']").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("line 3"));
    assert!(text(&result).contains("KeyError"));
}

#[tokio::test]
async fn does_not_expose_itself_to_the_code() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, "programmatic_tool_caller").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("NameError"));
}

#[tokio::test]
async fn filters_exposed_tools_with_allowed_tools() {
    let restricted = make_programmatic_tool_caller(
        MakeProgrammaticToolCallerOptions::builder()
            .allowed_tools(vec!["calculator".to_owned()])
            .name("run_code")
            .isolation(Isolation::InProcess)
            .build(),
    );
    let mut agent = agent_with(restricted, vec![calculator(), boom()]);
    let result = run_named(&mut agent, "print(await calculator(expression=\"1 + 1\"))", "run_code").await;
    assert_eq!(text(&result), "2");
    let result = run_named(&mut agent, "await boom()", "run_code").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("NameError"));
}

#[test]
fn states_the_contract_in_the_description() {
    for phrase in ["await", "print()", "RuntimeError", "keyword arguments", "fetch_url"] {
        assert!(
            DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION.contains(phrase),
            "{phrase}"
        );
    }
}

#[tokio::test]
async fn never_exposes_another_programmatic_tool_caller() {
    let other = make_programmatic_tool_caller(
        MakeProgrammaticToolCallerOptions::builder()
            .name("run_code")
            .allowed_tools(vec!["programmatic_tool_caller".to_owned(), "calculator".to_owned()])
            .isolation(Isolation::InProcess)
            .build(),
    );
    let mut agent = agent_with(default_caller(), vec![Arc::new(other), calculator()]);
    for (caller, target) in [
        ("run_code", "programmatic_tool_caller"),
        ("programmatic_tool_caller", "run_code"),
    ] {
        let result = run_named(&mut agent, &format!("await {target}(code='print(1)')"), caller).await;
        assert_eq!(result.status, ToolResultStatus::Error);
        assert!(text(&result).contains("NameError"), "{}", text(&result));
    }
    let result = run_named(&mut agent, "print(await calculator(expression=\"1 + 1\"))", "run_code").await;
    assert_eq!(text(&result), "2");
}

#[tokio::test]
async fn calls_a_hyphenated_tool_via_its_identifier_alias() {
    let mut agent = agent_with(default_caller(), vec![fetch_url()]);
    assert_eq!(
        text(&run(&mut agent, "print(await fetch_url(value=\"x\"))").await),
        "dash:x"
    );
}

fn assert_truncated(text: &str) {
    let marker = text.rsplit_once("\n[output truncated at ").map(|(_, rest)| rest);
    let digits = marker.and_then(|rest| rest.strip_suffix(" characters]"));
    assert!(
        digits.is_some_and(|digits| digits.parse::<usize>().is_ok()),
        "{}",
        &text[text.len().saturating_sub(80)..]
    );
}

#[tokio::test]
async fn truncates_an_error_message_that_is_too_long() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, "print('before')\nraise ValueError('x' * 600000)").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    let text = text(&result);
    assert!(text.starts_with("Error: before\n\nExecution error:"));
    assert_truncated(&text);
    assert!(text.chars().count() < 200_100);
}

#[tokio::test]
async fn shares_the_cap_between_printed_output_and_the_error() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, "print('p' * 210000)\nraise ValueError('e' * 210000)").await;
    let text = text(&result);
    assert!(text.starts_with("Error: ppp"));
    assert!(text.contains("ValueError: eee"));
    assert!(text.chars().count() < 200_100);
}

#[tokio::test]
async fn truncates_a_syntax_error_that_is_too_long() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let result = run(&mut agent, &format!("x = '{}' +", "A".repeat(400_000))).await;
    let text = text(&result);
    assert!(
        text.starts_with("Error: Syntax error:"),
        "{}",
        &text[..80.min(text.len())]
    );
    assert!(text.chars().count() < 200_100);
}

#[test]
fn does_not_buffer_an_oversized_print_in_full() {
    let output = Output::default();
    output.write(&"a".repeat(MAX_OUTPUT_CHARS * 5));
    output.write(&"b".repeat(100));
    assert!(output.raw().chars().count() <= 200_001);
    assert!(output.text().ends_with("[output truncated at 200000 characters]"));
}

#[tokio::test]
async fn truncates_output_that_is_too_long() {
    let mut agent = agent_with(default_caller(), vec![calculator()]);
    let text = text(&run(&mut agent, "print('x' * 200500)").await);
    assert!(text.ends_with("[output truncated at 200000 characters]"));
    assert!(text.chars().count() < 200_100);
}

#[tokio::test(start_paused = true)]
async fn enforces_the_timeout() {
    let slow: Arc<dyn Tool> = Arc::new(
        FunctionTool::builder("slow", "Block longer than the timeout.").callback(|_, _| async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok("late".into())
        }),
    );
    let quick = make_programmatic_tool_caller(
        MakeProgrammaticToolCallerOptions::builder()
            .name("quick")
            .timeout(Some(Duration::from_millis(300)))
            .isolation(Isolation::InProcess)
            .build(),
    );
    let mut agent = agent_with(inline(quick), vec![slow]);
    let result = run_named(&mut agent, "print('start')\nawait slow()", "quick").await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(
        text(&result),
        "Error: start\n\nExecution error: timed out after 0.3 seconds."
    );
}

#[tokio::test]
async fn honors_the_parent_cancel_signal() {
    let context = tool_context(ToolUse::new(
        "programmatic_tool_caller",
        "x",
        json!({"code": "await calculator(expression=\"1\")"}),
    ));
    context.agent().cancel(CancelOptions::default());
    let result = stream_result(&default_caller(), context).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(text(&result).contains("Execution cancelled."));
}

#[tokio::test(start_paused = true)]
async fn cancels_an_in_flight_run_and_makes_no_further_inner_tool_calls() {
    let calls = Arc::new(AtomicUsize::new(0));
    let cancel = CancelHandle::new();
    let counter = calls.clone();
    let trigger = cancel.clone();
    let bump: Arc<dyn Tool> = Arc::new(FunctionTool::builder("bump", "Records a call.").callback(move |_, _| {
        let counter = counter.clone();
        let trigger = trigger.clone();
        async move {
            if counter.fetch_add(1, Ordering::SeqCst) + 1 == 3 {
                trigger.cancel(CancelOptions::default());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok("ok".into())
        }
    }));
    let model = MockModel::new()
        .with_turn(MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(
            "programmatic_tool_caller",
            "ptc-1",
            json!({"code": "while True:\n    await bump()"}),
        ))]))
        .with_turn(MockTurn::text("done"));
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(inline(default_caller())), bump];
    let mut agent = Agent::builder()
        .model(model)
        .tools(tools)
        .printer(false)
        .build()
        .unwrap();
    let seen = Arc::new(Calls::default());
    let record = seen.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        if event.tool_use().name == "programmatic_tool_caller" {
            record.0.lock().unwrap().push(text(event.result()));
        }
    });
    let start = tokio::time::Instant::now();
    let options = InvokeOptions {
        cancel_signal: Some(cancel.signal()),
        ..InvokeOptions::default()
    };
    let _ = agent.invoke_with("go", options).await;
    assert!(start.elapsed() < Duration::from_secs(2));
    let results = seen.take();
    assert_eq!(results.len(), 1);
    assert!(results[0].contains("Execution cancelled."), "{results:?}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn parses_the_portable_config() {
    let config: ProgrammaticToolCallerConfig =
        serde_json::from_value(json!({"allowedTools": ["read"], "timeout": 30})).unwrap();
    assert_eq!(config.allowed_tools, Some(vec!["read".to_owned()]));
    assert_eq!(config.timeout, Some(Some(30.0)));
    let unbounded: ProgrammaticToolCallerConfig = serde_json::from_value(json!({"timeout": null})).unwrap();
    assert_eq!(unbounded.timeout, Some(None));
    assert_eq!(serde_json::to_value(&unbounded).unwrap(), json!({"timeout": null}));
    assert_eq!(
        serde_json::to_value(ProgrammaticToolCallerConfig::default()).unwrap(),
        json!({})
    );
    assert!(serde_json::from_value::<ProgrammaticToolCallerConfig>(json!({"bogus": 1})).is_err());
    assert_eq!(
        programmatic_tool_caller(unbounded).inner.timeout,
        None,
        "null timeout disables the bound"
    );
    assert_eq!(default_caller().inner.timeout, Some(Duration::from_secs(900)));
    assert_eq!(
        programmatic_tool_caller(config).inner.timeout,
        Some(Duration::from_secs(30))
    );
}

#[test]
fn matches_the_ts_tool_spec() {
    let spec = serde_json::to_value(default_caller().tool_spec()).unwrap();
    let expected = json!({
        "name": "programmatic_tool_caller",
        "description": DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "Python code to execute. Use `await tool_name(...)` to call tools."}},
            "required": ["code"],
            "additionalProperties": false
        }
    });
    assert_eq!(spec, expected);
    assert_eq!(
        serde_json::to_string(&spec["inputSchema"]).unwrap(),
        r#"{"type":"object","properties":{"code":{"type":"string","description":"Python code to execute. Use `await tool_name(...)` to call tools."}},"required":["code"],"additionalProperties":false}"#
    );
}

// --- inner calls run through the agent hooks ------------------------------------------------

#[derive(Default)]
struct Calls(std::sync::Mutex<Vec<String>>);

impl Calls {
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

fn shell_like(calls: Arc<Calls>) -> Arc<dyn Tool> {
    Arc::new(
        FunctionTool::builder("shell_like", "Records that it ran.").callback(move |input, _| {
            let calls = calls.clone();
            async move {
                let command = input["command"].as_str().unwrap_or_default().to_owned();
                calls.0.lock().unwrap().push(command.clone());
                Ok(format!("ran:{command}").into())
            }
        }),
    )
}

struct Deny;

#[strands::async_trait]
impl InterventionHandler for Deny {
    fn name(&self) -> &str {
        "deny-shell"
    }

    async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        Ok(if event.tool_use().name == "shell_like" {
            InterventionAction::deny("shell is off")
        } else {
            InterventionAction::proceed()
        })
    }
}

struct Confirm {
    response: Option<JsonValue>,
}

#[strands::async_trait]
impl InterventionHandler for Confirm {
    fn name(&self) -> &str {
        "ask"
    }

    fn on_error(&self) -> OnError {
        OnError::Proceed
    }

    async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        if event.tool_use().name != "shell_like" {
            return Ok(InterventionAction::proceed());
        }
        let mut confirm = strands::interventions::Confirm::new("Run shell?");
        if let Some(response) = &self.response {
            confirm = confirm.with_response(response.clone());
        }
        Ok(InterventionAction::Confirm(confirm))
    }
}

struct Rewrite;

#[strands::async_trait]
impl InterventionHandler for Rewrite {
    fn name(&self) -> &str {
        "rewrite"
    }

    async fn before_tool_call(&self, _event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        Ok(InterventionAction::transform(|event: &mut BeforeToolCallEvent| {
            event.tool_use_mut().input = json!({"command": "safe"});
        }))
    }
}

const GATED_CODE: &str =
    "try:\n    print(await shell_like(command='rm -rf /'))\nexcept RuntimeError as e:\n    print('ERR', e)";

fn gated_agent(calls: &Arc<Calls>, handler: impl InterventionHandler) -> Agent {
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(default_caller()), shell_like(calls.clone())];
    Agent::builder()
        .model(MockModel::new())
        .tools(tools)
        .interventions([handler])
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn deny_blocks_the_inner_call_and_the_tool_never_runs() {
    let calls = Arc::new(Calls::default());
    let mut agent = gated_agent(&calls, Deny);
    let result = run(&mut agent, GATED_CODE).await;
    assert_eq!(result.status, ToolResultStatus::Success);
    assert!(text(&result).contains("shell is off"), "{}", text(&result));
    assert!(calls.take().is_empty());
}

#[tokio::test]
async fn confirm_refuses_the_inner_call_no_prompt_possible_even_with_on_error_proceed() {
    let calls = Arc::new(Calls::default());
    let mut agent = gated_agent(&calls, Confirm { response: None });
    let result = run(&mut agent, GATED_CODE).await;
    assert!(text(&result).contains("approval"), "{}", text(&result));
    assert!(calls.take().is_empty());
}

#[tokio::test]
async fn transform_rewrites_the_inner_call_input() {
    let calls = Arc::new(Calls::default());
    let mut agent = gated_agent(&calls, Rewrite);
    let result = run(&mut agent, GATED_CODE).await;
    assert_eq!(text(&result), "ran:safe");
    assert_eq!(calls.take(), vec!["safe"]);
}

#[tokio::test]
async fn accepts_an_approval_the_handler_already_collected() {
    let calls = Arc::new(Calls::default());
    let mut agent = gated_agent(
        &calls,
        Confirm {
            response: Some(json!(true)),
        },
    );
    let result = run(&mut agent, GATED_CODE).await;
    assert_eq!(text(&result), "ran:rm -rf /");
    assert_eq!(calls.take(), vec!["rm -rf /"]);
}

#[tokio::test]
async fn fires_after_tool_call_for_a_denied_inner_call_with_the_error_result() {
    let calls = Arc::new(Calls::default());
    let mut agent = gated_agent(&calls, Deny);
    let seen = Arc::new(Calls::default());
    let record = seen.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        let status = match event.result().status {
            ToolResultStatus::Error => "error",
            _ => "success",
        };
        record
            .0
            .lock()
            .unwrap()
            .push(format!("{}:{status}", event.tool_use().name));
    });
    run(&mut agent, GATED_CODE).await;
    assert_eq!(seen.take(), vec!["shell_like:error"]);
}

#[tokio::test]
async fn fires_after_tool_call_for_a_refused_inner_approval_with_the_refusal() {
    let calls = Arc::new(Calls::default());
    let mut agent = gated_agent(&calls, Confirm { response: None });
    let seen = Arc::new(Calls::default());
    let record = seen.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        let refusal = event
            .result()
            .content
            .iter()
            .filter_map(|block| match block {
                ToolResultContent::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<String>();
        record.0.lock().unwrap().push(refusal);
        let mut result = event.result().clone();
        result.content = vec![ToolResultContent::text("not without a human")];
        event.set_result(result);
    });
    let result = run(&mut agent, GATED_CODE).await;
    assert_eq!(
        seen.take(),
        vec![
            "Tool 'shell_like' needs approval (Run shell?), which programmatic_tool_caller cannot prompt for; call it as a normal tool call instead."
        ]
    );
    assert_eq!(
        text(&result),
        "ERR Failed to execute tool 'shell_like': not without a human"
    );
    assert!(calls.take().is_empty());
}

#[tokio::test]
async fn plain_before_after_hooks_observe_inner_calls_and_can_replace_the_result() {
    let calls = Arc::new(Calls::default());
    let mut agent = agent_with(default_caller(), vec![shell_like(calls)]);
    let seen = Arc::new(Calls::default());
    let before = seen.clone();
    agent.add_hook(move |event: &mut BeforeToolCallEvent| {
        before
            .0
            .lock()
            .unwrap()
            .push(format!("before:{}", event.tool_use().name));
    });
    let after = seen.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        after.0.lock().unwrap().push(format!("after:{}", event.tool_use().name));
        let id = event.tool_use().tool_use_id.clone();
        event.set_result(ToolResultBlock::success(id, vec![ToolResultContent::text("replaced")]));
    });
    let result = run(&mut agent, "print(await shell_like(command='ls'))").await;
    assert_eq!(text(&result), "replaced");
    assert_eq!(seen.take(), vec!["before:shell_like", "after:shell_like"]);
}

/// Inside the agent loop an inner approval is refused like a direct call's: the outer call
/// completes without an interrupt, so nothing runs again.
#[tokio::test]
async fn an_inner_approval_completes_the_outer_call_in_the_agent_loop() {
    let calls = Arc::new(Calls::default());
    let notes = Arc::new(AtomicUsize::new(0));
    let counter = notes.clone();
    let note: Arc<dyn Tool> = Arc::new(
        FunctionTool::builder("write_note", "Side effect.").callback(move |_, _| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok("noted".into())
            }
        }),
    );
    let code = format!("print(await write_note(x=1))\n{GATED_CODE}");
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(default_caller()), shell_like(calls.clone()), note];
    let model = MockModel::new()
        .with_turn(MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(
            "programmatic_tool_caller",
            "ptc-1",
            json!({"code": code}),
        ))]))
        .with_turn(MockTurn::text("done"));
    let mut agent = Agent::builder()
        .model(model)
        .tools(tools)
        .interventions([Confirm { response: None }])
        .printer(false)
        .build()
        .unwrap();
    let seen = Arc::new(Calls::default());
    let record = seen.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        if event.tool_use().name == "programmatic_tool_caller" {
            record.0.lock().unwrap().push(text(event.result()));
        }
    });
    let result = agent.invoke("go").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert!(result.interrupts().is_empty());
    assert_eq!(
        seen.take(),
        vec![
            "noted\nERR Failed to execute tool 'shell_like': Tool 'shell_like' needs approval (Run shell?), which programmatic_tool_caller cannot prompt for; call it as a normal tool call instead."
        ]
    );
    assert_eq!(notes.load(Ordering::SeqCst), 1);
    assert!(calls.take().is_empty());
}

#[tokio::test]
async fn refuses_an_interrupt_raised_by_the_inner_tool_itself() {
    let asks: Arc<dyn Tool> = Arc::new(FunctionTool::builder("asks", "Asks a human.").callback(
        |_, context| async move {
            context.interrupt(strands::types::InterruptParams::new("approve"))?;
            Ok("approved".into())
        },
    ));
    let mut agent = agent_with(default_caller(), vec![asks]);
    let result = run(
        &mut agent,
        "try:\n    await asks()\nexcept RuntimeError as e:\n    print('ERR', e)",
    )
    .await;
    assert_eq!(
        text(&result),
        "ERR Failed to execute tool 'asks': Interrupts are not supported from programmatic_tool_caller."
    );
}

// --- programmatic_tool_caller over MCP ------------------------------------------------------

#[cfg(feature = "mcp")]
mod mcp {
    use std::sync::Arc;

    use rmcp::model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorData, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool as McpServerTool,
    };
    use rmcp::service::{RequestContext, RoleServer};
    use rmcp::{ServerHandler, ServiceExt};
    use serde_json::{Value, json};
    use strands::error::BoxError;
    use strands::mcp::{McpClient, McpClientConfig, McpTransport};
    use strands::{Agent, Tool};
    use tokio::io::DuplexStream;

    use super::{default_caller, run, text};
    use strands::types::ToolResultStatus;

    #[derive(Clone)]
    struct PtcServer;

    fn schema(properties: Value) -> Arc<rmcp::model::JsonObject> {
        let mut map = rmcp::model::JsonObject::new();
        map.insert("type".to_owned(), json!("object"));
        map.insert("properties".to_owned(), properties);
        Arc::new(map)
    }

    fn reply(text: String) -> CallToolResult {
        CallToolResult::success(vec![ContentBlock::text(text)])
    }

    impl ServerHandler for PtcServer {
        fn get_info(&self) -> ServerConfig {
            ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
        }

        async fn list_tools(
            &self,
            _request: Option<PaginatedRequestParams>,
            _context: RequestContext<RoleServer>,
        ) -> Result<ListToolsResult, ErrorData> {
            Ok(ListToolsResult::with_all_items(vec![
                McpServerTool::new(
                    "ptc_echo",
                    "Echoes the given text back",
                    schema(json!({"text": {"type": "string"}})),
                ),
                McpServerTool::new(
                    "ptc_add",
                    "Adds two integers",
                    schema(json!({"a": {"type": "number"}, "b": {"type": "number"}})),
                ),
                McpServerTool::new(
                    "ptc-dash",
                    "Tool whose name contains a hyphen",
                    schema(json!({"value": {"type": "string"}})),
                ),
                McpServerTool::new("ptc_boom", "Always raises", schema(json!({}))),
            ]))
        }

        async fn call_tool(
            &self,
            request: CallToolRequestParams,
            _context: RequestContext<RoleServer>,
        ) -> Result<CallToolResponse, ErrorData> {
            let args = request.arguments.unwrap_or_default();
            let string = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            let number = |key: &str| args.get(key).and_then(Value::as_i64).unwrap_or_default();
            let result = match &*request.name {
                "ptc_echo" => reply(format!("echo:{}", string("text"))),
                "ptc_add" => reply((number("a") + number("b")).to_string()),
                "ptc-dash" => reply(format!("dash:{}", string("value"))),
                _ => CallToolResult::error(vec![ContentBlock::text("mcp tool exploded")]),
            };
            Ok(result.into())
        }
    }

    async fn mcp_agent() -> (Agent, McpClient) {
        let transport = McpTransport::from_fn(|| async {
            let (client, server) = tokio::io::duplex(1 << 16);
            tokio::spawn(async move {
                if let Ok(running) = PtcServer.serve(server).await {
                    let _ = running.waiting().await;
                }
            });
            Ok::<DuplexStream, BoxError>(client)
        });
        let client = McpClient::new(McpClientConfig {
            transport: Some(transport),
            ..McpClientConfig::default()
        })
        .unwrap();
        let mut tools: Vec<Arc<dyn Tool>> = vec![Arc::new(default_caller())];
        for tool in client.list_tools().await.unwrap() {
            tools.push(Arc::new(tool));
        }
        let agent = Agent::builder()
            .model(strands::testing::MockModel::new())
            .tools(tools)
            .printer(false)
            .build()
            .unwrap();
        (agent, client)
    }

    #[tokio::test]
    async fn calls_an_mcp_tool() {
        let (mut agent, client) = mcp_agent().await;
        assert_eq!(
            text(&run(&mut agent, "print(await ptc_echo(text=\"hello\"))").await),
            "echo:hello"
        );
        client.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn loops_over_mcp_tool_calls() {
        let (mut agent, client) = mcp_agent().await;
        let result = run(&mut agent, "for i in range(3):\n    print(await ptc_add(a=i, b=10))").await;
        assert_eq!(text(&result), "10\n11\n12");
        client.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn runs_mcp_tools_concurrently() {
        let (mut agent, client) = mcp_agent().await;
        let code = "import asyncio\nprint(await asyncio.gather(*[ptc_echo(text=str(i)) for i in range(3)]))";
        assert_eq!(text(&run(&mut agent, code).await), "['echo:0', 'echo:1', 'echo:2']");
        client.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn surfaces_an_mcp_tool_error_as_a_catchable_exception() {
        let (mut agent, client) = mcp_agent().await;
        let code = "try:\n    await ptc_boom()\nexcept RuntimeError as e:\n    print('caught:', e)";
        let result = run(&mut agent, code).await;
        assert_eq!(result.status, ToolResultStatus::Success);
        assert!(text(&result).contains("mcp tool exploded"));
        client.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn calls_a_hyphenated_mcp_tool_via_its_identifier_alias() {
        let (mut agent, client) = mcp_agent().await;
        assert_eq!(
            text(&run(&mut agent, "print(await ptc_dash(value=\"x\"))").await),
            "dash:x"
        );
        client.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn returns_only_printed_output() {
        let (mut agent, client) = mcp_agent().await;
        let result = run(&mut agent, "x = await ptc_echo(text=\"secret\")\nprint(\"done\")").await;
        assert_eq!(text(&result), "done");
        client.disconnect().await.unwrap();
    }
}
