//! Tool input schemas: schemars output normalized for model providers, and input validation.
//!
//! [`schema_for`] generates the schema of a type and [`normalize_schema`] cleans up any schemars
//! output the same way:
//!
//! - subschemas are inlined, except for recursive types, which stay under `$defs`;
//! - `$schema` and every `title` keyword are dropped;
//! - `format` values that are not JSON Schema formats (`uint32`, `double`, ...) are dropped;
//! - property order is kept, and doc comments are the `description`s schemars wrote.

use std::collections::{HashMap, HashSet};

use schemars::JsonSchema as SchemarsJsonSchema;

use crate::error::{Error, Result, ToolValidationError};
use crate::types::{JsonObject, JsonSchema, JsonValue};

const JSON_SCHEMA_FORMATS: [&str; 19] = [
    "date-time",
    "date",
    "time",
    "duration",
    "email",
    "idn-email",
    "hostname",
    "idn-hostname",
    "ipv4",
    "ipv6",
    "uri",
    "uri-reference",
    "iri",
    "iri-reference",
    "uuid",
    "uri-template",
    "json-pointer",
    "relative-json-pointer",
    "regex",
];

const SINGLE_SUBSCHEMA_KEYS: [&str; 10] = [
    "items",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
];

const SUBSCHEMA_LIST_KEYS: [&str; 4] = ["prefixItems", "allOf", "anyOf", "oneOf"];

const SUBSCHEMA_MAP_KEYS: [&str; 3] = ["properties", "patternProperties", "dependentSchemas"];

const DEFS_KEYS: [&str; 2] = ["$defs", "definitions"];

/// The normalized input schema of `T`, generated with schemars.
///
/// `T` derives `schemars::JsonSchema`, so the crate that defines it depends on `schemars = "1"`,
/// the major version strands uses (a type deriving another major's trait does not satisfy the
/// bound). Typed structured output schemas and `#[tool]` parameter types of your own follow the
/// same rule.
///
/// ```
/// #[derive(schemars::JsonSchema)]
/// struct Input {
///     /// City name.
///     city: String,
///     days: u32,
/// }
///
/// let schema = strands::tools::schema_for::<Input>();
/// assert_eq!(
///     serde_json::to_string(&schema)?,
///     serde_json::to_string(&serde_json::json!({
///         "type": "object",
///         "properties": {
///             "city": {"type": "string", "description": "City name."},
///             "days": {"type": "integer", "minimum": 0}
///         },
///         "required": ["city", "days"]
///     }))?
/// );
/// # Ok::<(), serde_json::Error>(())
/// ```
#[must_use]
pub fn schema_for<T: SchemarsJsonSchema>() -> JsonSchema {
    normalize_schema(schemars::schema_for!(T).to_value())
}

/// Normalizes a schemars schema for model providers.
///
/// - Subschemas are inlined, except for recursive types, which stay under `$defs`.
/// - `$schema` and every `title` keyword are dropped.
/// - `format` values that are not JSON Schema formats (`uint32`, `double`, ...) are dropped.
/// - Property order is kept, and so are the `description`s schemars wrote from doc comments.
#[must_use]
pub fn normalize_schema(mut schema: JsonSchema) -> JsonSchema {
    let defs = take_defs(&mut schema);
    let recursive = recursive_defs(&defs);
    let mut kept = JsonObject::new();
    for (name, def) in &defs {
        if recursive.contains(name.as_str()) {
            let mut def = def.clone();
            inline_refs(&mut def, &defs, &recursive, &mut Vec::new());
            clean(&mut def);
            kept.insert(name.clone(), def);
        }
    }
    inline_refs(&mut schema, &defs, &recursive, &mut Vec::new());
    clean(&mut schema);
    if let JsonValue::Object(root) = &mut schema {
        root.remove("$schema");
        if !kept.is_empty() {
            root.insert("$defs".to_owned(), JsonValue::Object(kept));
        }
    }
    schema
}

fn take_defs(schema: &mut JsonSchema) -> HashMap<String, JsonValue> {
    let JsonValue::Object(root) = schema else {
        return HashMap::new();
    };
    DEFS_KEYS
        .iter()
        .filter_map(|key| root.remove(*key))
        .filter_map(|defs| match defs {
            JsonValue::Object(defs) => Some(defs),
            _ => None,
        })
        .flatten()
        .collect()
}

