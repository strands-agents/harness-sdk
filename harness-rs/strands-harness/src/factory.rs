//! The seam between the harness core and the built-in tool and plugin modules (`tools/`,
//! `plugins/`): one constructor per built-in, each taking its resolved config and the context
//! it needs.

use std::sync::Arc;

use futures::future::BoxFuture;
use strands::models::Model;
use strands::multiagent::SpecValue;
use strands::plugins::Plugin;
use strands::tools::Tool;
use strands::{Agent, ModelSource};

use crate::plugins::EnvironmentContext;
use crate::tools::file_tools;
use crate::tools::programmatic_tool_caller::{ProgrammaticToolCallerConfig, programmatic_tool_caller};
use crate::tools::subagent::{AgentBuilder, AgentSpec, SubagentConfig, SubagentContext, subagent_tool};
use crate::tools::web_fetch::{WebFetchConfig, WebFetchTransport, web_fetch_tool};
use crate::types::ShellConfig;

/// What a `subagent` child is built from: the resolved spec fields the harness builder reads
/// (`None` inherits the parent's).
#[derive(Debug, Clone, Default)]
pub(crate) struct ChildSpec {
    pub(crate) instructions: Option<String>,
    pub(crate) tools: Option<Vec<String>>,
    pub(crate) model: Option<ModelSource>,
    pub(crate) mcp_servers: Option<Vec<String>>,
}

/// Builds a `subagent` child the way the parent was built.
pub(crate) type ChildBuilder = Arc<dyn Fn(ChildSpec) -> BoxFuture<'static, strands::Result<Agent>> + Send + Sync>;

/// The `read` tool's resolved options.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ReadToolOptions {
    /// Return images and binary documents as viewable media.
    pub(crate) media: bool,
}

/// The `web_fetch` tool's resolved options.
#[derive(Clone)]
pub(crate) struct WebFetchToolOptions {
    /// The summarizer model, already resolved.
    pub(crate) model: Arc<dyn Model>,
    /// How the request is made; curl in the sandbox when `None`.
    pub(crate) transport: Option<WebFetchTransport>,
}

/// The `subagent` tool's resolved options.
#[derive(Clone)]
pub(crate) struct SubagentToolOptions {
    /// Rebuilds a child through `create_harness` with the resolved spec applied.
    pub(crate) builder: ChildBuilder,
    /// The parent's built-in (minus `web_search`) and consumer tool names, the default `tools`
    /// choice.
    pub(crate) inherited_tools: Vec<String>,
    /// The parent's offerable MCP server names, the default `mcp_servers` choice.
    pub(crate) inherited_mcp_servers: Vec<String>,
    /// The delegation-depth bound; the tool's default (2) when `None`.
    pub(crate) max_depth: Option<usize>,
}

/// One constructor per built-in tool and plugin.
pub(crate) struct BuiltinToolFactory {
    pub(crate) shell: fn(&ShellConfig) -> strands::Result<Arc<dyn Tool>>,
    pub(crate) read: fn(ReadToolOptions) -> strands::Result<Arc<dyn Tool>>,
    pub(crate) write: fn() -> strands::Result<Arc<dyn Tool>>,
    pub(crate) edit: fn() -> strands::Result<Arc<dyn Tool>>,
    pub(crate) web_fetch: fn(WebFetchToolOptions) -> strands::Result<Arc<dyn Tool>>,
    /// The Exa-backed `web_search` tool; native search is a model flag.
    pub(crate) web_search: fn() -> strands::Result<Arc<dyn Tool>>,
    /// Takes the portable config: `timeout` is in seconds, `Some(None)` unbounded.
    pub(crate) programmatic_tool_caller: fn(&ProgrammaticToolCallerConfig) -> strands::Result<Arc<dyn Tool>>,
    pub(crate) subagent: fn(SubagentToolOptions) -> strands::Result<Arc<dyn Tool>>,
    /// The `environment` plugin (`new EnvironmentContext()`).
    pub(crate) environment: fn() -> Arc<dyn Plugin>,
}

/// The constructors the harness builds its built-ins with.
pub(crate) const BUILTIN_TOOL_FACTORY: BuiltinToolFactory = BuiltinToolFactory {
    shell: |config| Ok(Arc::new(file_tools::shell_tool(config.description.clone())?)),
    read: |options| Ok(Arc::new(file_tools::read_tool(options.media))),
    write: || Ok(Arc::new(file_tools::write_tool())),
    edit: || Ok(Arc::new(file_tools::edit_tool())),
    web_fetch: |options| {
        let config = WebFetchConfig {
            model: None,
            transport: options.transport,
        };
        Ok(Arc::new(web_fetch_tool(config, Some(options.model))?))
    },
    web_search: exa_web_search,
    programmatic_tool_caller: |config| Ok(Arc::new(programmatic_tool_caller(config.clone()))),
    subagent,
    environment: || Arc::new(EnvironmentContext::default()),
};

#[cfg(feature = "mcp")]
fn exa_web_search() -> strands::Result<Arc<dyn Tool>> {
    Ok(Arc::new(crate::tools::web_search::web_search_tool()))
}

#[cfg(not(feature = "mcp"))]
fn exa_web_search() -> strands::Result<Arc<dyn Tool>> {
    Err(strands::Error::other(
        "web_search through Exa needs the strands-harness feature \"mcp\"; enable it, or drop web_search from builtinTools.",
    ))
}

fn child_spec(spec: AgentSpec) -> ChildSpec {
    ChildSpec {
        instructions: spec.instructions,
        tools: spec.tools,
        model: spec.model.and_then(|model| match model {
            SpecValue::Model(model) => Some(ModelSource::Model(model)),
            SpecValue::Text(model) => Some(ModelSource::Id(model)),
            _ => None,
        }),
        mcp_servers: spec.mcp_servers,
    }
}

/// The default `subagent` tool, building each child through the harness builder.
fn subagent(options: SubagentToolOptions) -> strands::Result<Arc<dyn Tool>> {
    let SubagentToolOptions {
        builder,
        inherited_tools,
        inherited_mcp_servers,
        max_depth,
    } = options;
    let builder = AgentBuilder::new(move |spec| builder(child_spec(spec)));
    let context = SubagentContext::new(builder)
        .with_inherited_tools(inherited_tools)
        .with_inherited_mcp_servers(inherited_mcp_servers);
    Ok(Arc::new(subagent_tool(SubagentConfig { max_depth }, context)?))
}

/// The default name of the `environment` plugin (`strands:environment`).
pub(crate) const ENVIRONMENT_PLUGIN_NAME: &str = "strands:environment";
