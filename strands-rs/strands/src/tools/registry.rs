//! The tool registry.

use std::fmt;
use std::sync::Arc;

use indexmap::IndexMap;

use super::source::ToolSource;
use super::tool::{Tool, is_valid_tool_name};
use crate::error::{Result, ToolNotFoundError, ToolValidationError};

const MAX_TOOL_NAME_LENGTH: usize = 64;

/// The tools an agent can call, by name (`ToolRegistry`).
///
/// Names are unique, and two names that differ only by `-` versus `_` count as the same name.
/// Cloning is cheap: the tools are shared.
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: IndexMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a registry holding `tools`.
    ///
    /// # Errors
    ///
    /// As [`ToolRegistry::add`].
    pub fn with_tools(tools: impl Into<ToolSource>) -> Result<Self> {
        let mut registry = Self::new();
        registry.add(tools)?;
        Ok(registry)
    }

    /// Registers one tool or a list of tools (`add`). Tools before a failing one stay registered.
    ///
    /// # Errors
    ///
    /// [`ToolValidationError`] when a name or description is invalid, the name is already
    /// registered (also under a `-`/`_` variant), or `tools` holds an MCP client.
    pub fn add(&mut self, tools: impl Into<ToolSource>) -> Result<()> {
        for tool in tools.into().into_registry_tools()? {
            validate_properties(tool.as_ref())?;
            let name = tool.name().to_owned();
            if self.tools.contains_key(&name) {
                return Err(ToolValidationError::new(format!("Tool with name '{name}' already registered")).into());
            }
            self.check_normalized_conflict(&name)?;
            self.tools.insert(name, tool);
        }
        Ok(())
    }

    /// Registers tools, replacing tools of the same name.
    ///
    /// # Errors
    ///
    /// [`ToolValidationError`] when a name or description is invalid, a new name conflicts with
    /// a `-`/`_` variant of a registered one, or `tools` holds an MCP client.
    pub fn add_or_replace(&mut self, tools: impl Into<ToolSource>) -> Result<()> {
        for tool in tools.into().into_registry_tools()? {
            validate_properties(tool.as_ref())?;
            let name = tool.name().to_owned();
            if !self.tools.contains_key(&name) {
                self.check_normalized_conflict(&name)?;
            }
            self.tools.insert(name, tool);
        }
        Ok(())
    }

    /// The tool registered under exactly `name` (`get`).
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.get(name)
    }

    /// Resolves a name the model used (`resolve`): an exact match, then a registered name whose
    /// `-` become `_` (`my_tool` finds `my-tool`), then a case-insensitive match.
    ///
    /// # Errors
    ///
    /// [`ToolNotFoundError`] when nothing matches.
    pub fn resolve(&self, name: &str) -> Result<&Arc<dyn Tool>> {
        if let Some(tool) = self.tools.get(name) {
            return Ok(tool);
        }
        let hyphen_match = name
            .contains('_')
            .then(|| {
                self.tools
                    .iter()
                    .find(|(registered, _)| registered.replace('-', "_") == name)
            })
            .flatten();
        if let Some((_, tool)) = hyphen_match {
            return Ok(tool);
        }
        let lower = name.to_lowercase();
        self.tools
            .iter()
            .find(|(registered, _)| registered.to_lowercase() == lower)
            .map(|(_, tool)| tool)
            .ok_or_else(|| ToolNotFoundError::new(name).into())
    }

    /// Removes a tool by name; does nothing when it is not registered (`remove`).
    pub fn remove(&mut self, name: &str) {
        self.tools.shift_remove(name);
    }

    /// Removes every tool (`clear`).
    pub fn clear(&mut self) {
        self.tools.clear();
    }

    /// Every registered tool, in registration order (`list`).
    #[must_use]
    pub fn list(&self) -> Vec<Arc<dyn Tool>> {
        self.tools.values().cloned().collect()
    }

    /// Whether no tools are registered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    fn check_normalized_conflict(&self, name: &str) -> Result<()> {
        let normalized = name.replace('-', "_");
        let conflict = self
            .tools
            .keys()
            .find(|existing| existing.as_str() != name && existing.replace('-', "_") == normalized);
        match conflict {
            Some(existing) => Err(ToolValidationError::new(format!(
                "Tool name '{name}' already exists as '{existing}'. Cannot add a duplicate tool which differs by a '-' or '_'"
            ))
            .into()),
            None => Ok(()),
        }
    }
}

fn validate_properties(tool: &dyn Tool) -> Result<()> {
    let name = tool.name();
    if name.is_empty() || name.len() > MAX_TOOL_NAME_LENGTH {
        return Err(ToolValidationError::new(format!(
            "tool_name=<{name}> | Tool name must be between 1 and {MAX_TOOL_NAME_LENGTH} characters"
        ))
        .into());
    }
    if !is_valid_tool_name(name) {
        return Err(ToolValidationError::new(format!(
            "tool_name=<{name}> | Tool name must contain only alphanumeric characters, hyphens, and underscores"
        ))
        .into());
    }
    if tool.description().is_empty() {
        return Err(ToolValidationError::new(format!(
            "tool_name=<{name}> | Tool description must be a non-empty string"
        ))
        .into());
    }
    Ok(())
}

impl fmt::Debug for ToolRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.tools.keys()).finish()
    }
}

#[cfg(test)]
mod tests;
