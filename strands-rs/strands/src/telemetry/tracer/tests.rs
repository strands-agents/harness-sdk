//! Agent, cycle, model and tool spans, and local traces. The memory spans are in
//! `memory/tests.rs`; the multi-agent spans come with that feature.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::json;

use super::*;

use crate::types::{ContentBlock, Role};

fn settings(env: &[(&str, &str)]) -> TracerSettings {
    let env: BTreeMap<String, String> = env
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    TracerSettings::from_lookup(&move |key| env.get(key).cloned())
}

fn tracer_with(env: &[(&str, &str)], attributes: &[(&str, AttributeValue)]) -> Arc<Tracer> {
    let attributes = attributes
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect();
    Arc::new(Tracer::with_settings(settings(env), attributes, BTreeMap::new()))
}

fn tracer() -> Arc<Tracer> {
    tracer_with(&[], &[])
}

fn text_message(role: Role, text: &str) -> Message {
    Message::new(role, vec![ContentBlock::text(text)])
}

fn agent_options<'a>(messages: &'a [Message], agent_name: &'a str) -> StartAgentSpanOptions<'a> {
    StartAgentSpanOptions {
        messages,
        agent_name,
        ..StartAgentSpanOptions::default()
    }
}

fn tool_use(name: &str, id: &str, input: serde_json::Value) -> ToolUse {
    ToolUse::new(name, id, input)
}

#[cfg(feature = "otel")]
mod otel {
    use opentelemetry_sdk::trace::SpanData;

    use crate::types::ReasoningBlock;

    use super::*;
    use crate::telemetry::test_support::{
        attr, attr_i64, attr_str, capture_spans, event_attr, event_json, events, exceptions, is_error,
    };
    use crate::types::{
        CachePointBlock, InjectedBlock, SummaryBlock, SystemContentBlock, TextBlock, ToolResultContent, ToolUseBlock,
    };

    fn latest() -> Arc<Tracer> {
        tracer_with(&[("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")], &[])
    }

    fn hi() -> Vec<Message> {
        vec![text_message(Role::User, "Hi")]
    }

    #[test]
    fn reads_service_name_from_otel_service_name_env_var() {
        let capture = capture_spans();
        let tracer = tracer_with(&[("OTEL_SERVICE_NAME", "my-custom-service")], &[]);
        drop(tracer.start_agent_span(agent_options(&hi(), "agent")));
        assert_eq!(
            attr_str(&capture.span("invoke_agent agent"), "gen_ai.system").as_deref(),
            Some("my-custom-service")
        );
    }

    #[test]
    fn defaults_service_name_to_strands_agents() {
        let capture = capture_spans();
        let tracer = tracer_with(&[("OTEL_SERVICE_NAME", "")], &[]);
        drop(tracer.start_agent_span(agent_options(&hi(), "agent")));
        assert_eq!(
            attr_str(&capture.span("invoke_agent agent"), "gen_ai.system").as_deref(),
            Some("strands-agents")
        );
    }

    #[test]
    fn creates_span_with_correct_name_and_standard_attributes() {
        let capture = capture_spans();
        let messages = vec![text_message(Role::User, "Hello")];
        drop(tracer().start_agent_span(StartAgentSpanOptions {
            model_id: Some("model-123"),
            ..agent_options(&messages, "test-agent")
        }));
        let span = capture.span("invoke_agent test-agent");
        assert_eq!(
            attr_str(&span, "gen_ai.operation.name").as_deref(),
            Some("invoke_agent")
        );
        assert!(attr_str(&span, "gen_ai.system").is_some());
        assert_eq!(attr_str(&span, "gen_ai.agent.name").as_deref(), Some("test-agent"));
        assert_eq!(attr_str(&span, "gen_ai.request.model").as_deref(), Some("model-123"));
        assert_eq!(attr_str(&span, "name").as_deref(), Some("invoke_agent test-agent"));
        assert!(attr_str(&span, "gen_ai.event.start_time").is_some());
    }

    #[test]
    fn includes_agent_id_when_provided() {
        let capture = capture_spans();
        drop(tracer().start_agent_span(StartAgentSpanOptions {
            agent_id: Some("agent-42"),
            ..agent_options(&hi(), "test-agent")
        }));
        assert_eq!(
            attr_str(&capture.span("invoke_agent test-agent"), "gen_ai.agent.id").as_deref(),
            Some("agent-42")
        );
    }

