//! The [`Plugin`] trait.

use async_trait::async_trait;

use crate::agent::LocalAgent;
use crate::error::Result;
use crate::tools::ToolSource;

/// Extends an agent with hooks, tools and setup (`Plugin`).
///
/// [`init_agent`](Plugin::init_agent) runs once when the agent initializes and typically
/// registers hooks; [`get_tools`](Plugin::get_tools) runs after it, so the tools can depend on
/// what initialization set up. Plugin names are unique per agent.
///
/// ```
/// use strands::agent::LocalAgent;
/// use strands::hooks::BeforeToolCallEvent;
/// use strands::plugins::Plugin;
///
/// struct NoShell;
///
/// #[strands::async_trait]
/// impl Plugin for NoShell {
///     fn name(&self) -> &str {
///         "no-shell"
///     }
///
///     async fn init_agent(&self, agent: &mut LocalAgent) -> strands::Result<()> {
///         agent.add_hook(|event: &mut BeforeToolCallEvent| {
///             if event.tool_use().name == "shell" {
///                 event.set_cancel("shell is disabled");
///             }
///         });
///         Ok(())
///     }
/// }
/// ```
#[async_trait]
pub trait Plugin: Send + Sync + 'static {
    /// The unique plugin name, such as `strands:model` for built-ins.
    fn name(&self) -> &str;

    /// Sets the plugin up on the agent: register hooks, read configuration.
    ///
    /// # Errors
    ///
    /// Any error fails agent initialization.
    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()>;

    /// The tools to register on the agent after [`init_agent`](Plugin::init_agent):
    /// anything that converts into a [`ToolSource`], such as `vec![MyTool.into()]`. An MCP client
    /// is rejected; pass it to the agent's tools instead.
    fn get_tools(&self) -> Vec<ToolSource> {
        Vec::new()
    }
}

/// A shared plugin is a plugin, so `Arc<dyn Plugin>` and `Arc<P>` go wherever plugins do.
#[async_trait]
impl<P: Plugin + ?Sized> Plugin for std::sync::Arc<P> {
    fn name(&self) -> &str {
        (**self).name()
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        (**self).init_agent(agent).await
    }

    fn get_tools(&self) -> Vec<ToolSource> {
        (**self).get_tools()
    }
}
