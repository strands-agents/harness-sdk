use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;
use crate::agent::continuation::ContinuationInput;
use crate::error::Error;
use crate::experimental::context_manager::{
    ContextManagerConfig, ContextManagerStrategy, Offload, OffloadConditions, OffloadTarget, SummarizeConfig,
};
use crate::hooks::MessageAddedEvent;
use crate::models::{BaseModelConfig, Model, ModelCapabilities, ModelInfo};
use crate::test_support::{MockTool, record_logs};
use crate::testing::{MockModel, MockTurn};
use crate::tools::ToolSource;
use crate::types::{ToolResultBlock, ToolResultContent, ToolUseBlock};
use crate::{Agent, Plugin};

fn injected(text: &str, source: &str) -> ContentBlock {
    ContentBlock::Injected(InjectedBlock::new(text, source))
}

fn fixed(text: &'static str) -> ContextInjectorConfig {
    ContextInjectorConfig::new(move |_| async move { Ok(Some(text.to_owned())) })
}

fn agent_with(model: &MockModel, plugins: Vec<ContextInjector>, tools: Vec<ToolSource>) -> Agent {
    Agent::builder()
        .model(model.clone())
        .printer(false)
        .retry_strategy(vec![])
        .tools(tools)
        .plugins(plugins)
        .build()
        .unwrap()
}

fn setup(model: &MockModel, config: ContextInjectorConfig, tools: Vec<ToolSource>) -> Agent {
    agent_with(model, vec![ContextInjector::new(config.with_name("test"))], tools)
}

fn requests(model: &MockModel) -> Vec<Vec<Value>> {
    model
        .requests()
        .iter()
        .map(|request| {
            request
                .messages
                .iter()
                .map(|message| serde_json::to_value(&message.content).unwrap())
                .collect()
        })
        .collect()
}

fn tool_use_turn(name: &str) -> MockTurn {
    MockTurn::content([ToolUseBlock::new(name, "tool-1", json!({}))])
}

fn retry_on_error(agent: &Agent) {
    agent.add_hook(|event: &mut AfterModelCallEvent<'_>| {
        if event.error().is_some() {
            event.set_retry(true);
        }
    });
}

fn todo_tool(todo: Arc<Mutex<&'static str>>) -> ToolSource {
    MockTool::new("todo_write")
        .with_result(move |context| {
            *todo.lock().unwrap() = "v2";
            ToolResultBlock::success(
                context.tool_use().tool_use_id.clone(),
                vec![ToolResultContent::text("saved")],
            )
            .into()
        })
        .into()
}

fn todo_config(todo: &Arc<Mutex<&'static str>>) -> ContextInjectorConfig {
    let todo = todo.clone();
    ContextInjectorConfig::new(move |_| {
        let text = format!("<todos>{}</todos>", todo.lock().unwrap());
        async move { Ok(Some(text)) }
    })
    .with_trigger(InjectionTrigger::EveryTurn)
}

#[test]
fn defaults_to_the_strands_context_injector_name() {
    assert_eq!(ContextInjector::new(fixed("x")).name(), "strands:context-injector");
}

#[test]
fn honors_a_custom_name() {
    assert_eq!(ContextInjector::new(fixed("x").with_name("now")).name(), "now");
}

#[tokio::test]
async fn registers_an_invoke_model_stage_input_middleware_on_init_agent() {
    let mut agent = crate::test_support::local_agent();
    ContextInjector::new(fixed("x")).init_agent(&mut agent).await.unwrap();
    assert_eq!(
        agent.middleware().phases::<InvokeModelStage>(),
        [crate::middleware::MiddlewarePhase::Input]
    );
}

#[tokio::test]
async fn sends_the_injected_text_last_and_keeps_the_cache_point_ahead_of_it() {
    let model = MockModel::new().with_turn("Hello");
    let mut agent = agent_with(&model, vec![ContextInjector::new(fixed("<ctx>INJECTED</ctx>"))], vec![]);
    agent.invoke("what is the weather?").await.unwrap();
    let request = &model.requests()[0];
    assert_eq!(
        request.messages.last().unwrap().content.last(),
        Some(&ContentBlock::text("\n\n<ctx>INJECTED</ctx>"))
    );
    assert_eq!(request.dynamic_trailing_blocks, Some(1));
}

#[tokio::test]
async fn writes_the_text_into_the_latest_user_message_as_an_injected_block_under_its_name_sent_as_text() {
    let model = MockModel::new().with_turn("ok");
    let mut agent = setup(&model, fixed("<memory>dark mode</memory>"), vec![]);
    agent.invoke("what theme?").await.unwrap();
    assert_eq!(
        agent.messages()[0].content,
        [
            ContentBlock::text("what theme?"),
            injected("<memory>dark mode</memory>", "test")
        ]
    );
    assert_eq!(
        requests(&model)[0][0],
        json!([{"text": "what theme?"}, {"text": "\n\n<memory>dark mode</memory>"}])
    );
}

