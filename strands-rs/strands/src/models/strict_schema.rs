//! Strict JSON schema transformation for tool definitions.
//!
//! Strict tool use requires `additionalProperties: false` on every object type. This applies it
//! recursively, after OpenAI's `_ensure_strict_json_schema`.

#![allow(dead_code, reason = "providers that send strict tool schemas use these helpers")]

use std::collections::{BTreeSet, HashSet};

use crate::logging::warn_once;
use crate::types::{JsonObject, JsonSchema, JsonValue};

/// Keywords whose value is a map of subschemas.
const SCHEMA_MAP_KEYWORDS: [&str; 3] = ["$defs", "definitions", "properties"];
/// Keywords whose value is a list of subschemas.
const SCHEMA_LIST_KEYWORDS: [&str; 3] = ["anyOf", "allOf", "oneOf"];
/// Keywords whose value is a single subschema.
const SCHEMA_VALUE_KEYWORDS: [&str; 2] = ["items", "additionalProperties"];

/// Keywords outside Bedrock's strict-mode subset that the transform does not rewrite.
const UNSUPPORTED_STRICT_KEYWORDS: [&str; 7] = [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
];

/// One step from a schema node to a child.
#[derive(Debug, Clone)]
enum Segment {
    Key(String),
    Index(usize),
}

/// The direct subschemas of `schema`, including `$defs`/`definitions` entries.
pub(crate) fn child_schemas(schema: &JsonObject) -> Vec<&JsonObject> {
    let maps = SCHEMA_MAP_KEYWORDS
        .iter()
        .filter_map(|keyword| schema.get(*keyword)?.as_object())
        .flat_map(|map| map.values());
    let lists = SCHEMA_LIST_KEYWORDS
        .iter()
        .filter_map(|keyword| schema.get(*keyword)?.as_array())
        .flatten();
    let values = SCHEMA_VALUE_KEYWORDS.iter().filter_map(|keyword| schema.get(*keyword));
    maps.chain(lists)
        .chain(values)
        .filter_map(JsonValue::as_object)
        .collect()
}

/// Paths of the direct subschemas of `schema`, in [`child_schemas`] order.
fn child_paths(schema: &JsonObject) -> Vec<Vec<Segment>> {
    let mut paths = Vec::new();
    for keyword in SCHEMA_MAP_KEYWORDS {
        let Some(map) = schema.get(keyword).and_then(JsonValue::as_object) else {
            continue;
        };
        for (key, value) in map {
            if value.is_object() {
                paths.push(vec![Segment::Key(keyword.to_owned()), Segment::Key(key.clone())]);
            }
        }
    }
    for keyword in SCHEMA_LIST_KEYWORDS {
        let Some(list) = schema.get(keyword).and_then(JsonValue::as_array) else {
            continue;
        };
        for (index, value) in list.iter().enumerate() {
            if value.is_object() {
                paths.push(vec![Segment::Key(keyword.to_owned()), Segment::Index(index)]);
            }
        }
    }
    for keyword in SCHEMA_VALUE_KEYWORDS {
        if schema.get(keyword).is_some_and(JsonValue::is_object) {
            paths.push(vec![Segment::Key(keyword.to_owned())]);
        }
    }
    paths
}

fn node_at<'a>(root: &'a mut JsonValue, path: &[Segment]) -> Option<&'a mut JsonObject> {
    let mut current = root;
    for segment in path {
        current = match segment {
            Segment::Key(key) => current.as_object_mut()?.get_mut(key)?,
            Segment::Index(index) => current.as_array_mut()?.get_mut(*index)?,
        };
    }
    current.as_object_mut()
}

fn is_object_type(schema: &JsonObject) -> bool {
    match schema.get("type") {
        Some(JsonValue::String(kind)) => kind == "object",
        Some(JsonValue::Array(kinds)) => kinds.iter().any(|kind| kind == "object"),
        _ => false,
    }
}

/// A deep copy of `schema` with `additionalProperties: false` applied recursively to object types.
/// The original is not changed.
pub(crate) fn ensure_strict_json_schema(schema: &JsonSchema) -> JsonSchema {
    let mut copy = schema.clone();
    apply_strict(&mut copy, &mut Vec::new(), &HashSet::new());
    copy
}

