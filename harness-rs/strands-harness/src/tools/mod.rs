//! Harness-authored tools.
//!
//! Thin tools that fill gaps in the SDK's vended set: the harness `read`, `write` and `edit`
//! ([`file_tools`]), [`web_fetch`], the Exa-backed [`web_search`], the Monty-backed
//! [`programmatic_tool_caller`] and the preset-driven [`subagent`]. `shell` is the SDK's sandbox
//! shell ([`file_tools::shell_tool`]).

pub mod file_tools;
pub mod programmatic_tool_caller;
pub mod subagent;
pub mod web_fetch;
pub mod web_search;

#[cfg(test)]
mod conformance_tests;