fn def_name(reference: &str) -> Option<&str> {
    reference
        .strip_prefix("#/$defs/")
        .or_else(|| reference.strip_prefix("#/definitions/"))
}

fn collect_refs<'a>(schema: &'a JsonValue, refs: &mut Vec<&'a str>) {
    match schema {
        JsonValue::Object(map) => {
            if let Some(name) = map.get("$ref").and_then(JsonValue::as_str).and_then(def_name) {
                refs.push(name);
            }
            map.values().for_each(|value| collect_refs(value, refs));
        }
        JsonValue::Array(items) => items.iter().for_each(|item| collect_refs(item, refs)),
        _ => {}
    }
}

fn recursive_defs(defs: &HashMap<String, JsonValue>) -> HashSet<String> {
    let edges: HashMap<&str, Vec<&str>> = defs
        .iter()
        .map(|(name, def)| {
            let mut refs = Vec::new();
            collect_refs(def, &mut refs);
            (name.as_str(), refs)
        })
        .collect();
    defs.keys()
        .filter(|name| reaches(&edges, name, name))
        .cloned()
        .collect()
}

fn reaches(edges: &HashMap<&str, Vec<&str>>, from: &str, target: &str) -> bool {
    let mut stack: Vec<&str> = edges.get(from).cloned().unwrap_or_default();
    let mut seen = HashSet::new();
    while let Some(next) = stack.pop() {
        if next == target {
            return true;
        }
        if seen.insert(next) {
            stack.extend(edges.get(next).into_iter().flatten().copied());
        }
    }
    false
}

fn inline_refs(
    schema: &mut JsonValue,
    defs: &HashMap<String, JsonValue>,
    recursive: &HashSet<String>,
    stack: &mut Vec<String>,
) {
    match schema {
        JsonValue::Object(map) => {
            let target = map
                .get("$ref")
                .and_then(JsonValue::as_str)
                .and_then(def_name)
                .filter(|name| !recursive.contains(*name) && !stack.iter().any(|seen| seen == name))
                .map(str::to_owned);
            if let Some(name) = target
                && let Some(JsonValue::Object(def)) = defs.get(&name)
            {
                map.remove("$ref");
                let siblings = std::mem::take(map);
                map.extend(def.clone());
                map.extend(siblings);
                stack.push(name);
                map.values_mut()
                    .for_each(|value| inline_refs(value, defs, recursive, stack));
                stack.pop();
                return;
            }
            map.values_mut()
                .for_each(|value| inline_refs(value, defs, recursive, stack));
        }
        JsonValue::Array(items) => items
            .iter_mut()
            .for_each(|item| inline_refs(item, defs, recursive, stack)),
        _ => {}
    }
}

/// Drops `title` and unknown `format`s from a schema and every subschema.
fn clean(schema: &mut JsonValue) {
    let JsonValue::Object(map) = schema else {
        return;
    };
    map.remove("title");
    let unknown_format = map
        .get("format")
        .and_then(JsonValue::as_str)
        .is_some_and(|format| !JSON_SCHEMA_FORMATS.contains(&format));
    if unknown_format {
        map.remove("format");
    }
    for key in SINGLE_SUBSCHEMA_KEYS {
        match map.get_mut(key) {
            Some(JsonValue::Array(items)) => items.iter_mut().for_each(clean),
            Some(subschema) => clean(subschema),
            None => {}
        }
    }
    for key in SUBSCHEMA_LIST_KEYS {
        if let Some(JsonValue::Array(items)) = map.get_mut(key) {
            items.iter_mut().for_each(clean);
        }
    }
    for key in SUBSCHEMA_MAP_KEYS.iter().chain(&DEFS_KEYS) {
        if let Some(JsonValue::Object(entries)) = map.get_mut(*key) {
            entries.values_mut().for_each(clean);
        }
    }
}

/// Validates tool input against a JSON Schema.
#[derive(Debug)]
pub struct SchemaValidator {
    validator: jsonschema::Validator,
}

impl SchemaValidator {
    /// Compiles `schema`.
    ///
    /// # Errors
    ///
    /// [`Error::Other`] when `schema` is not a valid JSON Schema.
    pub fn new(schema: &JsonSchema) -> Result<Self> {
        let validator = jsonschema::validator_for(schema)
            .map_err(|error| Error::other(format!("invalid input schema: {error}")))?;
        Ok(Self { validator })
    }

