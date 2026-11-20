//! Interrupts raised during an invocation and resuming from them. The pending tool execution is
//! asserted through behaviour: which tools run again on resume and how often the model is called.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::{Arc, Mutex};

use common::{MockTool, collect, tool_use_turn, tool_uses_turn};
use futures::StreamExt;
use serde_json::json;
use strands::hooks::{
    AfterToolCallEvent, BeforeInvocationEvent, BeforeToolCallEvent, BeforeToolsEvent, InterruptEvent,
};
use strands::testing::MockModel;
use strands::tools::{FunctionTool, ToolExecutorStrategy, ToolStream};
use strands::types::{ToolResultContent, ToolSpec};
use strands::{
    Agent, AgentStreamEvent, CancelOptions, ContentBlock, InterruptParams, InterruptResponse, InterruptSource,
    JsonValue, Message, Role, StopReason, Tool, ToolContext, ToolOutcome, ToolResultBlock, ToolSource,
};
use tokio::sync::Notify;

type Log = Arc<Mutex<Vec<String>>>;

fn log() -> Log {
    Arc::default()
}

fn entries(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

fn agent(model: &MockModel, tools: Vec<ToolSource>) -> Agent {
    Agent::builder()
        .model(model.clone())
        .tools(tools)
        .printer(false)
        .build()
        .unwrap()
}

fn agent_with(model: &MockModel, tools: Vec<ToolSource>, executor: ToolExecutorStrategy) -> Agent {
    Agent::builder()
        .model(model.clone())
        .tools(tools)
        .tool_executor(executor)
        .printer(false)
        .build()
        .unwrap()
}

fn success(context: &ToolContext, text: &str) -> ToolOutcome {
    ToolResultBlock::success(
        context.tool_use().tool_use_id.clone(),
        vec![ToolResultContent::text(text)],
    )
    .into()
}

/// A tool that asks for a response and returns `render(response)` once it has one.
fn interrupting_tool(
    name: &str,
    params: InterruptParams,
    render: impl Fn(&JsonValue) -> String + Send + Sync + 'static,
) -> MockTool {
    MockTool::new(name, move |context| match context.interrupt(params.clone()) {
        Ok(response) => success(context, &render(&response)),
        Err(interrupt) => interrupt.into(),
    })
}

/// A tool that records its name and returns `<name> result`.
fn logging_tool(name: &str, log: &Log) -> MockTool {
    let log = log.clone();
    let tool_name = name.to_owned();
    MockTool::new(name, move |context| {
        log.lock().unwrap().push(tool_name.clone());
        success(context, &format!("{tool_name} result"))
    })
}

fn respond(id: &str, response: JsonValue) -> Vec<InterruptResponse> {
    vec![InterruptResponse::new(id, response)]
}

fn tool_result_texts(message: &Message) -> Vec<String> {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(serde_json::to_string(&result.content).unwrap()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn returns_stop_reason_interrupt_when_tool_calls_interrupt() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("confirmTool", "tool-1", json!({})))
        .with_turn("Should not reach this");
    let tool = interrupting_tool(
        "confirmTool",
        InterruptParams::new("confirm").with_reason("Please confirm"),
        |_| String::new(),
    );
    let mut agent = agent(&model, vec![tool.into()]);

    let result = agent.invoke("Test").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(result.interrupts().len(), 1);
    assert_eq!(result.interrupts()[0].name, "confirm");
    assert_eq!(result.interrupts()[0].reason, Some(json!("Please confirm")));
}

mod interrupt_from_before_tool_call_event_hook {
    use super::*;

    #[tokio::test]
    async fn returns_stop_reason_interrupt_when_hook_calls_interrupt() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn("Should not reach this");
        let mut agent = agent(&model, vec![MockTool::text("testTool", "Success").into()]);
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            if event.tool_use().name == "testTool" {
                let _ = event.interrupt(InterruptParams::new("confirm_tool").with_reason("Confirm tool execution?"));
            }
        });

        let result = agent.invoke("Test").await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::Interrupt);
        assert_eq!(result.interrupts()[0].name, "confirm_tool");
        assert_eq!(result.interrupts()[0].reason, Some(json!("Confirm tool execution?")));
    }

    #[tokio::test]
    async fn stores_pending_state_and_resumes_correctly_after_interrupt() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("deleteTool", "tool-1", json!({"key": "X"})))
            .with_turn("Deleted");
        let executed = log();
        let mut agent = agent(&model, vec![logging_tool("deleteTool", &executed).into()]);
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            if event.tool_use().name != "deleteTool" {
                return;
            }
            match event.interrupt(InterruptParams::new("approve_delete").with_reason("Confirm delete?")) {
                Ok(approval) if approval == json!("yes") => {}
                Ok(_) => event.set_cancel("not approved"),
                Err(_) => {}
            }
        });

        let interrupted = agent.invoke("Delete X").await.unwrap();

        assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
        let interrupt = &interrupted.interrupts()[0];
        assert_eq!(
            serde_json::to_value(interrupt).unwrap(),
            json!({
                "id": "hook:beforeToolCall:tool-1:approve_delete",
                "name": "approve_delete",
                "reason": "Confirm delete?",
                "source": "hook"
            })
        );
        assert!(entries(&executed).is_empty());
        assert_eq!(model.call_count(), 1);
        assert_eq!(
            agent.messages().len(),
            1,
            "the tool use waits for its tools outside history"
        );

        let result = agent.invoke(respond(&interrupt.id, json!("yes"))).await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(entries(&executed), ["deleteTool"]);
        assert_eq!(model.call_count(), 2);
        assert_eq!(
            serde_json::to_value(&agent.messages()[1].content).unwrap(),
            json!([{"toolUse": {"name": "deleteTool", "toolUseId": "tool-1", "input": {"key": "X"}}}])
        );
    }

    #[tokio::test]
    async fn preserves_completed_tool_results_when_interrupt_fires_on_a_later_tool() {
        let model = MockModel::new()
            .with_turn(tool_uses_turn(&[
                ("toolA", "tool-a"),
                ("toolB", "tool-b"),
                ("toolC", "tool-c"),
            ]))
            .with_turn("All done");
        let executed = log();
        let tools = ["toolA", "toolB", "toolC"]
            .map(|name| ToolSource::from(logging_tool(name, &executed)))
            .to_vec();
        let mut agent = agent_with(&model, tools, ToolExecutorStrategy::Sequential);
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            if event.tool_use().name == "toolB" {
                let _ = event.interrupt(InterruptParams::new("approve_b").with_reason("Approve B?"));
            }
        });

        let interrupted = agent.invoke("Run all").await.unwrap();

        assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
        assert_eq!(entries(&executed), ["toolA"]);

        let result = agent
            .invoke(respond(&interrupted.interrupts()[0].id, json!("approved")))
            .await
            .unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(entries(&executed), ["toolA", "toolB", "toolC"]);
        assert_eq!(model.call_count(), 2);
        assert_eq!(
            tool_result_texts(&agent.messages()[2]),
            [
                r#"[{"text":"toolA result"}]"#,
                r#"[{"text":"toolB result"}]"#,
                r#"[{"text":"toolC result"}]"#
            ]
        );
    }
}

