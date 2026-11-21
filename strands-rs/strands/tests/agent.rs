//! The agent loop through the public API.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests report failures by panicking"
)]

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{MockTool, collect, text_model, tool_use_turn, types};
use futures::StreamExt;
use serde_json::json;
use strands::context_manager::ContextManagerStrategy;
use strands::hooks::{AfterInvocationEvent, AfterToolsEvent, BeforeModelCallEvent, BeforeToolsEvent, InterruptEvent};
use strands::models::{BaseModelConfig, BoxStream, CountTokensOptions, ModelRequest};
use strands::storage::{InMemoryStorage, Storage};
use strands::testing::{MockModel, MockTurn};
use strands::tools::STRUCTURED_OUTPUT_TOOL_NAME;
use strands::types::{InjectedBlock, ToolResultContent, ToolUseBlock};
use strands::{
    AddMessagesContext, CandidateModel, ExtractionConfig, ExtractionTrigger, IntervalTrigger, IntervalTriggerOptions,
    MemoryEntry, MemoryManagerConfig, MemoryStore, ModelRouter, ModelRouterOptions, SearchOptions, SessionManager,
};
use strands::{
    Agent, AgentResult, AgentStreamEvent, ContentBlock, Error, InterruptResponse, InvokeArgs, InvokeLimits,
    InvokeOptions, JsonValue, Message, Model, ModelStreamEvent, Role, StopReason, SystemPrompt, ToolResultBlock,
    ToolSource, Usage,
};

fn agent(model: MockModel) -> Agent {
    Agent::builder().model(model).printer(false).build().unwrap()
}

fn agent_with_tools(model: MockModel, tools: impl IntoIterator<Item = impl Into<ToolSource>>) -> Agent {
    Agent::builder()
        .model(model)
        .tools(tools)
        .printer(false)
        .build()
        .unwrap()
}

fn ok_tool(name: &str, text: &str) -> MockTool {
    MockTool::text(name, text)
}

fn tool_turn_with_usage(name: &str, id: &str, usage: Usage) -> MockTurn {
    tool_use_turn(name, id, json!({})).with_usage(usage)
}

fn limits(limits: InvokeLimits) -> InvokeOptions {
    InvokeOptions {
        limits: Some(limits),
        ..InvokeOptions::default()
    }
}

/// Asserts a result's stop reason, final assistant text and cycle count.
fn assert_result(result: &AgentResult, stop_reason: &StopReason, text: &str, cycles: u64) {
    assert_eq!(&result.stop_reason(), stop_reason);
    assert_eq!(result.last_message().role, Role::Assistant);
    assert_eq!(result.last_message().text(), text);
    assert_eq!(result.metrics().unwrap().cycle_count, cycles);
}

fn tool_names(result: &AgentResult) -> Vec<String> {
    let metrics = result.metrics().unwrap();
    metrics.tool_metrics.iter().map(|(name, _)| name.clone()).collect()
}

fn usage(result: &AgentResult) -> Usage {
    result.metrics().unwrap().accumulated_usage
}

fn blocks(value: JsonValue) -> Vec<ContentBlock> {
    serde_json::from_value(value).unwrap()
}

fn message(value: JsonValue) -> Message {
    serde_json::from_value(value).unwrap()
}

fn content_json(message: &Message) -> JsonValue {
    serde_json::to_value(&message.content).unwrap()
}

mod stream {
    use super::*;

    #[tokio::test]
    async fn returns_async_generator() {
        let mut agent = agent(text_model(&["Hello"]));
        let stream = agent.stream("Test prompt");
        fn assert_stream<S: futures::Stream + Unpin + Send>(_: &S) {}
        assert_stream(&stream);
    }

    #[tokio::test]
    async fn returns_async_generator_that_can_be_iterated_without_type_errors() {
        let mut agent = agent(text_model(&["Hello"]));
        let mut stream = agent.stream("Test prompt");
        while let Some(event) = stream.next().await {
            event.unwrap();
        }
    }

    #[tokio::test]
    async fn yields_agent_stream_event_objects() {
        let mut agent = agent(text_model(&["Hello"]));
        let events = collect(agent.stream("Test prompt")).await;
        assert!(!events.is_empty());
        assert_eq!(
            serde_json::to_value(&events[0]).unwrap(),
            json!({"type": "beforeInvocationEvent"})
        );
        assert_eq!(agent.messages()[0].text(), "Test prompt");
    }

    #[tokio::test]
    async fn returns_agent_result_as_generator_return_value() {
        let mut agent = agent(text_model(&["Hello"]));
        let events = collect(agent.stream("Test prompt")).await;
        let Some(AgentStreamEvent::AgentResult(result)) = events.last() else {
            panic!("the stream ends with the result");
        };
        assert_result(result, &StopReason::EndTurn, "Hello", 1);
    }

    #[tokio::test]
    async fn handles_tool_execution_flow() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn("Tool result processed");
        let mut agent = agent_with_tools(model, [ok_tool("testTool", "Tool executed")]);
        let events = collect(agent.stream("Use the tool")).await;
        let kinds = types(&events);
        assert!(kinds.contains(&"beforeToolsEvent") && kinds.contains(&"afterToolsEvent"));
        let Some(AgentStreamEvent::AgentResult(result)) = events.last() else {
            panic!("the stream ends with the result");
        };
        assert_eq!(result.stop_reason(), StopReason::EndTurn);
    }

    #[tokio::test]
    async fn yields_tool_related_events() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn("Done");
        let mut agent = agent_with_tools(model, [ok_tool("testTool", "Success")]);
        let events = collect(agent.stream("Test")).await;
        let find = |kind: &str| {
            let event = events.iter().find(|event| event.event_type() == kind).unwrap();
            let mut value = serde_json::to_value(event).unwrap();
            value["message"].as_object_mut().unwrap().remove("trackingId");
            value
        };
        assert_eq!(
            find("beforeToolsEvent"),
            json!({"type": "beforeToolsEvent", "message": {"role": "assistant", "content": [
                {"toolUse": {"name": "testTool", "toolUseId": "tool-1", "input": {}}}
            ]}})
        );
        assert_eq!(
            find("afterToolsEvent"),
            json!({"type": "afterToolsEvent", "message": {"role": "user", "content": [
                {"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"text": "Success"}]}}
            ]}})
        );
    }

    #[tokio::test]
    async fn throws_max_tokens_error_when_model_hits_token_limit() {
        let model = MockModel::new().with_turn(MockTurn::text("Partial...").with_stop_reason(StopReason::MaxTokens));
        let mut agent = agent(model);
        let mut stream = agent.stream("Test");
        let mut error = None;
        while let Some(item) = stream.next().await {
            if let Err(failure) = item {
                error = Some(failure);
            }
        }
        assert!(matches!(error, Some(Error::MaxTokens(_))));
    }

    #[tokio::test]
    async fn fires_after_invocation_event_when_consumer_breaks_from_stream_and_allows_reinvocation() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn("Done");
        let mut agent = agent_with_tools(model, [ok_tool("testTool", "ok")]);
        let fired = Arc::new(Mutex::new(0));
        let counter = fired.clone();
        agent.add_hook(move |_: &mut AfterInvocationEvent<'_>| *counter.lock().unwrap() += 1);
        {
            let mut stream = agent.stream("Test");
            while let Some(event) = stream.next().await {
                if event.unwrap().event_type() == "beforeToolsEvent" {
                    break;
                }
            }
        }
        // The dropped stream is a cancel: history closes with the cancel message and the
        // AfterInvocationEvent hooks run when the agent is next called.
        assert_eq!(common::texts(&agent), ["Test", "Cancelled by user"]);
        assert_eq!(*fired.lock().unwrap(), 0);
        let result = agent.invoke("Test again").await.unwrap();
        assert_eq!(*fired.lock().unwrap(), 2);
        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(result.last_message().content, vec![ContentBlock::text("Done")]);
    }
}

mod invoke {
    use super::*;

    #[tokio::test]
    async fn returns_promise_agent_result() {
        let mut agent = agent(text_model(&["Hello"]));
        let result: AgentResult = agent.invoke("Test prompt").await.unwrap();
        assert_eq!(result.last_message().role, Role::Assistant);
    }

    #[tokio::test]
    async fn returns_correct_stop_reason_and_last_message() {
        let mut agent = agent(text_model(&["Response text"]));
        let result = agent.invoke("Test prompt").await.unwrap();
        assert_result(&result, &StopReason::EndTurn, "Response text", 1);
    }

    #[tokio::test]
    async fn consumes_stream_events_internally() {
        let mut agent = agent(text_model(&["Hello"]));
        let result = agent.invoke("Test").await.unwrap();
        assert_eq!(
            serde_json::to_value(&result).unwrap()["lastMessage"]["content"],
            json!([{"text": "Hello"}])
        );
        assert_eq!(result.metrics().unwrap().cycle_count, 1);
    }

