use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::agent::{Agent, InvocationContext, InvocationState, InvokeLimits};
use crate::models::streaming::Usage;
use crate::testing::{MockModel, MockTurn};
use crate::tools::{STRUCTURED_OUTPUT_TOOL_NAME, ToolOutcome};
use crate::types::{ContentBlock, Snapshot, StopReason, ToolResultBlock, ToolUse, ToolUseBlock};

fn tool_use_turn(name: &str, id: &str, input: JsonValue) -> MockTurn {
    MockTurn::content([ContentBlock::from(ToolUseBlock::new(name, id, input))])
}

fn agent_model(name: &str, input: JsonValue) -> MockModel {
    MockModel::new()
        .with_turn(tool_use_turn(name, "tool-1", input))
        .with_turn("Done")
}

fn classifier_model(requires_approval: bool, reason: &str) -> MockModel {
    MockModel::new().with_turn(tool_use_turn(
        STRUCTURED_OUTPUT_TOOL_NAME,
        "inner-1",
        json!({"requiresApproval": requires_approval, "reason": reason}),
    ))
}

#[derive(Clone, Default)]
struct Counter(Arc<AtomicUsize>);

impl Counter {
    fn get(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }

    fn bump(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn tool(name: &str, runs: &Counter) -> crate::test_support::MockTool {
    let runs = runs.clone();
    crate::test_support::MockTool::new(name).with_result(move |context| {
        runs.bump();
        ToolOutcome::Result(ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]))
    })
}

fn agent(model: MockModel, tools: Vec<crate::test_support::MockTool>, hitl: HumanInTheLoop) -> Agent {
    Agent::builder()
        .model(model)
        .tools(tools)
        .interventions([hitl])
        .printer(false)
        .build()
        .unwrap()
}

fn hitl(config: HumanInTheLoopConfig) -> HumanInTheLoop {
    HumanInTheLoop::new(config)
}

fn answering(answer: Option<JsonValue>, asks: &Counter) -> HumanInTheLoopAsk {
    let asks = asks.clone();
    HumanInTheLoopAsk::callback(move |_prompt: String| {
        asks.bump();
        let answer = answer.clone();
        async move { Ok(answer) }
    })
}

fn recording(answer: &'static str, prompts: &Arc<Mutex<Vec<String>>>) -> HumanInTheLoopAsk {
    let prompts = prompts.clone();
    HumanInTheLoopAsk::callback(move |prompt: String| {
        prompts.lock().unwrap().push(prompt);
        async move { Ok(Some(json!(answer))) }
    })
}

fn allowed(tools: &[&str]) -> Vec<String> {
    tools.iter().map(|tool| (*tool).to_owned()).collect()
}

fn tool_result_text(agent: &Agent) -> Option<String> {
    agent
        .messages()
        .iter()
        .find_map(|message| {
            message.content.iter().find_map(|block| match block {
                ContentBlock::ToolResult(result) => {
                    Some(serde_json::to_value(result).unwrap()["content"][0]["text"].clone())
                }
                _ => None,
            })
        })
        .and_then(|text| text.as_str().map(str::to_owned))
}

#[tokio::test]
async fn pauses_agent_with_interrupt_on_any_tool_call() {
    let runs = Counter::default();
    let mut agent = agent(
        agent_model("anyTool", json!({"x": 1})),
        vec![tool("anyTool", &runs)],
        HumanInTheLoop::default(),
    );

    let result = agent.invoke("Do something").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(result.interrupts().len(), 1);
    assert_eq!(result.interrupts()[0].name, "strands:human-in-the-loop");
    assert_eq!(
        result.interrupts()[0].reason,
        Some(json!("Approve \"anyTool\"?\n  Input: {\"x\":1}"))
    );
    assert_eq!(runs.get(), 0);
}

