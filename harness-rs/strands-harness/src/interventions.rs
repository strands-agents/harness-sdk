//! The harness's `interventions` sugar, resolved into SDK intervention handlers.
//!
//! The option takes a preset name, a natural-language policy, a Cedar policy file, an SDK handler
//! or a list of these. The string grammar is deterministic, with no content sniffing:
//!
//! - `off`, `ask` and `smart` map to a [`HumanInTheLoop`] config (`smart` adds the LLM risk
//!   classifier);
//! - a path ending in `.cedar` loads a `CedarAuthorization` policy (the `cedar` feature);
//! - any other string is a natural-language risk policy, used as the classifier's prompt.
//!
//! Inline Cedar policy text is not detected: it is indistinguishable from prose, so pass a
//! `CedarAuthorization` handler for that.

use std::fmt;
use std::sync::Arc;

use strands::interventions::InterventionHandler;
use strands::vended_interventions::hitl::{
    ClassifierConfig, HumanInTheLoop, HumanInTheLoopAsk, HumanInTheLoopConfig, LlmClassifierConfig,
};

/// One `interventions` value (`InterventionValue`): a preset, a `.cedar` path or a policy
/// string, or a handler.
#[derive(Clone)]
#[non_exhaustive]
pub enum InterventionValue {
    /// A preset (`off`, `ask`, `smart`), a `.cedar` policy file path, or a natural-language
    /// policy for the LLM risk classifier.
    Text(String),
    /// A handler, registered as is.
    Handler(Arc<dyn InterventionHandler>),
}

impl InterventionValue {
    /// A handler value, by value or as an `Arc`.
    pub fn handler(handler: impl InterventionHandler) -> Self {
        Self::Handler(Arc::new(handler))
    }
}

impl fmt::Debug for InterventionValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(text) => f.debug_tuple("Text").field(text).finish(),
            Self::Handler(handler) => f.debug_tuple("Handler").field(&handler.name()).finish(),
        }
    }
}