/// Applies strict-mode constraints to the node at `path` in place. `$ref`s resolve against `root`
/// as it stands, and `inlining` holds the refs being inlined on the current path so recursive refs
/// terminate.
fn apply_strict(root: &mut JsonValue, path: &mut Vec<Segment>, inlining: &HashSet<String>) {
    let Some(schema) = node_at(root, path) else {
        return;
    };
    // A node still carrying a $ref is left for the inline below, so the target's own value wins.
    if is_object_type(schema) && !schema.contains_key("additionalProperties") && !schema.contains_key("$ref") {
        schema.insert("additionalProperties".to_owned(), JsonValue::Bool(false));
    }
    let children = child_paths(schema);
    for child in children {
        let depth = path.len();
        path.extend(child);
        apply_strict(root, path, inlining);
        path.truncate(depth);
    }

    let Some(schema) = node_at(root, path) else {
        return;
    };
    let Some(reference) = schema.get("$ref").and_then(JsonValue::as_str).map(str::to_owned) else {
        return;
    };
    if schema.len() <= 1 {
        return;
    }
    if inlining.contains(&reference) {
        warn_once(&format!(
            "ref=<{reference}> | recursive $ref cannot be inlined, leaving it unresolved"
        ));
        return;
    }
    let Some(mut merged) = resolve_ref(root, &reference) else {
        return;
    };
    let Some(schema) = node_at(root, path) else {
        return;
    };
    for (key, value) in std::mem::take(schema) {
        merged.insert(key, value);
    }
    merged.shift_remove("$ref");
    *schema = merged;
    let mut inlining = inlining.clone();
    inlining.insert(reference);
    apply_strict(root, path, &inlining);
}

/// The keywords in `schema` that Bedrock's strict mode rejects, sorted: any `additionalProperties`
/// other than `false`, and numeric and length bounds.
pub(crate) fn find_unsupported_strict_keywords(schema: &JsonSchema) -> Vec<String> {
    let mut found = BTreeSet::new();
    if let Some(schema) = schema.as_object() {
        collect_unsupported_keywords(schema, &mut found);
    }
    found.into_iter().map(str::to_owned).collect()
}

fn collect_unsupported_keywords(schema: &JsonObject, found: &mut BTreeSet<&'static str>) {
    found.extend(
        UNSUPPORTED_STRICT_KEYWORDS
            .iter()
            .filter(|keyword| schema.contains_key(**keyword)),
    );
    if schema
        .get("additionalProperties")
        .is_some_and(|value| *value != JsonValue::Bool(false))
    {
        found.insert("additionalProperties");
    }
    for child in child_schemas(schema) {
        collect_unsupported_keywords(child, found);
    }
}

