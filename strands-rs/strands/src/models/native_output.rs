//! Structured output enforcement for model providers: mechanism order, learned support and native
//! output schemas.
//!
//! What a model rejects is learned from its errors and kept for the life of the process: support is
//! a property of the model, and a stale entry costs at most a weaker mechanism.

#![allow(dead_code, reason = "providers enforce structured output with these helpers")]

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

use super::model_info::ModelInfo;
use super::strict_schema::child_schemas;
use crate::error::{Error, Result};
use crate::logging::warn_once;
use crate::types::{JsonObject, JsonSchema, JsonValue, ToolChoice};

/// Ways a provider can enforce a structured output request, strongest first
/// (`StructuredOutputMechanism`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum StructuredOutputMechanism {
    /// Force a call to the structured output tool.
    Forced,
    /// Constrain the text output to the schema.
    Native,
    /// Offer the tool and let the model choose.
    Auto,
}

impl StructuredOutputMechanism {
    fn as_str(self) -> &'static str {
        match self {
            Self::Forced => "forced",
            Self::Native => "native",
            Self::Auto => "auto",
        }
    }
}

const STRUCTURED_OUTPUT_MECHANISMS: [StructuredOutputMechanism; 3] = [
    StructuredOutputMechanism::Forced,
    StructuredOutputMechanism::Native,
    StructuredOutputMechanism::Auto,
];

/// String formats native structured output accepts; others move into the field description.
const SUPPORTED_STRING_FORMATS: [&str; 10] = [
    "date-time",
    "time",
    "date",
    "duration",
    "email",
    "hostname",
    "uri",
    "ipv4",
    "ipv6",
    "uuid",
];

/// A schema node needs one of these to be representable; without them it accepts any value.
const SCHEMA_TYPE_KEYS: [&str; 5] = ["type", "anyOf", "oneOf", "allOf", "$ref"];

// Providers report these cases only as a generic 400, so the message text is the only signal.
// "Documented" entries are published provider error text; "observed" entries were seen in live
// responses and may change wording.

/// Error substrings meaning the model cannot be forced to call a tool.
pub(crate) const FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES: [&str; 2] = [
    // documented: Anthropic API errors, forced tool use
    "tool_choice: type \"tool\" and \"any\" are not supported",
    // observed: Bedrock models without tool choice support
    "doesn't support the toolConfig.toolChoice",
];

/// Error substrings meaning the model has no native structured output.
pub(crate) const NATIVE_OUTPUT_UNSUPPORTED_MESSAGES: [&str; 2] = [
    // observed: Bedrock models without structured output
    "doesn't support the outputConfig field",
    // observed: Claude models without structured output
    "output_config.format: Extra inputs are not permitted",
];

/// Error substrings meaning native structured output cannot express the schema or request.
pub(crate) const NATIVE_OUTPUT_REJECTED_MESSAGES: [&str; 4] = [
    // observed: unsupported JSON Schema keyword
    "output_config.format.schema",
    // observed: optional or union parameter limit
    "Schemas contains too many",
    // documented: Anthropic structured outputs, schema complexity limits
    "Schema is too complex",
    // observed: citations with native output
    "Citations cannot be enabled when output format is set",
];

/// Mechanisms each model was learned to reject, keyed by provider and model id.
static UNSUPPORTED_MECHANISMS: LazyLock<Mutex<HashMap<String, HashSet<StructuredOutputMechanism>>>> =
    LazyLock::new(Mutex::default);

/// Output schemas a model's native output rejected, keyed by provider and model id. Schemas are
/// keyed by their JSON text, since Rust has no object identity to key them by.
static REJECTED_NATIVE_SCHEMAS: LazyLock<Mutex<HashMap<String, HashSet<String>>>> = LazyLock::new(Mutex::default);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn model_key(provider: &str, model_id: &str) -> String {
    format!("{provider}:{model_id}")
}

fn schema_key(schema: &JsonSchema) -> String {
    schema.to_string()
}

