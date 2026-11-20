//! What the crate root exports. A missing export is a compile error.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests report failures by panicking"
)]

use std::time::Duration;

use serde_json::json;
use strands::{
    BackgroundTasksConfig, ClassifierStrategy, ConcurrentToolExecutor, ContextWindowOverflowError, FallbackStrategy,
    InterruptError, ModelContentBlockDeltaEvent, ModelContentBlockStartEvent, ModelContentBlockStopEvent,
    ModelMessageStartEvent, ModelMessageStopEvent, ModelMetadataEvent, ModelRedactionEvent, ModelRouter,
    ModelStreamEvent, Role, RoutingCandidate, SequentialToolExecutor, ToolExecutorStrategy, ToolStreamEvent,
};

fn named<T>() -> &'static str {
    std::any::type_name::<T>()
}

#[test]
fn exports_error_classes() {
    assert!(named::<ContextWindowOverflowError>().ends_with("ContextWindowOverflowError"));
    assert!(named::<InterruptError>().ends_with("InterruptError"));
}

#[cfg(feature = "bedrock")]
#[test]
fn exports_bedrock_model() {
    assert!(named::<strands::BedrockModel>().ends_with("BedrockModel"));
}

#[cfg(feature = "bedrock")]
#[test]
fn can_instantiate_bedrock_model() {
    use strands::Model;

    let provider = strands::BedrockModel::builder().region("us-west-2").build();
    assert!(provider.get_config().model_id.is_some());
}

#[test]
fn exports_zero_argument_tool_executors() {
    let concurrent = ToolExecutorStrategy::from(ConcurrentToolExecutor::new());
    let sequential = ToolExecutorStrategy::from(SequentialToolExecutor::new());
    assert!(matches!(concurrent, ToolExecutorStrategy::Concurrent));
    assert!(matches!(sequential, ToolExecutorStrategy::Sequential));
}

#[test]
fn exports_model_routing_values() {
    assert!(named::<ClassifierStrategy>().ends_with("ClassifierStrategy"));
    assert!(named::<FallbackStrategy>().ends_with("FallbackStrategy"));
    assert!(named::<ModelRouter>().ends_with("ModelRouter"));
    assert!(named::<RoutingCandidate>().ends_with("RoutingCandidate"));
}

#[test]
fn exports_all_required_types() {
    let config = BackgroundTasksConfig {
        wait_for_completion: Some(false),
        max_concurrency: Some(2),
        timeout: Some(Duration::from_millis(5_000)),
        ..BackgroundTasksConfig::default()
    };
    assert_eq!(config.max_concurrency, Some(2));
}

#[test]
fn exports_streaming_event_classes_as_values_not_just_types() {
    let names = [
        named::<ToolStreamEvent>(),
        named::<ModelMessageStartEvent>(),
        named::<ModelContentBlockStartEvent>(),
        named::<ModelContentBlockDeltaEvent>(),
        named::<ModelContentBlockStopEvent>(),
        named::<ModelMessageStopEvent>(),
        named::<ModelMetadataEvent>(),
        named::<ModelRedactionEvent>(),
    ];
    assert!(names.iter().all(|name| name.starts_with("strands::")));
}

#[test]
fn can_instantiate_exported_streaming_event_classes() {
    let tool_event = ToolStreamEvent::new("test");
    assert_eq!(
        serde_json::to_value(&tool_event).unwrap(),
        json!({"type": "toolStreamEvent", "data": "test"})
    );

    let message_start = ModelStreamEvent::from(ModelMessageStartEvent::new(Role::Assistant));
    assert_eq!(
        serde_json::to_value(&message_start).unwrap(),
        json!({"type": "modelMessageStartEvent", "role": "assistant"})
    );
}

/// The context manager items are reachable from `strands::experimental` itself.
#[test]
fn exports_the_experimental_context_manager_barrel() {
    use strands::experimental::{
        ContextManager, ContextManagerConfig, ContextManagerStrategy, ContextState, ContextStrategy, Offload,
        OffloadConditions, OffloadTarget, StashConfig, SummarizeConfig, TruncateConfig,
    };
    assert!(named::<ContextManager>().ends_with("ContextManager"));
    assert!(named::<ContextManagerConfig>().ends_with("ContextManagerConfig"));
    assert!(named::<ContextManagerStrategy>().ends_with("ContextManagerStrategy"));
    assert!(named::<ContextState<'_>>().contains("ContextState"));
    assert!(named::<std::sync::Arc<dyn ContextStrategy>>().contains("ContextStrategy"));
    assert!(named::<Offload>().ends_with("Offload"));
    assert!(named::<OffloadConditions>().ends_with("OffloadConditions"));
    assert!(named::<OffloadTarget>().ends_with("OffloadTarget"));
    assert!(named::<StashConfig>().ends_with("StashConfig"));
    assert!(named::<SummarizeConfig>().ends_with("SummarizeConfig"));
    assert!(named::<TruncateConfig>().ends_with("TruncateConfig"));
}

/// `strands::*` does not bring a `JsonSchema` that makes the `schemars` derive ambiguous.
mod glob_import_with_schemars {
    #[allow(unused_imports, reason = "the globs are what the case checks")]
    use schemars::*;
    #[allow(unused_imports, reason = "the globs are what the case checks")]
    use strands::*;

    #[derive(serde::Deserialize, JsonSchema)]
    #[allow(dead_code, reason = "only the derive is checked")]
    struct Input {
        city: String,
    }

    #[test]
    fn derives_json_schema_next_to_a_strands_glob_import() {
        let schema = schemars::schema_for!(Input);
        assert!(schema.as_value()["properties"]["city"].is_object());
    }
}

/// The types the root APIs name are re-exported next to them.
#[test]
fn exports_the_types_root_apis_name() {
    use strands::{
        AgentAsTool, Cancel, EndTurn, ExecutionStream, ExecutionStreamItem, Hook, HookCleanup, ToolStreamItem,
    };
    assert!(named::<AgentAsTool>().ends_with("AgentAsTool"));
    assert!(named::<Cancel>().ends_with("Cancel"));
    assert!(named::<EndTurn>().ends_with("EndTurn"));
    assert!(named::<ExecutionStream>().contains("ExecutionStreamItem"));
    assert!(named::<ExecutionStreamItem>().ends_with("ExecutionStreamItem"));
    assert!(named::<Box<dyn Hook<strands::BeforeInvocationEvent<'static>>>>().contains("Hook"));
    assert!(named::<HookCleanup>().ends_with("HookCleanup"));
    assert!(named::<ToolStreamItem>().ends_with("ToolStreamItem"));
}

/// Every callback type is a cheap-clone newtype: `new` takes an unannotated closure, `.into()`
/// an annotated one, and the value is callable like the closure.
#[test]
fn callbacks_are_newtypes_built_from_closures() {
    use strands::IsRetryable;
    use strands::interventions::Evaluate;
    use strands::session::SnapshotTriggerCallback;

    let retryable = IsRetryable::new(|error| error.to_string() == "custom");
    assert!((*retryable)(&strands::Error::other("custom")));
    let evaluate: Evaluate = (|response: &serde_json::Value| response == &json!("ok")).into();
    assert!(evaluate(&json!("ok")));
    let trigger = SnapshotTriggerCallback::new(|_params| true);
    let manager = strands::SessionManager::builder()
        .storage(strands::storage::InMemoryStorage::new())
        .snapshot_trigger(trigger)
        .build();
    assert!(manager.is_ok());
    assert_eq!(format!("{retryable:?}"), "IsRetryable(..)");
}