#[tokio::test]
async fn returns_stop_reason_interrupt_when_before_tools_hook_calls_interrupt() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
        .with_turn("Should not reach this");
    let mut agent = agent(&model, vec![MockTool::text("testTool", "Success").into()]);
    agent.add_hook(|event: &mut BeforeToolsEvent<'_>| {
        let _ = event.interrupt(InterruptParams::new("batch_approval").with_reason("Approve all tools?"));
    });

    let result = agent.invoke("Test").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(result.interrupts()[0].id, "hook:beforeTools:batch_approval");
    assert_eq!(result.interrupts()[0].reason, Some(json!("Approve all tools?")));
}

mod resume_flow {
    use super::*;

    #[tokio::test]
    async fn resumes_tool_callback_execution_without_re_calling_model() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("confirmTool", "tool-1", json!({"amount": 5000})))
            .with_turn("Transfer completed");
        let calls = Arc::new(Mutex::new(Vec::<JsonValue>::new()));
        let seen = calls.clone();
        let tool = FunctionTool::builder("confirmTool", "Tool that requires confirmation")
            .input_schema(json!({"type": "object", "properties": {"amount": {"type": "number"}}}))
            .callback(move |input, context| {
                let seen = seen.clone();
                async move {
                    let response = context.interrupt(
                        InterruptParams::new("confirm_transfer")
                            .with_reason(format!("Confirm transfer of ${}?", input["amount"])),
                    );
                    seen.lock().unwrap().push(response.clone().unwrap_or(JsonValue::Null));
                    let response = response?;
                    let approved = response["approved"].as_bool().unwrap_or(false);
                    Ok(json!(if approved {
                        "Transfer approved"
                    } else {
                        "Transfer denied"
                    }))
                }
            });
        let mut agent = agent(&model, vec![tool.into()]);

        let interrupted = agent.invoke("Transfer $5000").await.unwrap();

        assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
        assert_eq!(interrupted.interrupts()[0].name, "confirm_transfer");
        assert_eq!(
            interrupted.interrupts()[0].reason,
            Some(json!("Confirm transfer of $5000?"))
        );
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(model.call_count(), 1);

        let result = agent
            .invoke(respond(&interrupted.interrupts()[0].id, json!({"approved": true})))
            .await
            .unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(calls.lock().unwrap()[1], json!({"approved": true}));
        assert_eq!(calls.lock().unwrap().len(), 2);
        assert_eq!(model.call_count(), 2);
        assert_eq!(
            tool_result_texts(&agent.messages()[2]),
            [r#"[{"text":"Transfer approved"}]"#]
        );
    }

    #[tokio::test]
    async fn does_not_append_hook_messages_when_resuming_an_interrupted_tool() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("confirmTool", "tool-1", json!({})))
            .with_turn("finished");
        let tool = interrupting_tool(
            "confirmTool",
            InterruptParams::new("confirm").with_reason("Continue?"),
            |response| format!("confirmed:{}", response.as_str().unwrap_or_default()),
        );
        let mut agent = agent(&model, vec![tool.into()]);
        agent.add_hook(|event: &mut BeforeInvocationEvent<'_>| {
            event.messages_mut().push(Message::user("context"));
        });

        let interrupted = agent.invoke("start").await.unwrap();
        let result = agent
            .invoke(respond(&interrupted.interrupts()[0].id, json!("yes")))
            .await
            .unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        let history: Vec<JsonValue> = agent
            .messages()
            .iter()
            .map(|message| json!({"role": message.role, "content": message.content}))
            .collect();
        assert_eq!(
            history,
            [
                json!({"role": "user", "content": [{"text": "start"}]}),
                json!({"role": "user", "content": [{"text": "context"}]}),
                json!({"role": "assistant", "content": [{"toolUse": {"name": "confirmTool", "toolUseId": "tool-1", "input": {}}}]}),
                json!({"role": "user", "content": [{"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"text": "confirmed:yes"}]}}]}),
                json!({"role": "assistant", "content": [{"text": "finished"}]}),
            ]
        );
    }

    #[tokio::test]
    async fn skips_already_completed_tools_when_resuming_from_partial_execution() {
        let model = MockModel::new()
            .with_turn(tool_uses_turn(&[
                ("toolA", "tool-a"),
                ("toolB", "tool-b"),
                ("toolC", "tool-c"),
            ]))
            .with_turn("All tools completed");
        let executed = log();
        let c_log = executed.clone();
        let tool_c = MockTool::new("toolC", move |context| {
            match context.interrupt(InterruptParams::new("confirm_c").with_reason("Confirm tool C?")) {
                Ok(response) => {
                    c_log.lock().unwrap().push("toolC".into());
                    let approved = response["approved"].as_bool().unwrap_or(false);
                    success(context, if approved { "C approved" } else { "C denied" })
                }
                Err(interrupt) => interrupt.into(),
            }
        });
        let tools = vec![
            logging_tool("toolA", &executed).into(),
            logging_tool("toolB", &executed).into(),
            tool_c.into(),
        ];
        let mut agent = agent_with(&model, tools, ToolExecutorStrategy::Sequential);

        let interrupted = agent.invoke("Run all tools").await.unwrap();

        assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
        assert_eq!(interrupted.interrupts()[0].name, "confirm_c");
        assert_eq!(entries(&executed), ["toolA", "toolB"]);
        assert_eq!(model.call_count(), 1);

        let result = agent
            .invoke(respond(&interrupted.interrupts()[0].id, json!({"approved": true})))
            .await
            .unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(entries(&executed), ["toolA", "toolB", "toolC"]);
        assert_eq!(model.call_count(), 2);
        assert_eq!(tool_result_texts(&agent.messages()[2]).len(), 3);
    }

    #[tokio::test]
    async fn throws_type_error_when_sending_a_new_message_while_in_interrupted_state() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("confirmTool", "tool-1", json!({})))
            .with_turn("Different response");
        let tool = interrupting_tool(
            "confirmTool",
            InterruptParams::new("confirm").with_reason("Confirm?"),
            |_| String::new(),
        );
        let mut agent = agent(&model, vec![tool.into()]);

        let interrupted = agent.invoke("First message").await.unwrap();
        assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);

        let error = agent.invoke("Different question").await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Agent is in an interrupted state. Resume by invoking with interruptResponse content blocks."
        );
    }
}