#[tokio::test]
async fn fires_no_event_for_the_write_so_listeners_keep_the_message_as_it_was_added() {
    let model = MockModel::new().with_turn("ok");
    let mut agent = setup(&model, fixed("reminder"), vec![]);
    let added = Arc::new(Mutex::new(Vec::new()));
    let record = added.clone();
    agent.add_hook(move |event: &mut MessageAddedEvent<'_>| record.lock().unwrap().push(event.message().clone()));
    agent.invoke("ask").await.unwrap();
    let added = added.lock().unwrap();
    assert_eq!(
        added.iter().map(|message| message.content.clone()).collect::<Vec<_>>(),
        [vec![ContentBlock::text("ask")], vec![ContentBlock::text("ok")]]
    );
    assert_eq!(agent.messages()[0].tracking_id(), added[0].tracking_id());
}

#[tokio::test]
async fn keeps_each_injector_apart_when_two_write_into_the_same_message() {
    let model = MockModel::new().with_turn("ok");
    let mut agent = agent_with(
        &model,
        vec![
            ContextInjector::new(fixed("likes tea").with_name("memory")),
            ContextInjector::new(fixed("cwd: /repo").with_name("env")),
        ],
        vec![],
    );
    agent.invoke("ask").await.unwrap();
    assert_eq!(
        agent.messages()[0].content,
        [
            ContentBlock::text("ask"),
            injected("likes tea", "memory"),
            injected("cwd: /repo", "env")
        ]
    );
}

#[tokio::test]
async fn writes_on_every_tool_result_turn_with_every_turn_and_sends_only_the_latest_text() {
    let todo = Arc::new(Mutex::new("v1"));
    let model = MockModel::new()
        .with_turn(tool_use_turn("todo_write"))
        .with_turn("done");
    let mut agent = setup(&model, todo_config(&todo), vec![todo_tool(todo.clone())]);
    agent.invoke("plan the work").await.unwrap();

    assert_eq!(
        agent.messages()[0].content,
        [
            ContentBlock::text("plan the work"),
            injected("<todos>v1</todos>", "test")
        ]
    );
    let result_turn = &agent.messages()[2].content;
    assert!(matches!(result_turn[0], ContentBlock::ToolResult(_)));
    assert_eq!(result_turn[1], injected("<todos>v2</todos>", "test"));
    let requests = requests(&model);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1][0], json!([{"text": "plan the work"}]));
    assert!(requests[1][2][0].get("toolResult").is_some());
    assert_eq!(requests[1][2][1], json!({"text": "\n\n<todos>v2</todos>"}));
}

#[tokio::test]
async fn keeps_every_request_a_prefix_of_the_next_for_a_model_that_takes_temporary_messages() {
    let todo = Arc::new(Mutex::new("v1"));
    let model = MockModel::new()
        .with_turn(tool_use_turn("todo_write"))
        .with_turn("done")
        .with_turn("again");
    model
        .update_config(BaseModelConfig {
            model_info: Some(ModelInfo {
                capabilities: ModelCapabilities {
                    temporary_messages: Some(true),
                    ..Default::default()
                },
                ..Default::default()
            }),
            ..Default::default()
        })
        .unwrap();
    let mut agent = setup(&model, todo_config(&todo), vec![todo_tool(todo.clone())]);
    agent.invoke("plan the work").await.unwrap();
    agent.invoke("next").await.unwrap();

    let requests = requests(&model);
    assert_eq!(requests.len(), 3);
    for pair in requests.windows(2) {
        assert_eq!(pair[1][..pair[0].len()], pair[0][..]);
    }
    assert_eq!(
        *requests[2].last().unwrap(),
        json!([{"text": "next"}, {"injected": {"text": "<todos>v2</todos>", "source": "test"}}])
    );
}

#[tokio::test]
async fn writes_on_every_user_turn_and_sends_only_the_latest_text() {
    let model = MockModel::new().with_turn("one").with_turn("two");
    let mut agent = setup(&model, fixed("cwd: /repo"), vec![]);
    agent.invoke("first").await.unwrap();
    agent.invoke("second").await.unwrap();

    assert_eq!(
        agent.messages()[0].content,
        [ContentBlock::text("first"), injected("cwd: /repo", "test")]
    );
    assert_eq!(
        agent.messages()[2].content,
        [ContentBlock::text("second"), injected("cwd: /repo", "test")]
    );
    assert_eq!(
        requests(&model)[1],
        [
            json!([{"text": "first"}]),
            json!([{"text": "one"}]),
            json!([{"text": "second"}, {"text": "\n\ncwd: /repo"}])
        ]
    );
}

