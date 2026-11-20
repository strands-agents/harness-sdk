//! The default model an agent gets without one (a Bedrock model with default settings), resolved
//! when first called so that building an agent stays synchronous.

use std::sync::{PoisonError, RwLock};

use crate::error::{DefaultNotConfiguredError, Error};
use crate::models::streaming::ModelStreamEvent;
use crate::models::{BaseModelConfig, BoxStream, Model, ModelRequest};

const NO_DEFAULT_MODEL: &str =
    "No model configured. Pass a `model` to the Agent: the default Bedrock model is not available in this build.";

/// Stands in for the default Bedrock model until it is available; calling it fails with
/// [`DefaultNotConfiguredError`].
pub(crate) struct DefaultModelSlot {
    config: RwLock<BaseModelConfig>,
}

impl DefaultModelSlot {
    pub(crate) fn new(model_id: Option<String>) -> Self {
        Self {
            config: RwLock::new(BaseModelConfig {
                model_id,
                ..BaseModelConfig::default()
            }),
        }
    }
}

#[async_trait::async_trait]
impl Model for DefaultModelSlot {
    fn stream(&self, _request: ModelRequest) -> BoxStream<'static, crate::Result<ModelStreamEvent>> {
        let error = Error::from(DefaultNotConfiguredError::new(NO_DEFAULT_MODEL));
        Box::pin(futures::stream::iter([Err(error)]))
    }

    fn get_config(&self) -> BaseModelConfig {
        self.config.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn update_config(&self, config: BaseModelConfig) -> crate::Result<()> {
        self.config
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .merge(config);
        Ok(())
    }
}