impl From<&str> for InterventionValue {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<String> for InterventionValue {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<Arc<dyn InterventionHandler>> for InterventionValue {
    fn from(handler: Arc<dyn InterventionHandler>) -> Self {
        Self::Handler(handler)
    }
}

impl From<HumanInTheLoop> for InterventionValue {
    fn from(handler: HumanInTheLoop) -> Self {
        Self::handler(handler)
    }
}

/// What `interventions` accepts (`InterventionsOption`): one value, or a list layering, for
/// example, a Cedar policy with one human gate.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum InterventionsOption {
    /// One value.
    Value(InterventionValue),
    /// Several values, registered in order.
    List(Vec<InterventionValue>),
}

impl InterventionsOption {
    fn values(&self) -> &[InterventionValue] {
        match self {
            Self::Value(value) => std::slice::from_ref(value),
            Self::List(values) => values,
        }
    }
}

impl<T: Into<InterventionValue>> From<T> for InterventionsOption {
    fn from(value: T) -> Self {
        Self::Value(value.into())
    }
}

impl<T: Into<InterventionValue>> From<Vec<T>> for InterventionsOption {
    fn from(values: Vec<T>) -> Self {
        Self::List(values.into_iter().map(Into::into).collect())
    }
}

impl<T: Into<InterventionValue>, const N: usize> From<[T; N]> for InterventionsOption {
    fn from(values: [T; N]) -> Self {
        Self::List(values.into_iter().map(Into::into).collect())
    }
}

/// The HITL config a preset or policy string maps to, or `None` for `off`, a `.cedar` path or
/// another kind of value.
pub(crate) fn hitl_config(text: &str, ask: Option<&HumanInTheLoopAsk>) -> Option<HumanInTheLoopConfig> {
    let classifier = match text.trim() {
        "off" => return None,
        "ask" => None,
        "smart" => Some(ClassifierConfig::llm()),
        trimmed if trimmed.ends_with(".cedar") => return None,
        _ => Some(ClassifierConfig::Llm(LlmClassifierConfig {
            system_prompt: Some(text.to_owned()),
            ..Default::default()
        })),
    };
    Some(HumanInTheLoopConfig {
        classifier,
        ask: ask.cloned(),
        ..Default::default()
    })
}

#[cfg(feature = "cedar")]
fn cedar_handler(policies: &str) -> strands::Result<Arc<dyn InterventionHandler>> {
    use strands::vended_interventions::cedar::{CedarAuthorization, CedarAuthorizationConfig};

    let config = CedarAuthorizationConfig {
        policies: policies.to_owned(),
        ..Default::default()
    };
    Ok(Arc::new(CedarAuthorization::new(config)?))
}

#[cfg(not(feature = "cedar"))]
fn cedar_handler(policies: &str) -> strands::Result<Arc<dyn InterventionHandler>> {
    Err(strands::Error::other(format!(
        "Cedar policy '{policies}' needs the strands-harness feature \"cedar\"; enable it to use Cedar interventions."
    )))
}

fn resolve_one(
    value: &InterventionValue,
    ask: Option<&HumanInTheLoopAsk>,
) -> strands::Result<Option<Arc<dyn InterventionHandler>>> {
    let text = match value {
        InterventionValue::Handler(handler) => return Ok(Some(Arc::clone(handler))),
        InterventionValue::Text(text) => text,
    };
    let trimmed = text.trim();
    if trimmed.ends_with(".cedar") && !matches!(trimmed, "off" | "ask" | "smart") {
        return cedar_handler(trimmed).map(Some);
    }
    Ok(hitl_config(text, ask).map(|config| Arc::new(HumanInTheLoop::new(config)) as Arc<dyn InterventionHandler>))
}

/// Fails when two handlers share a name: an agent registers at most one per name.
fn check_handler_collisions(handlers: &[Arc<dyn InterventionHandler>]) -> strands::Result<()> {
    for (index, handler) in handlers.iter().enumerate() {
        if handlers[..index].iter().any(|prior| prior.name() == handler.name()) {
            return Err(strands::Error::other(format!(
                "Two interventions share the handler name '{}', but an agent registers at most one per name. Layer different kinds (e.g. a Cedar policy plus one human-approval preset), not two of the same kind.",
                handler.name()
            )));
        }
    }
    Ok(())
}

/// Coerces the `interventions` sugar into SDK handlers; `None` and `off` yield none. `ask` sets how
/// a preset collects approval (interrupt and resume when `None`).
pub(crate) fn resolve_interventions(
    value: Option<&InterventionsOption>,
    ask: Option<&HumanInTheLoopAsk>,
) -> strands::Result<Vec<Arc<dyn InterventionHandler>>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let mut handlers = Vec::new();
    for value in value.values() {
        handlers.extend(resolve_one(value, ask)?);
    }
    check_handler_collisions(&handlers)?;
    Ok(handlers)
}

/// The HITL handler's config is asserted through the config the harness builds for it.
#[cfg(test)]
mod tests {
    use super::*;

    fn cedar_file(dir: &std::path::Path) -> String {
        let path = dir.join("agent.cedar");
        std::fs::write(&path, "permit(principal, action == Action::\"read\", resource);").unwrap();
        path.to_string_lossy().into_owned()
    }

    fn names(handlers: &[Arc<dyn InterventionHandler>]) -> Vec<&str> {
        handlers.iter().map(|handler| handler.name()).collect()
    }

    #[test]
    fn registers_nothing_for_undefined_or_off() {
        assert!(resolve_interventions(None, None).unwrap().is_empty());
        assert!(resolve_interventions(Some(&"off".into()), None).unwrap().is_empty());
        let list = InterventionsOption::List(vec!["off".into()]);
        assert!(resolve_interventions(Some(&list), None).unwrap().is_empty());
    }