#[tokio::test]
async fn allows_pure_interrupt_response_arrays_without_error() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("confirmTool", "tool-1", json!({})))
        .with_turn("Done");
    let tool = interrupting_tool(
        "confirmTool",
        InterruptParams::new("confirm").with_reason("Confirm?"),
        |response| format!("Got: {response}"),
    );
    let mut agent = agent(&model, vec![tool.into()]);

    let interrupted = agent.invoke("Test").await.unwrap();
    assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);

    let result = agent
        .invoke(respond(&interrupted.interrupts()[0].id, json!("approved")))
        .await
        .unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
}

#[tokio::test]
async fn rejects_a_response_to_an_unknown_interrupt() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("confirmTool", "tool-1", json!({})))
        .with_turn("Done");
    let tool = interrupting_tool("confirmTool", InterruptParams::new("confirm"), |_| String::new());
    let mut agent = agent(&model, vec![tool.into()]);
    agent.invoke("Test").await.unwrap();

    let error = agent.invoke(respond("unknown", json!("yes"))).await.unwrap_err();

    assert_eq!(error.to_string(), "interrupt_id=<unknown> | no interrupt found");
}

mod multiple_hook_interrupts {
    use super::*;

    fn names(agent_result: &strands::AgentResult) -> Vec<(String, Option<JsonValue>)> {
        agent_result
            .interrupts()
            .iter()
            .map(|interrupt| (interrupt.name.clone(), interrupt.reason.clone()))
            .collect()
    }