fn unsupported_mechanisms(provider: &str, model_id: &str, schema: &JsonSchema) -> HashSet<StructuredOutputMechanism> {
    let key = model_key(provider, model_id);
    let mut unsupported = lock(&UNSUPPORTED_MECHANISMS).get(&key).cloned().unwrap_or_default();
    let rejected = lock(&REJECTED_NATIVE_SCHEMAS)
        .get(&key)
        .is_some_and(|schemas| schemas.contains(&schema_key(schema)));
    if rejected {
        unsupported.insert(StructuredOutputMechanism::Native);
    }
    unsupported
}

/// The mechanisms to try for a structured output request, strongest first, skipping those the
/// model was learned to reject.
///
/// Native output is skipped for schemas it cannot represent, such as record and tuple fields, so
/// those fall back to auto. The list is never empty: auto is always available.
pub(crate) fn structured_output_mechanisms(
    provider: &str,
    model_id: &str,
    tool_choice: Option<&ToolChoice>,
    schema: &JsonSchema,
    model_info: &ModelInfo,
) -> Vec<StructuredOutputMechanism> {
    let mut unsupported = unsupported_mechanisms(provider, model_id, schema);
    if model_info.capabilities.forced_tool_choice == Some(false) {
        unsupported.insert(StructuredOutputMechanism::Forced);
    }
    if model_info.capabilities.native_structured_output == Some(false) {
        unsupported.insert(StructuredOutputMechanism::Native);
    }
    let forces_tool = matches!(tool_choice, Some(ToolChoice::Any | ToolChoice::Tool { .. }));
    let feature = if unsupported.contains(&StructuredOutputMechanism::Native) {
        None
    } else {
        find_unsupported_native_output_feature(schema)
    };
    if let Some(feature) = feature {
        warn_once(&unrepresentable_schema_warning(feature));
    }
    STRUCTURED_OUTPUT_MECHANISMS
        .into_iter()
        .filter(|mechanism| !unsupported.contains(mechanism))
        .filter(|mechanism| *mechanism != StructuredOutputMechanism::Forced || forces_tool)
        .filter(|mechanism| *mechanism != StructuredOutputMechanism::Native || feature.is_none())
        .collect()
}

fn unrepresentable_schema_warning(feature: &str) -> String {
    format!(
        "feature=<{feature}> | native structured output cannot represent the schema, if the model cannot be forced to call the structured output tool structured output falls back to auto tool choice"
    )
}

/// Handles a provider error for a structured output request.
///
/// A rejection the model gives for every request is remembered per model; native output rejecting
/// this schema or request is remembered for that schema only. Returns `true` when the rejection
/// was recorded and the next mechanism should be tried, `false` when the error is unrelated and
/// should surface unchanged.
pub(crate) fn handle_rejected_mechanism(
    provider: &str,
    model_id: &str,
    mechanism: StructuredOutputMechanism,
    schema: &JsonSchema,
    message: &str,
) -> bool {
    let key = model_key(provider, model_id);
    let schema_rejected = NATIVE_OUTPUT_REJECTED_MESSAGES
        .iter()
        .any(|signal| message.contains(signal));
    if mechanism == StructuredOutputMechanism::Native && schema_rejected {
        lock(&REJECTED_NATIVE_SCHEMAS)
            .entry(key)
            .or_default()
            .insert(schema_key(schema));
        tracing::warn!(
            "provider=<{provider}>, model_id=<{model_id}>, error=<{message}> | native structured output rejected the schema, using auto tool choice instead"
        );
        return true;
    }
    if !is_unsupported_mechanism_message(message, mechanism) {
        return false;
    }
    lock(&UNSUPPORTED_MECHANISMS).entry(key).or_default().insert(mechanism);
    tracing::debug!(
        "provider=<{provider}>, model_id=<{model_id}>, mechanism=<{}> | model rejects structured output mechanism",
        mechanism.as_str()
    );
    true
}

/// Clears the structured output support learned from model errors.
pub(crate) fn clear_structured_output_support() {
    lock(&UNSUPPORTED_MECHANISMS).clear();
    lock(&REJECTED_NATIVE_SCHEMAS).clear();
}

fn is_unsupported_mechanism_message(message: &str, mechanism: StructuredOutputMechanism) -> bool {
    let signals: &[&str] = match mechanism {
        StructuredOutputMechanism::Forced => &FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES,
        StructuredOutputMechanism::Native => &NATIVE_OUTPUT_UNSUPPORTED_MESSAGES,
        StructuredOutputMechanism::Auto => &[],
    };
    signals.iter().any(|signal| message.contains(signal))
}