    #[test]
    fn serializes_tool_names_into_gen_ai_agent_tools() {
        let capture = capture_spans();
        let tools = vec!["calculator".to_owned(), "search".to_owned()];
        drop(tracer().start_agent_span(StartAgentSpanOptions {
            tools: &tools,
            ..agent_options(&hi(), "test-agent")
        }));
        assert_eq!(
            attr_str(&capture.span("invoke_agent test-agent"), "gen_ai.agent.tools").as_deref(),
            Some(r#"["calculator","search"]"#)
        );
    }

    fn input_schema() -> JsonValue {
        json!({"type": "object", "properties": {"expression": {"type": "string"}}})
    }

    fn output_schema() -> JsonValue {
        json!({"type": "object", "properties": {"value": {"type": "number"}}})
    }

    fn tools_config() -> JsonObject {
        json!({
            "calc": {"name": "calc", "description": "Calculator", "inputSchema": input_schema(), "outputSchema": output_schema()},
            "clock": {"name": "clock", "description": "Current time"},
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn includes_tool_definitions_when_gen_ai_tool_definitions_opt_in_is_set() {
        let capture = capture_spans();
        let config = tools_config();
        let tracer = tracer_with(&[("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_tool_definitions")], &[]);
        drop(tracer.start_agent_span(StartAgentSpanOptions {
            tools_config: Some(&config),
            ..agent_options(&hi(), "test-agent")
        }));
        let definitions = attr_str(&capture.span("invoke_agent test-agent"), "gen_ai.tool.definitions").unwrap();
        assert_eq!(
            serde_json::from_str::<JsonValue>(&definitions).unwrap(),
            json!([
                {"name": "calc", "description": "Calculator", "inputSchema": input_schema(), "outputSchema": output_schema()},
                {"name": "clock", "description": "Current time", "inputSchema": null, "outputSchema": null},
            ])
        );
    }

    #[test]
    fn omits_tool_definitions_without_the_opt_in() {
        let capture = capture_spans();
        let config = tools_config();
        drop(tracer().start_agent_span(StartAgentSpanOptions {
            tools_config: Some(&config),
            ..agent_options(&hi(), "test-agent")
        }));
        assert!(attr(&capture.span("invoke_agent test-agent"), "gen_ai.tool.definitions").is_none());
    }

    #[test]
    fn serializes_system_prompt_into_attribute() {
        let capture = capture_spans();
        let prompt = SystemPrompt::from("You are a helpful assistant");
        drop(tracer().start_agent_span(StartAgentSpanOptions {
            system_prompt: Some(&prompt),
            ..agent_options(&hi(), "test-agent")
        }));
        assert_eq!(
            attr_str(&capture.span("invoke_agent test-agent"), "system_prompt").as_deref(),
            Some(r#""You are a helpful assistant""#)
        );
    }

    #[test]
    fn merges_constructor_level_and_call_level_trace_attributes() {
        let capture = capture_spans();
        let tracer = tracer_with(&[], &[("global.attr", "global-val".into())]);
        let call = vec![("custom.session".to_owned(), AttributeValue::from("sess-1"))];
        drop(tracer.start_agent_span(StartAgentSpanOptions {
            trace_attributes: &call,
            ..agent_options(&hi(), "test-agent")
        }));
        let span = capture.span("invoke_agent test-agent");
        assert_eq!(attr_str(&span, "global.attr").as_deref(), Some("global-val"));
        assert_eq!(attr_str(&span, "custom.session").as_deref(), Some("sess-1"));
    }

    #[test]
    fn adds_separate_stable_message_events_per_message() {
        let capture = capture_spans();
        let messages = vec![text_message(Role::User, "Hello"), text_message(Role::Assistant, "Hi")];
        drop(tracer().start_agent_span(agent_options(&messages, "test-agent")));
        let span = capture.span("invoke_agent test-agent");
        assert_eq!(events(&span, "gen_ai.user.message").len(), 1);
        assert_eq!(events(&span, "gen_ai.assistant.message").len(), 1);
    }

    #[test]
    fn classifies_tool_result_messages_as_gen_ai_tool_message() {
        let capture = capture_spans();
        let messages = vec![Message::new(
            Role::User,
            vec![ContentBlock::ToolResult(ToolResultBlock::success(
                "tool-1",
                vec![ToolResultContent::text("done")],
            ))],
        )];
        drop(tracer().start_agent_span(agent_options(&messages, "test-agent")));
        assert_eq!(
            events(&capture.span("invoke_agent test-agent"), "gen_ai.tool.message").len(),
            1
        );
    }

    #[test]
    fn adds_single_operation_details_event_with_latest_conventions() {
        let capture = capture_spans();
        let messages = vec![text_message(Role::User, "Hello"), text_message(Role::Assistant, "Hi")];
        drop(latest().start_agent_span(agent_options(&messages, "test-agent")));
        let details = events(&capture.span("invoke_agent test-agent"), OPERATION_DETAILS);
        assert_eq!(details.len(), 1);
        assert_eq!(
            event_json(&details[0], "gen_ai.input.messages"),
            json!([
                {"role": "user", "parts": [{"type": "text", "content": "Hello"}]},
                {"role": "assistant", "parts": [{"type": "text", "content": "Hi"}]},
            ])
        );
    }

    #[test]
    fn uses_gen_ai_provider_name_with_latest_conventions() {
        let capture = capture_spans();
        drop(latest().start_agent_span(agent_options(&hi(), "test-agent")));
        let span = capture.span("invoke_agent test-agent");
        assert!(attr(&span, "gen_ai.provider.name").is_some());
        assert!(attr(&span, "gen_ai.system").is_none());
    }

    #[test]
    fn uses_gen_ai_system_with_stable_conventions() {
        let capture = capture_spans();
        drop(tracer().start_agent_span(agent_options(&hi(), "test-agent")));
        let span = capture.span("invoke_agent test-agent");
        assert!(attr(&span, "gen_ai.system").is_some());
        assert!(attr(&span, "gen_ai.provider.name").is_none());
    }

    #[test]
    fn end_agent_span_sets_ok_status_and_ends_span_on_success() {
        let capture = capture_spans();
        tracer()
            .start_agent_span(agent_options(&hi(), "agent"))
            .end(EndAgentSpanOptions::default());
        let span = capture.span("invoke_agent agent");
        assert_eq!(span.status, opentelemetry::trace::Status::Ok);
        assert!(attr_str(&span, "gen_ai.event.end_time").is_some());
    }

    #[test]
    fn end_agent_span_sets_error_status_and_records_exception_on_error() {
        let capture = capture_spans();
        tracer()
            .start_agent_span(agent_options(&hi(), "agent"))
            .end(EndAgentSpanOptions {
                error: Some("agent failed".into()),
                ..EndAgentSpanOptions::default()
            });
        let span = capture.span("invoke_agent agent");
        assert!(is_error(&span, "agent failed"));
        assert_eq!(exceptions(&span), vec!["agent failed".to_owned()]);
    }

    #[test]
    fn sets_accumulated_usage_attributes() {
        let capture = capture_spans();
        tracer()
            .start_agent_span(agent_options(&hi(), "agent"))
            .end(EndAgentSpanOptions {
                accumulated_usage: Some(Usage::new(100, 200, 300)),
                ..EndAgentSpanOptions::default()
            });
        let span = capture.span("invoke_agent agent");
        assert_eq!(attr_i64(&span, "gen_ai.usage.input_tokens"), Some(100));
        assert_eq!(attr_i64(&span, "gen_ai.usage.output_tokens"), Some(200));
        assert_eq!(attr_i64(&span, "gen_ai.usage.total_tokens"), Some(300));
        assert_eq!(attr_i64(&span, "gen_ai.usage.prompt_tokens"), Some(100));
        assert_eq!(attr_i64(&span, "gen_ai.usage.completion_tokens"), Some(200));
    }

    fn disjoint_cache_usage() -> Usage {
        Usage::new(10, 20, 58)
            .with_cache_read_input_tokens(25)
            .with_cache_write_input_tokens(3)
    }

    #[test]
    fn includes_cached_tokens_in_accumulated_input_tokens_for_disjoint_cache_providers() {
        let capture = capture_spans();
        tracer()
            .start_agent_span(agent_options(&hi(), "agent"))
            .end(EndAgentSpanOptions {
                accumulated_usage: Some(disjoint_cache_usage()),
                ..EndAgentSpanOptions::default()
            });
        let span = capture.span("invoke_agent agent");
        assert_eq!(attr_i64(&span, "gen_ai.usage.input_tokens"), Some(38));
        assert_eq!(attr_i64(&span, "gen_ai.usage.prompt_tokens"), Some(38));
        assert_eq!(attr_i64(&span, "gen_ai.usage.total_tokens"), Some(58));
    }

    #[test]
    fn adds_response_event_with_stable_conventions() {
        let capture = capture_spans();
        let response = text_message(Role::Assistant, "Hello back");
        tracer()
            .start_agent_span(agent_options(&hi(), "agent"))
            .end(EndAgentSpanOptions {
                response: Some(&response),
                stop_reason: Some("end_turn"),
                ..EndAgentSpanOptions::default()
            });
        let choices = events(&capture.span("invoke_agent agent"), "gen_ai.choice");
        assert_eq!(choices.len(), 1);
        assert_eq!(event_attr(&choices[0], "message"), "Hello back");
        assert_eq!(event_attr(&choices[0], "finish_reason"), "end_turn");
    }

    #[test]
    fn adds_response_event_with_latest_conventions() {
        let capture = capture_spans();
        let response = text_message(Role::Assistant, "Hello back");
        latest()
            .start_agent_span(agent_options(&hi(), "agent"))
            .end(EndAgentSpanOptions {
                response: Some(&response),
                stop_reason: Some("end_turn"),
                ..EndAgentSpanOptions::default()
            });
        let details = events(&capture.span("invoke_agent agent"), OPERATION_DETAILS);
        let output = details
            .iter()
            .find(|event| {
                event
                    .attributes
                    .iter()
                    .any(|kv| kv.key.as_str() == "gen_ai.output.messages")
            })
            .unwrap();
        assert_eq!(
            event_json(output, "gen_ai.output.messages"),
            json!([{"role": "assistant", "parts": [{"type": "text", "content": "Hello back"}], "finish_reason": "end_turn"}])
        );
    }

    #[test]
    fn creates_span_with_chat_operation_name_and_model_id() {
        let capture = capture_spans();
        drop(tracer().start_model_invoke_span(StartModelInvokeSpanOptions {
            messages: &[text_message(Role::User, "Hello")],
            model_id: Some("claude-3"),
            system_prompt: None,
        }));
        let span = capture.span("chat");
        assert_eq!(attr_str(&span, "gen_ai.operation.name").as_deref(), Some("chat"));
        assert_eq!(attr_str(&span, "gen_ai.request.model").as_deref(), Some("claude-3"));
    }

    #[test]
    fn model_span_adds_message_events_to_span() {
        let capture = capture_spans();
        drop(tracer().start_model_invoke_span(StartModelInvokeSpanOptions {
            messages: &[text_message(Role::User, "Hello")],
            ..StartModelInvokeSpanOptions::default()
        }));
        assert_eq!(events(&capture.span("chat"), "gen_ai.user.message").len(), 1);
    }

    #[test]
    fn includes_constructor_level_trace_attributes_overriding_standard_ones() {
        let capture = capture_spans();
        let tracer = tracer_with(
            &[],
            &[
                ("session.id", "sess-1".into()),
                ("gen_ai.request.model", "override".into()),
            ],
        );
        drop(tracer.start_model_invoke_span(StartModelInvokeSpanOptions {
            messages: &[text_message(Role::User, "Hello")],
            model_id: Some("claude-3"),
            system_prompt: None,
        }));
        let span = capture.span("chat");
        assert_eq!(attr_str(&span, "session.id").as_deref(), Some("sess-1"));
        assert_eq!(attr_str(&span, "gen_ai.request.model").as_deref(), Some("override"));
    }

    fn end_chat(tracer: &Arc<Tracer>, options: EndModelSpanOptions<'_>) {
        tracer
            .start_model_invoke_span(StartModelInvokeSpanOptions {
                messages: &hi(),
                ..StartModelInvokeSpanOptions::default()
            })
            .end(options);
    }

    #[test]
    fn sets_usage_and_metrics_attributes() {
        let capture = capture_spans();
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                usage: Some(&Usage::new(10, 20, 30)),
                metrics: Some(&Metrics::new(500)),
                ..EndModelSpanOptions::default()
            },
        );
        let span = capture.span("chat");
        assert_eq!(attr_i64(&span, "gen_ai.usage.input_tokens"), Some(10));
        assert_eq!(attr_i64(&span, "gen_ai.usage.output_tokens"), Some(20));
        assert_eq!(attr_i64(&span, "gen_ai.usage.total_tokens"), Some(30));
        assert_eq!(attr_i64(&span, "gen_ai.server.request.duration"), Some(500));
    }

    #[test]
    fn includes_cached_tokens_in_input_tokens_for_disjoint_cache_providers() {
        let capture = capture_spans();
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                usage: Some(&disjoint_cache_usage()),
                ..EndModelSpanOptions::default()
            },
        );
        let span = capture.span("chat");
        assert_eq!(attr_i64(&span, "gen_ai.usage.input_tokens"), Some(38));
        assert_eq!(attr_i64(&span, "gen_ai.usage.prompt_tokens"), Some(38));
        assert_eq!(attr_i64(&span, "gen_ai.usage.output_tokens"), Some(20));
        assert_eq!(attr_i64(&span, "gen_ai.usage.total_tokens"), Some(58));
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_read.input_tokens"), Some(25));
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_creation.input_tokens"), Some(3));
    }

    #[test]
    fn does_not_double_count_when_the_provider_already_includes_cache_in_input_tokens() {
        let capture = capture_spans();
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                usage: Some(&Usage::new(100, 20, 120).with_cache_read_input_tokens(30)),
                ..EndModelSpanOptions::default()
            },
        );
        let span = capture.span("chat");
        assert_eq!(attr_i64(&span, "gen_ai.usage.input_tokens"), Some(100));
        assert_eq!(attr_i64(&span, "gen_ai.usage.prompt_tokens"), Some(100));
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_read.input_tokens"), Some(30));
    }

    #[test]
    fn sets_cache_token_attributes_when_provided() {
        let capture = capture_spans();
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                usage: Some(
                    &Usage::new(100, 200, 300)
                        .with_cache_read_input_tokens(50)
                        .with_cache_write_input_tokens(25),
                ),
                ..EndModelSpanOptions::default()
            },
        );
        let span = capture.span("chat");
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_read.input_tokens"), Some(50));
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_creation.input_tokens"), Some(25));
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_read_input_tokens"), Some(50));
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_write_input_tokens"), Some(25));
    }

    #[test]
    fn skips_cache_token_attributes_when_zero() {
        let capture = capture_spans();
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                usage: Some(&Usage::new(10, 20, 30).with_cache_read_input_tokens(0)),
                ..EndModelSpanOptions::default()
            },
        );
        let span = capture.span("chat");
        assert!(attr(&span, "gen_ai.usage.cache_read.input_tokens").is_none());
        assert!(attr(&span, "gen_ai.usage.cache_read_input_tokens").is_none());
    }

    #[test]
    fn dual_emits_cache_usage_under_both_the_semconv_names_and_the_deprecated_aliases() {
        let capture = capture_spans();
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                usage: Some(&Usage::new(10, 4, 14).with_cache_read_input_tokens(5848)),
                ..EndModelSpanOptions::default()
            },
        );
        let span = capture.span("chat");
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_read.input_tokens"), Some(5848));
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_read_input_tokens"), Some(5848));
    }

    #[test]
    fn suppresses_the_deprecated_cache_aliases_when_opted_into_the_latest_conventions() {
        let capture = capture_spans();
        end_chat(
            &latest(),
            EndModelSpanOptions {
                usage: Some(
                    &Usage::new(10, 4, 14)
                        .with_cache_read_input_tokens(5848)
                        .with_cache_write_input_tokens(3),
                ),
                ..EndModelSpanOptions::default()
            },
        );
        let span = capture.span("chat");
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_read.input_tokens"), Some(5848));
        assert_eq!(attr_i64(&span, "gen_ai.usage.cache_creation.input_tokens"), Some(3));
        assert!(attr(&span, "gen_ai.usage.cache_read_input_tokens").is_none());
        assert!(attr(&span, "gen_ai.usage.cache_write_input_tokens").is_none());
    }

    #[test]
    fn skips_latency_attribute_when_zero() {
        let capture = capture_spans();
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                usage: Some(&Usage::new(10, 20, 30)),
                metrics: Some(&Metrics::new(0)),
                ..EndModelSpanOptions::default()
            },
        );
        assert!(attr(&capture.span("chat"), "gen_ai.server.request.duration").is_none());
    }

    fn mixed_output(text: &str, input: serde_json::Value) -> Message {
        Message::new(
            Role::Assistant,
            vec![
                ContentBlock::text(text),
                ContentBlock::ToolUse(ToolUseBlock::new("calc", "tool-1", input)),
            ],
        )
    }

    #[test]
    fn adds_output_event_with_stable_conventions_for_mixed_content() {
        let capture = capture_spans();
        let output = mixed_output("The answer is 42", json!({"expr": "6*7"}));
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                output: Some(&output),
                stop_reason: Some("tool_use"),
                ..EndModelSpanOptions::default()
            },
        );
        let choices = events(&capture.span("chat"), "gen_ai.choice");
        assert_eq!(choices.len(), 1);
        assert_eq!(event_attr(&choices[0], "finish_reason"), "tool_use");
        assert_eq!(
            event_json(&choices[0], "message"),
            json!([
                {"text": "The answer is 42"},
                {"type": "toolUse", "name": "calc", "toolUseId": "tool-1", "input": {"expr": "6*7"}},
            ])
        );
    }

    fn reasoning_output() -> Message {
        Message::new(
            Role::Assistant,
            vec![
                ContentBlock::Reasoning(
                    ReasoningBlock::new()
                        .with_text("Multiply 17 by 23.")
                        .with_signature("sig-secret"),
                ),
                ContentBlock::text("391"),
            ],
        )
    }

    fn output_messages(span: &SpanData) -> JsonValue {
        let details = events(span, OPERATION_DETAILS);
        let event = details
            .iter()
            .find(|event| {
                event
                    .attributes
                    .iter()
                    .any(|kv| kv.key.as_str() == "gen_ai.output.messages")
            })
            .unwrap();
        event_json(event, "gen_ai.output.messages")
    }

    #[test]
    fn keeps_reasoning_text_as_a_reasoning_part_with_name_and_never_exports_the_signature() {
        for (name, tracer) in [("stable conventions", tracer()), ("latest conventions", latest())] {
            let capture = capture_spans();
            let output = reasoning_output();
            end_chat(
                &tracer,
                EndModelSpanOptions {
                    output: Some(&output),
                    stop_reason: Some("end_turn"),
                    ..EndModelSpanOptions::default()
                },
            );
            let span = capture.span("chat");
            let read = match name {
                "stable conventions" => event_json(&events(&span, "gen_ai.choice")[0], "message"),
                _ => output_messages(&span),
            };
            let expected = match name {
                "stable conventions" => json!([{"type": "reasoning", "text": "Multiply 17 by 23."}, {"text": "391"}]),
                _ => json!([{
                    "role": "assistant",
                    "parts": [
                        {"type": "reasoning", "content": "Multiply 17 by 23."},
                        {"type": "text", "content": "391"},
                    ],
                    "finish_reason": "end_turn",
                }]),
            };
            assert_eq!(read, expected, "{name}");
            assert!(!format!("{:?}", span.events).contains("sig-secret"), "{name}");
        }
    }

    #[test]
    fn does_not_export_redacted_reasoning_content() {
        let capture = capture_spans();
        let output = Message::new(
            Role::Assistant,
            vec![
                ContentBlock::Reasoning(ReasoningBlock::new().with_redacted_content(vec![1, 2, 3])),
                ContentBlock::text("done"),
            ],
        );
        end_chat(
            &latest(),
            EndModelSpanOptions {
                output: Some(&output),
                stop_reason: Some("end_turn"),
                ..EndModelSpanOptions::default()
            },
        );
        assert_eq!(
            output_messages(&capture.span("chat"))[0]["parts"],
            json!([{"type": "reasoningBlock"}, {"type": "text", "content": "done"}])
        );
    }

    #[test]
    fn adds_output_event_with_latest_conventions_for_mixed_content() {
        let capture = capture_spans();
        let output = mixed_output("The answer", json!({"x": 1}));
        end_chat(
            &latest(),
            EndModelSpanOptions {
                output: Some(&output),
                stop_reason: Some("tool_use"),
                ..EndModelSpanOptions::default()
            },
        );
        let details = events(&capture.span("chat"), OPERATION_DETAILS);
        let event = details
            .iter()
            .find(|event| {
                event
                    .attributes
                    .iter()
                    .any(|kv| kv.key.as_str() == "gen_ai.output.messages")
            })
            .unwrap();
        assert_eq!(
            event_json(event, "gen_ai.output.messages"),
            json!([{
                "role": "assistant",
                "parts": [
                    {"type": "text", "content": "The answer"},
                    {"type": "tool_call", "name": "calc", "id": "tool-1", "arguments": {"x": 1}},
                ],
                "finish_reason": "tool_use",
            }])
        );
    }

    #[test]
    fn records_error_on_model_invocation_failure() {
        let capture = capture_spans();
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                error: Some("model timeout"),
                ..EndModelSpanOptions::default()
            },
        );
        let span = capture.span("chat");
        assert!(is_error(&span, "model timeout"));
        assert_eq!(exceptions(&span), vec!["model timeout".to_owned()]);
    }

    #[test]
    fn creates_span_with_tool_name_and_call_id() {
        let capture = capture_spans();
        drop(tracer().start_tool_call_span(&tool_use("calculator", "call-1", json!({"expr": "2+2"}))));
        let span = capture.span("execute_tool calculator");
        assert_eq!(
            attr_str(&span, "gen_ai.operation.name").as_deref(),
            Some("execute_tool")
        );
        assert_eq!(attr_str(&span, "gen_ai.tool.name").as_deref(), Some("calculator"));
        assert_eq!(attr_str(&span, "gen_ai.tool.call.id").as_deref(), Some("call-1"));
    }

    #[test]
    fn tool_span_includes_constructor_level_trace_attributes() {
        let capture = capture_spans();
        let tracer = tracer_with(&[], &[("session.id", "sess-1".into())]);
        drop(tracer.start_tool_call_span(&tool_use("calculator", "call-1", json!({"expr": "2+2"}))));
        let span = capture.span("execute_tool calculator");
        assert_eq!(attr_str(&span, "session.id").as_deref(), Some("sess-1"));
        assert_eq!(attr_str(&span, "gen_ai.tool.name").as_deref(), Some("calculator"));
    }

    #[test]
    fn adds_stable_tool_message_event_with_serialized_input() {
        let capture = capture_spans();
        drop(tracer().start_tool_call_span(&tool_use("search", "call-2", json!({"query": "test"}))));
        let tool_events = events(&capture.span("execute_tool search"), "gen_ai.tool.message");
        assert_eq!(tool_events.len(), 1);
        assert_eq!(event_attr(&tool_events[0], "role"), "tool");
        assert_eq!(event_attr(&tool_events[0], "content"), r#"{"query":"test"}"#);
        assert_eq!(event_attr(&tool_events[0], "id"), "call-2");
    }

    #[test]
    fn adds_latest_convention_tool_input_event() {
        let capture = capture_spans();
        drop(latest().start_tool_call_span(&tool_use("search", "call-2", json!({"query": "test"}))));
        let details = events(&capture.span("execute_tool search"), OPERATION_DETAILS);
        assert_eq!(details.len(), 1);
        assert_eq!(
            event_json(&details[0], "gen_ai.input.messages"),
            json!([{
                "role": "tool",
                "parts": [{"type": "tool_call", "name": "search", "id": "call-2", "arguments": {"query": "test"}}],
            }])
        );
    }

    #[test]
    fn sets_latest_convention_tool_call_arguments_attribute() {
        let capture = capture_spans();
        drop(latest().start_tool_call_span(&tool_use("search", "call-2", json!({"query": "test"}))));
        assert_eq!(
            attr_str(&capture.span("execute_tool search"), "gen_ai.tool.call.arguments").as_deref(),
            Some(r#"{"query":"test"}"#)
        );
    }

    fn end_calc(tracer: &Arc<Tracer>, result: &ToolResultBlock) {
        tracer
            .start_tool_call_span(&tool_use("calc", "call-1", json!({})))
            .end(EndToolCallSpanOptions {
                tool_result: Some(result),
                error: None,
            });
    }

    fn calc_result(status: ToolResultStatus, text: &str) -> ToolResultBlock {
        ToolResultBlock::new("call-1", status, vec![ToolResultContent::text(text)])
    }

    #[test]
    fn sets_tool_status_attribute_and_adds_stable_result_event() {
        let capture = capture_spans();
        end_calc(&tracer(), &calc_result(ToolResultStatus::Success, "42"));
        let span = capture.span("execute_tool calc");
        assert_eq!(attr_str(&span, "gen_ai.tool.status").as_deref(), Some("success"));
        let choices = events(&span, "gen_ai.choice");
        assert_eq!(choices.len(), 1);
        assert_eq!(event_attr(&choices[0], "id"), "call-1");
        assert_eq!(event_json(&choices[0], "message"), json!([{"text": "42"}]));
    }

    #[test]
    fn adds_latest_convention_tool_result_event() {
        let capture = capture_spans();
        end_calc(&latest(), &calc_result(ToolResultStatus::Success, "42"));
        let details = events(&capture.span("execute_tool calc"), OPERATION_DETAILS);
        let event = details
            .iter()
            .find(|event| {
                event
                    .attributes
                    .iter()
                    .any(|kv| kv.key.as_str() == "gen_ai.output.messages")
            })
            .unwrap();
        let parsed = event_json(event, "gen_ai.output.messages");
        assert_eq!(parsed[0]["role"], "tool");
        assert_eq!(parsed[0]["parts"][0]["type"], "tool_call_response");
        assert_eq!(parsed[0]["parts"][0]["id"], "call-1");
    }

    #[test]
    fn sets_latest_convention_tool_call_result_attribute_on_success() {
        let capture = capture_spans();
        end_calc(&latest(), &calc_result(ToolResultStatus::Success, "42"));
        let result = attr_str(&capture.span("execute_tool calc"), "gen_ai.tool.call.result").unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&result).unwrap(),
            json!([{"text": "42"}])
        );
    }

    #[test]
    fn omits_latest_convention_tool_call_result_attribute_on_error_status() {
        let capture = capture_spans();
        end_calc(&latest(), &calc_result(ToolResultStatus::Error, "tool exploded"));
        let span = capture.span("execute_tool calc");
        assert!(attr(&span, "gen_ai.tool.call.result").is_none());
        assert_eq!(attr_str(&span, "gen_ai.tool.status").as_deref(), Some("error"));
    }

    #[test]
    fn records_error_on_tool_failure() {
        let capture = capture_spans();
        tracer()
            .start_tool_call_span(&tool_use("calc", "call-1", json!({})))
            .end(EndToolCallSpanOptions {
                tool_result: None,
                error: Some("tool crashed"),
            });
        let span = capture.span("execute_tool calc");
        assert!(is_error(&span, "tool crashed"));
        assert_eq!(exceptions(&span), vec!["tool crashed".to_owned()]);
    }

    #[test]
    fn creates_span_with_cycle_id_attribute() {
        let capture = capture_spans();
        drop(tracer().start_agent_loop_span("cycle-42", &hi()));
        let span = capture.span("execute_agent_loop_cycle");
        assert_eq!(attr_str(&span, "agent_loop.cycle_id").as_deref(), Some("cycle-42"));
        assert!(attr(&span, "gen_ai.operation.name").is_none());
    }

    #[test]
    fn loop_span_includes_constructor_level_trace_attributes() {
        let capture = capture_spans();
        let tracer = tracer_with(&[], &[("session.id", "sess-1".into())]);
        drop(tracer.start_agent_loop_span("cycle-42", &[]));
        let span = capture.span("execute_agent_loop_cycle");
        assert_eq!(attr_str(&span, "session.id").as_deref(), Some("sess-1"));
        assert_eq!(attr_str(&span, "agent_loop.cycle_id").as_deref(), Some("cycle-42"));
    }

    #[test]
    fn adds_message_events_to_loop_span() {
        let capture = capture_spans();
        drop(tracer().start_agent_loop_span("cycle-1", &[text_message(Role::User, "Hello")]));
        assert_eq!(
            events(&capture.span("execute_agent_loop_cycle"), "gen_ai.user.message").len(),
            1
        );
    }

    #[test]
    fn end_agent_loop_span_ends_span_with_ok_status() {
        let capture = capture_spans();
        tracer().start_agent_loop_span("cycle-1", &hi()).end(None);
        assert_eq!(
            capture.span("execute_agent_loop_cycle").status,
            opentelemetry::trace::Status::Ok
        );
    }

    #[test]
    fn records_error_on_loop_failure() {
        let capture = capture_spans();
        tracer()
            .start_agent_loop_span("cycle-1", &hi())
            .end(Some("loop failed"));
        let span = capture.span("execute_agent_loop_cycle");
        assert!(is_error(&span, "loop failed"));
        assert_eq!(exceptions(&span), vec!["loop failed".to_owned()]);
    }

    #[test]
    fn parents_cycle_spans_to_the_agent_span_and_model_and_tool_spans_to_the_cycle() {
        let capture = capture_spans();
        let tracer = tracer();
        let agent = tracer.start_agent_span(agent_options(&hi(), "agent"));
        let cycle = tracer.start_agent_loop_span("cycle-1", &hi());
        tracer
            .start_model_invoke_span(StartModelInvokeSpanOptions::default())
            .end(EndModelSpanOptions::default());
        tracer
            .start_tool_call_span(&tool_use("calc", "t1", json!({})))
            .end(EndToolCallSpanOptions::default());
        cycle.end(None);
        agent.end(EndAgentSpanOptions::default());
        let agent = capture.span("invoke_agent agent");
        let cycle = capture.span("execute_agent_loop_cycle");
        assert_eq!(cycle.parent_span_id, agent.span_context.span_id());
        assert_eq!(capture.span("chat").parent_span_id, cycle.span_context.span_id());
        assert_eq!(
            capture.span("execute_tool calc").parent_span_id,
            cycle.span_context.span_id()
        );
    }

    #[test]
    fn executes_callback_within_span_context_when_span_is_provided() {
        let capture = capture_spans();
        let tracer = tracer();
        let span = tracer.start_tool_call_span(&tool_use("calc", "t1", json!({})));
        let inside = span.span().in_scope(|| tracing::info_span!("inside").in_scope(|| 42));
        assert_eq!(inside, 42);
        span.end(EndToolCallSpanOptions::default());
        assert_eq!(
            capture.span("inside").parent_span_id,
            capture.span("execute_tool calc").span_context.span_id()
        );
    }

    #[test]
    fn maps_tool_use_blocks_to_tool_call_parts_in_latest_conventions() {
        let capture = capture_spans();
        let messages = vec![Message::new(
            Role::Assistant,
            vec![ContentBlock::ToolUse(ToolUseBlock::new(
                "search",
                "tu-1",
                json!({"q": "test"}),
            ))],
        )];
        drop(latest().start_agent_span(agent_options(&messages, "agent")));
        let details = events(&capture.span("invoke_agent agent"), OPERATION_DETAILS);
        assert_eq!(
            event_json(&details[0], "gen_ai.input.messages")[0]["parts"][0],
            json!({"type": "tool_call", "name": "search", "id": "tu-1", "arguments": {"q": "test"}})
        );
    }

    #[test]
    fn records_an_offloaded_block_as_the_text_the_model_receives() {
        let capture = capture_spans();
        let messages = vec![Message::new(
            Role::User,
            vec![ContentBlock::Text(crate::types::TextBlock::offloaded(
                "[Dropped] [ref: tu-1]",
                crate::types::Offloaded::new(crate::types::OffloadMethod::Drop).with_reference("tu-1"),
            ))],
        )];
        drop(latest().start_agent_span(agent_options(&messages, "test-agent")));
        let details = events(&capture.span("invoke_agent test-agent"), OPERATION_DETAILS);
        assert_eq!(
            event_json(&details[0], "gen_ai.input.messages"),
            json!([{"role": "user", "parts": [{"type": "text", "content": "[Dropped] [ref: tu-1]"}]}])
        );
    }

    #[test]
    fn maps_tool_result_blocks_to_tool_call_response_parts_in_latest_conventions() {
        let capture = capture_spans();
        let messages = vec![Message::new(
            Role::User,
            vec![ContentBlock::ToolResult(ToolResultBlock::success(
                "tu-1",
                vec![ToolResultContent::text("result")],
            ))],
        )];
        drop(latest().start_agent_span(agent_options(&messages, "agent")));
        let details = events(&capture.span("invoke_agent agent"), OPERATION_DETAILS);
        let part = &event_json(&details[0], "gen_ai.input.messages")[0]["parts"][0];
        assert_eq!(part["type"], "tool_call_response");
        assert_eq!(part["id"], "tu-1");
        assert_eq!(part["response"], json!([{"text": "result"}]));
    }

    fn latest_chat_input(messages: &[Message]) -> serde_json::Value {
        let capture = capture_spans();
        drop(latest().start_model_invoke_span(StartModelInvokeSpanOptions {
            messages,
            ..StartModelInvokeSpanOptions::default()
        }));
        let details = events(&capture.span("chat"), OPERATION_DETAILS);
        event_json(&details[0], "gen_ai.input.messages")
    }

    #[test]
    fn maps_injected_blocks_to_text_parts_in_latest_conventions() {
        let parsed = latest_chat_input(&[Message::new(
            Role::User,
            vec![
                ContentBlock::text("Hi"),
                ContentBlock::Injected(InjectedBlock::new("cwd: /repo", "env")),
            ],
        )]);
        assert_eq!(
            parsed[0]["parts"],
            json!([{"type": "text", "content": "Hi"}, {"type": "text", "content": "cwd: /repo"}])
        );
    }

    #[test]
    fn maps_summary_blocks_to_text_parts_in_latest_conventions() {
        let mut summary = SummaryBlock::new("compacted");
        summary.provider = Some("anthropic".into());
        let parsed = latest_chat_input(&[Message::new(Role::Assistant, vec![ContentBlock::Summary(summary)])]);
        assert_eq!(parsed[0]["parts"], json!([{"type": "text", "content": "compacted"}]));
    }

    #[test]
    fn maps_other_blocks_to_their_type_in_latest_conventions() {
        let parsed = latest_chat_input(&[Message::new(
            Role::User,
            vec![ContentBlock::CachePoint(CachePointBlock::new())],
        )]);
        assert_eq!(parsed[0]["parts"], json!([{"type": "cachePointBlock"}]));
    }

    #[test]
    fn serializes_text_block_content_in_stable_convention_events() {
        let capture = capture_spans();
        drop(tracer().start_model_invoke_span(StartModelInvokeSpanOptions {
            messages: &[text_message(Role::User, "Hello world")],
            ..StartModelInvokeSpanOptions::default()
        }));
        let user = events(&capture.span("chat"), "gen_ai.user.message");
        assert_eq!(event_json(&user[0], "content")[0]["text"], "Hello world");
    }

    fn chat_with_prompt(tracer: &Arc<Tracer>, prompt: Option<&SystemPrompt>) -> SpanData {
        let capture = capture_spans();
        drop(tracer.start_model_invoke_span(StartModelInvokeSpanOptions {
            messages: &[text_message(Role::User, "Hello")],
            model_id: Some("test-model"),
            system_prompt: prompt,
        }));
        capture.span("chat")
    }

    fn system_instructions(span: &SpanData) -> serde_json::Value {
        let details = events(span, OPERATION_DETAILS);
        let event = details
            .iter()
            .find(|event| {
                event
                    .attributes
                    .iter()
                    .any(|kv| kv.key.as_str() == "gen_ai.system_instructions")
            })
            .unwrap();
        event_json(event, "gen_ai.system_instructions")
    }

    fn blocks_prompt() -> SystemPrompt {
        SystemPrompt::Blocks(vec![
            SystemContentBlock::Text(TextBlock::new("You are helpful")),
            SystemContentBlock::CachePoint(CachePointBlock::new()),
        ])
    }

    #[test]
    fn emits_gen_ai_system_message_event_with_stable_conventions() {
        let span = chat_with_prompt(&tracer(), Some(&"You are a helpful assistant".into()));
        let system = events(&span, "gen_ai.system.message");
        assert_eq!(system.len(), 1);
        assert_eq!(
            event_json(&system[0], "content"),
            json!([{"text": "You are a helpful assistant"}])
        );
    }

    #[test]
    fn emits_gen_ai_system_instructions_with_latest_conventions() {
        let span = chat_with_prompt(&latest(), Some(&"You are a calculator assistant".into()));
        assert_eq!(
            system_instructions(&span),
            json!([{"type": "text", "content": "You are a calculator assistant"}])
        );
    }

    #[test]
    fn does_not_emit_system_prompt_event_when_system_prompt_is_undefined() {
        let span = chat_with_prompt(&tracer(), None);
        assert!(events(&span, "gen_ai.system.message").is_empty());
    }

    #[test]
    fn handles_system_content_block_array_with_cache_points_in_latest_conventions() {
        let span = chat_with_prompt(&latest(), Some(&blocks_prompt()));
        assert_eq!(
            system_instructions(&span),
            json!([{"type": "text", "content": "You are helpful"}, {"type": "cache_point", "cacheType": "default"}])
        );
    }

    #[test]
    fn serializes_system_content_block_array_in_stable_conventions() {
        let span = chat_with_prompt(&tracer(), Some(&blocks_prompt()));
        let system = events(&span, "gen_ai.system.message");
        assert_eq!(
            event_json(&system[0], "content"),
            json!([{"text": "You are helpful"}, {"cachePoint": {"cacheType": "default"}}])
        );
    }

    #[test]
    fn does_not_set_ttfb_as_span_attribute() {
        let capture = capture_spans();
        let mut metrics = Metrics::new(500);
        metrics.time_to_first_byte_ms = Some(150);
        end_chat(
            &tracer(),
            EndModelSpanOptions {
                usage: Some(&Usage::new(10, 20, 30)),
                metrics: Some(&metrics),
                ..EndModelSpanOptions::default()
            },
        );
        let span = capture.span("chat");
        assert!(attr(&span, "gen_ai.server.time_to_first_token").is_none());
        assert_eq!(attr_i64(&span, "gen_ai.server.request.duration"), Some(500));
    }

    fn langfuse_attr(env: &[(&str, &str)]) -> Option<String> {
        let capture = capture_spans();
        tracer_with(env, &[])
            .start_agent_span(agent_options(&hi(), "agent"))
            .end(EndAgentSpanOptions {
                accumulated_usage: Some(Usage::new(10, 20, 30)),
                ..EndAgentSpanOptions::default()
            });
        attr_str(&capture.span("invoke_agent agent"), "langfuse.observation.type")
    }

    #[test]
    fn sets_langfuse_observation_type_on_agent_span_when_otel_exporter_otlp_endpoint_contains_langfuse() {
        assert_eq!(
            langfuse_attr(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "https://us.cloud.langfuse.com")]).as_deref(),
            Some("span")
        );
    }

    #[test]
    fn sets_langfuse_observation_type_when_otel_exporter_otlp_traces_endpoint_contains_langfuse() {
        assert_eq!(
            langfuse_attr(&[(
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                "https://us.cloud.langfuse.com/api/public/otel/v1/traces"
            )])
            .as_deref(),
            Some("span")
        );
    }

    #[test]
    fn sets_langfuse_observation_type_when_langfuse_base_url_is_set() {
        assert_eq!(
            langfuse_attr(&[("LANGFUSE_BASE_URL", "https://self-hosted.example.com")]).as_deref(),
            Some("span")
        );
    }

    #[test]
    fn does_not_set_langfuse_observation_type_when_no_langfuse_env_vars_are_set() {
        assert_eq!(
            langfuse_attr(&[
                ("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
                ("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", ""),
                ("LANGFUSE_BASE_URL", ""),
            ]),
            None
        );
    }

    fn chat_hi(env: &[(&str, &str)]) -> SpanData {
        let capture = capture_spans();
        drop(
            tracer_with(env, &[]).start_model_invoke_span(StartModelInvokeSpanOptions {
                messages: &hi(),
                ..StartModelInvokeSpanOptions::default()
            }),
        );
        capture.span("chat")
    }

    const HI_PARTS: &str = r#"[{"role":"user","parts":[{"type":"text","content":"Hi"}]}]"#;

    #[test]
    fn records_latest_convention_content_as_span_attributes_and_skips_the_event_when_opted_in() {
        let span = chat_hi(&[(
            "OTEL_SEMCONV_STABILITY_OPT_IN",
            "gen_ai_latest_experimental,gen_ai_span_attributes_only",
        )]);
        assert_eq!(attr_str(&span, "gen_ai.input.messages").as_deref(), Some(HI_PARTS));
        assert!(events(&span, OPERATION_DETAILS).is_empty());
    }

    #[test]
    fn records_latest_convention_content_as_span_attributes_for_langfuse_without_opt_in() {
        let span = chat_hi(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "https://us.cloud.langfuse.com"),
            ("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental"),
        ]);
        assert_eq!(attr_str(&span, "gen_ai.input.messages").as_deref(), Some(HI_PARTS));
        assert!(events(&span, OPERATION_DETAILS).is_empty());
    }

    #[test]
    fn emits_span_events_by_default_without_the_opt_in_or_langfuse() {
        let span = chat_hi(&[("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")]);
        assert_eq!(events(&span, OPERATION_DETAILS).len(), 1);
        assert!(attr(&span, "gen_ai.input.messages").is_none());
    }

    #[test]
    fn leaves_legacy_per_message_events_as_events_even_when_opted_in() {
        let span = chat_hi(&[("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_span_attributes_only")]);
        assert_eq!(events(&span, "gen_ai.user.message").len(), 1);
    }

    #[test]
    fn parses_multiple_comma_separated_opt_in_values() {
        let capture = capture_spans();
        let config = tools_config();
        let tracer = tracer_with(
            &[(
                "OTEL_SEMCONV_STABILITY_OPT_IN",
                "gen_ai_latest_experimental,gen_ai_tool_definitions",
            )],
            &[],
        );
        drop(tracer.start_agent_span(StartAgentSpanOptions {
            tools_config: Some(&config),
            ..agent_options(&hi(), "agent")
        }));
        let span = capture.span("invoke_agent agent");
        assert!(attr(&span, "gen_ai.provider.name").is_some());
        assert!(attr_str(&span, "gen_ai.tool.definitions").is_some());
    }

    #[test]
    fn records_array_trace_attributes() {
        let capture = capture_spans();
        let tracer = tracer_with(&[], &[("tags", vec!["a", "b"].into())]);
        drop(tracer.start_agent_loop_span("cycle-1", &[]));
        assert_eq!(
            attr(&capture.span("execute_agent_loop_cycle"), "tags"),
            Some(opentelemetry::Value::Array(opentelemetry::Array::String(vec![
                "a".into(),
                "b".into()
            ])))
        );
    }

    #[test]
    fn handles_null_span_gracefully() {
        let _capture = crate::telemetry::test_support::capture_spans_except(|_| false);
        let tracer = tracer();
        tracer
            .start_agent_span(agent_options(&hi(), "agent"))
            .end(EndAgentSpanOptions {
                error: Some("test".into()),
                ..EndAgentSpanOptions::default()
            });
        tracer.start_agent_loop_span("c", &hi()).end(Some("test"));
        assert_eq!(tracer.local_traces().len(), 1);
    }
}