    #[tokio::test]
    async fn executes_tools_and_returns_final_result() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("calc", "tool-1", json!({"a": 1, "b": 2})).with_usage(Usage::new(100, 50, 150)))
            .with_turn(MockTurn::text("The answer is 3").with_usage(Usage::new(200, 30, 230)));
        let mut agent = agent_with_tools(model, [ok_tool("calc", "3")]);
        let result = agent.invoke("What is 1 + 2?").await.unwrap();
        assert_result(&result, &StopReason::EndTurn, "The answer is 3", 2);
        assert_eq!(tool_names(&result), ["calc"]);
        assert_eq!(usage(&result), Usage::new(300, 80, 380));
    }

    #[tokio::test]
    async fn propagates_max_tokens_error() {
        let model = MockModel::new().with_turn(MockTurn::text("Partial").with_stop_reason(StopReason::MaxTokens));
        let error = agent(model).invoke("Test").await.unwrap_err();
        assert!(matches!(error, Error::MaxTokens(_)));
    }

    #[tokio::test]
    async fn rejects_a_blank_prompt_without_breaking_later_calls() {
        let prompts: Vec<InvokeArgs> = vec![
            "".into(),
            "  \n".into(),
            blocks(json!([{"text": " "}, {"text": "\n"}])).into(),
            blocks(json!([{"text": ""}])).into(),
            vec![message(json!({"role": "user", "content": [{"text": ""}]}))].into(),
            vec![message(json!({"role": "user", "content": []}))].into(),
        ];
        for prompt in prompts {
            let mut agent = agent(text_model(&["Hello"]));
            let error = agent.invoke(prompt).await.unwrap_err();
            assert!(error.to_string().starts_with("Input prompt is blank"), "{error}");
            assert!(agent.messages().is_empty());
            assert_eq!(agent.invoke("Hi").await.unwrap().to_string(), "Hello");
        }
    }

    #[tokio::test]
    async fn accepts_a_prompt_with_some_non_blank_content() {
        let prompts = [
            blocks(json!([{"text": "hello"}, {"text": ""}])),
            blocks(json!([{"text": ""}, {"image": {"format": "png", "source": {"bytes": "AQ=="}}}])),
        ];
        for prompt in prompts {
            let result = agent(text_model(&["Hello"])).invoke(prompt).await.unwrap();
            assert_eq!(result.to_string(), "Hello");
        }
    }

    #[tokio::test]
    async fn exposes_accumulated_metrics_on_the_agent_instance() {
        let mut agent = agent(text_model(&["Hello"]));
        assert_eq!(agent.metrics().cycle_count, 0);
        agent.invoke("Test").await.unwrap();
        assert_eq!(agent.metrics().cycle_count, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn includes_the_completed_cycle_duration_in_the_returned_result_metrics() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("slowTool", "tool-1", json!({})).with_usage(Usage::new(10, 5, 15)));
        let agent = agent_with_tools(model, [ok_tool("slowTool", "Done")]);
        agent.add_async_hook::<BeforeToolsEvent<'_>>(|_| {
            Box::pin(async move { tokio::time::sleep(Duration::from_millis(60)).await })
        });
        agent.add_hook(|event: &mut AfterToolsEvent<'_>| event.set_end_turn(true));
        let mut agent = agent;
        let result = agent.invoke("Test").await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        let metrics = result.metrics().unwrap();
        assert_eq!(metrics.cycle_count, 1);
        assert_eq!(metrics.total_duration, 60);
        assert!((metrics.average_cycle_time() - 60.0).abs() < f64::EPSILON);
        assert_eq!(metrics.latest_agent_invocation().unwrap().cycles[0].duration, 60);
    }

    #[tokio::test(start_paused = true)]
    async fn includes_the_cycle_duration_when_the_model_ends_the_turn_without_tools() {
        let agent = agent(text_model(&["Hello"]));
        agent.add_async_hook::<BeforeModelCallEvent<'_>>(|_| {
            Box::pin(async move { tokio::time::sleep(Duration::from_millis(60)).await })
        });
        let mut agent = agent;
        let result = agent.invoke("Test").await.unwrap();
        let metrics = result.metrics().unwrap();
        assert_eq!(metrics.cycle_count, 1);
        assert_eq!(metrics.total_duration, 60);
        assert_eq!(metrics.latest_agent_invocation().unwrap().cycles[0].duration, 60);
    }

    #[tokio::test]
    async fn tracks_cycle_count_when_max_tokens_error_occurs() {
        let model = MockModel::new()
            .with_turn(tool_turn_with_usage("testTool", "tool-1", Usage::new(100, 50, 150)))
            .with_turn(
                MockTurn::text("Partial")
                    .with_stop_reason(StopReason::MaxTokens)
                    .with_usage(Usage::new(80, 20, 100)),
            );
        let mut agent = agent_with_tools(model, [ok_tool("testTool", "Done")]);
        let error = agent.invoke("Test").await.unwrap_err();
        assert!(matches!(error, Error::MaxTokens(_)));
        let metrics = agent.metrics();
        assert_eq!(metrics.cycle_count, 2);
        assert_eq!(metrics.accumulated_usage, Usage::new(100, 50, 150));
        let tool = metrics.tool("testTool").unwrap();
        assert_eq!((tool.call_count, tool.success_count, tool.error_count), (1, 1, 0));
        assert_eq!(metrics.tool_metrics.len(), 1);
    }

    #[tokio::test]
    async fn tracks_metrics_when_a_hook_throws_an_error() {
        // Rust hooks cannot fail; a model error after the first tool turn stands in for the
        // failing hook: the first cycle's usage and tool call are recorded, the failed call adds none.
        let model = MockModel::new()
            .with_turn(tool_turn_with_usage("testTool", "tool-1", Usage::new(60, 25, 85)))
            .with_turn(MockTurn::error(|| Error::other("Hook failure")));
        let mut agent = agent_with_tools(model, [ok_tool("testTool", "Result")]);
        let error = agent.invoke("Test").await.unwrap_err();
        assert_eq!(error.to_string(), "Hook failure");
        let metrics = agent.metrics();
        assert_eq!(metrics.cycle_count, 2);
        assert_eq!(metrics.accumulated_usage, Usage::new(60, 25, 85));
    }

    #[tokio::test]
    async fn fires_after_invocation_event_when_a_mid_stream_hook_throws() {
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn(MockTurn::error(|| Error::other("hook error")));
        let mut agent = agent_with_tools(model, [ok_tool("testTool", "ok")]);
        let fired = Arc::new(Mutex::new(0));
        let counter = fired.clone();
        agent.add_hook(move |_: &mut AfterInvocationEvent<'_>| *counter.lock().unwrap() += 1);
        let error = agent.invoke("Test").await.unwrap_err();
        assert_eq!(error.to_string(), "hook error");
        assert_eq!(*fired.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn does_not_fire_after_invocation_event_when_before_invocation_event_hook_throws() {
        // A blank prompt fails before BeforeInvocationEvent completes, as a throwing hook does.
        let mut agent = agent(text_model(&["Hello"]));
        let fired = Arc::new(Mutex::new(0));
        let counter = fired.clone();
        agent.add_hook(move |_: &mut AfterInvocationEvent<'_>| *counter.lock().unwrap() += 1);
        agent.invoke("  ").await.unwrap_err();
        assert_eq!(*fired.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn does_not_fire_after_tools_event_when_before_tools_event_hook_throws() {
        // Two hooks raising interrupts with one name fail BeforeToolsEvent, as a throwing hook does.
        let model = MockModel::new()
            .with_turn(tool_use_turn("testTool", "tool-1", json!({})))
            .with_turn("Done");
        let mut agent = agent_with_tools(model, [ok_tool("testTool", "ok")]);
        for _ in 0..2 {
            agent.add_hook(|event: &mut BeforeToolsEvent<'_>| {
                let _ = event.interrupt("same");
            });
        }
        let fired = Arc::new(Mutex::new(0));
        let counter = fired.clone();
        agent.add_hook(move |_: &mut AfterToolsEvent<'_>| *counter.lock().unwrap() += 1);
        let error = agent.invoke("Test").await.unwrap_err();
        assert_eq!(error.to_string(), "interrupt_names=<same> | duplicate interrupt names");
        assert_eq!(*fired.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn fires_after_tools_event_when_a_mid_stream_hook_throws() {
        // A model turn that reports tool use without tool use blocks fails inside the batch,
        // after BeforeToolsEvent, as a throwing per-tool hook does.
        let model = MockModel::new().with_turn(MockTurn::text("no tools").with_stop_reason(StopReason::ToolUse));
        let mut agent = agent(model);
        let fired = Arc::new(Mutex::new(0));
        let counter = fired.clone();
        agent.add_hook(move |_: &mut AfterToolsEvent<'_>| *counter.lock().unwrap() += 1);
        let error = agent.invoke("Test").await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Model indicated toolUse but no tool use blocks found in message"
        );
        assert_eq!(*fired.lock().unwrap(), 1);
    }
}

mod api_consistency {
    use super::*;

    #[tokio::test]
    async fn invoke_and_stream_produce_same_final_result() {
        let invoked = agent(text_model(&["Consistent response"]))
            .invoke("Test")
            .await
            .unwrap();
        let mut streaming = agent(text_model(&["Consistent response"]));
        let events = collect(streaming.stream("Test")).await;
        let Some(AgentStreamEvent::AgentResult(streamed)) = events.last() else {
            panic!("the stream ends with the result");
        };
        assert_eq!(invoked.stop_reason(), streamed.stop_reason());
        assert_eq!(invoked.last_message().content, streamed.last_message().content);
    }

    #[tokio::test]
    async fn both_methods_produce_same_result_with_tool_use() {
        let build = || {
            let model = MockModel::new()
                .with_turn(tool_use_turn("testTool", "id", json!({})))
                .with_turn("Final");
            agent_with_tools(model, [ok_tool("testTool", "Tool ran")])
        };
        let invoked = build().invoke("Use tool").await.unwrap();
        let mut streaming = build();
        let events = collect(streaming.stream("Use tool")).await;
        let Some(AgentStreamEvent::AgentResult(streamed)) = events.last() else {
            panic!("the stream ends with the result");
        };
        assert_eq!(invoked.stop_reason(), streamed.stop_reason());
        assert_eq!(invoked.last_message().role, streamed.last_message().role);
        assert_eq!(invoked.last_message().content, streamed.last_message().content);
        assert_eq!(
            invoked.metrics().unwrap().cycle_count,
            streamed.metrics().unwrap().cycle_count
        );
    }
}

mod messages {
    use super::*;

    #[test]
    fn returns_array_of_messages() {
        assert!(agent(text_model(&["Hello"])).messages().is_empty());
    }

    #[tokio::test]
    async fn reflects_conversation_history_after_invoke() {
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke("Hello").await.unwrap();
        let history: Vec<(Role, JsonValue)> = agent
            .messages()
            .iter()
            .map(|message| (message.role, content_json(message)))
            .collect();
        assert_eq!(
            history,
            [
                (Role::User, json!([{"text": "Hello"}])),
                (Role::Assistant, json!([{"text": "Response"}]))
            ]
        );
    }
}

mod printer_configuration {
    use super::*;

    #[tokio::test]
    async fn agent_works_correctly_with_printer_disabled() {
        let mut agent = agent(text_model(&["Hello"]));
        let events = collect(agent.stream("Test")).await;
        let Some(AgentStreamEvent::AgentResult(result)) = events.last() else {
            panic!("the stream ends with the result");
        };
        assert_eq!(result.last_message().content, vec![ContentBlock::text("Hello")]);
    }
}

mod concurrency_guards {
    use super::*;

    #[tokio::test]
    async fn allows_sequential_invocations_after_lock_is_released() {
        let mut agent = agent(text_model(&["First response", "Second response"]));
        let first = agent.invoke("First").await.unwrap();
        assert_eq!(first.last_message().content, vec![ContentBlock::text("First response")]);
        let second = agent.invoke("Second").await.unwrap();
        assert_eq!(
            second.last_message().content,
            vec![ContentBlock::text("Second response")]
        );
    }

    #[tokio::test]
    async fn releases_lock_after_errors_and_abandoned_streams() {
        let model = MockModel::new()
            .with_turn(MockTurn::text("Partial").with_stop_reason(StopReason::MaxTokens))
            .with_turn("Success");
        let mut agent = agent(model);
        assert!(matches!(agent.invoke("First").await, Err(Error::MaxTokens(_))));
        let result = agent.invoke("Second").await.unwrap();
        assert_eq!(result.last_message().content, vec![ContentBlock::text("Success")]);
    }
}

mod nested_tool_arrays {
    use super::*;
    use strands::tool_list;

    fn names(agent: &Agent) -> Vec<String> {
        agent.tools().iter().map(|tool| tool.name().to_owned()).collect()
    }

    #[test]
    fn flattens_nested_arrays_at_any_depth() {
        let tool = |name: &str| ToolSource::from(ok_tool(name, "ok"));
        let cases: Vec<(&str, Vec<ToolSource>, Vec<&str>)> = vec![
            ("flat array", vec![tool("a"), tool("b"), tool("c")], vec!["a", "b", "c"]),
            ("single tool", vec![tool("a")], vec!["a"]),
            ("empty array", vec![], vec![]),
            (
                "single level nesting",
                vec![ToolSource::from(vec![tool("a"), tool("b")]), tool("c")],
                vec!["a", "b", "c"],
            ),
            (
                "empty nested arrays",
                vec![
                    ToolSource::from(Vec::<ToolSource>::new()),
                    tool("a"),
                    ToolSource::from(Vec::<ToolSource>::new()),
                ],
                vec!["a"],
            ),
            (
                "deeply nested",
                vec![
                    ToolSource::from(vec![ToolSource::from(vec![tool("a")])]),
                    ToolSource::from(vec![tool("b")]),
                    tool("c"),
                ],
                vec!["a", "b", "c"],
            ),
            (
                "mixed nesting",
                vec![
                    ToolSource::from(vec![tool("a"), ToolSource::from(vec![tool("b")])]),
                    tool("c"),
                ],
                vec!["a", "b", "c"],
            ),
            (
                "very deep nesting",
                vec![ToolSource::from(vec![ToolSource::from(vec![ToolSource::from(vec![
                    tool("a"),
                ])])])],
                vec!["a"],
            ),
        ];
        for (label, input, expected) in cases {
            let agent = agent_with_tools(MockModel::new(), input);
            assert_eq!(names(&agent), expected, "{label}");
        }
        let mixed = agent_with_tools(
            MockModel::new(),
            tool_list![ok_tool("a", "ok"), vec![ok_tool("b", "ok")]],
        );
        assert_eq!(names(&mixed), ["a", "b"]);
    }

    #[test]
    fn accepts_undefined_tools() {
        assert!(agent(MockModel::new()).tools().is_empty());
    }

    #[test]
    fn catches_duplicate_tool_names_across_nested_arrays() {
        let error = Agent::builder()
            .model(MockModel::new())
            .tools([vec![ok_tool("duplicate", "1")], vec![ok_tool("duplicate", "2")]])
            .build()
            .unwrap_err();
        assert_eq!(error.to_string(), "Tool with name 'duplicate' already registered");
    }
}

mod system_prompt_configuration {
    use super::*;

    #[test]
    fn accepts_and_stores_string_system_prompt() {
        let agent = Agent::builder()
            .model(MockModel::new())
            .system_prompt("You are a helpful assistant")
            .build()
            .unwrap();
        assert_eq!(
            agent.system_prompt(),
            Some(&SystemPrompt::from("You are a helpful assistant"))
        );
    }

    #[test]
    fn converts_text_block_data_to_text_block() {
        let prompt: SystemPrompt = serde_json::from_value(json!([{"text": "System prompt text"}])).unwrap();
        let agent = Agent::builder()
            .model(MockModel::new())
            .system_prompt(prompt.clone())
            .build()
            .unwrap();
        assert_eq!(agent.system_prompt(), Some(&prompt));
    }

    #[test]
    fn converts_mixed_block_data_types() {
        let data = json!([{"text": "First block"}, {"cachePoint": {"cacheType": "default"}}, {"text": "Second block"}]);
        let prompt: SystemPrompt = serde_json::from_value(data.clone()).unwrap();
        let agent = Agent::builder()
            .model(MockModel::new())
            .system_prompt(prompt)
            .build()
            .unwrap();
        assert_eq!(serde_json::to_value(agent.system_prompt()).unwrap(), data);
    }

    #[test]
    fn accepts_array_of_class_instances() {
        let prompt: SystemPrompt =
            serde_json::from_value(json!([{"text": "System prompt"}, {"cachePoint": {"cacheType": "default"}}]))
                .unwrap();
        let agent = Agent::builder()
            .model(MockModel::new())
            .system_prompt(prompt.clone())
            .build()
            .unwrap();
        assert_eq!(agent.system_prompt(), Some(&prompt));
    }

    #[test]
    fn allows_system_prompt_to_be_set_after_initialization() {
        let mut agent = Agent::builder()
            .model(MockModel::new())
            .system_prompt("Initial prompt")
            .build()
            .unwrap();
        agent.set_system_prompt(Some("Updated prompt".into()));
        assert_eq!(agent.system_prompt(), Some(&SystemPrompt::from("Updated prompt")));
    }

    #[tokio::test]
    async fn allows_system_prompt_to_be_changed_between_turns() {
        let model = MockModel::new().with_turn("First response");
        let initial: SystemPrompt = serde_json::from_value(json!([{"text": "You are a helpful assistant"}])).unwrap();
        let mut agent = Agent::builder()
            .model(model.clone())
            .system_prompt(initial.clone())
            .printer(false)
            .build()
            .unwrap();
        agent.invoke("First prompt").await.unwrap();
        assert_eq!(agent.system_prompt(), Some(&initial));
        assert_eq!(model.requests()[0].system_prompt, Some(initial));
        assert!(model.requests()[0].tool_specs.is_empty());

        agent.set_system_prompt(Some("You are a coding expert".into()));
        agent.invoke("Second prompt").await.unwrap();
        assert_eq!(
            model.requests()[1].system_prompt,
            Some(SystemPrompt::from("You are a coding expert"))
        );
        assert!(model.requests()[1].tool_specs.is_empty());
    }
}

mod model_property {
    use super::*;

    #[test]
    fn returns_the_configured_model_instance() {
        let model: Arc<dyn Model> = Arc::new(MockModel::new());
        let agent = Agent::builder().model(model.clone()).build().unwrap();
        assert!(Arc::ptr_eq(agent.model(), &model));
    }

    #[test]
    fn updates_the_model_instance() {
        let initial: Arc<dyn Model> = Arc::new(MockModel::new());
        let replacement: Arc<dyn Model> = Arc::new(MockModel::new());
        let mut agent = Agent::builder().model(initial.clone()).build().unwrap();
        agent.set_model(replacement.clone()).unwrap();
        assert!(Arc::ptr_eq(agent.model(), &replacement));
        assert!(!Arc::ptr_eq(agent.model(), &initial));
    }

    #[tokio::test]
    async fn allows_model_change_to_persist_across_invocations() {
        let mut agent = agent(text_model(&["First response"]));
        let first = agent.invoke("First prompt").await.unwrap();
        assert_eq!(first.last_message().content[0], ContentBlock::text("First response"));
        agent.set_model(text_model(&["Second response"])).unwrap();
        let second = agent.invoke("Second prompt").await.unwrap();
        assert_eq!(second.last_message().content[0], ContentBlock::text("Second response"));
    }

    #[tokio::test]
    async fn successfully_switches_between_different_model_providers() {
        let mut agent = agent(text_model(&["Bedrock response"]));
        let first = agent.invoke("First prompt").await.unwrap();
        assert_eq!(first.last_message().content[0], ContentBlock::text("Bedrock response"));
        agent.set_model(text_model(&["OpenAI response"])).unwrap();
        let second = agent.invoke("Second prompt").await.unwrap();
        assert_eq!(second.last_message().content[0], ContentBlock::text("OpenAI response"));
    }

    /// Whether `model` is configured as a `BedrockModel` with `model_id`: the same config, model
    /// info and statefulness (the public API does not downcast).
    #[cfg(feature = "bedrock")]
    fn assert_bedrock_model(model: &Arc<dyn strands::Model>, model_id: Option<&str>) {
        let expected = strands::BedrockModel::new(strands::BedrockModelConfig {
            model_id: model_id.map(str::to_owned),
            ..Default::default()
        });
        assert_eq!(model.get_config(), strands::Model::get_config(&expected));
        assert_eq!(model.model_info(), strands::Model::model_info(&expected));
        assert!(!model.stateful());
    }

    #[cfg(feature = "bedrock")]
    #[test]
    fn returns_default_bedrock_model_when_no_model_provided() {
        let agent = Agent::builder().printer(false).build().unwrap();
        assert_eq!(
            agent.model().model_id().as_deref(),
            Some("global.anthropic.claude-sonnet-4-6")
        );
        assert_bedrock_model(agent.model(), None);
    }

    #[cfg(feature = "bedrock")]
    #[test]
    fn creates_default_bedrock_model() {
        let agent = Agent::builder().printer(false).build().unwrap();
        assert_bedrock_model(agent.model(), None);
    }

    #[cfg(feature = "bedrock")]
    #[test]
    fn uses_provided_bedrock_model_instance() {
        let explicit: Arc<dyn strands::Model> = Arc::new(strands::BedrockModel::new(strands::BedrockModelConfig {
            model_id: Some("explicit-model-id".to_owned()),
            ..Default::default()
        }));
        let agent = Agent::builder().model(explicit.clone()).printer(false).build().unwrap();
        assert!(Arc::ptr_eq(agent.model(), &explicit));
        assert_eq!(
            agent.model().get_config().model_id.as_deref(),
            Some("explicit-model-id")
        );
    }

    #[cfg(feature = "bedrock")]
    #[test]
    fn string_model_behaves_identically_to_explicit_bedrock_model_with_same_model_id() {
        let model_id = "anthropic.claude-3-5-sonnet-20240620-v1:0";
        let with_string = Agent::builder().model(model_id).printer(false).build().unwrap();
        let explicit = strands::BedrockModel::new(strands::BedrockModelConfig {
            model_id: Some(model_id.to_owned()),
            ..Default::default()
        });
        let with_explicit = Agent::builder().model(explicit).printer(false).build().unwrap();
        assert_eq!(
            with_string.model().get_config().model_id,
            with_explicit.model().get_config().model_id
        );
        assert_eq!(with_string.model().get_config().model_id.as_deref(), Some(model_id));
        assert_bedrock_model(with_string.model(), Some(model_id));
    }

    #[cfg(not(feature = "bedrock"))]
    #[tokio::test]
    async fn fails_on_first_use_when_no_model_is_provided_without_bedrock() {
        let mut agent = Agent::builder().printer(false).build().unwrap();
        assert_eq!(agent.model().model_id(), None);
        let error = agent.invoke("Hi").await.unwrap_err();
        assert!(error.is_model_error(), "{error}");
        assert!(error.to_string().starts_with("No model configured."), "{error}");
    }

    #[cfg(feature = "bedrock")]
    #[test]
    fn creates_bedrock_model_with_specified_model_id() {
        let agent = Agent::builder()
            .model("anthropic.claude-3-5-sonnet-20240620-v1:0")
            .build()
            .unwrap();
        assert_eq!(
            agent.model().get_config().model_id.as_deref(),
            Some("anthropic.claude-3-5-sonnet-20240620-v1:0")
        );
        assert_bedrock_model(agent.model(), Some("anthropic.claude-3-5-sonnet-20240620-v1:0"));
    }

    #[cfg(feature = "bedrock")]
    #[test]
    fn creates_bedrock_model_with_custom_model_id() {
        let agent = Agent::builder().model("custom.model.id").build().unwrap();
        assert_eq!(agent.model().get_config().model_id.as_deref(), Some("custom.model.id"));
    }

    #[cfg(not(feature = "bedrock"))]
    #[test]
    fn a_model_id_needs_the_bedrock_feature() {
        let error = Agent::builder().model("custom.model.id").build().unwrap_err();
        assert!(matches!(error, Error::DefaultNotConfigured(_)), "{error}");
    }
}

mod durable_message_id {
    use super::*;

    #[tokio::test]
    async fn assigns_a_durable_tracking_id_to_every_recorded_message() {
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke("Hello").await.unwrap();
        assert_eq!(agent.messages().len(), 2);
        assert!(agent.messages().iter().all(|message| !message.tracking_id().is_empty()));
        assert_ne!(agent.messages()[0].tracking_id(), agent.messages()[1].tracking_id());
    }

    #[tokio::test]
    async fn preserves_a_caller_supplied_id_on_input_messages() {
        let earlier =
            message(json!({"role": "user", "content": [{"text": "Earlier"}], "trackingId": "caller-supplied"}));
        let mut agent = Agent::builder()
            .model(text_model(&["Response"]))
            .messages(vec![earlier])
            .printer(false)
            .build()
            .unwrap();
        agent.invoke("Hello").await.unwrap();
        assert_eq!(agent.messages()[0].tracking_id(), "caller-supplied");
    }
}

mod multimodal_input {
    use super::*;

    #[tokio::test]
    async fn creates_user_message_with_single_text_block() {
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke("Hello").await.unwrap();
        assert_eq!(agent.messages().len(), 2);
        assert_eq!(agent.messages()[0].role, Role::User);
        assert_eq!(agent.messages()[0].content, vec![ContentBlock::text("Hello")]);
    }

    #[tokio::test]
    async fn creates_single_user_message_with_single_text_block() {
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke(vec![ContentBlock::text("Hello")]).await.unwrap();
        assert_eq!(agent.messages().len(), 2);
        assert_eq!(agent.messages()[0].role, Role::User);
        assert_eq!(agent.messages()[0].content, vec![ContentBlock::text("Hello")]);
    }

    #[tokio::test]
    async fn creates_single_user_message_with_multiple_blocks() {
        let content = vec![ContentBlock::text("Analyze this"), ContentBlock::text("and this")];
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke(content.clone()).await.unwrap();
        assert_eq!(agent.messages().len(), 2);
        assert_eq!(agent.messages()[0].content, content);
    }

    fn every_block_type() -> JsonValue {
        json!([
            {"text": "Text content"},
            {"toolUse": {"name": "tool1", "toolUseId": "id-1", "input": {"key": "value"}}},
            {"toolResult": {"toolUseId": "id-1", "status": "success", "content": [{"text": "Result"}, {"json": {"result": 42}}]}},
            {"reasoning": {"text": "My reasoning"}},
            {"cachePoint": {"cacheType": "default"}},
            {"guardContent": {"text": {"text": "Guard content", "qualifiers": ["grounding_source"]}}},
            {"audio": {"format": "mp3", "source": {"bytes": "AQID"}}},
            {"image": {"format": "png", "source": {"url": "https://example.com/image.png"}}},
            {"video": {"format": "mp4", "source": {"location": {"type": "s3", "uri": "s3://bucket/video.mp4"}}}},
            {"document": {"format": "pdf", "name": "doc.pdf", "source": {"bytes": "AQID"}}}
        ])
    }

    #[tokio::test]
    async fn supports_all_content_block_types() {
        let content = blocks(every_block_type());
        assert_eq!(content.len(), 10);
        assert!(
            content.iter().all(|block| !matches!(block, ContentBlock::Unknown(_))),
            "{content:?}"
        );
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke(content.clone()).await.unwrap();
        assert_eq!(agent.messages().len(), 2);
        assert_eq!(agent.messages()[0].role, Role::User);
        assert_eq!(agent.messages()[0].content, content);
    }

    #[tokio::test]
    async fn handles_empty_content_block_array() {
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke(Vec::<ContentBlock>::new()).await.unwrap();
        assert_eq!(agent.messages().len(), 1);
    }

    #[tokio::test]
    async fn accepts_content_block_data_and_converts_to_content_block() {
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke(blocks(every_block_type())).await.unwrap();
        let user = &agent.messages()[0];
        assert_eq!(user.role, Role::User);
        assert_eq!(user.content.len(), 10);
        assert_eq!(user.content[0], ContentBlock::text("Text content"));
        assert_eq!(
            user.content[1],
            ToolUseBlock::new("tool1", "id-1", json!({"key": "value"})).into()
        );
    }

    #[tokio::test]
    async fn appends_single_message_to_conversation() {
        let user = Message::user("Hello");
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke(vec![user.clone()]).await.unwrap();
        assert_eq!(agent.messages().len(), 2);
        assert_eq!(agent.messages()[0], user);
    }

    #[tokio::test]
    async fn appends_multiple_messages_in_order() {
        let input = vec![
            Message::user("First message"),
            Message::assistant("Second message"),
            Message::user("Third message"),
        ];
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke(input.clone()).await.unwrap();
        assert_eq!(agent.messages().len(), 4);
        assert_eq!(&agent.messages()[..3], &input[..]);
    }

    #[tokio::test]
    async fn handles_empty_message_array() {
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke(Vec::<Message>::new()).await.unwrap();
        assert_eq!(agent.messages().len(), 1);
    }

    #[tokio::test]
    async fn accepts_message_data_and_converts_to_message() {
        let input: Vec<Message> = serde_json::from_value(json!([
            {"role": "user", "content": [{"text": "First message"}]},
            {"role": "assistant", "content": [{"text": "Second message"}]}
        ]))
        .unwrap();
        let mut agent = agent(text_model(&["Response"]));
        agent.invoke(input).await.unwrap();
        assert_eq!(agent.messages().len(), 3);
        assert_eq!(
            (agent.messages()[0].role, agent.messages()[0].text()),
            (Role::User, "First message".to_owned())
        );
        assert_eq!(
            (agent.messages()[1].role, agent.messages()[1].text()),
            (Role::Assistant, "Second message".to_owned())
        );
    }
}

mod aux_model {
    use super::*;

    #[test]
    fn defaults_to_model() {
        let model: Arc<dyn Model> = Arc::new(MockModel::new());
        let agent = Agent::builder().model(model.clone()).build().unwrap();
        assert!(Arc::ptr_eq(agent.aux_model(), &model));
    }

    #[test]
    fn uses_the_configured_aux_model() {
        let aux: Arc<dyn Model> = Arc::new(MockModel::new());
        let agent = Agent::builder()
            .model(MockModel::new())
            .aux_model(aux.clone())
            .build()
            .unwrap();
        assert!(Arc::ptr_eq(agent.aux_model(), &aux));
    }

    #[cfg(feature = "bedrock")]
    #[test]
    fn creates_bedrock_model_from_a_string_model_id() {
        let agent = Agent::builder()
            .model(MockModel::new())
            .aux_model("us.anthropic.claude-haiku-4-5-20251001-v1:0")
            .build()
            .unwrap();
        assert_eq!(
            agent.aux_model().get_config().model_id.as_deref(),
            Some("us.anthropic.claude-haiku-4-5-20251001-v1:0")
        );
    }

    #[test]
    fn rejects_a_model_router() {
        let model: Arc<dyn Model> = Arc::new(MockModel::new());
        let router = ModelRouter::new([CandidateModel::from(model)], ModelRouterOptions::default()).unwrap();
        let error = Agent::builder()
            .model(MockModel::new())
            .aux_model(router)
            .build()
            .err()
            .unwrap();
        assert!(error.to_string().contains("ModelRouter"), "{error}");
    }

    #[test]
    fn is_reassignable_at_runtime() {
        let model: Arc<dyn Model> = Arc::new(MockModel::new());
        let mut agent = Agent::builder().model(model.clone()).build().unwrap();
        let aux: Arc<dyn Model> = Arc::new(MockModel::new());
        agent.set_aux_model(Some(aux.clone()));
        assert!(Arc::ptr_eq(agent.aux_model(), &aux));
        agent.set_aux_model(None);
        assert!(Arc::ptr_eq(agent.aux_model(), &model));
    }
}

mod structured_output {
    use super::*;

    fn schema() -> JsonValue {
        json!({
            "type": "object",
            "properties": {"steps": {"type": "array", "items": {"type": "string"}}},
            "required": ["steps"]
        })
    }

    fn valid() -> JsonValue {
        json!({"steps": ["review"]})
    }

    fn text_reply() -> ContentBlock {
        ContentBlock::text("Plain text instead of structured output")
    }

    fn output_call(input: JsonValue, id: &str) -> ContentBlock {
        ToolUseBlock::new(STRUCTURED_OUTPUT_TOOL_NAME, id, input).into()
    }

    fn so_agent(model: MockModel) -> Agent {
        Agent::builder()
            .model(model)
            .structured_output_schema_json(schema())
            .printer(false)
            .build()
            .unwrap()
    }

    fn attempts(count: u64) -> InvokeOptions {
        limits(InvokeLimits {
            structured_output_attempts: Some(count),
            ..InvokeLimits::default()
        })
    }

    fn unexpected() -> MockTurn {
        MockTurn::error(|| Error::other("Unexpected model call"))
    }

    #[tokio::test]
    async fn retries_failed_attempts_until_the_limit() {
        let block = |name: &str| match name {
            "text" => text_reply(),
            "invalid" => output_call(json!({}), "invalid"),
            "valid" => output_call(valid(), "valid"),
            _ => ToolUseBlock::new("unknown_tool", "other", json!({})).into(),
        };
        let cases = [
            (
                ["text", "text", "text", "text"],
                StopReason::LimitStructuredOutputAttempts,
            ),
            (
                ["invalid", "text", "text", "text"],
                StopReason::LimitStructuredOutputAttempts,
            ),
            (
                ["text", "other", "invalid", "text"],
                StopReason::LimitStructuredOutputAttempts,
            ),
            (["text", "text", "invalid", "valid"], StopReason::ToolUse),
        ];
        for (responses, stop_reason) in cases {
            let model = MockModel::new();
            for response in responses {
                model.add_turn(MockTurn::content([block(response)]));
            }
            model.add_turn(MockTurn::content([block("valid")]));
            let mut agent = so_agent(model.clone());
            let result = agent.invoke_with("Plan a review", attempts(3)).await.unwrap();
            assert_eq!(result.stop_reason(), stop_reason, "{responses:?}");
            let expected_output = (stop_reason == StopReason::ToolUse).then(valid);
            assert_eq!(
                result.structured_output_value().cloned(),
                expected_output,
                "{responses:?}"
            );
            assert_eq!(
                result.last_message().content,
                vec![block(responses[3])],
                "{responses:?}"
            );
            assert_eq!(model.call_count(), 4, "{responses:?}");
        }
    }

    #[tokio::test]
    async fn returns_the_model_reply_when_the_limit_is_reached_on_the_forced_retry() {
        let model = MockModel::from_turns([MockTurn::content([text_reply()]), MockTurn::content([text_reply()])]);
        let mut agent = so_agent(model.clone());
        let result = agent.invoke_with("Plan a review", attempts(1)).await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::LimitStructuredOutputAttempts);
        assert_eq!(result.last_message().content, vec![text_reply()]);
        let roles: Vec<Role> = agent.messages().iter().map(|message| message.role).collect();
        assert_eq!(roles, [Role::User, Role::Assistant]);
        assert_eq!(model.call_count(), 2);
        assert_eq!(&agent.messages()[1], result.last_message());
    }

    #[tokio::test]
    async fn returns_the_model_reply_when_a_turn_limit_is_reached_before_forcing() {
        let model = MockModel::from_turns([MockTurn::content([text_reply()]), unexpected()]);
        let mut agent = so_agent(model.clone());
        let options = limits(InvokeLimits {
            turns: Some(1),
            ..InvokeLimits::default()
        });
        let result = agent.invoke_with("Plan a review", options).await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::LimitTurns);
        assert_eq!(result.last_message().content, vec![text_reply()]);
        assert_eq!(model.call_count(), 1);
        assert_eq!(&agent.messages()[1], result.last_message());
    }

    #[tokio::test]
    async fn throws_without_an_attempt_limit_when_the_forced_retry_fails() {
        let mut agent = so_agent(MockModel::new().with_turn(MockTurn::content([text_reply()])));
        let options = limits(InvokeLimits {
            turns: Some(5),
            ..InvokeLimits::default()
        });
        let error = agent.invoke_with("Plan a review", options).await.unwrap_err();
        assert!(matches!(error, Error::StructuredOutput(_)));
        assert_eq!(
            error.to_string(),
            "The model did not produce structured output: it neither called the structured output tool nor returned a JSON object."
        );
    }

    #[tokio::test]
    async fn counts_filtered_responses_toward_the_attempt_limit() {
        let model = MockModel::new().with_turn(MockTurn::content([text_reply()]));
        for _ in 0..3 {
            model.add_turn(MockTurn::text("Filtered").with_stop_reason(StopReason::ContentFiltered));
        }
        model.add_turn(MockTurn::content([output_call(valid(), "output")]));
        let mut agent = so_agent(model.clone());
        let result = agent.invoke_with("Plan a review", attempts(3)).await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::LimitStructuredOutputAttempts);
        assert_eq!(result.structured_output_value(), None);
        assert_eq!(model.call_count(), 4);
    }

    #[tokio::test]
    async fn starts_each_root_call_with_a_fresh_attempt_budget() {
        let model = MockModel::new();
        for attempt in 0..6 {
            model.add_turn(MockTurn::content([output_call(
                json!({}),
                &format!("output-{attempt}"),
            )]));
        }
        model.add_turn(MockTurn::content([output_call(valid(), "output")]));
        let mut agent = agent(model.clone());
        let options = InvokeOptions {
            structured_output_schema: Some(schema()),
            ..attempts(3)
        };
        let first = agent.invoke_with("Plan a review", options.clone()).await.unwrap();
        let first_calls = model.call_count();
        let second = agent.invoke_with("Plan a review", options).await.unwrap();
        assert_eq!(
            [first.stop_reason(), second.stop_reason()],
            [
                StopReason::LimitStructuredOutputAttempts,
                StopReason::LimitStructuredOutputAttempts
            ]
        );
        assert_eq!([first_calls, model.call_count()], [3, 6]);
        assert!(agent.tools().is_empty());
        let last = agent.messages().last().unwrap();
        assert!(
            matches!(&last.content[..], [ContentBlock::ToolResult(result)] if result.status == strands::ToolResultStatus::Error)
        );
    }

    #[tokio::test]
    async fn continues_the_attempt_budget_when_passed_the_previous_call_s_invocation_context() {
        let model = MockModel::new();
        for attempt in 0..3 {
            model.add_turn(MockTurn::content([output_call(
                json!({}),
                &format!("output-{attempt}"),
            )]));
        }
        let mut agent = so_agent(model.clone());
        let first = agent.invoke_with("Plan a review", attempts(2)).await.unwrap();
        let options = InvokeOptions {
            invocation_context: first.invocation_context().cloned(),
            ..InvokeOptions::default()
        };
        let second = agent.invoke_with("Try again", options).await.unwrap();
        assert_eq!(
            [first.stop_reason(), second.stop_reason()],
            [
                StopReason::LimitStructuredOutputAttempts,
                StopReason::LimitStructuredOutputAttempts
            ]
        );
        assert_eq!(model.call_count(), 2);
    }

    #[tokio::test]
    async fn preserves_the_attempt_budget_across_a_hook_resume() {
        let model = MockModel::new();
        for attempt in 0..6 {
            model.add_turn(MockTurn::content([output_call(
                json!({}),
                &format!("output-{attempt}"),
            )]));
        }
        let agent = so_agent(model.clone());
        let resume: Arc<Mutex<Option<InvokeArgs>>> = Arc::default();
        let counting = model.clone();
        agent.add_hook(move |event: &mut BeforeToolsEvent<'_>| {
            if counting.call_count() == 3 {
                let _ = event.interrupt("approve");
            }
        });
        let slot = resume.clone();
        agent.add_hook(move |event: &mut InterruptEvent<'_>| {
            let response = InterruptResponse::new(event.interrupt().id.clone(), json!("approved"));
            *slot.lock().unwrap() = Some(vec![response].into());
        });
        let slot = resume.clone();
        agent.add_hook(move |event: &mut AfterInvocationEvent<'_>| {
            if let Some(args) = slot.lock().unwrap().take() {
                event.set_resume(args);
            }
        });
        let mut agent = agent;
        let result = agent.invoke_with("Plan a review", attempts(3)).await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::LimitStructuredOutputAttempts);
        assert_eq!(result.structured_output_value(), None);
        assert_eq!(model.call_count(), 3);
    }

    #[tokio::test]
    async fn counts_a_forced_response_that_calls_another_tool_before_an_interrupt() {
        let model = MockModel::from_turns([
            MockTurn::content([text_reply()]),
            tool_use_turn("lookup", "lookup", json!({})),
            unexpected(),
        ]);
        let agent = Agent::builder()
            .model(model.clone())
            .tools([ok_tool("lookup", "found")])
            .structured_output_schema_json(schema())
            .printer(false)
            .build()
            .unwrap();
        agent.add_hook(|event: &mut BeforeToolsEvent<'_>| {
            let _ = event.interrupt("approve");
        });
        let mut agent = agent;
        let paused = agent.invoke_with("Plan a review", attempts(1)).await.unwrap();
        let responses: Vec<InterruptResponse> = paused
            .interrupts()
            .iter()
            .map(|interrupt| InterruptResponse::new(interrupt.id.clone(), json!("approved")))
            .collect();
        let options = InvokeOptions {
            invocation_context: paused.invocation_context().cloned(),
            ..InvokeOptions::default()
        };
        let result = agent.invoke_with(responses, options).await.unwrap();
        assert_eq!(
            [paused.stop_reason(), result.stop_reason()],
            [StopReason::Interrupt, StopReason::LimitStructuredOutputAttempts]
        );
        assert_eq!(model.call_count(), 2);
    }

    #[tokio::test]
    async fn counts_a_failed_attempt_when_a_hook_ends_the_turn() {
        let model = MockModel::from_turns([MockTurn::content([output_call(json!({}), "invalid")]), unexpected()]);
        let agent = so_agent(model.clone());
        agent.add_hook(|event: &mut AfterToolsEvent<'_>| event.set_end_turn("Paused for review"));
        let mut agent = agent;
        let ended = agent.invoke_with("Plan a review", attempts(1)).await.unwrap();
        let options = InvokeOptions {
            invocation_context: ended.invocation_context().cloned(),
            ..InvokeOptions::default()
        };
        let result = agent.invoke_with("Continue", options).await.unwrap();
        assert_eq!(
            [ended.stop_reason(), result.stop_reason()],
            [StopReason::EndTurn, StopReason::LimitStructuredOutputAttempts]
        );
        assert_eq!(model.call_count(), 1);
    }

    #[tokio::test]
    async fn returns_the_valid_output_of_a_response_that_also_has_an_invalid_call() {
        let cases = [
            [output_call(json!({}), "invalid"), output_call(valid(), "valid")],
            [output_call(valid(), "valid"), output_call(json!({}), "invalid")],
        ];
        for content in cases {
            let model = MockModel::from_turns([MockTurn::content(content), unexpected()]);
            let mut agent = so_agent(model.clone());
            let result = agent.invoke_with("Plan a review", attempts(1)).await.unwrap();
            assert_eq!(result.structured_output_value(), Some(&valid()));
            assert_eq!(model.call_count(), 1);
        }
    }

    #[tokio::test]
    async fn counts_one_attempt_per_model_response() {
        let model = MockModel::from_turns([
            MockTurn::content([output_call(json!({}), "invalid-1"), output_call(json!({}), "invalid-2")]),
            MockTurn::content([output_call(valid(), "output")]),
        ]);
        let mut agent = so_agent(model.clone());
        let result = agent.invoke_with("Plan a review", attempts(2)).await.unwrap();
        assert_eq!(result.structured_output_value(), Some(&valid()));
        assert_eq!(model.call_count(), 2);
    }

    #[tokio::test]
    async fn reports_stop_reason_before_the_attempt_limit() {
        let cases = [
            (
                InvokeLimits {
                    turns: Some(1),
                    ..InvokeLimits::default()
                },
                StopReason::LimitTurns,
            ),
            (
                InvokeLimits {
                    output_tokens: Some(1),
                    ..InvokeLimits::default()
                },
                StopReason::LimitOutputTokens,
            ),
            (
                InvokeLimits {
                    total_tokens: Some(2),
                    ..InvokeLimits::default()
                },
                StopReason::LimitTotalTokens,
            ),
        ];
        for (mut case, stop_reason) in cases {
            case.structured_output_attempts = Some(1);
            let model = MockModel::from_turns([
                MockTurn::content([output_call(json!({}), "output")]).with_usage(Usage::new(1, 1, 2)),
                unexpected(),
            ]);
            let mut agent = so_agent(model.clone());
            let result = agent.invoke_with("Plan a review", limits(case)).await.unwrap();
            assert_eq!(result.stop_reason(), stop_reason);
            assert_eq!(result.structured_output_value(), None);
            assert_eq!(model.call_count(), 1);
        }
    }

    #[tokio::test]
    async fn does_not_count_ordinary_tool_failures() {
        let unavailable = MockTool::new("unavailable", |context| {
            strands::tools::create_error_result("service unavailable", context.tool_use().tool_use_id.clone()).into()
        });
        let model = MockModel::from_turns([
            tool_use_turn("unavailable", "service", json!({})),
            MockTurn::content([output_call(valid(), "output")]),
        ]);
        let mut agent = Agent::builder()
            .model(model.clone())
            .tools([unavailable])
            .structured_output_schema_json(schema())
            .printer(false)
            .build()
            .unwrap();
        let result = agent.invoke_with("Plan a review", attempts(1)).await.unwrap();
        assert_eq!(result.structured_output_value(), Some(&valid()));
        assert_eq!(model.call_count(), 2);
    }

    fn person() -> JsonValue {
        json!({
            "type": "object",
            "properties": {"name": {"type": "string"}, "age": {"type": "number"}},
            "required": ["name", "age"]
        })
    }

    fn value_schema() -> JsonValue {
        json!({"type": "object", "properties": {"value": {"type": "number"}}, "required": ["value"]})
    }

    fn agent_with_schema(model: MockModel, schema: JsonValue) -> Agent {
        Agent::builder()
            .model(model)
            .structured_output_schema_json(schema)
            .printer(false)
            .build()
            .unwrap()
    }

    fn long_answer() -> String {
        "Rust has a steep learning curve but produces fast single binaries. ".repeat(120)
    }

    fn context_managed(model: MockModel, context_manager: ContextManagerStrategy) -> Agent {
        Agent::builder()
            .model(model)
            .context_manager(context_manager)
            .printer(false)
            .build()
            .unwrap()
    }

    fn offloaded_text(block: &JsonValue) -> bool {
        block["content"]
            .as_array()
            .is_some_and(|content| content.len() == 1 && content[0].get("text").is_some_and(JsonValue::is_string))
    }

    #[tokio::test]
    async fn does_not_count_valid_output_that_history_offloading_rewrites() {
        let large_valid = json!({"steps": ["Review the change thoroughly before merging. ".repeat(400)]});
        let model = MockModel::from_turns([
            MockTurn::content([output_call(large_valid.clone(), "large")]),
            MockTurn::content([output_call(valid(), "small")]),
        ]);
        let mut agent = Agent::builder()
            .model(model)
            .structured_output_schema_json(schema())
            .context_manager(ContextManagerStrategy::Auto)
            .printer(false)
            .build()
            .unwrap();

        let first = agent.invoke_with("Plan a review", attempts(1)).await.unwrap();
        let options = InvokeOptions {
            invocation_context: first.invocation_context().cloned(),
            ..InvokeOptions::default()
        };
        let second = agent.invoke_with("Plan another", options).await.unwrap();

        assert_eq!(first.structured_output_value(), Some(&large_valid));
        assert_eq!(second.structured_output_value(), Some(&valid()));
        let offloaded = serde_json::to_value(&agent.messages()[2].content).unwrap();
        assert_eq!(offloaded[0]["toolResult"]["status"], "success");
        assert!(offloaded_text(&offloaded[0]["toolResult"]), "{offloaded}");
    }

    #[tokio::test]
    async fn preserves_validated_structured_output_with_mode() {
        let long = long_answer();
        let cases = [
            ("disabled", ContextManagerStrategy::Disabled, long.clone(), false),
            (
                "auto with short output",
                ContextManagerStrategy::Auto,
                "Short answer.".to_owned(),
                false,
            ),
            (
                "auto with large output",
                ContextManagerStrategy::Auto,
                long.clone(),
                true,
            ),
            (
                "agentic below threshold",
                ContextManagerStrategy::Agentic,
                long.clone(),
                false,
            ),
            (
                "agentic above threshold",
                ContextManagerStrategy::Agentic,
                long.repeat(5),
                true,
            ),
        ];
        let schema = json!({"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]});
        for (mode, context_manager, answer, offloaded) in cases {
            let expected = json!({"message": answer});
            let model = MockModel::new()
                .with_turn(MockTurn::content([output_call(expected.clone(), "tool-1")]))
                .with_turn(MockTurn::content([output_call(
                    json!({"message": "Short fallback answer."}),
                    "tool-2",
                )]));
            let mut agent = context_managed(model.clone(), context_manager);
            let options = InvokeOptions {
                structured_output_schema: Some(schema.clone()),
                ..InvokeOptions::default()
            };

            let result = agent.invoke_with("Test", options).await.unwrap();

            assert_eq!(result.structured_output_value(), Some(&expected), "{mode}");
            assert_eq!(model.call_count(), 1, "{mode}");
            let content = serde_json::to_value(&agent.messages()[2].content).unwrap();
            let block = &content[0]["toolResult"];
            assert_eq!(block["toolUseId"], "tool-1", "{mode}");
            assert_eq!(block["status"], "success", "{mode}");
            if offloaded {
                assert!(offloaded_text(block), "{mode}: {content}");
            } else {
                assert_eq!(block["content"], json!([{"json": expected}]), "{mode}");
            }
        }
    }

    #[tokio::test]
    async fn continues_offloading_ordinary_tool_results() {
        let long = long_answer();
        let large_result = MockTool::new("large_result", move |context| {
            ToolResultBlock::success(
                context.tool_use().tool_use_id.clone(),
                vec![ToolResultContent::json(json!({"message": long}))],
            )
            .into()
        });
        let model = MockModel::from_turns([tool_use_turn("large_result", "tool-1", json!({})), "Done".into()]);
        let mut agent = Agent::builder()
            .model(model.clone())
            .tools([large_result])
            .context_manager(ContextManagerStrategy::Auto)
            .printer(false)
            .build()
            .unwrap();

        let result = agent.invoke("Test").await.unwrap();

        assert_eq!(result.structured_output_value(), None);
        assert_eq!(
            serde_json::to_value(&result.last_message().content).unwrap(),
            json!([{"text": "Done"}])
        );
        assert_eq!(model.call_count(), 2);
        let content = serde_json::to_value(&agent.messages()[2].content).unwrap();
        let block = &content[0]["toolResult"];
        assert_eq!(block["toolUseId"], "tool-1");
        assert_eq!(block["status"], "success");
        assert!(
            block["content"][0]["text"].as_str().unwrap().contains("[Truncated:"),
            "{content}"
        );
    }

    #[tokio::test]
    async fn returns_structured_output_when_schema_provided_and_tool_used() {
        let model = MockModel::new()
            .with_turn(MockTurn::content([output_call(
                json!({"name": "John", "age": 30}),
                "tool-1",
            )]))
            .with_turn("Done");
        let mut agent = agent_with_schema(model.clone(), person());
        let result = agent.invoke("Test").await.unwrap();
        assert_eq!(
            result.structured_output_value(),
            Some(&json!({"name": "John", "age": 30}))
        );
        assert_eq!(model.call_count(), 1);
    }

    #[tokio::test]
    async fn forces_structured_output_tool_when_model_does_not_use_it() {
        let model = MockModel::new()
            .with_turn("First response")
            .with_turn(MockTurn::content([output_call(json!({"value": 42}), "tool-1")]))
            .with_turn("Done");
        let result = agent_with_schema(model, value_schema()).invoke("Test").await.unwrap();
        assert_eq!(result.structured_output_value(), Some(&json!({"value": 42})));
    }

    #[tokio::test]
    async fn does_not_send_assistant_ended_conversation_when_forcing_structured_output_retry() {
        let model = MockModel::new()
            .with_turn("Plain text, no tool call")
            .with_turn(MockTurn::content([output_call(json!({"value": 42}), "tool-1")]))
            .with_turn("Done");
        agent_with_schema(model.clone(), value_schema())
            .invoke("Test")
            .await
            .unwrap();
        let requests = model.requests();
        assert!(requests.len() >= 2);
        assert_eq!(requests[1].messages.last().unwrap().role, Role::User);
    }

    #[tokio::test]
    async fn throws_structured_output_error_when_model_refuses_to_use_tool_after_forcing() {
        let model = MockModel::new().with_turn("Response");
        let error = agent_with_schema(model, value_schema())
            .invoke("Test")
            .await
            .unwrap_err();
        assert!(matches!(error, Error::StructuredOutput(_)));
        assert_eq!(
            error.to_string(),
            "The model did not produce structured output: it neither called the structured output tool nor returned a JSON object."
        );
    }

    #[tokio::test]
    async fn passes_the_schema_on_the_retry_and_accepts_a_json_text_response() {
        let model = MockModel::new()
            .with_turn("Plain text, no tool call")
            .with_turn(r#"{"value": 42}"#);
        let mut agent = Agent::builder()
            .model(model.clone())
            .tools([ok_tool("lookup", "found")])
            .structured_output_schema_json(value_schema())
            .printer(false)
            .build()
            .unwrap();
        let result = agent.invoke("Test").await.unwrap();
        assert_eq!(result.structured_output_value(), Some(&json!({"value": 42})));
        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        let roles: Vec<Role> = agent.messages().iter().map(|message| message.role).collect();
        assert_eq!(roles, [Role::User, Role::Assistant]);
        assert_eq!(&agent.messages()[1], result.last_message());
        let requests = model.requests();
        let schemas: Vec<Option<JsonValue>> = requests
            .iter()
            .map(|request| request.structured_output_schema.clone())
            .collect();
        assert_eq!(schemas, [None, Some(value_schema())]);
        let choices: Vec<Option<JsonValue>> = requests
            .iter()
            .map(|request| {
                request
                    .tool_choice
                    .as_ref()
                    .map(|choice| serde_json::to_value(choice).unwrap())
            })
            .collect();
        assert_eq!(
            choices,
            [None, Some(json!({"tool": {"name": "strands_structured_output"}}))]
        );
        let names: Vec<&str> = requests[1].tool_specs.iter().map(|spec| spec.name.as_str()).collect();
        assert_eq!(names, ["lookup", "strands_structured_output"]);
    }

    #[tokio::test]
    async fn throws_structured_output_error_when_the_json_text_response_fails_validation() {
        let model = MockModel::new()
            .with_turn("Plain text, no tool call")
            .with_turn(r#"{"value": "not a number"}"#);
        let error = agent_with_schema(model, value_schema())
            .invoke("Test")
            .await
            .unwrap_err();
        assert!(matches!(error, Error::StructuredOutput(_)));
        assert!(
            error.to_string().starts_with("Structured output failed validation: "),
            "{error}"
        );
    }

    #[tokio::test]
    async fn throws_max_tokens_error_when_max_tokens_reached_before_structured_output() {
        let model = MockModel::new().with_turn(MockTurn::text("Partial...").with_stop_reason(StopReason::MaxTokens));
        let error = agent_with_schema(model, value_schema())
            .invoke("Test")
            .await
            .unwrap_err();
        assert!(matches!(error, Error::MaxTokens(_)));
    }

    #[tokio::test]
    async fn retries_with_validation_feedback_when_structured_output_tool_returns_error() {
        let model = MockModel::new()
            .with_turn(MockTurn::content([output_call(
                json!({"name": "John", "age": "invalid"}),
                "tool-1",
            )]))
            .with_turn(MockTurn::content([output_call(
                json!({"name": "John", "age": 30}),
                "tool-2",
            )]))
            .with_turn("Done");
        let mut agent = agent_with_schema(model.clone(), person());
        let result = agent.invoke("Test").await.unwrap();
        assert_eq!(
            result.structured_output_value(),
            Some(&json!({"name": "John", "age": 30}))
        );
        assert_eq!(model.call_count(), 2);
        let [ContentBlock::ToolResult(feedback)] = &agent.messages()[2].content[..] else {
            panic!("the third message holds the failed result");
        };
        assert_eq!(
            (feedback.tool_use_id.as_str(), feedback.status),
            ("tool-1", strands::ToolResultStatus::Error)
        );
    }

    #[tokio::test]
    async fn works_without_structured_output_schema() {
        let result = agent(text_model(&["Hello"])).invoke("Test").await.unwrap();
        assert_eq!(result.structured_output_value(), None);
    }

    #[tokio::test]
    async fn cleans_up_structured_output_tool_after_invocation() {
        let model = MockModel::new()
            .with_turn(MockTurn::content([output_call(json!({"value": 42}), "tool-1")]))
            .with_turn("Done");
        let mut agent = agent_with_schema(model, value_schema());
        agent.invoke("Test").await.unwrap();
        assert!(agent.tool_registry().get(STRUCTURED_OUTPUT_TOOL_NAME).is_none());
    }

    #[tokio::test]
    async fn cleans_up_structured_output_tool_even_when_error_occurs() {
        let model = MockModel::new().with_turn(MockTurn::text("Partial...").with_stop_reason(StopReason::MaxTokens));
        let mut agent = agent_with_schema(model, value_schema());
        agent.invoke("Test").await.unwrap_err();
        assert!(agent.tool_registry().get(STRUCTURED_OUTPUT_TOOL_NAME).is_none());
    }

    #[tokio::test]
    async fn validates_nested_objects_in_structured_output() {
        let schema = json!({
            "type": "object",
            "properties": {"user": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "age": {"type": "number"}},
                "required": ["name", "age"]
            }},
            "required": ["user"]
        });
        let output = json!({"user": {"name": "Alice", "age": 25}});
        let model = MockModel::new()
            .with_turn(MockTurn::content([output_call(output.clone(), "tool-1")]))
            .with_turn("Done");
        let result = agent_with_schema(model, schema).invoke("Test").await.unwrap();
        assert_eq!(result.structured_output_value(), Some(&output));
    }

    #[tokio::test]
    async fn validates_arrays_in_structured_output() {
        let schema = json!({
            "type": "object",
            "properties": {"items": {"type": "array", "items": {"type": "string"}}},
            "required": ["items"]
        });
        let output = json!({"items": ["a", "b", "c"]});
        let model = MockModel::new()
            .with_turn(MockTurn::content([output_call(output.clone(), "tool-1")]))
            .with_turn("Done");
        let result = agent_with_schema(model, schema).invoke("Test").await.unwrap();
        assert_eq!(result.structured_output_value(), Some(&output));
    }

    #[tokio::test]
    async fn uses_per_invocation_override_schema_and_restores_constructor_schema_on_next_call() {
        let constructor = json!({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]});
        let model = MockModel::new()
            .with_turn(MockTurn::content([output_call(json!({"value": 99}), "tool-1")]))
            .with_turn("Done")
            .with_turn(MockTurn::content([output_call(json!({"name": "Bob"}), "tool-2")]))
            .with_turn("Done");
        let mut agent = agent_with_schema(model, constructor);
        let options = InvokeOptions {
            structured_output_schema: Some(value_schema()),
            ..InvokeOptions::default()
        };
        let first = agent.invoke_with("First", options).await.unwrap();
        assert_eq!(first.structured_output_value(), Some(&json!({"value": 99})));
        let second = agent.invoke("Second").await.unwrap();
        assert_eq!(second.structured_output_value(), Some(&json!({"name": "Bob"})));
    }

    #[tokio::test]
    async fn honors_after_tools_event_end_turn_over_structured_output() {
        let schema = json!({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]});
        let model = MockModel::new()
            .with_turn(MockTurn::content([output_call(
                json!({"name": "long answer"}),
                "tool-1",
            )]))
            .with_turn("Done");
        let agent = agent_with_schema(model.clone(), schema);
        agent.add_hook(|event: &mut AfterToolsEvent<'_>| event.set_end_turn(true));
        let mut agent = agent;
        let result = agent.invoke("Test").await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::EndTurn);
        assert_eq!(result.structured_output_value(), None);
        assert_eq!(model.call_count(), 1);
    }
}