/// Finds a schema feature native structured output cannot represent without losing data.
///
/// Native output requires `additionalProperties: false` on every object, has no tuples, and needs
/// a type on every node, so record, tuple and untyped fields cannot use it.
pub(crate) fn find_unsupported_native_output_feature(schema: &JsonSchema) -> Option<&'static str> {
    find_unsupported_feature(schema.as_object()?)
}

fn find_unsupported_feature(schema: &JsonObject) -> Option<&'static str> {
    if schema.contains_key("prefixItems") {
        return Some("tuple fields");
    }
    let open = schema
        .get("additionalProperties")
        .is_some_and(|value| *value != JsonValue::Bool(false));
    if open || schema.contains_key("patternProperties") {
        return Some("record fields");
    }
    if !SCHEMA_TYPE_KEYS.iter().any(|key| schema.contains_key(*key)) {
        return Some("untyped fields");
    }
    child_schemas(schema).into_iter().find_map(find_unsupported_feature)
}

/// Converts a JSON schema to the subset native structured output accepts.
///
/// Follows the Anthropic SDK's schema transform, for every provider: objects get
/// `additionalProperties: false`, and keywords outside the supported subset move into the field
/// description, where the model can still follow them. Validate the result against the original
/// schema, which still enforces every constraint.
///
/// # Errors
///
/// Returns an error when a schema node has no `type`, `anyOf`, `oneOf`, `allOf` or `$ref`.
pub(crate) fn to_native_output_schema(schema: &JsonSchema) -> Result<JsonSchema> {
    convert_value(schema).map(JsonValue::Object)
}

fn convert_value(schema: &JsonValue) -> Result<JsonObject> {
    let node = schema.as_object().cloned().unwrap_or_default();
    convert_node(node)
}

fn convert_all(values: &[JsonValue]) -> Result<JsonValue> {
    let converted = values
        .iter()
        .map(|value| convert_value(value).map(JsonValue::Object))
        .collect::<Result<Vec<_>>>()?;
    Ok(JsonValue::Array(converted))
}

fn convert_map(map: &JsonObject) -> Result<JsonValue> {
    let mut converted = JsonObject::new();
    for (name, value) in map {
        converted.insert(name.clone(), JsonValue::Object(convert_value(value)?));
    }
    Ok(JsonValue::Object(converted))
}

/// Removes a key from a schema node, keeping the order of the rest, and returns its value.
fn take(schema: &mut JsonObject, key: &str) -> Option<JsonValue> {
    schema.shift_remove(key)
}

fn convert_node(mut remaining: JsonObject) -> Result<JsonObject> {
    let mut converted = JsonObject::new();

    if let Some(JsonValue::Object(defs)) = take(&mut remaining, "$defs") {
        converted.insert("$defs".to_owned(), convert_map(&defs)?);
    }
    if let Some(reference) = take(&mut remaining, "$ref") {
        converted.insert("$ref".to_owned(), reference);
        return Ok(converted);
    }

    let kind = take(&mut remaining, "type");
    convert_composition(&mut remaining, &mut converted, kind.clone())?;

    for key in ["enum", "description", "title"] {
        if let Some(value) = take(&mut remaining, key) {
            converted.insert(key.to_owned(), value);
        }
    }

    match kind.as_ref().and_then(JsonValue::as_str) {
        Some("object") => convert_object(&mut remaining, &mut converted)?,
        Some("string") => convert_string(&mut remaining, &mut converted),
        Some("array") => convert_array(&mut remaining, &mut converted)?,
        _ => {}
    }

    if !remaining.is_empty() {
        let unsupported = remaining
            .iter()
            .map(|(key, value)| format!("{key}: {value}"))
            .collect::<Vec<_>>()
            .join(", ");
        let unsupported = format!("{{{unsupported}}}");
        let description = match converted.get("description") {
            Some(description) => {
                let description = description
                    .as_str()
                    .map_or_else(|| description.to_string(), str::to_owned);
                format!("{description}\n\n{unsupported}")
            }
            None => unsupported,
        };
        converted.insert("description".to_owned(), JsonValue::String(description));
    }

    Ok(converted)
}

