//! Memory spans, the current span context, and memory spans in span-attributes-only mode, checked
//! as exported `SpanData`.

use std::collections::BTreeMap;

use super::*;
use crate::telemetry::utils::TracerSettings;

fn tracer() -> Tracer {
    Tracer::with_settings(TracerSettings::from_lookup(&|_| None), BTreeMap::new(), BTreeMap::new())
}

#[test]
fn memory_span_methods_handle_a_null_span_gracefully() {
    let tracer = tracer();
    tracer.end_memory_search_span(MemorySpan::none(), EndMemorySearchSpanOptions::default());
    tracer.end_memory_add_span(MemorySpan::none(), EndMemoryAddSpanOptions::default());
    tracer.end_memory_inject_span(MemorySpan::none(), EndMemoryInjectSpanOptions::default());
    tracer.end_memory_extract_span(MemorySpan::none(), EndMemoryExtractSpanOptions::default());
}

#[test]
fn returns_undefined_when_no_span_is_active() {
    assert!(tracer().current_span_context().is_none());
}

#[cfg(feature = "otel")]
mod otel {
    use opentelemetry::Value;
    use opentelemetry::trace::{SpanContext, SpanId, Status, TraceFlags, TraceId, TraceState};
    use serde_json::json;

    use super::*;
    use crate::memory::MemoryEntry;
    use crate::telemetry::test_support::{
        attr, attr_i64, attr_str, capture_spans, capture_spans_except, event_attr, events, exceptions, is_error,
    };

    fn attributes_only_tracer() -> Tracer {
        let settings = TracerSettings::from_lookup(&|key| {
            (key == "OTEL_SEMCONV_STABILITY_OPT_IN").then(|| "gen_ai_span_attributes_only".to_owned())
        });
        Tracer::with_settings(settings, BTreeMap::new(), BTreeMap::new())
    }

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    fn search_span(tracer: &Tracer, stores: &[String]) -> MemorySpan {
        tracer.start_memory_search_span(StartMemorySearchSpanOptions {
            query: "q",
            store_names: stores,
            max_search_results: None,
        })
    }

