//! Interventions through the agent, including these guarantees: inner `ToolAgent::call_tool` calls
//! are gated, a `Confirm` resumes from an interrupt, an approval an inner call needs stops the outer tool and approves
//! the inner call on resume, `call_tool_without_interrupts` refuses that approval through
//! `AfterToolCallEvent`, and the intervention hooks run at their `HookOrder` slots.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::{MockTool, async_tool, tool_use_turn};
use serde_json::json;
use strands::hooks::{
    AfterModelCallEvent, AfterToolCallEvent, BeforeModelCallEvent, BeforeToolCallEvent, HookCallbackOptions, HookOrder,
};
use strands::interventions::{InterventionAction, InterventionHandler, InterventionResult};
use strands::testing::MockModel;
use strands::vended_interventions::hitl::{HumanInTheLoop, HumanInTheLoopConfig};
use strands::{Agent, InterruptResponse, StopReason, ToolSource, async_trait};

struct BlockTool(&'static str);

#[async_trait]
impl InterventionHandler for BlockTool {
    fn name(&self) -> &str {
        "block"
    }

    async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        if event.tool_use().name == self.0 {
            return Ok(InterventionAction::deny("blocked by intervention"));
        }
        Ok(InterventionAction::proceed())
    }
}

fn counting_tool(name: &str, count: &Arc<AtomicUsize>) -> MockTool {
    let count = count.clone();
    MockTool::new(name, move |context| {
        count.fetch_add(1, Ordering::SeqCst);
        strands::ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into()
    })
}

