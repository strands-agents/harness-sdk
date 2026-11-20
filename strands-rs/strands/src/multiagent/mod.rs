//! Multi-agent building blocks. For now the authority-mode policies of the agent spec that the
//! [`subagent`](crate::vended_tools::subagent) tool uses; Graph and Swarm come in a later release.

pub(crate) mod spec;

pub use spec::{AgentSpec, Axis, ChildAgentBuilder, Choice, ChoiceOption, Fixed, Inherit, Open, Preset, SpecValue};