    #[tokio::test]
    async fn collects_interrupts_from_multiple_before_tool_call_event_hooks() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn("Should not reach this");
        let mut agent = agent(&model, vec![MockTool::text("testTool", "Success").into()]);
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            let _ = event.interrupt(InterruptParams::new("security_check").with_reason("Security review required"));
        });
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            let _ = event.interrupt(InterruptParams::new("budget_check").with_reason("Budget approval required"));
        });

        let result = agent.invoke("Test").await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::Interrupt);
        assert_eq!(
            names(&result),
            [
                ("security_check".to_owned(), Some(json!("Security review required"))),
                ("budget_check".to_owned(), Some(json!("Budget approval required"))),
            ]
        );
    }

    #[tokio::test]
    async fn collects_interrupts_from_multiple_before_tools_event_hooks() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn("Should not reach this");
        let mut agent = agent(&model, vec![MockTool::text("testTool", "Success").into()]);
        agent.add_hook(|event: &mut BeforeToolsEvent<'_>| {
            let _ = event.interrupt(InterruptParams::new("approval_a").with_reason("First approval"));
        });
        agent.add_hook(|event: &mut BeforeToolsEvent<'_>| {
            let _ = event.interrupt(InterruptParams::new("approval_b").with_reason("Second approval"));
        });

        let result = agent.invoke("Test").await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::Interrupt);
        assert_eq!(
            names(&result),
            [
                ("approval_a".to_owned(), Some(json!("First approval"))),
                ("approval_b".to_owned(), Some(json!("Second approval"))),
            ]
        );
    }

    #[tokio::test]
    async fn resumes_correctly_after_multiple_interrupts_are_answered() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn("All approved");
        let responses = Arc::new(Mutex::new(Vec::<JsonValue>::new()));
        let hook_calls = Arc::new(Mutex::new(0));
        let mut agent = agent(&model, vec![MockTool::text("testTool", "Success").into()]);
        for name in ["security_check", "budget_check"] {
            let responses = responses.clone();
            let hook_calls = hook_calls.clone();
            agent.add_hook(move |event: &mut BeforeToolCallEvent| {
                *hook_calls.lock().unwrap() += 1;
                if let Ok(response) = event.interrupt(InterruptParams::new(name).with_reason("review")) {
                    responses.lock().unwrap().push(response);
                }
            });
        }

        let interrupted = agent.invoke("Test").await.unwrap();

        assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
        assert_eq!(interrupted.interrupts().len(), 2);
        assert_eq!(*hook_calls.lock().unwrap(), 2);
        assert_eq!(model.call_count(), 1);

        let answers: Vec<InterruptResponse> = interrupted
            .interrupts()
            .iter()
            .map(|interrupt| {
                InterruptResponse::new(interrupt.id.clone(), json!(format!("approved:{}", interrupt.name)))
            })
            .collect();
        let result = agent.invoke(answers).await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(model.call_count(), 2);
        assert_eq!(
            *responses.lock().unwrap(),
            [json!("approved:security_check"), json!("approved:budget_check")]
        );
    }
}

mod multi_cycle_interrupts {
    use super::*;

    #[tokio::test]
    async fn interrupts_again_on_cycle_2_after_resuming_from_cycle_1_before_tools_event() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn(tool_use_turn("testTool", "tool-2", json!({})))
            .with_turn("Done");
        let count = Arc::new(Mutex::new(0));
        let mut agent = agent(&model, vec![MockTool::text("testTool", "ok").into()]);
        let counter = count.clone();
        agent.add_hook(move |event: &mut BeforeToolsEvent<'_>| {
            *counter.lock().unwrap() += 1;
            let _ = event.interrupt(InterruptParams::new("approval").with_reason("Approve?"));
        });

        let first = agent.invoke("Go").await.unwrap();
        assert_eq!(first.stop_reason(), StopReason::Interrupt);
        assert_eq!(first.interrupts()[0].name, "approval");
        assert_eq!(*count.lock().unwrap(), 1);

        let second = agent
            .invoke(respond(&first.interrupts()[0].id, json!("yes")))
            .await
            .unwrap();

        assert_eq!(second.stop_reason(), StopReason::Interrupt);
        assert_eq!(*count.lock().unwrap(), 3);
    }

    #[tokio::test]
    async fn preserves_the_pending_tool_interrupt_when_a_resume_is_cancelled_before_the_tool_runs() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("confirmTool", "tool-1", json!({})))
            .with_turn("Done");
        let executed = Arc::new(Mutex::new(false));
        let flag = executed.clone();
        let tool = MockTool::new("confirmTool", move |context| {
            if !*flag.lock().unwrap()
                && let Err(interrupt) = context.interrupt(InterruptParams::new("confirm").with_reason("Approve?"))
            {
                return interrupt.into();
            }
            *flag.lock().unwrap() = true;
            success(context, "executed")
        });
        let mut agent = agent(&model, vec![tool.into()]);

        let interrupted = agent.invoke("Go").await.unwrap();
        assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
        let id = interrupted.interrupts()[0].id.clone();

        let cancel_hook = agent.add_hook(|event: &mut BeforeToolsEvent<'_>| {
            event.agent().cancel(CancelOptions::default());
        });
        let cancelled = agent.invoke(respond(&id, json!("yes"))).await.unwrap();
        assert_eq!(cancelled.stop_reason(), StopReason::Cancelled);
        assert!(!*executed.lock().unwrap());

        cancel_hook.remove();
        let result = agent.invoke(respond(&id, json!("yes"))).await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert!(*executed.lock().unwrap());
    }
}

mod event_contract_during_interrupt {
    use super::*;

    #[tokio::test]
    async fn does_not_fire_after_tool_call_event_when_before_tool_call_event_interrupt_triggers() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn("Done");
        let fired = log();
        let mut agent = agent(&model, vec![MockTool::text("testTool", "Success").into()]);
        let before = fired.clone();
        agent.add_hook(move |event: &mut BeforeToolCallEvent| {
            before.lock().unwrap().push("BeforeToolCallEvent".into());
            let _ = event.interrupt(InterruptParams::new("confirm").with_reason("Confirm?"));
        });
        let after = fired.clone();
        agent.add_hook(move |_: &mut AfterToolCallEvent| after.lock().unwrap().push("AfterToolCallEvent".into()));