    fn extract_options<'a>(context: Option<&'a AgentSpanContext>) -> StartMemoryExtractSpanOptions<'a> {
        StartMemoryExtractSpanOptions {
            store_name: "personal",
            message_count: 1,
            agent_span_context: context,
            ..StartMemoryExtractSpanOptions::default()
        }
    }

    fn span_context(trace_id: &str, span_id: &str, flags: TraceFlags) -> AgentSpanContext {
        AgentSpanContext::new(SpanContext::new(
            TraceId::from_hex(trace_id).unwrap(),
            SpanId::from_hex(span_id).unwrap(),
            flags,
            false,
            TraceState::default(),
        ))
    }

    #[test]
    fn start_memory_search_span_sets_attributes_and_records_the_query_as_an_event() {
        let capture = capture_spans();
        let tracer = tracer();
        let stores = names(&["personal", "team"]);
        let span = tracer.start_memory_search_span(StartMemorySearchSpanOptions {
            query: "dark mode preference",
            store_names: &stores,
            max_search_results: Some(5),
        });
        tracer.end_memory_search_span(span, EndMemorySearchSpanOptions::default());

        let span = capture.span("memory.search");
        assert_eq!(
            attr_str(&span, "gen_ai.operation.name").as_deref(),
            Some("memory.search")
        );
        assert_eq!(
            attr_str(&span, "memory.store.names").as_deref(),
            Some(r#"["personal","team"]"#)
        );
        assert_eq!(attr_i64(&span, "memory.store.count"), Some(2));
        assert_eq!(attr_i64(&span, "memory.max_search_results"), Some(5));
        assert_eq!(
            event_attr(&events(&span, "memory.query")[0], "content"),
            "dark mode preference"
        );
    }

    #[test]
    fn end_memory_search_span_records_result_failure_counts_and_the_entries_event() {
        let capture = capture_spans();
        let tracer = tracer();
        let span = search_span(&tracer, &names(&["personal"]));
        let entries = [MemoryEntry::new("likes dark mode")
            .with_store_name("personal")
            .with_metadata(json!({"score": 0.9}).as_object().unwrap().clone())];

        tracer.end_memory_search_span(
            span,
            EndMemorySearchSpanOptions {
                entries: &entries,
                store_failure_count: 1,
                error: None,
            },
        );

        let span = capture.span("memory.search");
        assert_eq!(attr_i64(&span, "memory.result.count"), Some(1));
        assert_eq!(attr_i64(&span, "memory.store.failure_count"), Some(1));
        assert!(attr_str(&span, "gen_ai.event.end_time").is_some());
        let results = events(&span, "memory.results");
        assert_eq!(results.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&event_attr(&results[0], "content")).unwrap(),
            json!([{"content": "likes dark mode", "storeName": "personal", "metadata": {"score": 0.9}}])
        );
        assert_eq!(span.status, Status::Ok);
    }

    #[test]
    fn end_memory_search_span_records_error_and_skips_the_results_event() {
        let capture = capture_spans();
        let tracer = tracer();
        let span = search_span(&tracer, &names(&["personal"]));

        tracer.end_memory_search_span(
            span,
            EndMemorySearchSpanOptions {
                error: Some("store missing"),
                ..EndMemorySearchSpanOptions::default()
            },
        );

        let span = capture.span("memory.search");
        assert!(events(&span, "memory.results").is_empty());
        assert!(is_error(&span, "store missing"));
        assert_eq!(exceptions(&span), ["store missing"]);
    }

    #[test]
    fn start_memory_add_span_records_content_as_an_event() {
        let capture = capture_spans();
        let tracer = tracer();
        let stores = names(&["personal"]);
        let span = tracer.start_memory_add_span(StartMemoryAddSpanOptions {
            content: "remember dark mode",
            store_names: &stores,
            force_root: false,
        });
        tracer.end_memory_add_span(span, EndMemoryAddSpanOptions::default());

        let span = capture.span("memory.add");
        assert_eq!(attr_str(&span, "gen_ai.operation.name").as_deref(), Some("memory.add"));
        assert_eq!(
            attr_str(&span, "memory.store.names").as_deref(),
            Some(r#"["personal"]"#)
        );
        assert_eq!(attr_i64(&span, "memory.store.count"), Some(1));
        assert_eq!(
            event_attr(&events(&span, "memory.content")[0], "content"),
            "remember dark mode"
        );
    }

    #[test]
    fn end_memory_add_span_records_the_store_failure_count_and_error() {
        let capture = capture_spans();
        let tracer = tracer();
        let stores = names(&["personal"]);
        let span = tracer.start_memory_add_span(StartMemoryAddSpanOptions {
            content: "x",
            store_names: &stores,
            force_root: false,
        });

        tracer.end_memory_add_span(
            span,
            EndMemoryAddSpanOptions {
                store_failure_count: 2,
                error: Some("write failed"),
            },
        );

        let span = capture.span("memory.add");
        assert_eq!(attr_i64(&span, "memory.store.failure_count"), Some(2));
        assert!(is_error(&span, "write failed"));
        assert_eq!(exceptions(&span), ["write failed"]);
    }

    #[test]
    fn memory_inject_span_start_sets_max_entries_end_records_injected_and_entry_count() {
        let capture = capture_spans();
        let tracer = tracer();
        let span = tracer.start_memory_inject_span(StartMemoryInjectSpanOptions { max_entries: Some(5) });

        tracer.end_memory_inject_span(
            span,
            EndMemoryInjectSpanOptions {
                injected: true,
                entry_count: 3,
                format_error: false,
            },
        );

        let span = capture.span("memory.inject");
        assert_eq!(attr_i64(&span, "memory.max_entries"), Some(5));
        assert_eq!(attr(&span, "memory.injected"), Some(Value::Bool(true)));
        assert_eq!(attr_i64(&span, "memory.entry.count"), Some(3));
        assert!(attr_str(&span, "gen_ai.event.end_time").is_some());
        assert_eq!(attr(&span, "memory.inject.format_error"), None);
        assert_eq!(span.status, Status::Ok);
    }

    #[test]
    fn end_memory_inject_span_fails_open_on_a_format_error_ok_status_flag_set() {
        let capture = capture_spans();
        let tracer = tracer();
        let span = tracer.start_memory_inject_span(StartMemoryInjectSpanOptions::default());

        tracer.end_memory_inject_span(
            span,
            EndMemoryInjectSpanOptions {
                injected: false,
                entry_count: 0,
                format_error: true,
            },
        );

        let span = capture.span("memory.inject");
        assert_eq!(attr(&span, "memory.injected"), Some(Value::Bool(false)));
        assert_eq!(attr_i64(&span, "memory.entry.count"), Some(0));
        assert_eq!(attr(&span, "memory.inject.format_error"), Some(Value::Bool(true)));
        assert_eq!(span.status, Status::Ok);
        assert!(exceptions(&span).is_empty());
    }

    #[test]
    fn start_memory_extract_span_is_a_root_span_force_root_no_parent_context() {
        let capture = capture_spans();
        let tracer = tracer();
        let outer = tracing::info_span!("outer");
        let span = outer.in_scope(|| {
            tracer.start_memory_extract_span(StartMemoryExtractSpanOptions {
                store_name: "personal",
                message_count: 2,
                filtered_count: 1,
                extractor: Some("ModelExtractor"),
                agent_span_context: None,
            })
        });
        tracer.end_memory_extract_span(span, EndMemoryExtractSpanOptions::default());
        drop(outer);

        let span = capture.span("memory.extract");
        assert_eq!(
            attr_str(&span, "gen_ai.operation.name").as_deref(),
            Some("memory.extract")
        );
        assert_eq!(attr_str(&span, "memory.store.name").as_deref(), Some("personal"));
        assert_eq!(attr_i64(&span, "memory.message.count"), Some(2));
        assert_eq!(attr_i64(&span, "memory.message.filtered_count"), Some(1));
        assert_eq!(attr_str(&span, "memory.extractor").as_deref(), Some("ModelExtractor"));
        assert_eq!(span.parent_span_id, SpanId::INVALID);
        assert_ne!(
            span.span_context.trace_id(),
            capture.span("outer").span_context.trace_id()
        );
    }

    #[test]
    fn start_memory_extract_span_attaches_a_valid_agent_span_context_as_a_link() {
        let capture = capture_spans();
        let tracer = tracer();
        let context = span_context(
            "abcdef01234567890abcdef012345678",
            "abcdef0123456789",
            TraceFlags::SAMPLED,
        );

        let span = tracer.start_memory_extract_span(extract_options(Some(&context)));
        tracer.end_memory_extract_span(span, EndMemoryExtractSpanOptions::default());

        let span = capture.span("memory.extract");
        assert_eq!(span.links.links.len(), 1);
        assert_eq!(&span.links.links[0].span_context, context.valid().unwrap());
        assert_eq!(
            attr_str(&span, "memory.parent.trace_id").as_deref(),
            Some("abcdef01234567890abcdef012345678")
        );
        assert_eq!(
            attr_str(&span, "memory.parent.span_id").as_deref(),
            Some("abcdef0123456789")
        );
    }

    #[test]
    fn start_memory_extract_span_skips_the_link_and_parent_ids_for_an_invalid_agent_span_context() {
        let capture = capture_spans();
        let tracer = tracer();
        let invalid = span_context(
            "00000000000000000000000000000000",
            "0000000000000000",
            TraceFlags::default(),
        );

        let span = tracer.start_memory_extract_span(extract_options(Some(&invalid)));
        tracer.end_memory_extract_span(span, EndMemoryExtractSpanOptions::default());

        let span = capture.span("memory.extract");
        assert!(span.links.links.is_empty());
        assert_eq!(attr(&span, "memory.parent.trace_id"), None);
        assert_eq!(attr(&span, "memory.parent.span_id"), None);
    }

    #[test]
    fn end_memory_extract_span_records_the_entry_count_on_success() {
        let capture = capture_spans();
        let tracer = tracer();
        let span = tracer.start_memory_extract_span(extract_options(None));

        tracer.end_memory_extract_span(
            span,
            EndMemoryExtractSpanOptions {
                entry_count: Some(3),
                error: None,
            },
        );

        let span = capture.span("memory.extract");
        assert_eq!(attr_i64(&span, "memory.entry.count"), Some(3));
        assert!(attr_str(&span, "gen_ai.event.end_time").is_some());
        assert_eq!(span.status, Status::Ok);
    }

    #[test]
    fn end_memory_extract_span_records_error_failures_are_swallowed_by_the_coordinator() {
        let capture = capture_spans();
        let tracer = tracer();
        let span = tracer.start_memory_extract_span(extract_options(None));

        tracer.end_memory_extract_span(
            span,
            EndMemoryExtractSpanOptions {
                entry_count: None,
                error: Some("save failed"),
            },
        );

        let span = capture.span("memory.extract");
        assert!(is_error(&span, "save failed"));
        assert_eq!(exceptions(&span), ["save failed"]);
    }

    #[test]
    fn records_the_memory_search_query_as_a_span_attribute_and_skips_the_event_when_opted_in() {
        let capture = capture_spans();
        let tracer = attributes_only_tracer();
        let span = search_span(&tracer, &names(&["personal"]));
        drop(span);
        let span = capture.span("memory.search");
        assert_eq!(attr_str(&span, "content").as_deref(), Some("q"));
        assert!(events(&span, "memory.query").is_empty());
    }

    #[test]
    fn records_the_memory_add_content_as_a_span_attribute_and_skips_the_event_when_opted_in() {
        let capture = capture_spans();
        let tracer = attributes_only_tracer();
        let stores = names(&["personal"]);
        drop(tracer.start_memory_add_span(StartMemoryAddSpanOptions {
            content: "remember dark mode",
            store_names: &stores,
            force_root: false,
        }));
        let span = capture.span("memory.add");
        assert_eq!(attr_str(&span, "content").as_deref(), Some("remember dark mode"));
        assert!(events(&span, "memory.content").is_empty());
    }

    #[test]
    fn returns_undefined_for_a_non_recording_active_span() {
        let _capture = capture_spans_except(|metadata| metadata.name() != "sampled_out");
        let span = tracing::info_span!("sampled_out");
        assert!(span.in_scope(|| tracer().current_span_context()).is_none());
    }

    #[test]
    fn returns_the_context_for_a_recording_span_with_a_valid_context() {
        let capture = capture_spans();
        let span = tracing::info_span!("agent");
        let context = span.in_scope(|| tracer().current_span_context()).unwrap();
        drop(span);
        assert_eq!(context.valid(), Some(&capture.span("agent").span_context));
    }

    #[test]
    fn returns_undefined_for_a_recording_span_with_an_invalid_all_zeros_context() {
        let context = tracing::subscriber::with_default(tracing_subscriber::registry(), || {
            let span = tracing::info_span!("plain");
            assert!(!span.is_disabled());
            span.in_scope(|| tracer().current_span_context())
        });
        assert!(context.is_none());
    }
}