fn convert_composition(remaining: &mut JsonObject, converted: &mut JsonObject, kind: Option<JsonValue>) -> Result<()> {
    let any_of = take(remaining, "anyOf");
    let one_of = take(remaining, "oneOf");
    let all_of = take(remaining, "allOf");

    if let Some(JsonValue::Array(variants)) = any_of {
        converted.insert("anyOf".to_owned(), convert_all(&variants)?);
    } else if let Some(JsonValue::Array(variants)) = one_of {
        converted.insert("anyOf".to_owned(), convert_all(&variants)?);
    } else if let Some(JsonValue::Array(variants)) = all_of {
        converted.insert("allOf".to_owned(), convert_all(&variants)?);
    } else if let Some(kind) = kind {
        converted.insert("type".to_owned(), kind);
    } else {
        return Err(Error::other(
            "Schema must have a 'type', 'anyOf', 'oneOf', or 'allOf' field.",
        ));
    }
    Ok(())
}

fn convert_object(remaining: &mut JsonObject, converted: &mut JsonObject) -> Result<()> {
    let properties = match take(remaining, "properties") {
        Some(JsonValue::Object(properties)) => convert_map(&properties)?,
        _ => JsonValue::Object(JsonObject::new()),
    };
    converted.insert("properties".to_owned(), properties);
    take(remaining, "additionalProperties");
    converted.insert("additionalProperties".to_owned(), JsonValue::Bool(false));
    if let Some(required) = take(remaining, "required") {
        converted.insert("required".to_owned(), required);
    }
    Ok(())
}

fn convert_string(remaining: &mut JsonObject, converted: &mut JsonObject) {
    let Some(format) = take(remaining, "format") else {
        return;
    };
    let supported = format
        .as_str()
        .is_some_and(|format| SUPPORTED_STRING_FORMATS.contains(&format));
    let target = if supported { converted } else { remaining };
    target.insert("format".to_owned(), format);
}

fn convert_array(remaining: &mut JsonObject, converted: &mut JsonObject) -> Result<()> {
    match take(remaining, "items") {
        Some(items @ JsonValue::Object(_)) => {
            converted.insert("items".to_owned(), JsonValue::Object(convert_value(&items)?));
        }
        Some(items) => {
            remaining.insert("items".to_owned(), items);
        }
        None => {}
    }
    if let Some(min_items) = take(remaining, "minItems") {
        let representable = min_items.as_f64().is_some_and(|min| min == 0.0 || min == 1.0);
        let target = if representable { converted } else { remaining };
        target.insert("minItems".to_owned(), min_items);
    }
    Ok(())
}