#[tokio::test]
async fn writes_into_a_message_once_so_a_retry_resends_the_same_request_even_when_the_text_changes() {
    let renders = Arc::new(AtomicUsize::new(0));
    let counter = renders.clone();
    let config = ContextInjectorConfig::new(move |_| {
        let render = counter.fetch_add(1, Ordering::SeqCst) + 1;
        async move { Ok(Some(format!("<now>{render}</now>"))) }
    });
    let model = MockModel::new()
        .with_turn(MockTurn::error(|| Error::other("throttled")))
        .with_turn("ok");
    let mut agent = setup(&model, config, vec![]);
    retry_on_error(&agent);
    agent.invoke("ask").await.unwrap();

    assert_eq!(
        agent.messages()[0].content,
        [ContentBlock::text("ask"), injected("<now>1</now>", "test")]
    );
    let requests = requests(&model);
    assert_eq!(requests[1], requests[0]);
    assert_eq!(renders.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn writes_nothing_when_another_hook_cancels_the_model_call() {
    let renders = Arc::new(AtomicUsize::new(0));
    let counter = renders.clone();
    let config = ContextInjectorConfig::new(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
        async { Ok(Some("reminder".to_owned())) }
    });
    let model = MockModel::new();
    let mut agent = setup(&model, config, vec![]);
    agent.add_hook(|event: &mut BeforeModelCallEvent<'_>| event.set_cancel("denied"));
    agent.invoke("ask").await.unwrap();

    assert_eq!(agent.messages()[0].content, [ContentBlock::text("ask")]);
    assert_eq!(renders.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn writes_into_a_user_message_another_before_model_call_event_hook_adds() {
    let model = MockModel::new().with_turn("ok");
    let mut agent = setup(&model, fixed("reminder"), vec![]);
    agent.add_hook(|event: &mut BeforeModelCallEvent<'_>| {
        if event.agent().messages().len() == 1 {
            event.agent_mut().messages_mut().push(Message::user("[guide] be brief"));
        }
    });
    agent.invoke("ask").await.unwrap();

    assert_eq!(agent.messages()[0].content, [ContentBlock::text("ask")]);
    assert_eq!(
        agent.messages()[1].content,
        [ContentBlock::text("[guide] be brief"), injected("reminder", "test")]
    );
}

#[tokio::test]
async fn writes_into_the_result_a_background_task_delivers_before_the_model_call() {
    let model = MockModel::new().with_turn("one").with_turn("two");
    let mut agent = setup(
        &model,
        fixed("reminder").with_trigger(InjectionTrigger::EveryTurn),
        vec![],
    );
    agent.invoke("Run work.").await.unwrap();
    let delivered = Arc::new(AtomicUsize::new(0));
    agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| {
        if delivered.fetch_add(1, Ordering::SeqCst) > 0 {
            return;
        }
        let tool_use = Message::new(
            Role::Assistant,
            vec![ToolUseBlock::new("task", "task-1", json!({})).into()],
        );
        let result = Message::new(
            Role::User,
            vec![ContentBlock::ToolResult(ToolResultBlock::success(
                "task-1",
                vec![ToolResultContent::text("done")],
            ))],
        );
        event.add_continuation_input(ContinuationInput::new(vec![tool_use, result]));
    });
    agent.invoke("Continue.").await.unwrap();

    let last = requests(&model)[1].last().unwrap().clone();
    assert!(last[0].get("toolResult").is_some());
    assert_eq!(last[1], json!({"text": "\n\nreminder"}));
}

#[tokio::test]
async fn keeps_text_other_middleware_adds_for_one_call_after_the_injected_block() {
    struct PerCall;

    #[async_trait]
    impl Plugin for PerCall {
        fn name(&self) -> &str {
            "per-call"
        }

        async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
            agent.add_middleware(InvokeModelStage::input(|mut context| async move {
                if let Some(latest) = context.messages.last_mut() {
                    latest.content.push(ContentBlock::text("\n\nper-call"));
                }
                Ok(context)
            }));
            Ok(())
        }
    }

    let model = MockModel::new()
        .with_turn(MockTurn::error(|| Error::other("throttled")))
        .with_turn("ok");
    let mut agent = Agent::builder()
        .model(model.clone())
        .printer(false)
        .retry_strategy(vec![])
        .plugins([Arc::new(PerCall) as Arc<dyn Plugin>])
        .plugins([ContextInjector::new(fixed("reminder").with_name("test"))])
        .build()
        .unwrap();
    retry_on_error(&agent);
    agent.invoke("ask").await.unwrap();

    let requests = requests(&model);
    assert_eq!(
        requests[0][0],
        json!([{"text": "ask"}, {"text": "\n\nreminder"}, {"text": "\n\nper-call"}])
    );
    assert_eq!(requests[1], requests[0]);
}

#[tokio::test]
async fn does_not_render_on_a_tool_result_turn_with_the_default_user_turn_trigger() {
    let renders = Arc::new(AtomicUsize::new(0));
    let counter = renders.clone();
    let config = ContextInjectorConfig::new(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
        async { Ok(Some("reminder".to_owned())) }
    });
    let model = MockModel::new().with_turn(tool_use_turn("lookup")).with_turn("done");
    let mut agent = setup(&model, config, vec![MockTool::new("lookup").into()]);
    agent.invoke("ask").await.unwrap();

    assert_eq!(renders.load(Ordering::SeqCst), 1);
    let requests = requests(&model);
    assert_eq!(requests[0][0], json!([{"text": "ask"}, {"text": "\n\nreminder"}]));
    assert_eq!(requests[1][0], json!([{"text": "ask"}]));
}