#[test]
fn handles_whitespace_in_opt_in_values() {
    let settings = settings(&[(
        "OTEL_SEMCONV_STABILITY_OPT_IN",
        " gen_ai_latest_experimental , gen_ai_tool_definitions ",
    )]);
    assert!(settings.use_latest_conventions);
    assert!(settings.include_tool_definitions);
}

#[test]
fn defaults_to_stable_conventions_when_env_var_is_empty() {
    let settings = settings(&[("OTEL_SEMCONV_STABILITY_OPT_IN", "")]);
    assert!(!settings.use_latest_conventions);
    assert!(!settings.include_tool_definitions);
    assert!(!settings.span_attributes_only);
    assert_eq!(settings.service_name, "strands-agents");
}

#[test]
fn records_spans_without_a_subscriber() {
    let tracer = tracer();
    let span = tracer.start_agent_span(agent_options(&[], "agent"));
    tracer
        .start_tool_call_span(&tool_use("x", "y", json!({})))
        .end(EndToolCallSpanOptions::default());
    span.end(EndAgentSpanOptions::default());
    assert!(tracer.local_traces().is_empty());
}

#[test]
fn creates_local_trace_with_cycle_id_in_metadata() {
    let tracer = tracer();
    drop(tracer.start_agent_loop_span("cycle-123", &[]));
    let traces = tracer.local_traces();
    assert_eq!(traces.len(), 1);
    assert_eq!(traces[0].name, "Cycle 1");
    assert_eq!(traces[0].metadata["cycleId"], "cycle-123");
}