/// A [`MockModel`] whose token counting returns a fixed number or fails.
struct CountingModel {
    inner: MockModel,
    count: Option<u64>,
    calls: Arc<Mutex<Vec<(usize, bool)>>>,
}

impl CountingModel {
    fn new(inner: MockModel, count: Option<u64>) -> Self {
        Self {
            inner,
            count,
            calls: Arc::default(),
        }
    }
}

#[strands::async_trait]
impl Model for CountingModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, strands::Result<ModelStreamEvent>> {
        self.inner.stream(request)
    }

    fn get_config(&self) -> BaseModelConfig {
        self.inner.get_config()
    }

    fn update_config(&self, config: BaseModelConfig) -> strands::Result<()> {
        self.inner.update_config(config)
    }

    async fn count_tokens(&self, messages: &[Message], options: CountTokensOptions) -> strands::Result<u64> {
        let with_options = options.system_prompt.is_some() || !options.tool_specs.is_empty();
        self.calls.lock().unwrap().push((messages.len(), with_options));
        self.count.ok_or_else(|| Error::other("API unavailable"))
    }
}

fn capture_projected_tokens(agent: &Agent) -> Arc<Mutex<Vec<Option<u64>>>> {
    let seen: Arc<Mutex<Vec<Option<u64>>>> = Arc::default();
    let slot = seen.clone();
    agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| {
        slot.lock().unwrap().push(event.projected_input_tokens());
    });
    seen
}