    /// Validates `input`.
    ///
    /// # Errors
    ///
    /// A [`ToolValidationError`] listing every violation, one per line, each prefixed with the
    /// JSON pointer of the offending value, for example
    /// `Validation failed:\n- /age: "thirty" is not of type "number"`.
    pub fn validate(&self, input: &JsonValue) -> Result<(), ToolValidationError> {
        let issues: Vec<String> = self
            .validator
            .iter_errors(input)
            .map(|error| {
                let path = error.instance_path().as_str();
                if path.is_empty() {
                    format!("- {error}")
                } else {
                    format!("- {path}: {error}")
                }
            })
            .collect();
        if issues.is_empty() {
            return Ok(());
        }
        Err(ToolValidationError::new(format!(
            "Validation failed:\n{}",
            issues.join("\n")
        )))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A point.
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code, reason = "schema-only type")]
    struct Point {
        /// Horizontal.
        x: f64,
        y: i32,
    }

    #[derive(schemars::JsonSchema)]
    #[allow(dead_code, reason = "schema-only type")]
    struct Shape {
        /// The origin.
        origin: Point,
        corners: Vec<Point>,
        label: Option<String>,
        when: Option<String>,
    }

    #[derive(schemars::JsonSchema)]
    #[allow(dead_code, reason = "schema-only type")]
    struct Tree {
        name: String,
        children: Vec<Tree>,
    }

    #[test]
    fn inlines_subschemas_and_drops_titles_and_non_standard_formats() {
        assert_eq!(
            schema_for::<Shape>(),
            json!({
                "type": "object",
                "properties": {
                    "origin": {
                        "description": "The origin.",
                        "type": "object",
                        "properties": {
                            "x": {"description": "Horizontal.", "type": "number"},
                            "y": {"type": "integer"}
                        },
                        "required": ["x", "y"]
                    },
                    "corners": {
                        "type": "array",
                        "items": {
                            "description": "A point.",
                            "type": "object",
                            "properties": {
                                "x": {"description": "Horizontal.", "type": "number"},
                                "y": {"type": "integer"}
                            },
                            "required": ["x", "y"]
                        }
                    },
                    "label": {"type": ["string", "null"]},
                    "when": {"type": ["string", "null"]}
                },
                "required": ["origin", "corners"]
            })
        );
    }

    #[derive(schemars::JsonSchema)]
    #[allow(dead_code, reason = "schema-only type")]
    struct Forest {
        trees: Vec<Tree>,
    }

    #[test]
    fn keeps_recursive_types_under_defs() {
        let schema = schema_for::<Forest>();
        assert_eq!(schema["properties"]["trees"]["items"], json!({"$ref": "#/$defs/Tree"}));
        let tree = &schema["$defs"]["Tree"];
        assert_eq!(tree["properties"]["children"]["items"], json!({"$ref": "#/$defs/Tree"}));
        assert_eq!(tree["properties"]["name"], json!({"type": "string"}));
        assert!(tree.get("title").is_none());
        let root = schema_for::<Tree>();
        assert_eq!(root["properties"]["children"]["items"], json!({"$ref": "#"}));
        assert!(root.get("title").is_none());
    }

    #[test]
    fn keeps_standard_formats_and_properties_named_title() {
        let schema = normalize_schema(json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "Root",
            "type": "object",
            "properties": {
                "title": {"type": "string", "title": "Title", "format": "date-time"},
                "count": {"type": "integer", "format": "uint32"}
            }
        }));
        assert_eq!(
            schema,
            json!({
                "type": "object",
                "properties": {
                    "title": {"type": "string", "format": "date-time"},
                    "count": {"type": "integer"}
                }
            })
        );
    }

    #[test]
    fn validates_input_and_lists_every_violation() {
        let validator = SchemaValidator::new(&json!({
            "type": "object",
            "properties": {"name": {"type": "string"}, "age": {"type": "number"}},
            "required": ["name", "age"]
        }))
        .unwrap();
        validator.validate(&json!({"name": "John", "age": 30})).unwrap();
        let error = validator.validate(&json!({"age": "thirty"})).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Validation failed:\n- \"name\" is a required property\n- /age: \"thirty\" is not of type \"number\""
        );
    }

    #[test]
    fn rejects_an_invalid_schema() {
        assert!(SchemaValidator::new(&json!({"type": 12})).is_err());
    }
}