        let result = agent.invoke("Test").await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::Interrupt);
        assert_eq!(entries(&fired), ["BeforeToolCallEvent"]);
    }

    #[tokio::test]
    async fn does_not_fire_after_tool_call_event_when_tool_callback_interrupts() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("confirmTool", "tool-1", json!({})))
            .with_turn("Done");
        let tool = interrupting_tool(
            "confirmTool",
            InterruptParams::new("confirm").with_reason("Confirm?"),
            |_| String::new(),
        );
        let fired = log();
        let mut agent = agent(&model, vec![tool.into()]);
        let before = fired.clone();
        agent.add_hook(move |_: &mut BeforeToolCallEvent| before.lock().unwrap().push("BeforeToolCallEvent".into()));
        let after = fired.clone();
        agent.add_hook(move |_: &mut AfterToolCallEvent| after.lock().unwrap().push("AfterToolCallEvent".into()));

        let result = agent.invoke("Test").await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::Interrupt);
        assert_eq!(entries(&fired), ["BeforeToolCallEvent"]);
    }
}

mod concurrent_tool_execution_with_interrupts {
    use super::*;

    fn interrupting_b(log: &Log) -> FunctionTool {
        let log = log.clone();
        FunctionTool::builder("toolB", "Interrupting tool B").callback(move |_input, context| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push("B".into());
                let response = context.interrupt(InterruptParams::new("confirm_b").with_reason("Approve B?"))?;
                Ok(json!(format!("B: {}", response.as_str().unwrap_or_default())))
            }
        })
    }

    #[tokio::test]
    async fn allows_in_flight_tool_to_complete_when_sibling_interrupts() {
        let model = MockModel::new()
            .with_turn(tool_uses_turn(&[("toolA", "tool-a"), ("toolB", "tool-b")]))
            .with_turn("Done");
        let started = Arc::new(Notify::new());
        let gate = Arc::new(Notify::new());
        let completed = Arc::new(Mutex::new(false));
        let (a_started, a_gate, a_completed) = (started.clone(), gate.clone(), completed.clone());
        let tool_a = FunctionTool::builder("toolA", "Gated tool A").callback(move |_input, _context| {
            let (started, gate, completed) = (a_started.clone(), a_gate.clone(), a_completed.clone());
            async move {
                started.notify_one();
                gate.notified().await;
                *completed.lock().unwrap() = true;
                Ok(json!("A done"))
            }
        });
        let mut agent = agent_with(
            &model,
            vec![tool_a.into(), interrupting_b(&log()).into()],
            ToolExecutorStrategy::Concurrent,
        );

        let invocation = tokio::spawn(async move {
            let result = agent.invoke("Go").await;
            (agent, result)
        });
        started.notified().await;
        assert!(!*completed.lock().unwrap());
        gate.notify_one();
        let (mut agent, result) = invocation.await.unwrap();
        let result = result.unwrap();

        assert_eq!(result.stop_reason(), StopReason::Interrupt);
        assert!(*completed.lock().unwrap());
        assert_eq!(
            serde_json::to_value(result.interrupts()).unwrap(),
            json!([{"id": "tool:tool-b:confirm_b", "name": "confirm_b", "reason": "Approve B?", "source": "tool"}])
        );

        let resumed = agent
            .invoke(respond("tool:tool-b:confirm_b", json!("ok")))
            .await
            .unwrap();
        assert_eq!(resumed.stop_reason(), StopReason::EndTurn);
        assert_eq!(
            tool_result_texts(&agent.messages()[2]),
            [r#"[{"text":"A done"}]"#, r#"[{"text":"B: ok"}]"#]
        );
    }

    #[tokio::test]
    async fn stores_completed_tool_results_and_resumes_only_the_interrupted_tool() {
        let model = MockModel::new()
            .with_turn(tool_uses_turn(&[("toolA", "tool-a"), ("toolB", "tool-b")]))
            .with_turn("Done");
        let executed = log();
        let a_log = executed.clone();
        let tool_a = FunctionTool::builder("toolA", "Tool A").callback(move |_input, _context| {
            let log = a_log.clone();
            async move {
                log.lock().unwrap().push("A".into());
                Ok(json!("A result"))
            }
        });
        let mut agent = agent_with(
            &model,
            vec![tool_a.into(), interrupting_b(&executed).into()],
            ToolExecutorStrategy::Concurrent,
        );

        let interrupted = agent.invoke("Go").await.unwrap();

        assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
        let mut first = entries(&executed);
        first.sort();
        assert_eq!(first, ["A", "B"]);

        executed.lock().unwrap().clear();
        let result = agent
            .invoke(respond(&interrupted.interrupts()[0].id, json!("approved")))
            .await
            .unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(entries(&executed), ["B"]);
    }

    #[tokio::test]
    async fn handles_before_tool_call_event_interrupt_in_concurrent_mode() {
        let model = MockModel::new()
            .with_turn(tool_uses_turn(&[("toolA", "tool-a"), ("toolB", "tool-b")]))
            .with_turn("Done");
        let executed = log();
        let tools = vec![
            logging_tool("toolA", &executed).into(),
            logging_tool("toolB", &executed).into(),
        ];
        let mut agent = agent_with(&model, tools, ToolExecutorStrategy::Concurrent);
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            if event.tool_use().name == "toolB" {
                let _ = event.interrupt(InterruptParams::new("approve_b").with_reason("Approve B?"));
            }
        });

        let result = agent.invoke("Go").await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::Interrupt);
        assert_eq!(
            serde_json::to_value(result.interrupts()).unwrap(),
            json!([{"id": "hook:beforeToolCall:tool-b:approve_b", "name": "approve_b", "reason": "Approve B?", "source": "hook"}])
        );
        assert_eq!(entries(&executed), ["toolA"]);
    }

    #[tokio::test]
    async fn fires_one_interrupt_event_per_interrupting_tool_of_a_batch() {
        let model = MockModel::new()
            .with_turn(tool_uses_turn(&[("toolA", "tool-a"), ("toolB", "tool-b")]))
            .with_turn("Done");
        let tools: Vec<ToolSource> = ["toolA", "toolB"]
            .map(|name| interrupting_tool(name, InterruptParams::new("confirm"), |_| String::new()).into())
            .to_vec();
        let mut agent = agent_with(&model, tools, ToolExecutorStrategy::Concurrent);

        let events = collect(agent.stream("Go")).await;

        let mut ids: Vec<String> = events
            .iter()
            .filter_map(|event| match event {
                AgentStreamEvent::Interrupt(data) => Some(data.interrupt.id.clone()),
                _ => None,
            })
            .collect();
        ids.sort();
        assert_eq!(ids, ["tool:tool-a:confirm", "tool:tool-b:confirm"]);
    }
}

