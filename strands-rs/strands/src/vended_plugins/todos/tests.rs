use serde_json::json;

use super::*;
use crate::Agent;
use crate::Tool;
use crate::agent::DirectToolCallOptions;
use crate::testing::{MockModel, MockTurn, injection_context};
use crate::types::{ContentBlock, ToolResultContent, ToolResultStatus, ToolUseBlock};

fn sample_todos() -> Vec<TodoItem> {
    vec![
        TodoItem::new("Read code", "Reading code", TodoStatus::Completed),
        TodoItem::new("Write tests", "Writing tests", TodoStatus::InProgress),
        TodoItem::new("Ship", "Shipping", TodoStatus::Pending),
    ]
}

fn agent() -> Agent {
    agent_with(&Todos::default())
}

fn agent_with(todos: &Todos) -> Agent {
    Agent::builder()
        .model(MockModel::new())
        .tools([todos.todo_write_tool()])
        .printer(false)
        .build()
        .unwrap()
}

async fn write(agent: &mut Agent, todos: &[TodoItem]) -> String {
    let result = agent
        .tool("todo_write")
        .invoke_with(
            json!({"todos": todos}),
            DirectToolCallOptions {
                record_direct_tool_call: Some(false),
            },
        )
        .await
        .unwrap();
    match result.content.as_slice() {
        [ToolResultContent::Text(text)] => text.text.clone(),
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test]
async fn persists_the_list_and_reports_what_is_left() {
    let mut agent = agent();
    let result = write(&mut agent, &sample_todos()).await;
    assert_eq!(
        agent.app_state().get::<Vec<TodoItem>>("todos").unwrap(),
        Some(sample_todos())
    );
    assert_eq!(
        agent.app_state().get_value("todos").unwrap()[1],
        json!({"content": "Write tests", "activeForm": "Writing tests", "status": "in_progress"})
    );
    assert_eq!(
        result,
        "2 todos remaining\n  [completed] Read code\n  [in_progress] Writing tests\n  [pending] Ship"
    );
}

#[tokio::test]
async fn clears_the_state_when_given_an_empty_list() {
    let mut agent = agent();
    write(&mut agent, &sample_todos()).await;
    assert_eq!(write(&mut agent, &[]).await, "Todo list cleared");
    assert!(agent.app_state().get_value("todos").is_none());
}

#[tokio::test]
async fn clears_safely_when_no_list_was_ever_set() {
    let mut agent = agent();
    assert_eq!(write(&mut agent, &[]).await, "Todo list cleared");
    assert!(agent.app_state().get_value("todos").is_none());
}

#[test]
fn renders_the_current_list_as_a_reminder() {
    let context = injection_context(Vec::new());
    context.app_state.set("todos", sample_todos()).unwrap();
    let reminder = Todos::render_reminder("todos", &context).unwrap();
    assert_eq!(
        reminder,
        "<system-reminder>\nYour current todo list:\n  [completed] Read code\n  [in_progress] Writing tests\n  [pending] Ship\nKeep it up to date with todo_write as you work.\n</system-reminder>"
    );
}

#[test]
fn renders_no_reminder_when_the_list_is_empty() {
    let context = injection_context(Vec::new());
    assert!(Todos::render_reminder("todos", &context).is_none());
}

#[test]
fn exposes_the_todo_write_tool() {
    let todos = Todos::default();
    let names: Vec<String> = todos
        .get_tools()
        .into_iter()
        .flat_map(ToolSource::into_tools)
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(names, ["todo_write"]);
    assert_eq!(todos.name(), "strands:todos");
}

#[tokio::test]
async fn registers_the_re_surfacing_injector_on_init_agent() {
    let model = MockModel::new().with_turn("ok");
    let mut agent = Agent::builder()
        .model(model)
        .plugins([Todos::default()])
        .printer(false)
        .build()
        .unwrap();
    agent.app_state().set("todos", sample_todos()).unwrap();
    agent.invoke("go").await.unwrap();
    let injected: Vec<&ContentBlock> = agent.messages()[0]
        .content
        .iter()
        .filter(|block| matches!(block, ContentBlock::Injected(_)))
        .collect();
    assert_eq!(injected.len(), 1);
    assert!(agent.tool_registry().get("todo_write").is_some());
}

#[tokio::test]
async fn validates_its_input_against_the_model_facing_schema() {
    let mut agent = agent();
    let result = agent
        .tool("todo_write")
        .invoke(json!({"todos": [{"content": "x", "status": "pending"}]}))
        .await
        .unwrap();
    assert_eq!(result.status, ToolResultStatus::Error);
    let result = agent
        .tool("todo_write")
        .invoke(json!({"todos": [{"content": "Ship", "activeForm": "Shipping", "status": "nope"}]}))
        .await
        .unwrap();
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(write(&mut agent, &sample_todos()).await.contains("2 todos remaining"));
}

#[test]
fn has_the_todo_write_spec() {
    assert_eq!(
        serde_json::to_string(&Todos::default().todo_write_tool().tool_spec()).unwrap(),
        r#"{"name":"todo_write","description":"Create and maintain a structured task list for the current session. Use proactively for multi-step work (roughly 3+ distinct steps). Keep exactly one item in_progress at a time, and update status as you go rather than batching. The current list is re-surfaced to you before each step, so you do not need to restate it. Pass an empty list to clear it when the work is done.","inputSchema":{"type":"object","properties":{"todos":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string","description":"The task, imperative: \"Run tests\"."},"activeForm":{"type":"string","description":"Present continuous, shown while in progress: \"Running tests\"."},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["content","activeForm","status"],"additionalProperties":false},"description":"The full updated list."}},"required":["todos"],"additionalProperties":false}}"#
    );
}

#[tokio::test]
async fn strips_unknown_keys_from_todos_like_the_ts_schema() {
    let mut agent = agent();
    let result = agent
        .tool("todo_write")
        .invoke_with(
            json!({"todos": [{"id": "1", "priority": "high", "content": "Run tests", "activeForm": "Running tests", "status": "pending"}], "extra": true}),
            DirectToolCallOptions {
                record_direct_tool_call: Some(false),
            },
        )
        .await
        .unwrap();
    assert_eq!(result.status, ToolResultStatus::Success);
    assert_eq!(
        agent.app_state().get_value("todos").unwrap(),
        json!([{"content": "Run tests", "activeForm": "Running tests", "status": "pending"}])
    );
}

#[tokio::test]
async fn falls_back_to_the_content_of_an_in_progress_item_with_no_active_form() {
    let mut agent = agent();
    let result = write(&mut agent, &[TodoItem::new("Ship", "", TodoStatus::InProgress)]).await;
    assert_eq!(result, "1 todos remaining\n  [in_progress] Ship");
}

#[tokio::test]
async fn scopes_the_list_to_the_agent_not_the_plugin() {
    let todos = Todos::default();
    let mut first = agent_with(&todos);
    let second = agent_with(&todos);

    write(&mut first, &sample_todos()).await;

    assert_eq!(
        first.app_state().get::<Vec<TodoItem>>("todos").unwrap(),
        Some(sample_todos())
    );
    assert!(second.app_state().get_value("todos").is_none());
}

#[tokio::test]
async fn stores_the_list_under_a_configurable_state_key() {
    let mut agent = agent_with(&Todos::new(TodosConfig::builder().state_key("plan").build()));

    write(&mut agent, &sample_todos()).await;

    assert_eq!(
        agent.app_state().get::<Vec<TodoItem>>("plan").unwrap(),
        Some(sample_todos())
    );
    assert!(agent.app_state().get_value("todos").is_none());
}

#[test]
fn takes_a_configurable_plugin_name() {
    assert_eq!(Todos::new(TodosConfig::builder().name("plan").build()).name(), "plan");
    assert_eq!(Todos::default().name(), "strands:todos");
}

#[tokio::test]
async fn rejects_a_second_instance_even_under_a_different_plugin_name() {
    let mut agent = Agent::builder()
        .model(MockModel::new())
        .plugins([
            Todos::new(TodosConfig::builder().name("first").build()),
            Todos::new(TodosConfig::builder().name("second").state_key("other").build()),
        ])
        .printer(false)
        .build()
        .unwrap();

    let error = agent.initialize().await.unwrap_err();

    assert!(error.to_string().contains("todo_write"), "{error}");
}

#[tokio::test]
async fn re_surfaces_the_list_on_the_next_model_call_in_the_same_invocation() {
    let todos = json!({"todos": [{"content": "Run tests", "activeForm": "Running tests", "status": "in_progress"}]});
    let model = MockModel::new()
        .with_turn(MockTurn::content([ContentBlock::from(ToolUseBlock::new(
            "todo_write",
            "t1",
            todos,
        ))]))
        .with_turn("Done");
    let mut agent = Agent::builder()
        .model(model.clone())
        .plugins([Todos::default()])
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("go").await.unwrap();

    let reminded: Vec<bool> = model
        .requests()
        .iter()
        .map(|request| {
            request
                .messages
                .iter()
                .any(|message| message.text().contains("Your current todo list"))
        })
        .collect();
    assert_eq!(reminded, [false, true]);
}
