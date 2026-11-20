//! The order of the tool specs an agent sends to the model.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

mod common;

use std::sync::{Arc, Mutex};

use common::MockTool;
use strands::Agent;
use strands::middleware::InvokeModelStage;
use strands::testing::MockModel;
use strands::tools::Tool;
use strands::types::{ToolChoice, ToolSpec};

fn tools(names: &[&str]) -> Vec<Arc<dyn Tool>> {
    names
        .iter()
        .map(|name| Arc::new(MockTool::text(name, "OK")) as Arc<dyn Tool>)
        .collect()
}

fn sorted_agent(model: MockModel, registered: &[Arc<dyn Tool>]) -> Agent {
    let mut agent = Agent::builder()
        .model(model)
        .sort_tools(true)
        .printer(false)
        .build()
        .unwrap();
    agent.tool_registry_mut().add(registered.to_vec()).unwrap();
    agent
}

fn names(tools: &[Arc<dyn Tool>]) -> Vec<String> {
    tools.iter().map(|tool| tool.name().to_owned()).collect()
}

fn spec_names(specs: &[ToolSpec]) -> Vec<String> {
    specs.iter().map(|spec| spec.name.clone()).collect()
}

#[tokio::test]
async fn sends_specs_sorted_by_name_and_keeps_registry_order() {
    let tools = tools(&["zebra", "alpha", "Bravo"]);
    let reversed: Vec<_> = tools.iter().rev().cloned().collect();
    for registered in [tools.clone(), reversed] {
        let model = MockModel::new().with_turn("OK");
        let mut agent = sorted_agent(model.clone(), &registered);
        agent.invoke("hello").await.unwrap();

        assert_eq!(spec_names(&model.requests()[0].tool_specs), ["Bravo", "alpha", "zebra"]);
        assert_eq!(names(&agent.tools()), names(&registered));
    }
}

#[tokio::test]
async fn sorts_before_middleware_and_sends_middleware_output_as_is() {
    let tools = tools(&["zebra", "alpha", "Bravo"]);
    let model = MockModel::new().with_turn("OK");
    let mut agent = sorted_agent(model.clone(), &tools[..2]);
    let middleware_specs: Vec<ToolSpec> = tools.iter().map(|tool| tool.tool_spec()).collect();
    let choice = ToolChoice::Tool {
        name: "zebra".to_owned(),
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (sent, slot, sent_choice) = (middleware_specs.clone(), seen.clone(), choice.clone());
    agent.add_middleware(InvokeModelStage::wrap(move |mut context, next| {
        slot.lock().unwrap().push(spec_names(&context.tool_specs));
        context.tool_specs = sent.clone();
        context.tool_choice = Some(sent_choice.clone());
        next.call(context)
    }));

    agent.invoke("hello").await.unwrap();

    assert_eq!(*seen.lock().unwrap(), [vec!["alpha".to_owned(), "zebra".to_owned()]]);
    let request = &model.requests()[0];
    assert_eq!(request.tool_specs, middleware_specs);
    assert_eq!(request.tool_choice, Some(choice));
    assert_eq!(names(&agent.tools()), names(&tools[..2]));
}