#[test]
fn stores_unique_cycle_ids_for_multiple_cycles() {
    let tracer = tracer();
    tracer.start_agent_loop_span("cycle-abc", &[]).end(None);
    drop(tracer.start_agent_loop_span("cycle-xyz", &[]));
    let traces = tracer.local_traces();
    assert_eq!(
        traces.iter().map(|trace| trace.name.as_str()).collect::<Vec<_>>(),
        ["Cycle 1", "Cycle 2"]
    );
    assert_eq!(traces[0].metadata["cycleId"], "cycle-abc");
    assert_eq!(traces[1].metadata["cycleId"], "cycle-xyz");
}

#[test]
fn nests_model_and_tool_traces_under_the_current_cycle() {
    let tracer = tracer();
    let agent = tracer.start_agent_span(agent_options(&[], "agent"));
    let cycle = tracer.start_agent_loop_span("cycle-1", &[]);
    let output = text_message(Role::Assistant, "out");
    tracer
        .start_model_invoke_span(StartModelInvokeSpanOptions::default())
        .end(EndModelSpanOptions {
            output: Some(&output),
            ..EndModelSpanOptions::default()
        });
    let first = tracer.start_tool_call_span(&tool_use("calc", "t1", json!({})));
    let second = tracer.start_tool_call_span(&tool_use("calc", "t2", json!({})));
    first.end(EndToolCallSpanOptions::default());
    second.end(EndToolCallSpanOptions::default());
    cycle.end(None);
    agent.end(EndAgentSpanOptions::default());

    let traces = tracer.local_traces();
    let cycle = &traces[0];
    assert!(cycle.end_time.is_some());
    let names: Vec<&str> = cycle.children.iter().map(|child| child.name.as_str()).collect();
    assert_eq!(names, ["stream_messages", "Tool: calc", "Tool: calc"]);
    assert_eq!(cycle.children[0].message.as_ref(), Some(&output));
    assert_eq!(cycle.children[1].metadata["toolUseId"], "t1");
    assert_eq!(cycle.children[2].metadata["toolName"], "calc");
    assert!(cycle.children.iter().all(|child| child.end_time.is_some()));
    assert!(
        cycle
            .children
            .iter()
            .all(|child| child.parent_id.as_deref() == Some(cycle.id.as_str()))
    );
}

