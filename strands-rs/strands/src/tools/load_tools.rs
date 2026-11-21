//! The `load_tools` tool: loads the input schemas of deferred tools.

use std::fmt;
use std::sync::{Arc, LazyLock};

use indexmap::IndexSet;
use serde::Deserialize;
use serde_json::json;

use super::tool::{DelegationToken, SdkToolRole};
use super::{SchemaValidator, Tool, ToolContext, ToolError, ToolOutcome, ToolStream};
use crate::agent::ToolAgent;
use crate::error::Error;
use crate::types::{JsonValue, ToolReferenceBlock, ToolResultBlock, ToolResultContent, ToolSpec};

/// Name of the tool a model calls to load the input schemas of deferred tools
/// (`LOAD_TOOLS_TOOL_NAME`).
pub const LOAD_TOOLS_TOOL_NAME: &str = "load_tools";

const DESCRIPTION: &str =
    "Load tools whose parameters are not shown yet, so you can call them. Load every tool you need in one call.";

fn input_schema() -> JsonValue {
    json!({
        "type": "object",
        "properties": {
            "names": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 1,
                "description": "Names of the tools to load."
            }
        },
        "required": ["names"],
        "additionalProperties": false
    })
}

static VALIDATOR: LazyLock<Option<SchemaValidator>> = LazyLock::new(|| SchemaValidator::new(&input_schema()).ok());

#[derive(Deserialize)]
struct LoadToolsInput {
    names: Vec<String>,
}

/// Returns the names of an agent's deferred tools.
pub(crate) type DeferredToolsFn = Arc<dyn Fn(&ToolAgent) -> Vec<String> + Send + Sync>;

/// The tool a model calls to load deferred tools (`createLoadTools`). It returns one
/// [`ToolReferenceBlock`] per tool and nothing else, since the Claude API rejects a tool result
/// that mixes tool references with other content. A name that isn't a deferred tool fails the
/// whole call, so the model can call again with the right names.
pub(crate) struct LoadTools {
    deferred_tools: DeferredToolsFn,
    spec: ToolSpec,
}

impl fmt::Debug for LoadTools {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoadTools").finish_non_exhaustive()
    }
}

/// The `load_tools` tool for the deferred tools `deferred_tools` names.
pub(crate) fn create_load_tools(deferred_tools: DeferredToolsFn) -> Arc<dyn Tool> {
    Arc::new(LoadTools {
        deferred_tools,
        spec: ToolSpec::new(LOAD_TOOLS_TOOL_NAME, DESCRIPTION).with_input_schema(input_schema()),
    })
}

impl LoadTools {
    fn load(&self, agent: &ToolAgent, input: &JsonValue) -> Result<Vec<ToolResultContent>, Error> {
        if let Some(Err(error)) = VALIDATOR.as_ref().map(|validator| validator.validate(input)) {
            return Err(Error::other(error.to_string()));
        }
        let input: LoadToolsInput = serde_json::from_value(input.clone()).map_err(Error::other)?;
        let deferred = (self.deferred_tools)(agent);
        let names: IndexSet<String> = input.names.into_iter().collect();
        let registry = agent.tool_registry();
        let missing: Vec<&str> = names
            .iter()
            .filter(|name| registry.get(name).is_none())
            .map(String::as_str)
            .collect();
        let shown: Vec<&str> = names
            .iter()
            .filter(|name| !deferred.contains(name) && registry.get(name).is_some())
            .map(String::as_str)
            .collect();
        // One bad name loads none: a result that mixes references with text loses Claude's native references.
        if !missing.is_empty() || !shown.is_empty() {
            return Err(Error::other(nothing_loaded(&missing, &shown)));
        }
        Ok(names
            .into_iter()
            .map(|name| ToolReferenceBlock::new(name).into())
            .collect())
    }
}

impl Tool for LoadTools {
    fn name(&self) -> &str {
        LOAD_TOOLS_TOOL_NAME
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn tool_spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let tool_use_id = context.tool_use().tool_use_id.clone();
        let outcome = match self.load(context.agent(), &context.tool_use().input) {
            Ok(content) => ToolOutcome::Result(ToolResultBlock::success(tool_use_id, content)),
            Err(error) => ToolError::new(error).into_outcome(tool_use_id),
        };
        ToolStream::ready(outcome)
    }

    fn sdk_tool_role(&self, _: DelegationToken) -> Option<SdkToolRole> {
        Some(SdkToolRole::LoadTools)
    }
}

/// Why a load loaded nothing, naming each tool it couldn't load and what to do instead.
fn nothing_loaded(missing: &[&str], shown: &[&str]) -> String {
    let mut reasons = Vec::new();
    if !shown.is_empty() {
        reasons.push(names_with(
            shown,
            "is shown in full, so call it directly",
            "are shown in full, so call them directly",
        ));
    }
    if !missing.is_empty() {
        reasons.push(names_with(missing, "is not a tool", "are not tools"));
    }
    format!(
        "Nothing loaded: {}. Load only tools whose parameters are not shown.",
        reasons.join("; ")
    )
}

/// The names, followed by the phrase that agrees with how many there are.
fn names_with(names: &[&str], one: &str, many: &str) -> String {
    let phrase = if names.len() == 1 { one } else { many };
    format!("{} {phrase}", names.join(", "))
}