#[tokio::test]
async fn runs_the_completed_tool_exactly_once_across_interrupt_and_resume() {
    for executor in [ToolExecutorStrategy::Sequential, ToolExecutorStrategy::Concurrent] {
        let model = MockModel::new()
            .with_turn(tool_uses_turn(&[("toolA", "tool-a"), ("toolB", "tool-b")]))
            .with_turn("Done");
        let executed = log();
        let b_log = executed.clone();
        let tool_b = MockTool::new("toolB", move |context| {
            b_log.lock().unwrap().push("B".into());
            match context.interrupt(InterruptParams::new("confirm_b").with_reason("Approve B?")) {
                Ok(response) => success(context, &format!("B: {}", response.as_str().unwrap_or_default())),
                Err(interrupt) => interrupt.into(),
            }
        });
        let a_log = executed.clone();
        let tool_a = MockTool::new("toolA", move |context| {
            a_log.lock().unwrap().push("A".into());
            success(context, "A result")
        });
        let mut agent = agent_with(&model, vec![tool_a.into(), tool_b.into()], executor);
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            if event.tool_use().name == "toolA" {
                event.tool_use_mut().tool_use_id = "rewritten-a".into();
            }
        });
        agent.add_hook(|event: &mut AfterToolCallEvent| {
            if event.tool_use().name == "toolA" {
                event.result_mut().tool_use_id = "after-rewritten-a".into();
            }
        });

        let interrupted = agent.invoke("Go").await.unwrap();
        assert_eq!(interrupted.stop_reason(), StopReason::Interrupt, "{executor:?}");
        let mut first = entries(&executed);
        first.sort();
        assert_eq!(first, ["A", "B"], "{executor:?}");

        let result = agent
            .invoke(respond(&interrupted.interrupts()[0].id, json!("approved")))
            .await
            .unwrap();
        assert_eq!(result.stop_reason(), StopReason::EndTurn, "{executor:?}");
        let mut all = entries(&executed);
        all.sort();
        assert_eq!(all, ["A", "B", "B"], "{executor:?}");

        let snapshots: Vec<(Vec<String>, Vec<String>)> = model
            .requests()
            .iter()
            .filter_map(|request| {
                let blocks: Vec<&ContentBlock> = request.messages.iter().flat_map(|message| &message.content).collect();
                let uses: Vec<String> = blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolUse(tool_use) => Some(tool_use.tool_use_id.clone()),
                        _ => None,
                    })
                    .collect();
                let results: Vec<String> = blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::ToolResult(result) => Some(result.tool_use_id.clone()),
                        _ => None,
                    })
                    .collect();
                (!results.is_empty()).then_some((uses, results))
            })
            .collect();
        assert_eq!(
            snapshots,
            [(
                vec!["tool-a".to_owned(), "tool-b".to_owned()],
                vec!["tool-a".to_owned(), "tool-b".to_owned()]
            )],
            "{executor:?}"
        );
    }
}

mod interrupt_event_emission {
    use super::*;

    #[tokio::test]
    async fn yields_one_interrupt_event_per_unanswered_interrupt_at_stop_tagged_with_source() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("toolA", "tool-a", json!({})))
            .with_turn("done");
        let tool = interrupting_tool("toolA", InterruptParams::new("confirm_tool").with_reason("ok?"), |_| {
            String::new()
        });
        let mut agent = agent(&model, vec![tool.into()]);
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            if event.tool_use().name == "toolA" {
                let _ = event.interrupt(InterruptParams::new("confirm_hook").with_reason("hook ok?"));
            }
        });
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = emitted.clone();
        agent.add_hook(move |event: &mut InterruptEvent<'_>| sink.lock().unwrap().push(event.interrupt().source));

        let result = agent.invoke("go").await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::Interrupt);
        let emitted = emitted.lock().unwrap();
        assert_eq!(result.interrupts().len(), emitted.len());
        assert!(emitted.iter().all(|source| *source == InterruptSource::Hook));
    }

    #[tokio::test]
    async fn interrupt_event_is_available_on_the_stream() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("approveMe", "tool-1", json!({})))
            .with_turn("done");
        let tool = interrupting_tool(
            "approveMe",
            InterruptParams::new("approve").with_reason("please"),
            |_| String::new(),
        );
        let mut agent = agent(&model, vec![tool.into()]);

        let events = collect(agent.stream("go")).await;

        let interrupts: Vec<JsonValue> = events
            .iter()
            .filter_map(|event| match event {
                AgentStreamEvent::Interrupt(_) => Some(serde_json::to_value(event).unwrap()),
                _ => None,
            })
            .collect();
        assert_eq!(
            interrupts,
            [json!({
                "type": "interruptEvent",
                "interrupt": {"id": "tool:tool-1:approve", "name": "approve", "reason": "please", "source": "tool"}
            })]
        );
    }
}

