//! Harness-authored plugins.
//!
//! [`EnvironmentContext`] surfaces the working environment and project docs before each user turn.

mod environment;

pub use environment::{EnvironmentContext, EnvironmentContextConfig};
