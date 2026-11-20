//! Default configuration for the harness.

use crate::config::{BuiltinPluginName, BuiltinToolName};
use crate::types::Effort;

/// The model a harness agent runs on when `model` is unset.
pub(crate) const DEFAULT_MODEL: &str = "bedrock/global.anthropic.claude-opus-5";

/// The reasoning effort when `effort` is unset.
pub(crate) const DEFAULT_EFFORT: Effort = Effort::Auto;

/// The built-in tools enabled when `builtin_tools` is unset, in canonical order.
pub(crate) const DEFAULT_BUILTIN_TOOLS: [BuiltinToolName; 8] = [
    BuiltinToolName::Shell,
    BuiltinToolName::Read,
    BuiltinToolName::Write,
    BuiltinToolName::Edit,
    BuiltinToolName::WebFetch,
    BuiltinToolName::WebSearch,
    BuiltinToolName::ProgrammaticToolCaller,
    BuiltinToolName::Subagent,
];

/// The built-in plugins enabled when `builtin_plugins` is unset.
pub(crate) const DEFAULT_BUILTIN_PLUGINS: [BuiltinPluginName; 2] =
    [BuiltinPluginName::Todos, BuiltinPluginName::Environment];

/// The root directory of the default session store.
pub(crate) const DEFAULT_SESSION_DIR: &str = "./.agent/sessions";

/// The directory the default skills plugin scans when it exists.
pub(crate) const DEFAULT_SKILLS_DIR: &str = "./.agent/skills";

/// The directory the default memory store writes to.
pub(crate) const DEFAULT_MEMORY_DIR: &str = "./.agent/memory";