/// Resolves a `#/`-rooted `$ref` against `root` to a copy of its object, or `None`.
fn resolve_ref(root: &JsonValue, reference: &str) -> Option<JsonObject> {
    let Some(pointer) = reference.strip_prefix("#/") else {
        tracing::warn!("ref=<{reference}> | unexpected $ref format, skipping resolution");
        return None;
    };
    let mut current = root;
    for key in pointer.split('/') {
        let Some(next) = current.as_object().and_then(|object| object.get(key)) else {
            tracing::warn!("ref=<{reference}> | failed to resolve $ref path");
            return None;
        };
        current = next;
    }
    let Some(object) = current.as_object() else {
        tracing::warn!("ref=<{reference}> | resolved to non-dict value");
        return None;
    };
    Some(object.clone())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::capture_logs;

    #[test]
    fn adds_additional_properties_false_to_a_basic_object_and_does_not_mutate_the_original() {
        let original = json!({"type": "object", "properties": {"x": {"type": "string"}}});
        let result = ensure_strict_json_schema(&original);
        assert_eq!(
            result,
            json!({"type": "object", "properties": {"x": {"type": "string"}}, "additionalProperties": false})
        );
        assert!(original.get("additionalProperties").is_none());
    }

    #[test]
    fn recurses_into_nested_objects() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"outer": {"type": "object", "properties": {"inner": {"type": "integer"}}}},
        }));
        assert_eq!(
            result,
            json!({
                "type": "object",
                "properties": {
                    "outer": {"type": "object", "properties": {"inner": {"type": "integer"}}, "additionalProperties": false},
                },
                "additionalProperties": false,
            })
        );
    }

    #[test]
    fn processes_defs_blocks() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"item": {"$ref": "#/$defs/MyItem"}},
            "$defs": {"MyItem": {"type": "object", "properties": {"name": {"type": "string"}}}},
        }));
        assert_eq!(
            result,
            json!({
                "type": "object",
                "properties": {"item": {"$ref": "#/$defs/MyItem"}},
                "$defs": {"MyItem": {"type": "object", "properties": {"name": {"type": "string"}}, "additionalProperties": false}},
                "additionalProperties": false,
            })
        );
    }

    #[test]
    fn processes_definitions_blocks() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"item": {"$ref": "#/definitions/MyItem"}},
            "definitions": {"MyItem": {"type": "object", "properties": {"name": {"type": "string"}}}},
        }));
        assert_eq!(
            result,
            json!({
                "type": "object",
                "properties": {"item": {"$ref": "#/definitions/MyItem"}},
                "definitions": {
                    "MyItem": {"type": "object", "properties": {"name": {"type": "string"}}, "additionalProperties": false},
                },
                "additionalProperties": false,
            })
        );
    }

    #[test]
    fn inlines_a_ref_that_has_sibling_keys_existing_keys_winning() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"item": {"$ref": "#/$defs/MyItem", "description": "An item"}},
            "$defs": {"MyItem": {"type": "object", "description": "from $defs", "properties": {"name": {"type": "string"}}}},
        }));
        let item = &result["properties"]["item"];
        assert_eq!(
            *item,
            json!({
                "type": "object",
                "description": "An item",
                "properties": {"name": {"type": "string"}},
                "additionalProperties": false,
            })
        );
        let keys: Vec<_> = item.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["type", "description", "properties", "additionalProperties"]);
    }

    #[test]
    fn deep_copies_on_inline_so_repeated_refs_are_independent() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {
                "a": {"$ref": "#/$defs/Shared", "description": "first"},
                "b": {"$ref": "#/$defs/Shared", "description": "second"},
            },
            "$defs": {"Shared": {"type": "object", "properties": {"val": {"type": "string"}}}},
        }));
        assert_eq!(result["properties"]["a"]["description"], "first");
        assert_eq!(result["properties"]["b"]["description"], "second");
    }

    #[test]
    fn recurses_into_array_items_any_of_and_all_of() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {
                "items": {"type": "array", "items": {"type": "object", "properties": {"a": {"type": "string"}}}},
                "union": {"anyOf": [{"type": "object", "properties": {"b": {"type": "string"}}}, {"type": "null"}]},
                "intersection": {"allOf": [{"type": "object", "properties": {"c": {"type": "string"}}}]},
            },
        }));
        assert_eq!(
            result,
            json!({
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": false},
                    },
                    "union": {
                        "anyOf": [
                            {"type": "object", "properties": {"b": {"type": "string"}}, "additionalProperties": false},
                            {"type": "null"},
                        ],
                    },
                    "intersection": {
                        "allOf": [{"type": "object", "properties": {"c": {"type": "string"}}, "additionalProperties": false}],
                    },
                },
                "additionalProperties": false,
            })
        );
    }

    #[test]
    fn recurses_into_one_of() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {
                "value": {
                    "oneOf": [
                        {"type": "object", "properties": {"a": {"type": "string"}}},
                        {"type": "object", "properties": {"b": {"type": "integer"}}},
                    ],
                },
            },
        }));
        assert_eq!(
            result,
            json!({
                "type": "object",
                "properties": {
                    "value": {
                        "oneOf": [
                            {"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": false},
                            {"type": "object", "properties": {"b": {"type": "integer"}}, "additionalProperties": false},
                        ],
                    },
                },
                "additionalProperties": false,
            })
        );
    }

    #[test]
    fn leaves_required_unchanged() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"required_field": {"type": "string"}, "optional_field": {"type": "string"}},
            "required": ["required_field"],
        }));
        assert_eq!(result["required"], json!(["required_field"]));
    }

    #[test]
    fn preserves_an_existing_additional_properties_true() {
        let schema = json!({"type": "object", "properties": {"x": {"type": "string"}}, "additionalProperties": true});
        assert_eq!(ensure_strict_json_schema(&schema), schema);
    }

    #[test]
    fn preserves_an_existing_additional_properties_false() {
        let schema = json!({"type": "object", "properties": {"x": {"type": "string"}}, "additionalProperties": false});
        assert_eq!(ensure_strict_json_schema(&schema), schema);
    }

    #[test]
    fn leaves_a_non_object_type_unchanged() {
        assert_eq!(
            ensure_strict_json_schema(&json!({"type": "string"})),
            json!({"type": "string"})
        );
    }

    #[test]
    fn ignores_a_ref_that_does_not_start_with_hash_slash_but_still_closes_the_root() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"item": {"$ref": "external.json#/Foo", "description": "ext"}},
        }));
        assert_eq!(result["additionalProperties"], false);
        assert_eq!(result["properties"]["item"]["$ref"], "external.json#/Foo");
    }

    #[test]
    fn ignores_a_ref_pointing_at_a_missing_path_but_still_closes_the_root() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"item": {"$ref": "#/$defs/Missing", "description": "gone"}},
            "$defs": {},
        }));
        assert_eq!(result["additionalProperties"], false);
        assert!(result["properties"]["item"].get("$ref").is_some());
    }

    #[test]
    fn terminates_on_a_recursive_ref_with_sibling_keys_leaving_the_cycle_point_unresolved() {
        let (result, logs) = capture_logs(|| {
            ensure_strict_json_schema(&json!({
                "type": "object",
                "properties": {"filter": {"$ref": "#/definitions/Filter", "description": "root filter"}},
                "definitions": {
                    "Filter": {
                        "type": "object",
                        "properties": {"and": {"type": "array", "items": {"$ref": "#/definitions/Filter", "description": "sub"}}},
                    },
                },
            }))
        });
        let filter = &result["properties"]["filter"];
        assert_eq!(filter["description"], "root filter");
        assert_eq!(filter["additionalProperties"], false);
        let mut node = filter;
        while node.get("$ref").is_none() {
            node = &node["properties"]["and"]["items"];
        }
        assert_eq!(*node, json!({"$ref": "#/definitions/Filter", "description": "sub"}));
        assert!(logs.contains("ref=<#/definitions/Filter> | recursive $ref"), "{logs}");
    }

    #[test]
    fn does_not_mutate_nested_objects_or_defs_of_the_original() {
        let original = json!({
            "type": "object",
            "properties": {
                "outer": {"type": "object", "properties": {"inner": {"type": "string"}}},
                "item": {"$ref": "#/$defs/Item", "description": "an item"},
            },
            "$defs": {"Item": {"type": "object", "properties": {"name": {"type": "string"}}}},
        });
        let snapshot = original.clone();
        ensure_strict_json_schema(&original);
        assert_eq!(original, snapshot);
    }

    #[test]
    fn closes_an_object_whose_type_is_a_union_including_object() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"addr": {"type": ["object", "null"], "properties": {"city": {"type": "string"}}}},
        }));
        assert_eq!(
            result,
            json!({
                "type": "object",
                "properties": {
                    "addr": {"type": ["object", "null"], "properties": {"city": {"type": "string"}}, "additionalProperties": false},
                },
                "additionalProperties": false,
            })
        );
    }

    #[test]
    fn closes_objects_inside_a_schema_valued_additional_properties() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "additionalProperties": {"type": "object", "properties": {"v": {"type": "string"}}},
        }));
        assert_eq!(
            result,
            json!({
                "type": "object",
                "additionalProperties": {"type": "object", "properties": {"v": {"type": "string"}}, "additionalProperties": false},
            })
        );
    }

    #[test]
    fn keeps_a_ref_targets_additional_properties_when_the_ref_node_also_declares_type_object() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"m": {"$ref": "#/$defs/Map", "type": "object"}},
            "$defs": {"Map": {"type": "object", "additionalProperties": {"type": "string"}}},
        }));
        assert_eq!(
            result["properties"]["m"],
            json!({"type": "object", "additionalProperties": {"type": "string"}})
        );
    }

    #[test]
    fn does_not_resolve_a_ref_through_the_prototype_chain() {
        let result = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"x": {"$ref": "#/$defs/__proto__", "description": "d"}},
            "$defs": {},
        }));
        assert_eq!(
            result["properties"]["x"],
            json!({"$ref": "#/$defs/__proto__", "description": "d"})
        );
    }

    #[test]
    fn keeps_an_inlined_proto_key_as_an_own_property_and_still_closes_the_node() {
        let schema: JsonValue = serde_json::from_str(
            r##"{"type":"object","properties":{"x":{"$ref":"#/$defs/Item","description":"d"}},"$defs":{"Item":{"type":"object","__proto__":{"additionalProperties":true}}}}"##,
        )
        .unwrap();
        let result = ensure_strict_json_schema(&schema);
        let x = &result["properties"]["x"];
        assert_eq!(x["additionalProperties"], false);
        assert_eq!(x["__proto__"], json!({"additionalProperties": true}));
    }

    #[test]
    fn returns_nothing_for_a_closed_schema_without_bounds() {
        let strict = ensure_strict_json_schema(&json!({
            "type": "object",
            "properties": {"a": {"type": "string"}, "b": {"type": "array", "items": {"type": "integer"}}},
        }));
        assert!(find_unsupported_strict_keywords(&strict).is_empty());
    }

    #[test]
    fn reports_open_additional_properties_and_bounds_anywhere_in_the_schema_sorted_and_deduplicated() {
        let keywords = find_unsupported_strict_keywords(&json!({
            "type": "object",
            "properties": {
                "headers": {"type": "object", "additionalProperties": {"type": "string", "maxLength": 10}},
                "count": {"type": "integer", "minimum": 0, "maximum": 5},
                "timeout": {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 60},
                "tags": {"type": "array", "items": {"type": "string", "minLength": 1}},
            },
            "$defs": {"Step": {"type": "number", "multipleOf": 2, "minimum": 1}},
            "additionalProperties": false,
        }));
        assert_eq!(
            keywords,
            [
                "additionalProperties",
                "exclusiveMaximum",
                "exclusiveMinimum",
                "maxLength",
                "maximum",
                "minLength",
                "minimum",
                "multipleOf",
            ]
        );
    }

    #[test]
    fn does_not_treat_property_names_as_keywords() {
        let keywords = find_unsupported_strict_keywords(&json!({
            "type": "object",
            "properties": {"minimum": {"type": "number"}},
            "additionalProperties": false,
        }));
        assert!(keywords.is_empty());
    }
}
