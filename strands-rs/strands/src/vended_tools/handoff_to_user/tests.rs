use super::*;
use crate::Agent;
use crate::testing::{MockModel, MockTurn};
use crate::tools::{Tool, ToolOutcome};
use crate::types::{ContentBlock, InterruptResponse, StopReason, ToolResultContent, ToolUseBlock};
use crate::vended_tools::test_support::{agent, context, error_text, outcome};

fn tool_use(name: &str, id: &str, message: &str) -> MockTurn {
    MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(
        name,
        id,
        json!({"message": message}),
    ))])
}

fn handoff_agent(tool: FunctionTool, model: MockModel) -> Agent {
    Agent::builder()
        .model(model)
        .tools([tool])
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn raises_an_interrupt_carrying_the_message_and_stable_name_on_first_call() {
    let tool = handoff_to_user();
    let agent = agent();
    let ToolOutcome::Interrupt(error) =
        outcome(&tool, context(&tool, json!({"message": "please confirm"}), &agent)).await
    else {
        panic!("expected an interrupt");
    };
    let interrupt = &error.interrupts[0];
    assert_eq!(interrupt.name, HANDOFF_INTERRUPT_NAME);
    assert_eq!(interrupt.reason, Some(json!("please confirm")));
}

#[tokio::test]
async fn rejects_blank_message_without_registering_an_interrupt() {
    for blank in ["", "   "] {
        let agent = agent();
        let message = error_text(&handoff_to_user(), json!({"message": blank}), &agent).await;
        assert!(message.contains("must not be empty"), "{message}");
        assert!(agent.interrupt_state().interrupt_list().is_empty());
    }
}

#[tokio::test]
async fn rejects_a_non_string_message_without_registering_an_interrupt() {
    let agent = agent();
    let message = error_text(&handoff_to_user(), json!({"message": 42}), &agent).await;
    assert!(message.contains("expected string"), "{message}");
    assert!(agent.interrupt_state().interrupt_list().is_empty());
}

#[test]
fn exposes_the_default_name_and_input_schema() {
    let tool = handoff_to_user();
    assert_eq!(tool.name(), "handoff_to_user");
    let schema = tool.tool_spec().input_schema.unwrap();
    assert!(schema["properties"].get("message").is_some());
    assert!(schema["properties"].get("tool_context").is_none());
    assert_eq!(schema["required"], json!(["message"]));
}

#[test]
fn customizes_the_name_and_description_via_the_factory() {
    let tool = make_handoff_to_user(
        MakeHandoffToUserOptions::builder()
            .name("ask_user")
            .description("my desc")
            .build(),
    );
    assert_eq!(tool.name(), "ask_user");
    assert_eq!(tool.tool_spec().description, "my desc");
}

#[tokio::test]
async fn halts_with_stop_reason_interrupt_and_the_message_as_the_reason() {
    let model = MockModel::new()
        .with_turn(tool_use("handoff_to_user", "htu-1", "What is your address?"))
        .with_turn("Thanks, got it.");
    let mut agent = handoff_agent(handoff_to_user(), model);
    let result = agent.invoke("Process my order").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(result.interrupts().len(), 1);
    assert_eq!(result.interrupts()[0].name, HANDOFF_INTERRUPT_NAME);
    assert_eq!(result.interrupts()[0].reason, Some(json!("What is your address?")));
}

#[tokio::test]
async fn returns_the_reply_as_the_tool_result_and_the_model_continues_on_resume() {
    let model = MockModel::new()
        .with_turn(tool_use("handoff_to_user", "htu-2", "Confirm your email"))
        .with_turn("All done.");
    let mut agent = handoff_agent(handoff_to_user(), model);
    let result = agent.invoke("Verify me").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    let answer = InterruptResponse::new(result.interrupts()[0].id.clone(), "yes@example.com");
    let resumed = agent.invoke(vec![answer]).await.unwrap();
    assert_eq!(resumed.stop_reason(), StopReason::EndTurn);
    assert!(resumed.to_string().contains("All done"));
    let tool_result = agent
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .find_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(result.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(tool_result.content, vec![ToolResultContent::text("yes@example.com")]);
}

#[tokio::test]
async fn reports_the_stable_interrupt_name_even_when_the_tool_is_renamed() {
    let ask_user = make_handoff_to_user(MakeHandoffToUserOptions::builder().name("ask_user").build());
    let model = MockModel::new()
        .with_turn(tool_use("ask_user", "htu-3", "Enter PIN"))
        .with_turn("PIN accepted.");
    let mut agent = handoff_agent(ask_user, model);
    let result = agent.invoke("Authenticate").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(result.interrupts()[0].name, HANDOFF_INTERRUPT_NAME);
}