    #[test]
    fn converts_lists_and_arrays_of_values() {
        let texts = |option: InterventionsOption| -> Vec<String> {
            option
                .values()
                .iter()
                .map(|value| match value {
                    InterventionValue::Text(text) => text.clone(),
                    InterventionValue::Handler(_) => "handler".to_owned(),
                })
                .collect()
        };
        assert_eq!(texts(vec!["ask", "smart"].into()), ["ask", "smart"]);
        assert_eq!(texts(["ask".to_owned()].into()), ["ask"]);
    }

    #[test]
    fn gates_every_tool_for_ask() {
        let config = hitl_config("ask", None).unwrap();
        assert!(config.allowed_tools.is_empty());
        assert!(config.classifier.is_none());
        let handlers = resolve_interventions(Some(&"ask".into()), None).unwrap();
        assert_eq!(names(&handlers), ["strands:human-in-the-loop"]);
    }

    #[test]
    fn uses_the_llm_classifier_for_smart() {
        let config = hitl_config("smart", None).unwrap();
        assert!(config.allowed_tools.is_empty());
        assert!(matches!(
            config.classifier,
            Some(ClassifierConfig::Llm(LlmClassifierConfig {
                system_prompt: None,
                ..
            }))
        ));
    }

    #[test]
    fn turns_a_natural_language_string_into_the_classifier_prompt() {
        let policy = "Read-only overall, but writes under ./out are fine";
        let config = hitl_config(policy, None).unwrap();
        assert!(config.allowed_tools.is_empty());
        let Some(ClassifierConfig::Llm(classifier)) = config.classifier else {
            panic!("expected the LLM classifier");
        };
        assert_eq!(classifier.system_prompt.as_deref(), Some(policy));
    }

    #[cfg(not(feature = "cedar"))]
    #[test]
    fn reports_a_clear_error_when_the_optional_cedar_dependency_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let path = cedar_file(dir.path());
        let error = resolve_interventions(Some(&path.as_str().into()), None).err().unwrap();
        assert!(error.to_string().to_lowercase().contains("cedar"));
    }

    #[cfg(feature = "cedar")]
    #[test]
    fn loads_a_cedar_file_path_as_a_cedar_handler_when_the_dependency_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let path = cedar_file(dir.path());
        let handlers = resolve_interventions(Some(&path.as_str().into()), None).unwrap();
        assert_eq!(names(&handlers), ["cedar-authorization"]);
    }

    #[test]
    fn does_not_treat_a_non_cedar_file_path_as_cedar() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.txt");
        std::fs::write(&path, "be careful").unwrap();
        let text = path.to_string_lossy().into_owned();
        assert!(hitl_config(&text, None).is_some());
        let handlers = resolve_interventions(Some(&text.as_str().into()), None).unwrap();
        assert_eq!(names(&handlers), ["strands:human-in-the-loop"]);
    }

    #[test]
    fn passes_a_handler_instance_through_untouched() {
        let handler: Arc<dyn InterventionHandler> = Arc::new(HumanInTheLoop::new(HumanInTheLoopConfig {
            ask: Some(HumanInTheLoopAsk::Stdio),
            enable_trust: Some(true),
            ..Default::default()
        }));
        let handlers = resolve_interventions(Some(&Arc::clone(&handler).into()), None).unwrap();
        assert_eq!(handlers.len(), 1);
        assert!(Arc::ptr_eq(&handlers[0], &handler));
    }

    #[test]
    fn throws_when_two_human_approval_handlers_collide() {
        let both = InterventionsOption::List(vec!["ask".into(), "smart".into()]);
        let error = resolve_interventions(Some(&both), None).err().unwrap();
        assert!(error.to_string().contains("at most one"));
        assert_eq!(
            error.to_string(),
            "Two interventions share the handler name 'strands:human-in-the-loop', but an agent registers at most one per name. Layer different kinds (e.g. a Cedar policy plus one human-approval preset), not two of the same kind."
        );
    }

    #[test]
    fn threads_the_ask_mode_into_the_handler() {
        assert!(hitl_config("ask", None).unwrap().ask.is_none());
        let stdio = HumanInTheLoopAsk::Stdio;
        assert!(hitl_config("ask", Some(&stdio)).unwrap().ask.is_some());
    }
}