#[tokio::test]
async fn deny_on_before_tool_call_prevents_tool_execution() {
    let executed = Arc::new(AtomicUsize::new(0));
    let model = MockModel::new()
        .with_turn(tool_use_turn("blockedTool", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([counting_tool("blockedTool", &executed)])
        .interventions([BlockTool("blockedTool")])
        .printer(false)
        .build()
        .unwrap();

    let result = agent.invoke("Test").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(executed.load(Ordering::SeqCst), 0);
    let tool_result = serde_json::to_string(&agent.messages()[2]).unwrap();
    assert!(tool_result.contains("DENIED: blocked by intervention"), "{tool_result}");
}

#[tokio::test]
async fn interventions_run_before_plugins_hook_order_interventions_lt_default() {
    struct OrderTracker(Arc<Mutex<Vec<&'static str>>>);

    #[async_trait]
    impl InterventionHandler for OrderTracker {
        fn name(&self) -> &str {
            "order-tracker"
        }

        async fn before_tool_call(&self, _event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
            self.0.lock().unwrap().push("intervention");
            Ok(InterventionAction::proceed())
        }
    }

    let order = Arc::new(Mutex::new(Vec::new()));
    let model = MockModel::new()
        .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([MockTool::text("testTool", "result")])
        .interventions([OrderTracker(order.clone())])
        .printer(false)
        .build()
        .unwrap();
    let plugin_order = order.clone();
    agent.add_hook(move |_: &mut BeforeToolCallEvent| plugin_order.lock().unwrap().push("plugin"));

    agent.invoke("Test").await.unwrap();

    assert_eq!(*order.lock().unwrap(), ["plugin", "intervention"]);
}

#[tokio::test]
async fn inner_call_tool_calls_are_gated() {
    let executed = Arc::new(AtomicUsize::new(0));
    let outer = async_tool("outer", |_, context| async move {
        let result = context.agent().call_tool("secret", json!({})).await?;
        Ok(serde_json::to_value(&result).unwrap())
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("outer", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools(vec![
            ToolSource::from(outer),
            ToolSource::from(counting_tool("secret", &executed)),
        ])
        .interventions([BlockTool("secret")])
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("Test").await.unwrap();

    assert_eq!(executed.load(Ordering::SeqCst), 0);
    let tool_result = serde_json::to_string(&agent.messages()[2]).unwrap();
    assert!(tool_result.contains("DENIED: blocked by intervention"), "{tool_result}");
}

#[tokio::test]
async fn confirm_pauses_and_an_approving_response_runs_the_tool() {
    struct Approve;

    #[async_trait]
    impl InterventionHandler for Approve {
        fn name(&self) -> &str {
            "approve"
        }

        async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
            Ok(InterventionAction::confirm(format!("Run {}?", event.tool_use().name)))
        }
    }

    let executed = Arc::new(AtomicUsize::new(0));
    let model = MockModel::new()
        .with_turn(tool_use_turn("work", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([counting_tool("work", &executed)])
        .interventions([Approve])
        .printer(false)
        .build()
        .unwrap();

    let paused = agent.invoke("Test").await.unwrap();
    assert_eq!(paused.stop_reason(), StopReason::Interrupt);
    let interrupt = paused.interrupts()[0].clone();
    assert_eq!(interrupt.name, "approve");
    assert_eq!(interrupt.reason, Some(json!("Run work?")));
    assert_eq!(executed.load(Ordering::SeqCst), 0);

    let resumed = agent
        .invoke(vec![InterruptResponse::new(interrupt.id, "yes")])
        .await
        .unwrap();
    assert_eq!(resumed.stop_reason(), StopReason::EndTurn);
    assert_eq!(executed.load(Ordering::SeqCst), 1);
}

#[test]
fn duplicate_handler_names_fail_the_build() {
    let error = Agent::builder()
        .model(MockModel::new())
        .interventions([BlockTool("a"), BlockTool("b")])
        .printer(false)
        .build()
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "Duplicate intervention handler name: 'block'");
}

fn hitl_outer_agent(executed: &Arc<AtomicUsize>, outer_runs: &Arc<AtomicUsize>, model: MockModel) -> Agent {
    let runs = outer_runs.clone();
    let outer = async_tool("outer", move |_, context| {
        let runs = runs.clone();
        async move {
            runs.fetch_add(1, Ordering::SeqCst);
            let result = context.agent().call_tool("secret", json!({})).await?;
            Ok(serde_json::to_value(&result).unwrap())
        }
    });
    let hitl = HumanInTheLoop::new(HumanInTheLoopConfig {
        allowed_tools: vec!["outer".into()],
        ..Default::default()
    });
    Agent::builder()
        .model(model)
        .tools(vec![
            ToolSource::from(outer),
            ToolSource::from(counting_tool("secret", executed)),
        ])
        .interventions([hitl])
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn an_inner_call_needing_approval_interrupts_the_outer_tool_and_runs_once_approved() {
    let executed = Arc::new(AtomicUsize::new(0));
    let outer_runs = Arc::new(AtomicUsize::new(0));
    let model = MockModel::new()
        .with_turn(tool_use_turn("outer", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = hitl_outer_agent(&executed, &outer_runs, model);

    let paused = agent.invoke("Test").await.unwrap();

    assert_eq!(paused.stop_reason(), StopReason::Interrupt);
    let interrupt = paused.interrupts()[0].clone();
    assert_eq!(
        interrupt.id,
        "hook:beforeToolCall:tool-1:call:0:strands:human-in-the-loop"
    );
    assert_eq!(executed.load(Ordering::SeqCst), 0);

    let resumed = agent
        .invoke(vec![InterruptResponse::new(interrupt.id, "y")])
        .await
        .unwrap();

    assert_eq!(resumed.stop_reason(), StopReason::EndTurn);
    assert_eq!(executed.load(Ordering::SeqCst), 1);
    assert_eq!(outer_runs.load(Ordering::SeqCst), 2);
    let tool_result = serde_json::to_value(&agent.messages()[2]).unwrap();
    assert_eq!(tool_result["content"][0]["toolResult"]["toolUseId"], "tool-1");
    assert_eq!(tool_result["content"][0]["toolResult"]["status"], "success");
}

#[tokio::test]
async fn a_declined_inner_call_approval_cancels_only_the_inner_call() {
    let executed = Arc::new(AtomicUsize::new(0));
    let outer_runs = Arc::new(AtomicUsize::new(0));
    let model = MockModel::new()
        .with_turn(tool_use_turn("outer", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = hitl_outer_agent(&executed, &outer_runs, model);
    let paused = agent.invoke("Test").await.unwrap();
    let interrupt = paused.interrupts()[0].clone();

    let resumed = agent
        .invoke(vec![InterruptResponse::new(interrupt.id, "n")])
        .await
        .unwrap();

    assert_eq!(resumed.stop_reason(), StopReason::EndTurn);
    assert_eq!(executed.load(Ordering::SeqCst), 0);
    let tool_result = serde_json::to_string(&agent.messages()[2]).unwrap();
    assert!(tool_result.contains("CONFIRMATION_FAILED"), "{tool_result}");
}

#[tokio::test]
async fn an_inner_interrupt_stops_the_outer_tool_even_when_it_carries_on() {
    let executed = Arc::new(AtomicUsize::new(0));
    let outer = async_tool("outer", |_, context| async move {
        let result = context.agent().call_tool("secret", json!({})).await;
        Ok(json!({"interrupted": result.is_err()}))
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("outer", "tool-1", json!({})))
        .with_turn("Done");
    let hitl = HumanInTheLoop::new(HumanInTheLoopConfig {
        allowed_tools: vec!["outer".into()],
        ..Default::default()
    });
    let mut agent = Agent::builder()
        .model(model)
        .tools(vec![
            ToolSource::from(outer),
            ToolSource::from(counting_tool("secret", &executed)),
        ])
        .interventions([hitl])
        .printer(false)
        .build()
        .unwrap();

    let paused = agent.invoke("Test").await.unwrap();

    assert_eq!(paused.stop_reason(), StopReason::Interrupt);
    assert_eq!(paused.interrupts().len(), 1);
    assert_eq!(executed.load(Ordering::SeqCst), 0);
}

struct Recorder(Arc<Mutex<Vec<&'static str>>>);

#[async_trait]
impl InterventionHandler for Recorder {
    fn name(&self) -> &str {
        "recorder"
    }

    async fn before_tool_call(&self, _event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        self.0.lock().unwrap().push("intervention");
        Ok(InterventionAction::proceed())
    }

    async fn after_tool_call(&self, _event: &mut AfterToolCallEvent) -> InterventionResult<AfterToolCallEvent> {
        self.0.lock().unwrap().push("intervention");
        Ok(InterventionAction::proceed())
    }

    async fn before_model_call<'a>(
        &self,
        _event: &mut BeforeModelCallEvent<'a>,
    ) -> InterventionResult<BeforeModelCallEvent<'a>> {
        self.0.lock().unwrap().push("intervention");
        Ok(InterventionAction::proceed())
    }

    async fn after_model_call<'a>(
        &self,
        _event: &mut AfterModelCallEvent<'a>,
    ) -> InterventionResult<AfterModelCallEvent<'a>> {
        self.0.lock().unwrap().push("intervention");
        Ok(InterventionAction::proceed())
    }
}

fn order(offset: i32, base: i32) -> HookCallbackOptions {
    HookCallbackOptions { order: base + offset }
}

#[tokio::test]
async fn interventions_run_at_their_input_and_output_hook_orders() {
    let log: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let model = MockModel::new()
        .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model)
        .tools([MockTool::text("testTool", "result")])
        .interventions([Recorder(log.clone())])
        .printer(false)
        .build()
        .unwrap();
    let input = HookOrder::INTERVENTION_INPUT;
    let output = HookOrder::INTERVENTION_OUTPUT;
    for (offset, label) in [(-1, "before"), (1, "after")] {
        let l = log.clone();
        agent.add_hook_with(
            move |_: &mut BeforeToolCallEvent| l.lock().unwrap().push(label),
            order(offset, input),
        );
        let l = log.clone();
        agent.add_hook_with(
            move |_: &mut BeforeModelCallEvent<'_>| l.lock().unwrap().push(label),
            order(offset, input),
        );
        let l = log.clone();
        agent.add_hook_with(
            move |_: &mut AfterToolCallEvent| l.lock().unwrap().push(label),
            order(offset, output),
        );
        let l = log.clone();
        agent.add_hook_with(
            move |_: &mut AfterModelCallEvent<'_>| l.lock().unwrap().push(label),
            order(offset, output),
        );
    }

    agent.invoke("Test").await.unwrap();

    let model_call = ["before", "intervention", "after", "before", "intervention", "after"];
    let tool_call = ["before", "intervention", "after", "before", "intervention", "after"];
    let expected: Vec<&str> = model_call
        .iter()
        .chain(&tool_call)
        .chain(&model_call)
        .copied()
        .collect();
    assert_eq!(*log.lock().unwrap(), expected);
}

#[tokio::test]
async fn a_refused_inner_approval_reaches_after_tool_call_and_completes_the_outer_tool() {
    let executed = Arc::new(AtomicUsize::new(0));
    let outer = async_tool("outer", |_, context| async move {
        let refused = context
            .agent()
            .call_tool_without_interrupts("secret", json!({}), |error| {
                format!("refused: {}", error.interrupts[0].name)
            })
            .await
            .unwrap_err();
        Ok(serde_json::to_value(refused.result).unwrap())
    });
    let model = MockModel::new()
        .with_turn(tool_use_turn("outer", "tool-1", json!({})))
        .with_turn("Done");
    let hitl = HumanInTheLoop::new(HumanInTheLoopConfig {
        allowed_tools: vec!["outer".into()],
        ..Default::default()
    });
    let mut agent = Agent::builder()
        .model(model)
        .tools(vec![
            ToolSource::from(outer),
            ToolSource::from(counting_tool("secret", &executed)),
        ])
        .interventions([hitl])
        .printer(false)
        .build()
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    agent.add_hook(move |event: &mut AfterToolCallEvent| {
        if event.tool_use().name != "secret" {
            return;
        }
        recorded
            .lock()
            .unwrap()
            .push(serde_json::to_value(event.result()).unwrap());
        let mut result = event.result().clone();
        result.content = vec![strands::types::ToolResultContent::text("rewritten by a hook")];
        event.set_result(result);
    });

    let result = agent.invoke("Test").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(executed.load(Ordering::SeqCst), 0);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["toolUseId"], "tool-1:call:0");
    assert_eq!(seen[0]["status"], "error");
    assert_eq!(seen[0]["content"][0]["text"], "refused: strands:human-in-the-loop");
    let outer_result = serde_json::to_value(&agent.messages()[2]).unwrap();
    let returned = &outer_result["content"][0]["toolResult"]["content"][0]["json"];
    assert_eq!(returned["status"], "error");
    assert_eq!(returned["content"][0]["text"], "rewritten by a hook");
}