fn with_usage_metadata(message: Message, usage: Usage) -> Message {
    let metadata: strands::MessageMetadata =
        serde_json::from_value(json!({"usage": serde_json::to_value(usage).unwrap()})).unwrap();
    message.with_metadata(metadata)
}

mod estimate_input_tokens {
    use super::*;

    #[tokio::test]
    async fn uses_full_estimation_on_cold_start_no_prior_usage_metadata() {
        let model = CountingModel::new(text_model(&["Hello"]), Some(42));
        let calls = model.calls.clone();
        let mut agent = Agent::builder().model(model).printer(false).build().unwrap();
        let seen = capture_projected_tokens(&agent);
        agent.invoke("Hi").await.unwrap();
        assert_eq!(seen.lock().unwrap()[0], Some(42));
        assert_eq!(calls.lock().unwrap()[0].0, 1);
    }

    #[tokio::test]
    async fn uses_known_baseline_when_no_new_messages_after_last_assistant() {
        let history = vec![
            Message::user("Hi"),
            with_usage_metadata(Message::assistant("Hello"), Usage::new(100, 20, 120)),
        ];
        let mut agent = Agent::builder()
            .model(text_model(&["Hello"]))
            .messages(history)
            .printer(false)
            .build()
            .unwrap();
        let seen = capture_projected_tokens(&agent);
        agent.invoke(Vec::<Message>::new()).await.unwrap();
        assert_eq!(seen.lock().unwrap()[0], Some(120));
    }