#[test]
fn starts_new_local_traces_with_each_agent_span() {
    let tracer = tracer();
    drop(tracer.start_agent_span(agent_options(&[], "agent")));
    tracer.start_agent_loop_span("cycle-1", &[]).end(None);
    let late_tool = tracer.start_tool_call_span(&tool_use("calc", "t1", json!({})));
    drop(tracer.start_agent_span(agent_options(&[], "agent")));
    late_tool.end(EndToolCallSpanOptions::default());
    assert!(tracer.local_traces().is_empty());
}

mod local_trace {
    use super::*;

    #[test]
    fn generates_a_unique_id_in_uuid_format() {
        let first = AgentTrace::start("test");
        let second = AgentTrace::start("test");
        let pattern = regex::Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap();
        assert!(pattern.is_match(&first.id));
        assert!(pattern.is_match(&second.id));
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn sets_name_and_defaults() {
        let trace = AgentTrace::start("Cycle 1");
        assert_eq!(trace.name, "Cycle 1");
        assert!(trace.parent_id.is_none());
        assert!(trace.end_time.is_none());
        assert_eq!(trace.duration, 0);
        assert!(trace.children.is_empty());
        assert!(trace.metadata.is_empty());
        assert!(trace.message.is_none());
    }

    #[test]
    fn uses_current_time_as_default_start_time() {
        let before = now_ms();
        let trace = AgentTrace::start("test");
        let after = now_ms();
        assert!((before..=after).contains(&trace.start_time));
    }

    #[test]
    fn accepts_a_custom_start_time() {
        assert_eq!(AgentTrace::new("test", 1000).start_time, 1000);
    }

    #[test]
    fn adds_child_to_parent_when_parent_is_provided() {
        let mut parent = AgentTrace::start("parent");
        let child_id = parent.add_child(AgentTrace::start("child")).id.clone();
        assert_eq!(parent.children.len(), 1);
        assert_eq!(parent.children[0].id, child_id);
        assert_eq!(parent.children[0].parent_id.as_deref(), Some(parent.id.as_str()));
    }

    #[test]
    fn supports_multiple_children() {
        let mut parent = AgentTrace::start("parent");
        parent.add_child(AgentTrace::start("child1"));
        parent.add_child(AgentTrace::start("child2"));
        let names: Vec<&str> = parent.children.iter().map(|child| child.name.as_str()).collect();
        assert_eq!(names, ["child1", "child2"]);
    }

    #[test]
    fn sets_parent_id_to_null_when_no_parent_is_provided() {
        assert!(AgentTrace::start("root").parent_id.is_none());
    }

    #[test]
    fn builds_a_three_level_hierarchy() {
        let mut root = AgentTrace::new("Cycle 1", 1000);
        root.add_child(AgentTrace::new("stream_messages", 1001));
        root.add_child(AgentTrace::new("Tool: calc", 1050));
        assert_eq!(root.children.len(), 2);
        assert_eq!(root.children[0].name, "stream_messages");
        assert_eq!(root.children[1].name, "Tool: calc");
        assert!(
            root.children
                .iter()
                .all(|child| child.parent_id.as_deref() == Some(root.id.as_str()))
        );
    }

    #[test]
    fn computes_duration_from_start_time_to_end_time() {
        let mut trace = AgentTrace::new("test", 1000);
        trace.end(1500);
        assert_eq!(trace.end_time, Some(1500));
        assert_eq!(trace.duration, 500);
    }

    #[test]
    fn uses_current_time_when_no_end_time_is_provided() {
        let before = now_ms();
        let mut trace = AgentTrace::start("test");
        trace.end_now();
        assert!(trace.end_time.is_some_and(|end| end >= before));
    }

    #[test]
    fn stores_cycle_metadata() {
        let mut trace = AgentTrace::start("Cycle 1");
        trace.metadata.insert("cycleId".into(), json!("cycle-1"));
        assert_eq!(serde_json::Value::Object(trace.metadata), json!({"cycleId": "cycle-1"}));
    }

    #[test]
    fn stores_tool_metadata() {
        let mut trace = AgentTrace::start("Tool: calc");
        trace.metadata.insert("toolUseId".into(), json!("tool-1"));
        trace.metadata.insert("toolName".into(), json!("calc"));
        assert_eq!(
            serde_json::Value::Object(trace.metadata),
            json!({"toolUseId": "tool-1", "toolName": "calc"})
        );
    }

    #[test]
    fn stores_a_message_with_role_and_content() {
        let mut trace = AgentTrace::start("stream_messages");
        trace.message = Some(text_message(Role::Assistant, "hello"));
        let message = trace.message.unwrap();
        assert_eq!(message.role, Role::Assistant);
        assert_eq!(message.content, vec![ContentBlock::text("hello")]);
    }

    #[test]
    fn returns_complete_data_for_a_default_trace() {
        let trace = AgentTrace::new("Cycle 1", 1000);
        assert_eq!(
            serde_json::to_value(&trace).unwrap(),
            json!({
                "id": trace.id,
                "name": "Cycle 1",
                "parentId": null,
                "startTime": 1000,
                "endTime": null,
                "duration": 0,
                "children": [],
                "metadata": {},
                "message": null,
            })
        );
    }

    #[test]
    fn serializes_a_hierarchy_with_children_and_metadata() {
        let mut root = AgentTrace::new("Cycle 1", 1000);
        root.metadata.insert("cycleId".into(), json!("cycle-1"));
        let child = root.add_child(AgentTrace::new("stream_messages", 1001));
        child.end(1100);
        let child_id = child.id.clone();
        root.end(1200);
        let json = serde_json::to_value(&root).unwrap();
        assert_eq!(json["name"], "Cycle 1");
        assert_eq!(json["metadata"]["cycleId"], "cycle-1");
        assert_eq!(json["duration"], 200);
        assert_eq!(
            json["children"],
            json!([{
                "id": child_id,
                "name": "stream_messages",
                "parentId": root.id,
                "startTime": 1001,
                "endTime": 1100,
                "duration": 99,
                "children": [],
                "metadata": {},
                "message": null,
            }])
        );
    }

    #[test]
    fn serializes_tool_metadata_correctly() {
        let mut trace = AgentTrace::new("Tool: calc", 1000);
        trace.metadata.insert("toolUseId".into(), json!("tool-123"));
        trace.metadata.insert("toolName".into(), json!("calc"));
        trace.end(1500);
        let json = serde_json::to_value(&trace).unwrap();
        assert_eq!(json["name"], "Tool: calc");
        assert_eq!(json["metadata"], json!({"toolUseId": "tool-123", "toolName": "calc"}));
        assert_eq!(json["duration"], 500);
    }

    #[test]
    fn serializes_absent_fields_as_null() {
        let mut trace = AgentTrace::new("Cycle 1", 10);
        trace.id = "t-1".into();
        trace.end(25);
        assert_eq!(
            serde_json::to_string(&trace).unwrap(),
            r#"{"id":"t-1","name":"Cycle 1","parentId":null,"startTime":10,"endTime":25,"duration":15,"children":[],"metadata":{},"message":null}"#
        );
    }
}
