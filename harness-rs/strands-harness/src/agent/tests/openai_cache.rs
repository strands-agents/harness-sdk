//! Prompt caching on OpenAI. Only the network boundary is replaced: a local server records each
//! Responses request and streams native Responses events back through the real SDK client, stream
//! adapter and agent loop. Bedrock Mantle is not covered: its endpoint is derived from its region
//! and cannot be pointed at a local server. The environment plugin reads the real date and working
//! directory, so the assertions on the environment block are structural.

use std::collections::VecDeque;
use std::num::NonZeroUsize;
use std::sync::Mutex;

use serde_json::Value;
use strands::vended_plugins::todos::{Todos, TodosConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::env::Env;

/// A Responses API stand-in: records request bodies and answers each with the next reply.
struct ResponsesServer {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
}

#[derive(Clone)]
enum Reply {
    Text(&'static str),
    Todos(Value),
}

fn sse(id: &str, reply: &Reply) -> String {
    let mut events = vec![(
        "response.created",
        json!({ "type": "response.created", "response": { "id": id } }),
    )];
    match reply {
        Reply::Text(text) => events.push((
            "response.output_text.delta",
            json!({ "type": "response.output_text.delta", "delta": text }),
        )),
        Reply::Todos(todos) => {
            events.push((
                "response.output_item.added",
                json!({ "type": "response.output_item.added", "item": { "type": "function_call", "id": "item_todos", "call_id": "call_todos", "name": "todo_write" } }),
            ));
            events.push((
                "response.function_call_arguments.done",
                json!({ "type": "response.function_call_arguments.done", "item_id": "item_todos", "arguments": json!({ "todos": todos }).to_string() }),
            ));
        }
    }
    events.push((
        "response.completed",
        json!({ "type": "response.completed", "response": { "id": id } }),
    ));
    events
        .into_iter()
        .map(|(event, data)| format!("event: {event}\ndata: {data}\n\n"))
        .collect()
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Value> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    let header_end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_lowercase();
    let length: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0);
    while buffer.len() < header_end + length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    serde_json::from_slice(&buffer[header_end..header_end + length]).ok()
}

impl ResponsesServer {
    async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
        let recorded = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let Some(request) = read_request(&mut stream).await else {
                    continue;
                };
                let count = {
                    let mut recorded = recorded.lock().unwrap();
                    recorded.push(request);
                    recorded.len()
                };
                let reply = replies
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected extra OpenAI request");
                let body = sse(&format!("response_{count}"), &reply);
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        Self { url, requests }
    }

    fn env(&self) -> Env {
        crate::test_support::env(&[("OPENAI_API_KEY", "offline-test-key"), ("OPENAI_BASE_URL", &self.url)])
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

fn todos(content: &str) -> Value {
    json!([{ "content": content, "activeForm": content, "status": "in_progress" }])
}

fn cached_text(text: &str) -> Value {
    json!({ "type": "input_text", "text": text, "prompt_cache_breakpoint": { "mode": "explicit" } })
}

fn user_input(text: &str) -> Value {
    json!({ "role": "user", "content": [cached_text(text)] })
}

/// Asserts a user input whose first block is the cached question and whose other blocks are
/// temporary text containing each of `temporary`, in order.
fn assert_user_turn(input: &Value, text: &str, temporary: &[&str]) {
    assert_eq!(input["role"], json!("user"), "{input}");
    let content = input["content"].as_array().unwrap();
    assert_eq!(content[0], cached_text(text), "{input}");
    assert_eq!(content.len(), 1 + temporary.len(), "{input}");
    for (block, expected) in content[1..].iter().zip(temporary) {
        assert_eq!(block["type"], json!("input_text"), "{input}");
        assert!(block.get("prompt_cache_breakpoint").is_none(), "{input}");
        assert!(
            block["text"].as_str().unwrap().contains(expected),
            "{expected} in {input}"
        );
    }
}

struct MemoryEntryStore;

const MEMORY_ENTRY: &str = "Offline memory: releases ship on Thursdays.";

#[async_trait]
impl strands::memory::MemoryStore for MemoryEntryStore {
    fn name(&self) -> &str {
        "memory"
    }

    fn writable(&self) -> bool {
        false
    }

    async fn search(&self, _query: &str, _options: SearchOptions) -> strands::Result<Vec<MemoryEntry>> {
        Ok(vec![MemoryEntry::new(MEMORY_ENTRY)])
    }
}

/// The conversation without injected blocks.
fn durable_history(agent: &Agent) -> Vec<Value> {
    agent
        .messages()
        .iter()
        .map(|message| {
            let mut data = serde_json::to_value(message).unwrap();
            if let Some(content) = data["content"].as_array_mut() {
                content.retain(|block| block.get("injected").is_none());
            }
            data
        })
        .collect()
}

#[tokio::test]
async fn keeps_durable_checkpoints_ahead_of_changing_todos_environment_and_tool_continuation_injections() {
    let first = "Inspect initial cache prefix";
    let second = "Inspect updated cache prefix";
    let tool = "Verify tool continuation";
    let third = "Review final cache prefix";
    let server = ResponsesServer::start(vec![
        Reply::Text("First answer"),
        Reply::Todos(todos(tool)),
        Reply::Text("Second answer"),
        Reply::Text("Third answer"),
    ])
    .await;
    let options = HarnessAgentOptions {
        model: Some("openai/gpt-6-sol".into()),
        system_prompt: Some("Keep this system prompt stable.".into()),
        builtin_tools: Some(BuiltinToolsOption::List(Vec::new())),
        builtin_plugins: Some(vec![BuiltinPluginName::Environment]),
        plugins: vec![Arc::new(Todos::new(
            TodosConfig::builder()
                .reminder_interval(NonZeroUsize::new(1).unwrap())
                .build(),
        ))],
        memory: Some(
            MemoryConfig {
                stores: vec![Arc::new(MemoryEntryStore)],
                ..Default::default()
            }
            .into(),
        ),
        context_manager: Some(ContextManagerStrategy::Disabled),
        background_tasks: Some(false.into()),
        interventions: Some("off".into()),
        ..quiet()
    };
    let assembly = assemble(options, &server.env()).await.unwrap();
    assert!(assembly.model_plan.as_ref().unwrap().caching);
    let mut agent = Agent::new(assembly.config).unwrap();

    agent.app_state().set("todos", todos(first)).unwrap();
    agent.invoke("First question").await.unwrap();
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let input = requests[0]["input"].as_array().unwrap();
    assert_eq!(input.len(), 1);
    assert_user_turn(&input[0], "First question", &[first, "Date: ", MEMORY_ENTRY]);
    assert!(requests[0]["input"].to_string().contains("Working directory: "));
    let first_history = durable_history(&agent);
    assert_eq!(first_history.len(), 2);
    assert_eq!(first_history[0]["content"], json!([{ "text": "First question" }]));
    assert_eq!(first_history[1]["content"], json!([{ "text": "First answer" }]));

    agent.app_state().set("todos", todos(second)).unwrap();
    agent.invoke("Second question").await.unwrap();
    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    let input = requests[1]["input"].as_array().unwrap();
    assert_eq!(input[0], user_input("First question"));
    assert_eq!(input[1], json!({ "role": "assistant", "content": "First answer" }));
    assert_user_turn(&input[2], "Second question", &[second, "Date: ", MEMORY_ENTRY]);
    let tool_call = json!({
        "type": "function_call",
        "call_id": "call_todos",
        "name": "todo_write",
        "arguments": json!({ "todos": todos(tool) }).to_string(),
    });
    let tool_output = json!({
        "type": "function_call_output",
        "call_id": "call_todos",
        "output": [cached_text(&format!("1 todos remaining\n  [in_progress] {tool}"))],
    });
    let input = requests[2]["input"].as_array().unwrap();
    assert_eq!(
        &input[..5],
        &[
            user_input("First question"),
            json!({ "role": "assistant", "content": "First answer" }),
            user_input("Second question"),
            tool_call.clone(),
            tool_output.clone()
        ]
    );
    // The call carrying the todo_write result shows the list there, so no reminder follows it.
    assert_eq!(input.len(), 5);
    assert_eq!(agent.app_state().get_value("todos"), Some(todos(tool)));
    // Environment is user-turn only.
    assert!(!requests[2]["input"].to_string().contains("<environment>"));
    for request in &requests[1..] {
        assert!(!request["input"].to_string().contains(first));
    }
    assert!(!requests[2]["input"].to_string().contains(second));

    agent.app_state().set("todos", todos(third)).unwrap();
    agent.invoke("Third question").await.unwrap();
    let requests = server.requests();
    assert_eq!(requests.len(), 4);
    let input = requests[3]["input"].as_array().unwrap();
    assert_eq!(
        &input[..5],
        &[
            user_input("First question"),
            json!({ "role": "assistant", "content": "First answer" }),
            user_input("Second question"),
            tool_call,
            tool_output
        ]
    );
    assert_eq!(input[5], json!({ "role": "assistant", "content": "Second answer" }));
    assert_user_turn(&input[6], "Third question", &[third, "Date: ", MEMORY_ENTRY]);
    let latest = requests[3]["input"].to_string();
    assert!(!latest.contains(first) && !latest.contains(second));

    let history = durable_history(&agent);
    let injected_roles: Vec<String> = agent
        .messages()
        .iter()
        .filter(|message| {
            serde_json::to_value(message).unwrap()["content"]
                .as_array()
                .unwrap()
                .iter()
                .any(|block| block.get("injected").is_some())
        })
        .map(|message| {
            serde_json::to_value(message).unwrap()["role"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert!(injected_roles.iter().all(|role| role == "user"));
    assert_eq!(history[..first_history.len()], first_history[..]);
    assert_eq!(history.len(), 8);
    let durable = serde_json::to_string(&history).unwrap();
    for temporary in [
        "<system-reminder>",
        "<environment>",
        "<memory>",
        MEMORY_ENTRY,
        "prompt_cache_breakpoint",
        first,
        second,
        third,
    ] {
        assert!(!durable.contains(temporary), "{temporary}");
    }
    for request in &requests {
        assert_eq!(request["model"], json!("gpt-6-sol"));
        assert_eq!(request["stream"], json!(true));
        assert_eq!(request["store"], json!(false));
        assert_eq!(request["instructions"], json!("Keep this system prompt stable."));
        assert_eq!(request["prompt_cache_options"], json!({ "mode": "explicit" }));
        assert!(request.get("previous_response_id").is_none());
    }
}

#[tokio::test]
async fn sends_the_session_cache_key_when_caching_is_on() {
    for (model, cache_points) in [("openai/gpt-6-sol", true), ("openai/gpt-4.1", false)] {
        for caching in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let server = ResponsesServer::start(vec![Reply::Text("Done")]).await;
            let options = HarnessAgentOptions {
                model: Some(model.into()),
                caching: Some(caching),
                session: Some(
                    SessionConfig::builder()
                        .id("cache-key-test")
                        .dir(dir.path())
                        .build()
                        .into(),
                ),
                builtin_tools: Some(BuiltinToolsOption::List(Vec::new())),
                builtin_plugins: Some(Vec::new()),
                context_manager: Some(ContextManagerStrategy::Disabled),
                background_tasks: Some(false.into()),
                interventions: Some("off".into()),
                ..quiet()
            };
            let mut agent = create_harness_boxed(options, server.env()).await.unwrap();
            agent.invoke("Hello").await.unwrap();
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            let request = &requests[0];
            let breakpoints = request["input"].to_string().contains("prompt_cache_breakpoint");
            if caching {
                assert_eq!(request["prompt_cache_key"], json!("strands-cache-key-test"), "{model}");
                assert_eq!(request.get("prompt_cache_options").is_some(), cache_points, "{model}");
                assert_eq!(breakpoints, cache_points, "{model}");
            } else {
                assert!(request.get("prompt_cache_key").is_none(), "{model}");
                assert!(request.get("prompt_cache_options").is_none(), "{model}");
                assert!(!breakpoints, "{model}");
            }
        }
    }
}