    #[tokio::test]
    async fn counts_disjoint_provider_cache_reads_in_the_known_baseline() {
        let history = vec![
            Message::user("Hi"),
            with_usage_metadata(
                Message::assistant("Hello"),
                Usage::new(10, 4, 5862).with_cache_read_input_tokens(5848),
            ),
        ];
        let mut agent = Agent::builder()
            .model(text_model(&["Hello"]))
            .messages(history)
            .printer(false)
            .build()
            .unwrap();
        let seen = capture_projected_tokens(&agent);
        agent.invoke(Vec::<Message>::new()).await.unwrap();
        assert_eq!(seen.lock().unwrap()[0], Some(5862));
    }

    #[tokio::test]
    async fn returns_undefined_projected_input_tokens_when_estimation_fails() {
        let model = CountingModel::new(text_model(&["Hello"]), None);
        let mut agent = Agent::builder().model(model).printer(false).build().unwrap();
        let seen = capture_projected_tokens(&agent);
        agent.invoke("Hi").await.unwrap();
        assert_eq!(seen.lock().unwrap()[0], None);
    }

    #[tokio::test]
    async fn estimates_delta_for_new_messages_after_last_assistant() {
        let inner = MockModel::new()
            .with_turn(tool_use_turn("test", "id-1", json!({})).with_usage(Usage::new(100, 30, 130)))
            .with_turn("Done");
        let model = CountingModel::new(inner, Some(50));
        let calls = model.calls.clone();
        let mut agent = Agent::builder()
            .model(model)
            .tools([ok_tool("test", "result")])
            .printer(false)
            .build()
            .unwrap();
        let seen = capture_projected_tokens(&agent);
        agent.invoke("Use the tool").await.unwrap();
        assert_eq!(seen.lock().unwrap()[1], Some(180));
        assert!(!calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn uses_baseline_from_prior_invocation_on_second_invoke() {
        let inner = MockModel::new()
            .with_turn(MockTurn::text("First response").with_usage(Usage::new(200, 50, 250)))
            .with_turn("Second response");
        let mut agent = Agent::builder()
            .model(CountingModel::new(inner, Some(15)))
            .printer(false)
            .build()
            .unwrap();
        agent.invoke("First question").await.unwrap();
        let seen = capture_projected_tokens(&agent);
        agent.invoke("Second question").await.unwrap();
        assert_eq!(seen.lock().unwrap()[0], Some(265));
    }
}

mod injected_blocks {
    use super::*;

    #[tokio::test]
    async fn sends_an_injected_block_to_the_model_as_text_and_keeps_it_in_agent_messages() {
        let model = text_model(&["ok"]);
        let mut agent = agent(model.clone());
        let input = vec![
            ContentBlock::text("Refactor the tokenizer."),
            ContentBlock::Injected(InjectedBlock::new("reminder", "test")),
        ];
        agent.invoke(input.clone()).await.unwrap();
        assert_eq!(
            model.requests()[0].messages[0].content,
            vec![
                ContentBlock::text("Refactor the tokenizer."),
                ContentBlock::text("\n\nreminder")
            ]
        );
        assert_eq!(agent.messages()[0].content, input);
    }
}

mod normalize_tool_use_names {
    use super::*;

    fn history(tool_use: ToolUseBlock) -> Vec<Message> {
        vec![
            Message::user("do thing"),
            Message::new(Role::Assistant, vec![tool_use.into()]),
            Message::new(
                Role::User,
                vec![ToolResultBlock::success("tu-1", vec![ToolResultContent::text("result")]).into()],
            ),
        ]
    }

    async fn sent_tool_use(tool_use: ToolUseBlock) -> (ContentBlock, Agent) {
        let model = text_model(&["ok"]);
        let mut agent = Agent::builder()
            .model(model.clone())
            .messages(history(tool_use))
            .printer(false)
            .build()
            .unwrap();
        agent.invoke("continue").await.unwrap();
        let sent = model.requests()[0].messages[1].content[0].clone();
        (sent, agent)
    }

    #[tokio::test]
    async fn replaces_invalid_tool_use_names_with_invalid_tool_name_before_calling_model() {
        let (sent, agent) = sent_tool_use(ToolUseBlock::new("bad name!", "tu-1", json!({}))).await;
        assert_eq!(sent, ToolUseBlock::new("INVALID_TOOL_NAME", "tu-1", json!({})).into());
        assert_eq!(
            agent.messages()[1].content[0],
            ToolUseBlock::new("bad name!", "tu-1", json!({})).into()
        );
    }

    #[tokio::test]
    async fn preserves_reasoning_signature_on_replaced_tool_use_blocks() {
        let tool_use = ToolUseBlock::new("bad!", "tu-1", json!({})).with_reasoning_signature("sig-abc");
        let (sent, _) = sent_tool_use(tool_use).await;
        assert_eq!(
            sent,
            ToolUseBlock::new("INVALID_TOOL_NAME", "tu-1", json!({}))
                .with_reasoning_signature("sig-abc")
                .into()
        );
    }

    #[tokio::test]
    async fn leaves_valid_names_untouched() {
        let (sent, _) = sent_tool_use(ToolUseBlock::new("good_tool-1", "tu-1", json!({}))).await;
        assert_eq!(sent, ToolUseBlock::new("good_tool-1", "tu-1", json!({})).into());
    }

    #[tokio::test]
    async fn sends_it_to_the_model_as_a_blank_text_placeholder_without_changing_stored_history() {
        let model = text_model(&["ok"]);
        let mut agent = Agent::builder()
            .model(model.clone())
            .messages(vec![Message::user("Say hi"), Message::new(Role::Assistant, Vec::new())])
            .printer(false)
            .build()
            .unwrap();
        agent.invoke("continue").await.unwrap();
        let sent: Vec<(Role, Vec<ContentBlock>)> = model.requests()[0]
            .messages
            .iter()
            .map(|message| (message.role, message.content.clone()))
            .collect();
        assert_eq!(
            sent,
            [
                (Role::User, vec![ContentBlock::text("Say hi")]),
                (Role::Assistant, vec![ContentBlock::text("[blank text]")]),
                (Role::User, vec![ContentBlock::text("continue")]),
            ]
        );
        assert!(agent.messages()[1].content.is_empty());
    }
}

mod limits {
    use super::*;

    fn loop_turn(id: &str, usage: Usage) -> MockTurn {
        tool_turn_with_usage("loop", id, usage)
    }

    fn loop_agent(model: MockModel) -> Agent {
        let tool = MockTool::new("loop", |context| {
            ToolResultBlock::success(
                context.tool_use().tool_use_id.clone(),
                vec![ToolResultContent::text("ok")],
            )
            .into()
        });
        agent_with_tools(model, [tool])
    }

    fn two_turns(first: Usage, second: Usage) -> MockModel {
        MockModel::from_turns([loop_turn("tool-1", first), loop_turn("tool-2", second)])
    }

    fn assert_limit(result: &AgentResult, stop_reason: &StopReason, cycles: u64) {
        assert_eq!(&result.stop_reason(), stop_reason);
        assert_eq!(result.metrics().unwrap().cycle_count, cycles);
        assert_eq!(tool_names(result), ["loop"]);
    }

    fn assert_ends_on_tool_results(result: &AgentResult) {
        assert_eq!(result.last_message().role, Role::User);
        assert!(
            result
                .last_message()
                .content
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolResult(_)))
        );
    }