/// Sends an email after the first call asked for confirmation; the send waits on a gate.
struct SendEmail {
    raised: Arc<Mutex<bool>>,
    side_effects: Log,
    started: Arc<Notify>,
    release: Arc<Notify>,
}

impl Tool for SendEmail {
    fn name(&self) -> &str {
        "sendEmail"
    }

    fn description(&self) -> &str {
        "Sends an email"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new("sendEmail", "Sends an email").with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let first = !std::mem::replace(&mut *self.raised.lock().unwrap(), true);
        if first
            && let Err(interrupt) = context.interrupt(InterruptParams::new("confirm").with_reason("Send the email?"))
        {
            return ToolStream::ready(interrupt);
        }
        let (side_effects, started, release) = (self.side_effects.clone(), self.started.clone(), self.release.clone());
        ToolStream::from_future(async move {
            side_effects.lock().unwrap().push("email sent".into());
            started.notify_one();
            release.notified().await;
            success(&context, "sent")
        })
    }
}

#[tokio::test]
async fn runs_an_approved_tool_only_once_when_the_resume_is_cancelled_while_the_tool_is_in_flight() {
    let model = MockModel::new()
        .with_turn(tool_use_turn("sendEmail", "tool-1", json!({})))
        .with_turn("Done")
        .with_turn("Nothing else happened");
    let side_effects = log();
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let tool = SendEmail {
        raised: Arc::default(),
        side_effects: side_effects.clone(),
        started: started.clone(),
        release: release.clone(),
    };
    let mut agent = agent(&model, vec![tool.into()]);
    let interrupted = agent.invoke("Send the email").await.unwrap();
    let id = interrupted.interrupts()[0].id.clone();

    let cancel = agent.cancel_handle();
    let inflight = tokio::spawn(async move {
        let result = agent.invoke(respond(&id, json!("yes"))).await;
        (agent, result)
    });
    started.notified().await;
    cancel.cancel(CancelOptions::default());
    release.notify_one();
    let (mut agent, result) = inflight.await.unwrap();
    assert_eq!(result.unwrap().stop_reason(), StopReason::Cancelled);

    let tool_use_ids: Vec<String> = agent
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some(tool_use.tool_use_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(tool_use_ids, ["tool-1"]);

    agent.invoke("what happened?").await.unwrap();
    assert_eq!(entries(&side_effects), ["email sent"]);
}

mod stream_break_at_interrupt_event {
    use super::*;

    /// Stops consuming once the interrupt surfaces (the stream is dropped) and returns its id.
    async fn stream_until_interrupt(agent: &mut Agent, prompt: &str) -> String {
        let mut stream = agent.stream(prompt);
        while let Some(event) = stream.next().await {
            if let AgentStreamEvent::Interrupt(data) = event.unwrap() {
                return data.interrupt.id;
            }
        }
        panic!("stream ended without an InterruptEvent");
    }

    fn model() -> MockModel {
        MockModel::new()
            .with_turn(tool_use_turn("deleteFiles", "tool-1", json!({})))
            .with_turn("Done")
    }

    fn confirming_tool(runs: &Log) -> MockTool {
        let runs = runs.clone();
        MockTool::new("deleteFiles", move |context| {
            match context.interrupt(InterruptParams::new("confirm").with_reason("Delete?")) {
                Ok(response) => {
                    runs.lock()
                        .unwrap()
                        .push(response.as_str().unwrap_or_default().to_owned());
                    success(context, "deleted")
                }
                Err(interrupt) => interrupt.into(),
            }
        })
    }

    #[tokio::test]
    async fn rejects_a_new_prompt_instead_of_replaying_the_stored_tool_cycle() {
        let model = model();
        let runs = log();
        let mut agent = agent(&model, vec![confirming_tool(&runs).into()]);
        stream_until_interrupt(&mut agent, "Delete old files").await;

        let error = agent.invoke("anything new").await.unwrap_err();

        assert_eq!(
            error.to_string(),
            "Agent is in an interrupted state. Resume by invoking with interruptResponse content blocks."
        );
        assert!(entries(&runs).is_empty());
        assert_eq!(model.call_count(), 1);
    }

    #[tokio::test]
    async fn runs_a_tool_approved_call_once_when_resumed() {
        let model = model();
        let runs = log();
        let mut agent = agent(&model, vec![confirming_tool(&runs).into()]);
        let id = stream_until_interrupt(&mut agent, "Delete old files").await;

        let result = agent.invoke(respond(&id, json!("yes"))).await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(entries(&runs), ["yes"]);
        assert_eq!(model.call_count(), 2);
        let roles: Vec<Role> = agent.messages().iter().map(|message| message.role).collect();
        assert_eq!(roles, [Role::User, Role::Assistant, Role::User, Role::Assistant]);
    }

    #[tokio::test]
    async fn runs_a_hook_approved_call_once_when_resumed() {
        let model = model();
        let runs = log();
        let record = runs.clone();
        let tool = MockTool::new("deleteFiles", move |context| {
            record.lock().unwrap().push(context.tool_use().tool_use_id.clone());
            success(context, "deleted")
        });
        let mut agent = agent(&model, vec![tool.into()]);
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            match event.interrupt(InterruptParams::new("approve_delete").with_reason("Delete?")) {
                Ok(response) if response == json!("yes") => {}
                Ok(_) => event.set_cancel("not approved"),
                Err(_) => {}
            }
        });
        let id = stream_until_interrupt(&mut agent, "Delete old files").await;

        let result = agent.invoke(respond(&id, json!("yes"))).await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(entries(&runs), ["tool-1"]);
        assert_eq!(model.call_count(), 2);
    }
}

