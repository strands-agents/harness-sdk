//! Prompt-caching facts about Bedrock Converse models.

use super::model_info::{ModelCapabilities, ModelInfo, PromptCaching};

/// The Nova models Converse caches at cache points (measured on Converse). Nova Premier is
/// end-of-life and Nova 2 Pro is not in the Bedrock prompt-caching docs, so neither is listed.
/// Kept here rather than in the shared model info until the Python SDK places Nova cache points
/// too.
const NOVA_CACHE_POINT_MODELS: [&str; 4] = [
    "amazon.nova-pro-v1",
    "amazon.nova-lite-v1",
    "amazon.nova-micro-v1",
    "amazon.nova-2-lite-v1",
];

fn prompt_caching(caching: PromptCaching) -> ModelInfo {
    ModelInfo {
        capabilities: ModelCapabilities {
            prompt_caching: Some(caching),
            ..ModelCapabilities::default()
        },
        ..ModelInfo::default()
    }
}

/// Whether Converse limits where this model takes cache points. Nova takes a cache point only
/// directly after text: it rejects one after the tool definitions or directly after an image, PDF,
/// video, `toolResult` or `toolUse` block, and rejects any `ttl` (each a ValidationException,
/// measured on Converse).
pub(crate) fn bedrock_limits_cache_points(model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    NOVA_CACHE_POINT_MODELS.iter().any(|nova| id.contains(nova))
}

/// How Converse caches this model, where it differs from the shared model info. The shared info
/// lists cache points for the OpenAI models' own APIs, but Converse caches OpenAI GPT (not gpt-oss,
/// which it does not cache) and xAI implicitly, so they need no cache points. The shared info lists
/// no caching for Nova, which takes cache points.
pub(crate) fn bedrock_cache_model_info(model_id: &str) -> Option<ModelInfo> {
    let id = model_id.to_lowercase();
    if (id.contains("openai.") && !id.contains("gpt-oss")) || id.contains("xai.") {
        return Some(prompt_caching(PromptCaching::Auto));
    }
    bedrock_limits_cache_points(&id).then(|| prompt_caching(PromptCaching::CachePoints))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_id_to_prompt_caching() {
        let cases = [
            ("us.openai.gpt-5.6-luna", Some(PromptCaching::Auto)),
            ("us.openai.gpt-6-luna", Some(PromptCaching::Auto)),
            ("openai.gpt-6.1-sol", Some(PromptCaching::Auto)),
            ("us.openai.gpt-5.4", Some(PromptCaching::Auto)),
            ("us.xai.grok-4.7", Some(PromptCaching::Auto)),
            ("amazon.nova-pro-v1:0", Some(PromptCaching::CachePoints)),
            ("us.amazon.nova-lite-v1:0", Some(PromptCaching::CachePoints)),
            ("us.amazon.nova-micro-v1:0", Some(PromptCaching::CachePoints)),
            ("us.amazon.nova-2-lite-v1:0", Some(PromptCaching::CachePoints)),
            ("openai.gpt-oss-120b-1:0", None),
            ("us.openai.gpt-oss-20b-1:0", None),
            ("us.amazon.nova-premier-v1:0", None),
            ("us.amazon.nova-2-pro-preview-20251202-v1:0", None),
            ("global.anthropic.claude-sonnet-4-6", None),
            ("meta.llama4-maverick-17b-instruct-v1:0", None),
        ];
        for (model_id, expected) in cases {
            let caching = bedrock_cache_model_info(model_id).and_then(|info| info.capabilities.prompt_caching);
            assert_eq!(caching, expected, "{model_id}");
        }
    }

    #[test]
    fn model_id_to_limits_cache_points() {
        let cases = [
            ("amazon.nova-pro-v1:0", true),
            ("us.amazon.nova-pro-v1:0", true),
            ("us.amazon.nova-lite-v1:0", true),
            ("us.amazon.nova-micro-v1:0", true),
            ("us.amazon.nova-2-lite-v1:0", true),
            (
                "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0",
                true,
            ),
            ("us.amazon.nova-premier-v1:0", false),
            ("global.anthropic.claude-sonnet-4-6", false),
            ("us.openai.gpt-6-luna", false),
        ];
        for (model_id, expected) in cases {
            assert_eq!(bedrock_limits_cache_points(model_id), expected, "{model_id}");
        }
    }
}