    #[tokio::test]
    async fn runs_the_cycle_to_completion_and_bails_at_top_of_next_iteration() {
        let mut agent = loop_agent(two_turns(Usage::new(10, 5, 15), Usage::new(20, 5, 25)));
        let options = limits(InvokeLimits {
            turns: Some(1),
            ..InvokeLimits::default()
        });
        let result = agent.invoke_with("go", options).await.unwrap();
        assert_limit(&result, &StopReason::LimitTurns, 1);
        assert_ends_on_tool_results(&result);
        assert_eq!(usage(&result), Usage::new(10, 5, 15));
        assert_eq!(serde_json::to_value(&result).unwrap()["type"], json!("agentResult"));
    }

    #[tokio::test]
    async fn does_not_trip_and_the_model_ends_naturally() {
        let model = MockModel::new().with_turn(MockTurn::text("done").with_usage(Usage::new(5, 5, 10)));
        let options = limits(InvokeLimits {
            turns: Some(5),
            output_tokens: Some(1000),
            total_tokens: Some(1000),
            ..InvokeLimits::default()
        });
        let result = agent(model).invoke_with("go", options).await.unwrap();
        assert_result(&result, &StopReason::EndTurn, "done", 1);
        assert_eq!(usage(&result), Usage::new(5, 5, 10));
    }

