use super::*;
use crate::experimental::context_manager::{
    ContextManager, ContextManagerConfig, ContextManagerStrategy, ContextState,
};

struct Custom;

#[async_trait::async_trait]
impl ContextStrategy for Custom {
    fn name(&self) -> &str {
        "custom"
    }

    async fn apply(&self, _context: &mut ContextState<'_>) -> Result<bool> {
        Ok(false)
    }
}

fn names(strategies: &[Arc<dyn ContextStrategy>]) -> Vec<&str> {
    strategies.iter().map(|strategy| strategy.name()).collect()
}

#[test]
fn resolves_each_preset_to_a_non_empty_strategy_array() {
    for preset in STRATEGY_PRESET_NAMES {
        assert!(!resolve_preset(preset).unwrap().is_empty(), "{preset}");
    }
}

#[test]
fn proactive_summarization_resolves_to_a_summarize_strategy() {
    assert_eq!(
        names(&resolve_preset(StrategyPresetName::ProactiveSummarization).unwrap()),
        ["offload:summarize"]
    );
}

#[test]
fn large_tool_offloading_resolves_to_a_truncate_strategy() {
    assert_eq!(
        names(&resolve_preset(StrategyPresetName::LargeToolOffloading).unwrap()),
        ["offload:truncate"]
    );
}

#[test]
fn overflow_protection_resolves_to_a_drop_strategy() {
    assert_eq!(
        names(&resolve_preset(StrategyPresetName::OverflowProtection).unwrap()),
        ["offload:drop"]
    );
}

#[test]
fn stale_tool_cleanup_resolves_to_a_drop_strategy() {
    assert_eq!(
        names(&resolve_preset(StrategyPresetName::StaleToolCleanup).unwrap()),
        ["offload:drop"]
    );
}

#[test]
fn passes_raw_strategies_through_unchanged() {
    let raw: Arc<dyn ContextStrategy> = Arc::new(Custom);
    let result = resolve_strategies(&[StrategyEntry::from(raw.clone())]).unwrap();
    assert_eq!(result.len(), 1);
    assert!(Arc::ptr_eq(&result[0], &raw));
}

#[test]
fn resolves_preset_strings_to_strategy_arrays() {
    let result = resolve_strategies(&[StrategyPresetName::LargeToolOffloading.into()]).unwrap();
    assert_eq!(names(&result), ["offload:truncate"]);
}

#[test]
fn handles_mixed_arrays_of_presets_and_raw_strategies() {
    let result = resolve_strategies(&[
        StrategyPresetName::LargeToolOffloading.into(),
        Custom.into(),
        StrategyPresetName::OverflowProtection.into(),
    ])
    .unwrap();
    assert_eq!(names(&result), ["offload:truncate", "custom", "offload:drop"]);
}

#[test]
fn preserves_order_of_preset_expansion() {
    let result = resolve_strategies(&[
        StrategyPresetName::StaleToolCleanup.into(),
        StrategyPresetName::ProactiveSummarization.into(),
    ])
    .unwrap();
    assert_eq!(names(&result), ["offload:drop", "offload:summarize"]);
}

#[test]
fn throws_for_unknown_preset_string() {
    let error = "proactiveSummarisation".parse::<StrategyPresetName>().unwrap_err();
    assert_eq!(
        error.to_string(),
        "Unknown strategy preset: \"proactiveSummarisation\". Valid presets: proactiveSummarization, largeToolOffloading, overflowProtection, staleToolCleanup"
    );
    assert_eq!(
        "staleToolCleanup".parse::<StrategyPresetName>().unwrap(),
        StrategyPresetName::StaleToolCleanup
    );
}

#[test]
fn resolves_preset_strings_in_a_config_strategies_array() {
    let config = ContextManagerConfig {
        strategies: Some(vec![
            StrategyPresetName::LargeToolOffloading.into(),
            StrategyPresetName::ProactiveSummarization.into(),
        ]),
        ..ContextManagerConfig::default()
    };
    assert!(ContextManager::from_strategy(Some(config.into())).unwrap().is_some());
}

#[test]
fn resolves_a_mix_of_preset_strings_and_raw_strategies() {
    let config = ContextManagerConfig {
        strategies: Some(vec![StrategyPresetName::LargeToolOffloading.into(), Custom.into()]),
        ..ContextManagerConfig::default()
    };
    assert!(ContextManager::from_strategy(Some(config.into())).unwrap().is_some());
}

#[test]
fn resolves_auto_preset() {
    assert!(
        ContextManager::from_strategy(Some(ContextManagerStrategy::Auto))
            .unwrap()
            .is_some()
    );
}

#[test]
fn resolves_agentic_preset() {
    assert!(
        ContextManager::from_strategy(Some(ContextManagerStrategy::Agentic))
            .unwrap()
            .is_some()
    );
}

#[test]
fn returns_undefined_for_false() {
    assert!(
        ContextManager::from_strategy(Some(ContextManagerStrategy::Disabled))
            .unwrap()
            .is_none()
    );
}

#[test]
fn returns_undefined_for_undefined() {
    assert!(ContextManager::from_strategy(None).unwrap().is_none());
}

#[test]
fn throws_for_unknown_preset_string_in_context_manager_from() {
    let error = "atuo".parse::<ContextManagerStrategy>().unwrap_err();
    assert!(error.to_string().contains("Unknown contextManager preset"));
    assert_eq!(
        error.to_string(),
        "Unknown contextManager preset: \"atuo\". Valid presets: \"auto\", \"agentic\""
    );
}

#[test]
fn accepts_an_offload_strategy_without_when() {
    let strategy: Arc<dyn ContextStrategy> = Arc::new(
        crate::experimental::context_manager::Offload::drop(
            crate::experimental::context_manager::OffloadTarget::ToolResults,
        )
        .unwrap(),
    );
    let result = resolve_strategies(&[StrategyEntry::Strategy(strategy.clone())]).unwrap();
    assert_eq!(result.len(), 1);
    assert!(Arc::ptr_eq(&result[0], &strategy));
}
