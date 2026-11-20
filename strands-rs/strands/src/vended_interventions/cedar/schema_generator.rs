//! Cedar schemas generated from tool definitions.

use std::sync::LazyLock;

use cedar_policy_mcp_schema_generator::{SchemaGenerator as McpSchemaGenerator, SchemaGeneratorConfig};
use mcp_tools_sdk::description::ServerDescription;
use regex::Regex;

use super::ToolDefinition;
use crate::error::{Error, Result};

static NAMESPACE_OPEN: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^namespace\s+(\w+)\s*\{").ok());
static TRAILING_CLOSE: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"\}\s*$").ok());

fn generation_failed(error: impl std::fmt::Display) -> Error {
    Error::other(format!("Schema generation failed: {error}"))
}

/// Generates a validation schema for `tools` from the principal, resource and session-context stub,
/// with namespaces flattened. Without a namespace the `namespace Agent { .. }` wrapper is stripped
/// so policies in the empty namespace validate.
pub(crate) fn generate_schema(tools: &[ToolDefinition], namespace: Option<&str>) -> Result<String> {
    let ns = namespace.unwrap_or("Agent");
    let stub = format!(
        "
namespace {ns} {{
  @mcp_principal
  entity User;
  @mcp_resource
  entity Resource;
  @mcp_context(\"session\")
  type SessionContext = {{
    hour_utc: Long,
    call_count: Long
  }};
}}
"
    );
    let config = SchemaGeneratorConfig::default().flatten_namespaces(true);
    let mut generator =
        McpSchemaGenerator::from_cedarschema_str_with_config(&stub, config).map_err(generation_failed)?;
    let tools_json = serde_json::to_string(tools)?;
    let description = ServerDescription::from_json_str(&tools_json).map_err(generation_failed)?;
    generator
        .add_actions_from_server_description(&description)
        .map_err(generation_failed)?;
    let schema = generator.get_schema_as_str();
    if namespace.is_some() {
        return Ok(schema);
    }
    Ok(strip_namespace(&schema))
}

/// Unwraps `namespace <ns> { .. }` and drops the `<ns>::` qualifiers.
fn strip_namespace(schema: &str) -> String {
    let (Some(open), Some(close)) = (NAMESPACE_OPEN.as_ref(), TRAILING_CLOSE.as_ref()) else {
        return schema.to_owned();
    };
    let ns = open
        .captures(schema)
        .and_then(|captures| captures.get(1))
        .map_or("Agent", |name| name.as_str())
        .to_owned();
    let unwrapped = open.replace(schema, "");
    let unwrapped = close.replace(&unwrapped, "");
    unwrapped.replace(&format!("{ns}::"), "")
}
