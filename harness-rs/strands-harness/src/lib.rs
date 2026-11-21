//! A preconfigured Strands agent in one call.
//!
//! A thin composition layer over the [`strands`] crate: [`create_harness`] wires a resolved
//! model, the vended system prompt, built-in tools, context management, session persistence,
//! skills and long-term memory into a plain [`strands::Agent`], which callers can change or
//! extend like any other agent.
//!
//! ```no_run
//! use strands::{InterruptResponse, StopReason};
//! use strands_harness::{Effort, HarnessAgentOptions, create_harness};
//!
//! # fn ask_user(_: &strands::Interrupt) -> InterruptResponse { unimplemented!() }
//! # async fn run() -> strands::Result<()> {
//! let mut agent = create_harness(
//!     HarnessAgentOptions::builder()
//!         .model("anthropic/claude-opus-5")
//!         .effort(Effort::High)
//!         .interventions("ask")
//!         .mcp_servers("./mcp.json")
//!         .build(),
//! )
//! .await?;
//!
//! let mut result = agent.invoke("Fix the failing test in src/lib.rs").await?;
//! while result.stop_reason() == StopReason::Interrupt {
//!     let answers: Vec<InterruptResponse> = result.interrupts().iter().map(ask_user).collect();
//!     result = agent.invoke(answers).await?;
//! }
//! agent.shutdown().await?;
//! # Ok(())
//! # }
//! ```
//!
//! # Models
//!
//! `model` takes a model or router, or a string: `bedrock/<id>`, `bedrock-mantle/<id>`,
//! `anthropic/<id>`, `openai/<id>`, or a bare Bedrock model id. The default is
//! `bedrock/global.anthropic.claude-opus-5`. [`Effort`] maps to each provider's reasoning fields,
//! and prompt caching is on by default.
//!
//! # Features
//!
//! | Feature | Adds |
//! |---|---|
//! | `bedrock` (default) | `bedrock/` model strings and the default model |
//! | `anthropic` (default) | `anthropic/` model strings |
//! | `openai` (default) | `openai/` model strings |
//! | `mantle` (default) | `bedrock-mantle/` model strings; turns on `openai` |
//! | `mcp` (default) | `mcp_servers` |
//! | `cedar` (default) | `.cedar` interventions |
//! | `monty-pool` (default) | `programmatic_tool_caller` in a `monty` worker subprocess ([`Isolation`]) |
//! | `otel` | Span export selected by `OTEL_TRACES_EXPORTER` |
#![cfg_attr(docsrs, feature(doc_cfg))]

/// Compiles the README's code blocks as doctests.
#[cfg(doctest)]
#[doc = include_str!("../../README.md")]
struct ReadmeDoctests;

mod agent;
mod builtin_tools;
mod config;
mod defaults;
mod env;
mod factory;
mod interventions;
mod logging;
mod memory;
mod model_info;
mod models;
pub mod plugins;
mod prompt;
mod sandbox;
mod telemetry;
#[cfg(test)]
mod test_support;
pub mod tools;
mod types;

pub use agent::{
    HarnessAgentOptions, HarnessAgentOptionsBuilder, MemoryOption, SessionOption, SkillsOption, create_harness,
};
pub use config::{
    BUILTIN_PLUGIN_NAMES, BUILTIN_TOOL_NAMES, BuiltinPluginName, BuiltinToolName, DEFAULT_HARNESS_AGENT_CONFIG,
    HarnessAgentConfig, HarnessConfigBuiltinTools, HarnessConfigBuiltinToolsOption, HarnessConfigContextManager,
    HarnessConfigInterventions, HarnessConfigMcpServers, HarnessConfigMemory, HarnessConfigModel, HarnessConfigSkills,
    HarnessConfigWebFetch, HarnessDependencies, HarnessModuleKind, HarnessModuleLanguage, HarnessModuleReference,
    define_harness_agent_config, harness_agent_options_from_config,
};
pub use interventions::{InterventionValue, InterventionsOption};
pub use models::{supports_thinking, supports_web_search};
pub use plugins::{EnvironmentContext, EnvironmentContextConfig};
pub use prompt::{HARNESS_CONTRACT, build_system_prompt};
pub use strands::multiagent::{AgentSpec, ChildAgentBuilder, Choice, ChoiceOption, Fixed, Inherit, Open, Preset};
pub use strands::vended_tools::subagent::{MakeSubagentOptions, SubagentTool, make_subagent};
pub use tools::file_tools::{edit_tool, read_tool, write_tool};
pub use tools::programmatic_tool_caller::{
    DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION, Isolation, MakeProgrammaticToolCallerOptions, ProgrammaticToolCaller,
    ProgrammaticToolCallerConfig, make_programmatic_tool_caller, programmatic_tool_caller,
};
pub use tools::web_fetch::{WebFetchConfig, WebFetchTransport, web_fetch_tool};
pub use tools::web_search::WebSearchSetting;
#[cfg(feature = "mcp")]
pub use tools::web_search::web_search_tool;
pub use types::{
    BuiltinToolsConfig, BuiltinToolsOption, ContextManagerOption, Effort, McpServersOption, MemoryConfig, ReadConfig,
    SessionConfig, Setting, ShellConfig, SubagentConfig,
};