mod restored_interrupt_state {
    use strands::storage::{InMemoryStorage, Storage};
    use strands::types::Snapshot;
    use strands::{SessionManager, TakeSnapshotOptions};

    use super::*;

    fn recording_tool(name: &str, runs: &Log, text: &'static str) -> MockTool {
        let runs = runs.clone();
        MockTool::new(name, move |context| {
            runs.lock().unwrap().push(context.tool_use().tool_use_id.clone());
            success(context, text)
        })
    }

    fn approval_gate(agent: &Agent) {
        agent.add_hook(|event: &mut BeforeToolCallEvent| {
            match event.interrupt(InterruptParams::new("approve_delete").with_reason("Confirm delete?")) {
                Ok(approval) if approval == json!("yes") => {}
                Ok(_) => event.set_cancel("not approved"),
                Err(_) => {}
            }
        });
    }

    /// An agent restored by a session manager from a stored `snapshot_latest` holding `interrupts`.
    async fn agent_from_session(interrupts: JsonValue, model: &MockModel, tool: MockTool) -> Agent {
        let storage = Arc::new(InMemoryStorage::new());
        let snapshot = json!({
            "scope": "agent",
            "schemaVersion": "1.0",
            "createdAt": "2026-11-11T12:00:00.000Z",
            "data": {"messages": [], "interrupts": interrupts},
            "appData": {}
        });
        storage
            .write(
                "session/restored-session/scopes/agent/agent-1/snapshots/snapshot_latest.json",
                &serde_json::to_vec(&snapshot).unwrap(),
            )
            .await
            .unwrap();
        let session_manager = SessionManager::builder()
            .session_id("restored-session")
            .storage(storage)
            .build()
            .unwrap();
        Agent::builder()
            .id("agent-1")
            .model(model.clone())
            .tools([tool])
            .session_manager(session_manager)
            .printer(false)
            .build()
            .unwrap()
    }

    /// Interrupts an approval-gated tool call, then loads a JSON round-trip of the session
    /// snapshot into a fresh agent.
    async fn interrupt_and_restore() -> (Agent, MockModel, String, Log) {
        let runs = log();
        let interrupt_model = MockModel::new()
            .with_turn(tool_use_turn("deleteTool", "tool-1", json!({"key": "X"})))
            .with_turn("Unused");
        let mut interrupted = agent(
            &interrupt_model,
            vec![recording_tool("deleteTool", &runs, "deleted").into()],
        );
        approval_gate(&interrupted);
        let result = interrupted.invoke("Delete X").await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::Interrupt);

        let json = serde_json::to_string(&interrupted.take_snapshot(TakeSnapshotOptions::session()).unwrap()).unwrap();
        let snapshot: Snapshot = serde_json::from_str(&json).unwrap();
        let resume_model = MockModel::new().with_turn("Deleted").with_turn("Unused");
        let mut restored = agent(
            &resume_model,
            vec![recording_tool("deleteTool", &runs, "deleted").into()],
        );
        approval_gate(&restored);
        restored.load_snapshot(&snapshot).unwrap();
        (restored, resume_model, result.interrupts()[0].id.clone(), runs)
    }

    #[tokio::test]
    async fn ignores_a_restored_pending_tool_execution_when_the_interrupt_state_is_not_activated() {
        let model = MockModel::new().with_turn("Hello back").with_turn("Unused");
        let runs = log();
        let mut agent = agent_from_session(
            json!({
                "interrupts": {},
                "activated": false,
                "pendingToolExecution": {
                    "assistantMessageData": {
                        "role": "assistant",
                        "content": [{"toolUse": {"name": "recordTool", "toolUseId": "tool-1", "input": {}}}]
                    },
                    "completedToolResults": {}
                }
            }),
            &model,
            recording_tool("recordTool", &runs, "recorded"),
        )
        .await;

        let result = agent.invoke("Hello").await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(model.call_count(), 1);
        assert!(entries(&runs).is_empty());
    }

    #[tokio::test]
    async fn resumes_a_pending_tool_execution_restored_from_a_snapshot_after_an_interrupt_response() {
        let (mut restored, resume_model, interrupt_id, runs) = interrupt_and_restore().await;

        let result = restored.invoke(respond(&interrupt_id, json!("yes"))).await.unwrap();

        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(entries(&runs), ["tool-1"]);
        assert_eq!(resume_model.call_count(), 1);
        assert_eq!(
            serde_json::to_value(&restored.messages()[2].content).unwrap(),
            json!([{"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"text": "deleted"}]}}])
        );
    }

    #[tokio::test]
    async fn throws_type_error_when_a_restored_activated_interrupt_state_receives_a_new_prompt() {
        let (mut restored, resume_model, _, runs) = interrupt_and_restore().await;

        for _ in 0..2 {
            let error = restored.invoke("Something else").await.unwrap_err();
            assert_eq!(
                error.to_string(),
                "Agent is in an interrupted state. Resume by invoking with interruptResponse content blocks."
            );
        }
        assert!(entries(&runs).is_empty());
        assert_eq!(resume_model.call_count(), 0);
    }
}