    #[tokio::test]
    async fn returns_limit_output_tokens_once_cumulative_output_tokens_hits_the_limit() {
        let mut agent = loop_agent(two_turns(Usage::new(10, 60, 70), Usage::new(10, 60, 70)));
        let options = limits(InvokeLimits {
            output_tokens: Some(100),
            ..InvokeLimits::default()
        });
        let result = agent.invoke_with("go", options).await.unwrap();
        assert_limit(&result, &StopReason::LimitOutputTokens, 2);
        assert_ends_on_tool_results(&result);
        assert_eq!(usage(&result), Usage::new(20, 120, 140));
    }

    #[tokio::test]
    async fn uses_at_most_semantics_stops_when_count_exactly_equals_the_limit() {
        let mut agent = loop_agent(two_turns(Usage::new(10, 100, 110), Usage::new(10, 100, 110)));
        let options = limits(InvokeLimits {
            output_tokens: Some(100),
            ..InvokeLimits::default()
        });
        let result = agent.invoke_with("go", options).await.unwrap();
        assert_limit(&result, &StopReason::LimitOutputTokens, 1);
        assert_eq!(usage(&result), Usage::new(10, 100, 110));
    }

    #[tokio::test]
    async fn returns_limit_total_tokens_once_cumulative_total_tokens_hits_the_limit() {
        let mut agent = loop_agent(two_turns(Usage::new(200, 100, 300), Usage::new(200, 100, 300)));
        let options = limits(InvokeLimits {
            total_tokens: Some(500),
            ..InvokeLimits::default()
        });
        let result = agent.invoke_with("go", options).await.unwrap();
        assert_limit(&result, &StopReason::LimitTotalTokens, 2);
        assert_ends_on_tool_results(&result);
        assert_eq!(usage(&result), Usage::new(400, 200, 600));
    }

