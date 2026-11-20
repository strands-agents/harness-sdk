//! Plugin registration and initialization.

use std::collections::VecDeque;
use std::error::Error as StdError;
use std::fmt;
use std::sync::Arc;

use super::plugin::Plugin;
use crate::agent::LocalAgent;
use crate::error::{Error, Result};
use crate::tools::ToolSource;

/// A failed initialization, kept so later calls fail with the same message.
#[derive(Debug, Clone)]
struct InitializationError(String);

impl fmt::Display for InitializationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl StdError for InitializationError {}

enum State {
    Pending(VecDeque<Arc<dyn Plugin>>),
    Initialized,
    Failed(InitializationError),
}

/// Holds an agent's plugins and initializes them once, in order (`PluginRegistry`).
pub(crate) struct PluginRegistry {
    names: Vec<String>,
    state: State,
}

impl PluginRegistry {
    /// Creates a registry for `plugins`, in initialization order.
    pub(crate) fn new(plugins: Vec<Arc<dyn Plugin>>) -> Self {
        Self {
            names: Vec::new(),
            state: State::Pending(plugins.into()),
        }
    }

    /// Initializes every plugin once (`initialize`): `init_agent`, then its tools. Later calls do
    /// nothing; after a failure they fail again with the same message, without re-running any
    /// plugin.
    ///
    /// A plugin leaves the pending list only once it finished, so when a dropped agent stream
    /// cuts initialization short, the next call continues with the plugin it interrupted.
    ///
    /// # Errors
    ///
    /// `plugin_name=<name> | plugin already registered` for a repeated name, a plugin's
    /// `init_agent` error, or a tool registration error.
    pub(crate) async fn initialize(&mut self, agent: &mut LocalAgent) -> Result<()> {
        loop {
            let plugin = match &self.state {
                State::Pending(plugins) => match plugins.front() {
                    Some(plugin) => plugin.clone(),
                    None => {
                        self.state = State::Initialized;
                        return Ok(());
                    }
                },
                State::Initialized => return Ok(()),
                State::Failed(error) => return Err(Error::other(error.clone())),
            };
            if let Err(error) = self.add_and_init(plugin.as_ref(), agent).await {
                self.state = State::Failed(InitializationError(error.to_string()));
                return Err(error);
            }
            if let State::Pending(plugins) = &mut self.state {
                plugins.pop_front();
            }
        }
    }

    async fn add_and_init(&mut self, plugin: &dyn Plugin, agent: &mut LocalAgent) -> Result<()> {
        let name = plugin.name().to_owned();
        if self.names.contains(&name) {
            return Err(Error::other(format!(
                "plugin_name=<{name}> | plugin already registered"
            )));
        }
        plugin.init_agent(agent).await?;
        self.names.push(name);
        let tools = plugin.get_tools();
        if !tools.is_empty() {
            agent.tool_registry_mut().add(ToolSource::List(tools))?;
        }
        Ok(())
    }

    /// The names of the registered plugins, in order.
    #[cfg(test)]
    pub(crate) fn names(&self) -> &[String] {
        &self.names
    }
}

#[cfg(test)]
mod tests;