/// The output schemas are recorded in `testdata/native_output_schemas.json`. Tests run in parallel
/// against the process-wide learned support, so each uses its own provider name instead of clearing it.
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::StructuredOutputMechanism::{Auto, Forced, Native};
    use super::*;
    use crate::models::model_info::ModelCapabilities;

    static FIXTURES: LazyLock<JsonValue> =
        LazyLock::new(|| serde_json::from_str(include_str!("testdata/native_output_schemas.json")).unwrap());

    fn schema(name: &str) -> JsonSchema {
        FIXTURES[name]["schema"].clone()
    }

    fn forced() -> Option<ToolChoice> {
        Some(ToolChoice::tool("strands_structured_output"))
    }

    fn mechanisms(provider: &str, model: &str, name: &str) -> Vec<StructuredOutputMechanism> {
        structured_output_mechanisms(provider, model, forced().as_ref(), &schema(name), &ModelInfo::default())
    }

    fn capabilities(forced_tool_choice: Option<bool>, native_structured_output: Option<bool>) -> ModelInfo {
        ModelInfo {
            capabilities: ModelCapabilities {
                forced_tool_choice,
                native_structured_output,
                ..ModelCapabilities::default()
            },
            ..ModelInfo::default()
        }
    }

    #[test]
    fn lists_the_mechanisms_strongest_first_for_each_tool_choice() {
        let cases = [
            (forced(), vec![Forced, Native, Auto]),
            (Some(ToolChoice::Any), vec![Forced, Native, Auto]),
            (Some(ToolChoice::Auto), vec![Native, Auto]),
            (None, vec![Native, Auto]),
        ];
        for (tool_choice, expected) in cases {
            let actual = structured_output_mechanisms(
                "p-order",
                "m",
                tool_choice.as_ref(),
                &schema("Person"),
                &ModelInfo::default(),
            );
            assert_eq!(actual, expected, "{tool_choice:?}");
        }
    }

    #[test]
    fn skips_mechanisms_the_model_info_says_are_unsupported_without_a_request() {
        let person = schema("Person");
        let run = |info: ModelInfo| structured_output_mechanisms("p-info", "m", forced().as_ref(), &person, &info);
        assert_eq!(run(capabilities(Some(false), None)), [Native, Auto]);
        assert_eq!(run(capabilities(None, Some(false))), [Forced, Auto]);
        assert_eq!(run(capabilities(Some(true), Some(true))), [Forced, Native, Auto]);
    }

    #[test]
    fn skips_mechanisms_the_model_was_learned_to_reject() {
        let person = schema("Person");
        handle_rejected_mechanism(
            "p-learned",
            "m",
            Forced,
            &person,
            FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES[0],
        );
        assert_eq!(mechanisms("p-learned", "m", "Person"), [Native, Auto]);
        handle_rejected_mechanism("p-learned", "m", Native, &person, NATIVE_OUTPUT_UNSUPPORTED_MESSAGES[0]);
        assert_eq!(mechanisms("p-learned", "m", "Person"), [Auto]);
    }

    #[test]
    fn skips_native_output_and_warns_for_a_schema_it_cannot_represent() {
        crate::logging::forget_warning(&unrepresentable_schema_warning("record fields"));
        let (actual, logs) = crate::test_support::capture_logs(|| mechanisms("p-record", "m", "WithRecord"));
        assert_eq!(actual, [Forced, Auto]);
        assert!(logs.contains("feature=<record fields>"), "{logs}");
    }

    #[test]
    fn does_not_inspect_the_schema_when_native_output_is_known_unsupported() {
        let tuple = schema("WithTuple");
        handle_rejected_mechanism("p-tuple", "m", Native, &tuple, NATIVE_OUTPUT_UNSUPPORTED_MESSAGES[0]);
        crate::logging::forget_warning(&unrepresentable_schema_warning("tuple fields"));
        let (actual, logs) = crate::test_support::capture_logs(|| mechanisms("p-tuple", "m", "WithTuple"));
        assert_eq!(actual, [Forced, Auto]);
        assert!(!logs.contains("WARN"), "{logs}");
    }

    #[test]
    fn remembers_that_the_model_rejects_a_mechanism_for_every_schema() {
        let cases = FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES
            .iter()
            .map(|signal| (Forced, *signal))
            .chain(
                NATIVE_OUTPUT_UNSUPPORTED_MESSAGES
                    .iter()
                    .map(|signal| (Native, *signal)),
            );
        for (index, (mechanism, signal)) in cases.enumerate() {
            let provider = format!("p-every-{index}");
            let message = format!("ValidationException: {signal}.");
            assert!(handle_rejected_mechanism(
                &provider,
                "m",
                mechanism,
                &schema("Person"),
                &message
            ));
            assert!(!mechanisms(&provider, "m", "Team").contains(&mechanism), "{signal}");
            assert!(
                mechanisms(&provider, "other-model", "Person").contains(&mechanism),
                "{signal}"
            );
            assert!(
                mechanisms("other-provider", "m", "Person").contains(&mechanism),
                "{signal}"
            );
        }
    }

    #[test]
    fn remembers_a_rejected_native_schema_for_that_schema_only() {
        for (index, signal) in NATIVE_OUTPUT_REJECTED_MESSAGES.iter().enumerate() {
            let provider = format!("p-schema-{index}");
            let message = format!("invalid_request_error: {signal}");
            let (recorded, logs) = crate::test_support::capture_logs(|| {
                handle_rejected_mechanism(&provider, "m", Native, &schema("Person"), &message)
            });
            assert!(recorded);
            assert!(logs.contains("native structured output rejected the schema"), "{logs}");
            assert_eq!(mechanisms(&provider, "m", "Person"), [Forced, Auto]);
            assert_eq!(mechanisms(&provider, "m", "Team"), [Forced, Native, Auto]);
        }
    }

    #[test]
    fn ignores_an_unrelated_error() {
        let cases = [
            (Forced, "Input is too long for requested model"),
            (Forced, NATIVE_OUTPUT_REJECTED_MESSAGES[0]),
            (Native, FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES[0]),
            (Auto, FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES[0]),
        ];
        for (mechanism, message) in cases {
            assert!(!handle_rejected_mechanism(
                "p-unrelated",
                "m",
                mechanism,
                &schema("Person"),
                message
            ));
            assert_eq!(mechanisms("p-unrelated", "m", "Person"), [Forced, Native, Auto]);
        }
    }

    #[test]
    fn returns_the_unsupported_feature_for_each_schema() {
        let cases = [
            ("Person", None),
            ("Team", None),
            ("WithRecord", Some("record fields")),
            ("WithNestedRecord", Some("record fields")),
            ("WithCatchall", Some("record fields")),
            ("WithTuple", Some("tuple fields")),
            ("WithAny", Some("untyped fields")),
            ("WithMixedLiteral", Some("untyped fields")),
        ];
        for (name, expected) in cases {
            assert_eq!(
                find_unsupported_native_output_feature(&schema(name)),
                expected,
                "{name}"
            );
        }
        let pattern = json!({"type": "object", "patternProperties": {"^a": {"type": "string"}}});
        assert_eq!(find_unsupported_native_output_feature(&pattern), Some("record fields"));
    }

    #[test]
    fn matches_the_anthropic_sdk_transform() {
        for name in ["Person", "Roster", "WithNestedRecord"] {
            let converted = to_native_output_schema(&schema(name)).unwrap();
            let expected = &FIXTURES[name]["anthropic"];
            assert_eq!(converted, *expected, "{name}");
            assert_eq!(converted.to_string(), expected.to_string(), "key order of {name}");
        }
    }

    #[test]
    fn keeps_enums_which_native_output_supports() {
        assert_eq!(
            to_native_output_schema(&schema("Color")).unwrap(),
            json!({
                "type": "object",
                "properties": {"color": {"type": "string", "enum": ["red", "blue"]}},
                "additionalProperties": false,
                "required": ["color"],
            })
        );
    }

    #[test]
    fn keeps_defs_alongside_a_ref_and_moves_unsupported_array_keywords_into_the_description() {
        let schema =
            json!({"$defs": {"Item": {"type": "array", "items": false, "minItems": 3}}, "$ref": "#/$defs/Item"});
        assert_eq!(
            to_native_output_schema(&schema).unwrap(),
            json!({
                "$defs": {"Item": {"type": "array", "description": "{items: false, minItems: 3}"}},
                "$ref": "#/$defs/Item",
            })
        );
    }

    #[test]
    fn converts_one_of_to_any_of_keeps_all_of_and_moves_unsupported_formats_and_item_bounds_into_the_description() {
        let schema = json!({
            "type": "object",
            "properties": {
                "choice": {"oneOf": [{"type": "string", "format": "phone"}, {"type": "integer"}]},
                "merged": {"allOf": [{"type": "object", "properties": {"a": {"type": "string"}}}]},
                "tags": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            },
        });
        assert_eq!(
            to_native_output_schema(&schema).unwrap(),
            json!({
                "type": "object",
                "properties": {
                    "choice": {"anyOf": [{"type": "string", "description": "{format: \"phone\"}"}, {"type": "integer"}]},
                    "merged": {
                        "allOf": [{"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": false}],
                    },
                    "tags": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                },
                "additionalProperties": false,
            })
        );
    }

    #[test]
    fn does_not_mutate_the_input_schema() {
        let team = schema("Team");
        let copy = team.clone();
        to_native_output_schema(&team).unwrap();
        assert_eq!(team, copy);
    }

    #[test]
    fn throws_for_an_untyped_node() {
        let error = to_native_output_schema(&schema("WithAny")).unwrap_err();
        assert!(error.to_string().starts_with("Schema must have a 'type'"), "{error}");
    }
}