    #[tokio::test]
    async fn returns_end_turn_the_model_answer_wins() {
        let model = MockModel::new().with_turn(MockTurn::text("final answer").with_usage(Usage::new(300, 300, 600)));
        let options = limits(InvokeLimits {
            total_tokens: Some(500),
            ..InvokeLimits::default()
        });
        let result = agent(model).invoke_with("go", options).await.unwrap();
        assert_result(&result, &StopReason::EndTurn, "final answer", 1);
        assert_eq!(usage(&result), Usage::new(300, 300, 600));
    }

    fn heavy_agent() -> Agent {
        let heavy = Usage::new(100, 100, 200);
        loop_agent(two_turns(heavy, heavy))
    }

    #[tokio::test]
    async fn prefers_turns_when_all_three_trip() {
        let options = limits(InvokeLimits {
            turns: Some(1),
            total_tokens: Some(1),
            output_tokens: Some(1),
            ..InvokeLimits::default()
        });
        let result = heavy_agent().invoke_with("go", options).await.unwrap();
        assert_limit(&result, &StopReason::LimitTurns, 1);
    }

    #[tokio::test]
    async fn prefers_total_tokens_over_output_tokens() {
        let options = limits(InvokeLimits {
            total_tokens: Some(1),
            output_tokens: Some(1),
            ..InvokeLimits::default()
        });
        let result = heavy_agent().invoke_with("go", options).await.unwrap();
        assert_limit(&result, &StopReason::LimitTotalTokens, 1);
    }

    #[tokio::test]
    async fn falls_back_to_output_tokens_when_no_higher_priority_limit_is_set() {
        let options = limits(InvokeLimits {
            output_tokens: Some(1),
            ..InvokeLimits::default()
        });
        let result = heavy_agent().invoke_with("go", options).await.unwrap();
        assert_limit(&result, &StopReason::LimitOutputTokens, 1);
    }

    #[tokio::test]
    async fn scopes_the_limit_to_the_current_invocation_not_lifetime() {
        let model = MockModel::from_turns([
            MockTurn::text("first").with_usage(Usage::new(10, 50, 60)),
            MockTurn::text("second").with_usage(Usage::new(10, 50, 60)),
        ]);
        let mut agent = agent(model);
        let options = limits(InvokeLimits {
            output_tokens: Some(75),
            ..InvokeLimits::default()
        });
        let first = agent.invoke_with("go", options.clone()).await.unwrap();
        assert_eq!(first.stop_reason(), StopReason::EndTurn);
        assert_eq!(
            first.metrics().unwrap().latest_agent_invocation().unwrap().cycles.len(),
            1
        );
        let second = agent.invoke_with("go again", options).await.unwrap();
        assert_eq!(second.stop_reason(), StopReason::EndTurn);
        assert_eq!(
            second
                .metrics()
                .unwrap()
                .latest_agent_invocation()
                .unwrap()
                .cycles
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn rejects_with_type_error() {
        let cases = [
            (
                InvokeLimits {
                    turns: Some(0),
                    ..InvokeLimits::default()
                },
                "limits.turns must be a positive finite number, got 0",
            ),
            (
                InvokeLimits {
                    structured_output_attempts: Some(0),
                    ..InvokeLimits::default()
                },
                "limits.structuredOutputAttempts must be a positive finite number, got 0",
            ),
        ];
        for (case, message) in cases {
            let mut agent = agent(text_model(&["never reached"]));
            let error = agent.invoke_with("go", limits(case)).await.unwrap_err();
            assert_eq!(error.to_string(), message);
        }
    }

    #[tokio::test]
    async fn returns_limit_turns_as_the_generator_return_value() {
        let mut agent = loop_agent(two_turns(Usage::new(10, 5, 15), Usage::new(10, 5, 15)));
        let options = limits(InvokeLimits {
            turns: Some(1),
            ..InvokeLimits::default()
        });
        let events = collect(agent.stream_with("go", options)).await;
        let Some(AgentStreamEvent::AgentResult(result)) = events.last() else {
            panic!("the stream ends with the result");
        };
        assert_eq!(result.stop_reason(), StopReason::LimitTurns);
    }
}

mod traces {
    use super::*;

    fn calc_model(tool_name: &str, tool_use_id: &str) -> MockModel {
        MockModel::from_turns([tool_use_turn(tool_name, tool_use_id, json!({})), "Done".into()])
    }

    #[tokio::test]
    async fn stores_cycle_id_in_trace_metadata() {
        let mut agent = agent_with_tools(calc_model("calc", "tool-1"), [ok_tool("calc", "result")]);

        let result = agent.invoke("Test").await.unwrap();

        let traces: Vec<(&str, &JsonValue)> = result
            .traces()
            .unwrap()
            .iter()
            .map(|trace| (trace.name.as_str(), &trace.metadata["cycleId"]))
            .collect();
        assert_eq!(traces, [("Cycle 1", &json!("cycle-1")), ("Cycle 2", &json!("cycle-2"))]);
    }

    #[tokio::test]
    async fn stores_tool_metadata_in_trace_children() {
        let mut agent = agent_with_tools(calc_model("testTool", "tool-abc123"), [ok_tool("testTool", "result")]);

        let result = agent.invoke("Test").await.unwrap();

        let cycle = &result.traces().unwrap()[0];
        assert_eq!(cycle.name, "Cycle 1");
        let tool = cycle
            .children
            .iter()
            .find(|child| child.name == "Tool: testTool")
            .unwrap();
        assert_eq!(tool.metadata["toolUseId"], "tool-abc123");
        assert_eq!(tool.metadata["toolName"], "testTool");
    }
}

mod session_id {
    use super::*;

    #[test]
    fn returns_a_stable_8_character_string_when_no_session_manager_is_attached() {
        let agent = agent(MockModel::new());
        let first = agent.session_id().to_owned();
        assert_eq!(agent.session_id(), first);
        assert_eq!(first.len(), 8);
    }

    #[test]
    fn returns_different_ids_for_different_agent_instances() {
        assert_ne!(
            agent(MockModel::new()).session_id().to_owned(),
            agent(MockModel::new()).session_id().to_owned()
        );
    }

    #[test]
    fn delegates_to_session_manager_when_attached() {
        let agent = Agent::builder()
            .model(MockModel::new())
            .session_manager(session_manager("my-session"))
            .printer(false)
            .build()
            .unwrap();
        assert_eq!(agent.session_id(), "my-session");
    }
}

fn session_manager(session_id: &str) -> SessionManager {
    SessionManager::builder()
        .session_id(session_id)
        .storage(Arc::new(InMemoryStorage::new()) as Arc<dyn Storage>)
        .build()
        .unwrap()
}

mod agent_metadata {
    use super::*;

    #[tokio::test]
    async fn sends_no_agent_metadata_when_no_session_manager_is_attached() {
        let model = text_model(&["ok"]);
        agent(model.clone()).invoke("hi").await.unwrap();
        assert_eq!(model.requests().len(), 1);
        assert!(model.requests()[0].agent_metadata.is_none());
    }

    #[tokio::test]
    async fn forwards_the_session_id_to_the_model_when_a_session_manager_is_attached() {
        let model = text_model(&["ok"]);
        let mut agent = Agent::builder()
            .model(model.clone())
            .session_manager(session_manager("my-session"))
            .printer(false)
            .build()
            .unwrap();

        agent.invoke("hi").await.unwrap();

        let metadata = model.requests()[0].agent_metadata.clone().unwrap();
        assert_eq!(metadata.session_id.as_deref(), Some("my-session"));
    }

    #[tokio::test]
    async fn routes_each_agent_on_its_own_session_when_one_model_is_shared_across_sessions() {
        let model = text_model(&["ok", "ok"]);
        let shared: Arc<dyn Model> = Arc::new(model.clone());
        for session_id in ["s1", "s2"] {
            let mut agent = Agent::builder()
                .model(shared.clone())
                .session_manager(session_manager(session_id))
                .printer(false)
                .build()
                .unwrap();
            agent.invoke("hi").await.unwrap();
        }

        let session_ids: Vec<Option<String>> = model
            .requests()
            .iter()
            .map(|request| {
                request
                    .agent_metadata
                    .as_ref()
                    .and_then(|metadata| metadata.session_id.clone())
            })
            .collect();
        assert_eq!(session_ids, [Some("s1".to_owned()), Some("s2".to_owned())]);
    }
}

mod shutdown_and_async_disposal {
    use super::*;

    /// A store that saves raw messages, with extraction every 5 turns so only a flush saves one.
    #[derive(Default)]
    struct RecordingStore {
        batches: Mutex<Vec<Vec<Message>>>,
    }

    #[strands::async_trait]
    impl MemoryStore for RecordingStore {
        fn name(&self) -> &str {
            "notes"
        }

        fn writable(&self) -> bool {
            true
        }

        fn extraction(&self) -> Option<ExtractionConfig> {
            let interval = IntervalTrigger::new(IntervalTriggerOptions { turns: 5 }).unwrap();
            let trigger: Arc<dyn ExtractionTrigger> = Arc::new(interval);
            Some(ExtractionConfig::default().with_trigger(vec![trigger]))
        }

        async fn search(&self, _query: &str, _options: SearchOptions) -> strands::Result<Vec<MemoryEntry>> {
            Ok(Vec::new())
        }

        fn implements_add_messages(&self) -> bool {
            true
        }

        async fn add_messages(&self, messages: &[Message], _context: AddMessagesContext) -> strands::Result<JsonValue> {
            self.batches.lock().unwrap().push(messages.to_vec());
            Ok(JsonValue::Null)
        }
    }

    #[tokio::test]
    async fn flushes_the_memory_manager_when_shutdown_is_called_directly() {
        let store = Arc::new(RecordingStore::default());
        let mut agent = Agent::builder()
            .model(text_model(&["Hello"]))
            .memory_manager(MemoryManagerConfig {
                stores: vec![store.clone() as Arc<dyn MemoryStore>],
                injection: Some(false.into()),
                ..MemoryManagerConfig::default()
            })
            .printer(false)
            .build()
            .unwrap();
        agent.invoke("Test prompt").await.unwrap();
        assert!(store.batches.lock().unwrap().is_empty());

        agent.shutdown().await.unwrap();

        assert_eq!(store.batches.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn is_a_no_op_when_no_memory_manager_is_configured() {
        let mut agent = agent(text_model(&["Hello"]));
        agent.invoke("Test prompt").await.unwrap();
        agent.shutdown().await.unwrap();
        agent.shutdown().await.unwrap();
    }
}
