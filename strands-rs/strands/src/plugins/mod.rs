//! Plugins: the [`Plugin`] trait.

mod model_plugin;
mod plugin;
mod registry;

pub(crate) use model_plugin::ModelPlugin;
pub use plugin::Plugin;
pub(crate) use registry::PluginRegistry;