#[tokio::test]
async fn allows_tool_execution_when_approved() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        ask: Some(answering(Some(json!("y")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("myTool", json!({})),
        vec![tool("myTool", &runs)],
        hitl(config),
    );

    let result = agent.invoke("Run tool").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(runs.get(), 1);
}

#[tokio::test]
async fn denies_tool_execution_when_rejected() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        ask: Some(answering(Some(json!("n")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("myTool", json!({})),
        vec![tool("myTool", &runs)],
        hitl(config),
    );

    let result = agent.invoke("Run tool").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(runs.get(), 0);
}

#[tokio::test]
async fn does_not_prompt_for_tools_in_allowed_tools() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        allowed_tools: allowed(&["safeTool"]),
        ask: Some(answering(Some(json!("n")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("safeTool", json!({})),
        vec![tool("safeTool", &runs)],
        hitl(config),
    );

    agent.invoke("Run").await.unwrap();

    assert_eq!(asks.get(), 0);
    assert_eq!(runs.get(), 1);
}

#[tokio::test]
async fn prompts_for_tools_not_in_allowed_tools() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        allowed_tools: allowed(&["safeTool"]),
        ask: Some(answering(Some(json!("y")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("riskyTool", json!({})),
        vec![tool("riskyTool", &runs)],
        hitl(config),
    );

    agent.invoke("Run").await.unwrap();

    assert_eq!(asks.get(), 1);
    assert_eq!(runs.get(), 1);
}

#[tokio::test]
async fn allows_all_tools_except_negated_ones_with_bang_prefix() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let model = MockModel::new()
        .with_turn(tool_use_turn("readFile", "tool-1", json!({})))
        .with_turn(tool_use_turn("deleteFile", "tool-2", json!({})))
        .with_turn("Done");
    let config = HumanInTheLoopConfig {
        allowed_tools: allowed(&["*", "!deleteFile"]),
        ask: Some(answering(Some(json!("n")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(
        model,
        vec![tool("readFile", &runs), tool("deleteFile", &runs)],
        hitl(config),
    );

    agent.invoke("Run").await.unwrap();

    assert_eq!(asks.get(), 1);
    assert_eq!(runs.get(), 1);
}

#[tokio::test]
async fn allows_all_tools_with_wildcard_star() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        allowed_tools: allowed(&["*"]),
        ask: Some(answering(Some(json!("n")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("anyTool", json!({})),
        vec![tool("anyTool", &runs)],
        hitl(config),
    );

    agent.invoke("Run").await.unwrap();

    assert_eq!(asks.get(), 0);
    assert_eq!(runs.get(), 1);
}

#[tokio::test]
async fn passes_tool_name_and_input_in_the_prompt() {
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let config = HumanInTheLoopConfig {
        ask: Some(recording("yes", &prompts)),
        ..Default::default()
    };
    let runs = Counter::default();
    let mut agent = agent(
        agent_model("sendEmail", json!({"to": "bob@example.com"})),
        vec![tool("sendEmail", &runs)],
        hitl(config),
    );

    agent.invoke("Send email").await.unwrap();

    let prompts = prompts.lock().unwrap();
    assert_eq!(
        prompts[0],
        "Approve \"sendEmail\"?\n  Input: {\"to\":\"bob@example.com\"}"
    );
}

#[tokio::test]
async fn supports_custom_evaluate_function() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        ask: Some(answering(Some(json!("magic-word")), &asks)),
        evaluate: Some(Evaluate::new(|response: &JsonValue| response == &json!("magic-word"))),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("myTool", json!({})),
        vec![tool("myTool", &runs)],
        hitl(config),
    );

    let result = agent.invoke("Go").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(runs.get(), 1);
}

fn two_calls_model() -> MockModel {
    MockModel::new()
        .with_turn(tool_use_turn("myTool", "tool-1", json!({})))
        .with_turn(tool_use_turn("myTool", "tool-2", json!({})))
        .with_turn("Done")
}

#[tokio::test]
async fn trusts_a_tool_for_the_session_when_response_is_t() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        enable_trust: Some(true),
        ask: Some(answering(Some(json!("t")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(two_calls_model(), vec![tool("myTool", &runs)], hitl(config));

    agent.invoke("Run twice").await.unwrap();

    assert_eq!(asks.get(), 1);
    assert_eq!(runs.get(), 2);
    assert_eq!(agent.app_state().get_value(TRUSTED_TOOLS_KEY), Some(json!(["myTool"])));
}

#[tokio::test]
async fn does_not_trust_when_enable_trust_is_false_even_with_t_response() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        ask: Some(answering(Some(json!("t")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(two_calls_model(), vec![tool("myTool", &runs)], hitl(config));

    agent.invoke("Run twice").await.unwrap();

    assert_eq!(asks.get(), 2);
    assert_eq!(runs.get(), 0);
    assert_eq!(agent.app_state().get_value(TRUSTED_TOOLS_KEY), None);
}

#[tokio::test]
async fn t_response_also_approves_the_current_tool_call() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        enable_trust: Some(true),
        ask: Some(answering(Some(json!("t")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("myTool", json!({})),
        vec![tool("myTool", &runs)],
        hitl(config),
    );

    agent.invoke("Run").await.unwrap();

    assert_eq!(runs.get(), 1);
}

#[tokio::test]
async fn trusts_when_response_is_trust_t_or_upper_case_trust() {
    for answer in ["trust", "T", "TRUST"] {
        let (runs, asks) = (Counter::default(), Counter::default());
        let config = HumanInTheLoopConfig {
            enable_trust: Some(true),
            ask: Some(answering(Some(json!(answer)), &asks)),
            ..Default::default()
        };
        let mut agent = agent(two_calls_model(), vec![tool("myTool", &runs)], hitl(config));
        agent.invoke("Run twice").await.unwrap();
        assert_eq!((asks.get(), runs.get()), (1, 2), "{answer}");
    }
}

#[tokio::test]
async fn supports_custom_evaluate_trust_function() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        enable_trust: Some(true),
        evaluate_trust: Some(Evaluate::new(|response: &JsonValue| response == &json!("always"))),
        ask: Some(answering(Some(json!("always")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(two_calls_model(), vec![tool("myTool", &runs)], hitl(config));

    agent.invoke("Run twice").await.unwrap();

    assert_eq!(asks.get(), 1);
    assert_eq!(runs.get(), 2);
}

#[tokio::test]
async fn negated_tools_cannot_be_trusted_even_with_t_response() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        allowed_tools: allowed(&["!myTool"]),
        enable_trust: Some(true),
        ask: Some(answering(Some(json!("t")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(two_calls_model(), vec![tool("myTool", &runs)], hitl(config));

    agent.invoke("Run twice").await.unwrap();

    assert_eq!(asks.get(), 2);
    assert_eq!(runs.get(), 0);
    assert_eq!(agent.app_state().get_value(TRUSTED_TOOLS_KEY), None);
}

fn agent_with_state(trusted: JsonValue, config: HumanInTheLoopConfig, runs: &Counter) -> Agent {
    let mut app_state = crate::types::JsonObject::new();
    app_state.insert(TRUSTED_TOOLS_KEY.to_owned(), trusted);
    Agent::builder()
        .model(agent_model("myTool", json!({})))
        .tools([tool("myTool", runs)])
        .app_state(app_state)
        .interventions([hitl(config)])
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn ignores_trusted_tools_in_agent_state_when_enable_trust_is_false() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        ask: Some(answering(Some(json!("n")), &asks)),
        ..Default::default()
    };
    let mut agent = agent_with_state(json!(["myTool"]), config, &runs);

    agent.invoke("Run tool").await.unwrap();

    assert_eq!(asks.get(), 1);
    assert_eq!(runs.get(), 0);
}

#[tokio::test]
async fn ignores_a_trusted_tools_value_that_is_malformed() {
    for trusted in [
        json!("myTool"),
        json!(42),
        json!({"myTool": true}),
        json!(["myTool", 1]),
    ] {
        let (runs, asks) = (Counter::default(), Counter::default());
        let config = HumanInTheLoopConfig {
            enable_trust: Some(true),
            ask: Some(answering(Some(json!("n")), &asks)),
            ..Default::default()
        };
        let mut agent = agent_with_state(trusted.clone(), config, &runs);
        agent.invoke("Run tool").await.unwrap();
        assert_eq!((asks.get(), runs.get()), (1, 0), "{trusted}");
    }
}

#[tokio::test]
async fn replaces_a_malformed_trusted_tools_value_when_a_tool_is_trusted() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        enable_trust: Some(true),
        ask: Some(answering(Some(json!("t")), &asks)),
        ..Default::default()
    };
    let mut agent = agent_with_state(json!({"myTool": true}), config, &runs);

    agent.invoke("Run tool").await.unwrap();

    assert_eq!(agent.app_state().get_value(TRUSTED_TOOLS_KEY), Some(json!(["myTool"])));
}

#[tokio::test]
async fn denies_without_pausing_when_the_human_rejects_or_returns_no_answer() {
    let cases = [
        (
            Some(json!("n")),
            "DENIED: Tool \"myTool\" denied: the human rejected the call.",
        ),
        (
            None,
            "DENIED: Tool \"myTool\" denied: approval callback returned no response.",
        ),
    ];
    for (answer, expected) in cases {
        let (runs, asks) = (Counter::default(), Counter::default());
        let config = HumanInTheLoopConfig {
            ask: Some(answering(answer, &asks)),
            ..Default::default()
        };
        let mut agent = agent(
            agent_model("myTool", json!({})),
            vec![tool("myTool", &runs)],
            hitl(config),
        );
        let result = agent.invoke("Run tool").await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(runs.get(), 0);
        assert_eq!(tool_result_text(&agent).as_deref(), Some(expected));
    }
}

async fn interrupt_id_for_tool_call() -> String {
    let runs = Counter::default();
    let mut agent = agent(
        agent_model("myTool", json!({})),
        vec![tool("myTool", &runs)],
        HumanInTheLoop::default(),
    );
    agent.invoke("Run tool").await.unwrap().interrupts()[0].id.clone()
}

async fn restore_interrupt_response(agent: &mut Agent, response: &str) {
    let id = interrupt_id_for_tool_call().await;
    let snapshot: Snapshot = serde_json::from_value(json!({
        "scope": "agent",
        "schemaVersion": crate::types::SNAPSHOT_SCHEMA_VERSION,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "data": {
            "interrupts": {
                "interrupts": {
                    id.clone(): {"id": id, "name": "strands:human-in-the-loop", "response": response, "source": "hook"}
                },
                "activated": false
            }
        },
        "appData": {}
    }))
    .unwrap();
    agent.load_snapshot(&snapshot).unwrap();
}

#[tokio::test]
async fn uses_the_live_ask_answer_over_a_restored_answer() {
    let (runs, asks) = (Counter::default(), Counter::default());
    let config = HumanInTheLoopConfig {
        ask: Some(answering(Some(json!("n")), &asks)),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("myTool", json!({})),
        vec![tool("myTool", &runs)],
        hitl(config),
    );
    restore_interrupt_response(&mut agent, "y").await;

    agent.invoke("Run tool").await.unwrap();

    assert_eq!(asks.get(), 1);
    assert_eq!(runs.get(), 0);
}

#[tokio::test]
async fn applies_a_restored_answer_when_no_ask_callback_is_configured() {
    let runs = Counter::default();
    let mut agent = agent(
        agent_model("myTool", json!({})),
        vec![tool("myTool", &runs)],
        HumanInTheLoop::default(),
    );
    restore_interrupt_response(&mut agent, "y").await;

    let result = agent.invoke("Run tool").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(runs.get(), 1);
}

fn llm(model: &MockModel) -> Option<ClassifierConfig> {
    Some(
        LlmClassifierConfig {
            model: Some(Arc::new(model.clone())),
            ..Default::default()
        }
        .into(),
    )
}

#[tokio::test]
async fn classifier_true_uses_built_in_llm_risk_classifier() {
    let runs = Counter::default();
    let classifier = classifier_model(true, "destructive operation");
    let config = HumanInTheLoopConfig {
        classifier: llm(&classifier),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("deleteFile", json!({"path": "/data"})),
        vec![tool("deleteFile", &runs)],
        hitl(config),
    );

    let result = agent.invoke("Delete the file").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(runs.get(), 0);
    assert_eq!(
        result.interrupts()[0].reason,
        Some(json!(
            "Approve \"deleteFile\" \u{2014} destructive operation?\n  Input: {\"path\":\"/data\"}"
        ))
    );
    let request = &classifier.requests()[0];
    assert_eq!(request.system_prompt, Some(default_system_prompt_for_test().into()));
    assert_eq!(
        request.messages[0].text(),
        "Should this tool call require human approval?\n\nTool: deleteFile\nInput: {\n  \"path\": \"/data\"\n}"
    );
}

fn default_system_prompt_for_test() -> String {
    classifier::default_system_prompt()
}

#[tokio::test]
async fn classifier_true_evaluates_with_agent_aux_model_when_no_classifier_model_is_configured() {
    let aux = classifier_model(true, "destructive operation");
    let model = agent_model("deleteFile", json!({"path": "/data"}));
    let runs = Counter::default();
    let mut agent = Agent::builder()
        .model(model.clone())
        .aux_model(aux.clone())
        .tools([tool("deleteFile", &runs)])
        .interventions([hitl(HumanInTheLoopConfig {
            classifier: Some(ClassifierConfig::llm()),
            ..Default::default()
        })])
        .printer(false)
        .build()
        .unwrap();

    let result = agent.invoke("Delete the file").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(aux.requests().len(), 1);
    assert_eq!(model.requests().len(), 1);
}

#[tokio::test]
async fn classifier_true_allows_tool_when_llm_says_no_approval_needed() {
    let runs = Counter::default();
    let config = HumanInTheLoopConfig {
        classifier: llm(&classifier_model(false, "read-only operation")),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("readFile", json!({"path": "/tmp/x"})),
        vec![tool("readFile", &runs)],
        hitl(config),
    );

    let result = agent.invoke("Read the file").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(runs.get(), 1);
}

#[tokio::test]
async fn allowed_tools_bypasses_classifier() {
    let runs = Counter::default();
    let classifier = MockModel::new().with_turn("unused");
    let config = HumanInTheLoopConfig {
        allowed_tools: allowed(&["readFile"]),
        classifier: llm(&classifier),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("readFile", json!({})),
        vec![tool("readFile", &runs)],
        hitl(config),
    );

    let result = agent.invoke("Read").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert_eq!(runs.get(), 1);
    assert!(classifier.requests().is_empty());
}

#[tokio::test]
async fn custom_classifier_function_works() {
    let runs = Counter::default();
    let config = HumanInTheLoopConfig {
        classifier: Some(ClassifierConfig::custom(|event: &BeforeToolCallEvent| {
            let deploy = event.tool_use().name == "deploy";
            async move { Ok(ClassifierResult::new(deploy).with_reason("deployment requires approval")) }
        })),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("deploy", json!({"env": "prod"})),
        vec![tool("deploy", &runs)],
        hitl(config),
    );

    let result = agent.invoke("Deploy").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(runs.get(), 0);
}

#[tokio::test]
async fn includes_classifier_reason_in_prompt() {
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let config = HumanInTheLoopConfig {
        classifier: Some(ClassifierConfig::custom(|_: &BeforeToolCallEvent| async {
            Ok(ClassifierResult::new(true).with_reason("external communication"))
        })),
        ask: Some(recording("no", &prompts)),
        ..Default::default()
    };
    let runs = Counter::default();
    let mut agent = agent(
        agent_model("sendEmail", json!({"to": "all@co.com"})),
        vec![tool("sendEmail", &runs)],
        hitl(config),
    );

    agent.invoke("Send email").await.unwrap();

    assert_eq!(
        prompts.lock().unwrap()[0],
        "Approve \"sendEmail\" \u{2014} external communication?\n  Input: {\"to\":\"all@co.com\"}"
    );
}

#[tokio::test]
async fn a_failing_classifier_requires_approval() {
    let runs = Counter::default();
    let config = HumanInTheLoopConfig {
        classifier: Some(ClassifierConfig::custom(|_: &BeforeToolCallEvent| async {
            Err::<ClassifierResult, BoxError>("classifier down".into())
        })),
        ..Default::default()
    };
    let mut agent = agent(
        agent_model("deploy", json!({})),
        vec![tool("deploy", &runs)],
        hitl(config),
    );

    let result = agent.invoke("Deploy").await.unwrap();

    assert_eq!(result.stop_reason(), StopReason::Interrupt);
}

#[tokio::test]
async fn adds_the_classifier_usage_to_the_request_total_and_runs_it_past_a_spent_limit() {
    let classifier = MockModel::new().with_turn(
        tool_use_turn(
            STRUCTURED_OUTPUT_TOOL_NAME,
            "inner-1",
            json!({"requiresApproval": false, "reason": "read-only operation"}),
        )
        .with_usage(Usage::new(12, 3, 15)),
    );
    let handler = hitl(HumanInTheLoopConfig {
        classifier: llm(&classifier),
        ..Default::default()
    });
    let parent = InvocationContext::new(Some(InvokeLimits {
        turns: Some(1),
        ..Default::default()
    }));
    for _ in 0..5 {
        parent.record_turn();
    }
    let agent = crate::test_support::local_agent()
        .tool_agent()
        .with_invocation_context(Some(parent.clone()));
    let mut event = BeforeToolCallEvent::new(
        agent,
        InvocationState::new(),
        ToolUse::new("readFile", "tool-1", json!({"path": "/tmp/x"})),
        None,
    );

    let action = handler.before_tool_call(&mut event).await.unwrap();

    assert_eq!(action.action_type(), "proceed");
    let usage = parent.usage();
    assert_eq!(
        (
            usage.turns_taken,
            usage.usage.input_tokens,
            usage.usage.output_tokens,
            usage.usage.total_tokens
        ),
        (5, 12, 3, 15)
    );
}

#[test]
fn answers_are_trimmed_of_javascript_whitespace() {
    assert!(is_trust_response(&json!("\u{feff}t\u{feff}")));
    assert!(default_evaluate(&json!("\u{feff} yes\u{2028}")));
    assert!(!is_trust_response(&json!("\u{85}trust")));
    assert!(!default_evaluate(&json!("y\u{85}")));
}

#[test]
fn the_config_builder_takes_a_classifier_closure() {
    let config = HumanInTheLoopConfig::builder()
        .classifier(|_event: &BeforeToolCallEvent| async { Ok(ClassifierResult::new(true)) })
        .build();
    assert!(matches!(config.classifier, Some(ClassifierConfig::Custom(_))));
}