#[tokio::test]
async fn passes_the_conversation_as_data_app_state_and_the_agent_to_render_content() {
    let received = Arc::new(Mutex::new(None));
    let record = received.clone();
    let config = ContextInjectorConfig::new(move |context: InjectionContext| {
        context.app_state.set("seen", true).unwrap();
        *record.lock().unwrap() = Some((
            context.messages.iter().map(|message| message.role).collect::<Vec<_>>(),
            context.agent.id().to_owned(),
        ));
        async { Ok(None) }
    });
    let model = MockModel::new().with_turn("ok");
    let mut agent = setup(&model, config, vec![]);
    agent.invoke("ask").await.unwrap();

    assert_eq!(
        *received.lock().unwrap(),
        Some((vec![Role::User], agent.id().to_owned()))
    );
    assert_eq!(agent.app_state().get_value("seen"), Some(json!(true)));
}

#[tokio::test]
async fn leaves_the_conversation_unchanged_when_render_content_returns_empty_text() {
    let model = MockModel::new().with_turn("ok");
    let mut agent = setup(&model, fixed("   "), vec![]);
    agent.invoke("ask").await.unwrap();
    assert_eq!(agent.messages()[0].content, [ContentBlock::text("ask")]);
}

#[tokio::test]
async fn leaves_the_conversation_unchanged_when_render_content_throws() {
    let (logs, _guard) = record_logs();
    let model = MockModel::new().with_turn("ok");
    let mut agent = setup(
        &model,
        ContextInjectorConfig::new(|_| async { Err("boom".into()) }),
        vec![],
    );
    agent.invoke("ask").await.unwrap();
    assert_eq!(agent.messages()[0].content, [ContentBlock::text("ask")]);
    assert!(
        logs.text()
            .contains("reason=<boom> | injection renderContent threw; skipping injection")
    );
}

#[tokio::test]
async fn keeps_injected_blocks_out_of_context_offloading() {
    let text = format!("<agents_md>{}</agents_md>", "Keep functions small. ".repeat(40));
    let model = MockModel::new().with_turn("one").with_turn("two").with_turn("three");
    let summarize = Offload::summarize(OffloadTarget::UserText, SummarizeConfig::default())
        .unwrap()
        .when(OffloadConditions {
            block_threshold: Some(20.into()),
            ..OffloadConditions::default()
        })
        .unwrap();
    let rendered = text.clone();
    let config = ContextInjectorConfig::new(move |_| {
        let rendered = rendered.clone();
        async move { Ok(Some(rendered)) }
    });
    let mut agent = Agent::builder()
        .model(model.clone())
        .printer(false)
        .retry_strategy(vec![])
        .context_manager(ContextManagerStrategy::Config(ContextManagerConfig {
            strategies: Some(vec![summarize.into()]),
            ..ContextManagerConfig::default()
        }))
        .plugins([ContextInjector::new(config.with_name("test"))])
        .build()
        .unwrap();

    agent.invoke("first").await.unwrap();
    agent.invoke("second").await.unwrap();
    agent.invoke("third").await.unwrap();

    // Three requests means the summarizer never ran on the injected block.
    assert_eq!(model.requests().len(), 3);
    assert_eq!(
        agent.messages()[0].content,
        [ContentBlock::text("first"), injected(&text, "test")]
    );
}
