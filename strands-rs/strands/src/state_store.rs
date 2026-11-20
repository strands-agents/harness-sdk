//! Key-value JSON state outside the conversation.

use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{Error, JsonValidationError, Result};
use crate::types::{JsonObject, JsonValue};

/// Key-value storage for application state outside the conversation context (`StateStore`).
///
/// State is not sent to the model; tools and application code read and write it. Values are JSON,
/// so a store can be persisted in snapshots and sessions. A `StateStore` is a cheap handle: clones
/// share the same state, and [`StateStore::snapshot`] makes an independent copy.
///
/// ```
/// use strands::StateStore;
///
/// let state = StateStore::new();
/// state.set("userId", "user-123").unwrap();
/// let user_id: Option<String> = state.get("userId").unwrap();
/// assert_eq!(user_id.as_deref(), Some("user-123"));
/// ```
#[derive(Debug, Clone, Default)]
pub struct StateStore {
    state: Arc<RwLock<JsonObject>>,
}

impl StateStore {
    /// Creates an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// A handle that identifies this store (and so its agent) without keeping it alive.
    pub(crate) fn downgrade(&self) -> std::sync::Weak<RwLock<JsonObject>> {
        Arc::downgrade(&self.state)
    }

    /// Reads a value and deserializes it into `T`; `Ok(None)` when the key is absent.
    ///
    /// # Errors
    ///
    /// Returns an error when the stored value does not deserialize into `T`.
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let Some(value) = self.get_value(key) else {
            return Ok(None);
        };
        decode(key, value).map(Some)
    }

    /// A copy of the raw JSON value stored under `key`.
    #[must_use]
    pub fn get_value(&self, key: &str) -> Option<JsonValue> {
        self.read().get(key).cloned()
    }

    /// Serializes `value` and stores it under `key`, replacing any previous value.
    ///
    /// # Errors
    ///
    /// Returns a [`JsonValidationError`] when `value` cannot be serialized to JSON.
    pub fn set(&self, key: impl Into<String>, value: impl Serialize) -> Result<()> {
        let key = key.into();
        let value = encode(&key, value)?;
        self.write().insert(key, value);
        Ok(())
    }

    /// Reads, changes and writes back the value under `key` in one step, holding the store's lock
    /// throughout, so concurrent tools that update the same key do not lose each other's writes.
    /// `f` receives `None` when the key is absent; keep it short, since it blocks every other
    /// access to the store.
    ///
    /// ```
    /// use strands::StateStore;
    ///
    /// let state = StateStore::new();
    /// state.update("count", |count: Option<u32>| count.unwrap_or(0) + 1).unwrap();
    /// state.update("count", |count: Option<u32>| count.unwrap_or(0) + 1).unwrap();
    /// assert_eq!(state.get::<u32>("count").unwrap(), Some(2));
    /// ```
    ///
    /// # Errors
    ///
    /// Returns an error when the stored value does not deserialize into `T`, or the new value
    /// cannot be serialized; the stored value is then unchanged.
    pub fn update<T, F>(&self, key: impl Into<String>, f: F) -> Result<()>
    where
        T: Serialize + DeserializeOwned,
        F: FnOnce(Option<T>) -> T,
    {
        let key = key.into();
        let mut state = self.write();
        let current = state.get(&key).cloned().map(|value| decode(&key, value)).transpose()?;
        let value = encode(&key, f(current))?;
        state.insert(key, value);
        Ok(())
    }

    /// Removes `key`; a missing key is not an error.
    pub fn delete(&self, key: &str) {
        self.write().shift_remove(key);
    }

    /// Removes every value.
    pub fn clear(&self) {
        self.write().clear();
    }

    /// A copy of the whole state.
    #[must_use]
    pub fn get_all(&self) -> JsonObject {
        self.read().clone()
    }

    /// The keys, in insertion order.
    #[must_use]
    pub fn keys(&self) -> Vec<String> {
        self.read().keys().cloned().collect()
    }

    /// An independent store holding a copy of this state.
    #[must_use]
    pub fn snapshot(&self) -> Self {
        Self::from(self.get_all())
    }

    /// Replaces the whole state with `other`'s.
    #[allow(dead_code, reason = "the agent commits a model call's model state with it")]
    pub(crate) fn replace_with(&self, other: &Self) {
        let state = other.get_all();
        *self.write() = state;
    }

    /// The state as a JSON value.
    #[allow(dead_code, reason = "snapshots and sessions persist state with it")]
    pub(crate) fn to_json(&self) -> JsonValue {
        JsonValue::Object(self.get_all())
    }

    /// Replaces the state with saved JSON; anything but an object clears it.
    #[allow(dead_code, reason = "snapshots and sessions restore state with it")]
    pub(crate) fn load_json(&self, json: JsonValue) {
        let state = match json {
            JsonValue::Object(map) => map,
            _ => JsonObject::new(),
        };
        *self.write() = state;
    }

    fn read(&self) -> RwLockReadGuard<'_, JsonObject> {
        self.state.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self) -> RwLockWriteGuard<'_, JsonObject> {
        self.state.write().unwrap_or_else(PoisonError::into_inner)
    }
}

fn encode(key: &str, value: impl Serialize) -> Result<JsonValue> {
    serde_json::to_value(value).map_err(|error| {
        JsonValidationError::new(format!("value for key \"{key}\" cannot be serialized: {error}")).into()
    })
}

fn decode<T: DeserializeOwned>(key: &str, value: JsonValue) -> Result<T> {
    serde_json::from_value(value).map_err(|error| {
        Error::other(format!(
            "value for key \"{key}\" does not deserialize into the requested type: {error}"
        ))
    })
}

impl From<JsonObject> for StateStore {
    fn from(state: JsonObject) -> Self {
        Self {
            state: Arc::new(RwLock::new(state)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    fn store(value: JsonValue) -> StateStore {
        match value {
            JsonValue::Object(map) => StateStore::from(map),
            _ => panic!("not an object"),
        }
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct User {
        name: String,
        age: u32,
    }

    #[test]
    fn creates_empty_state_when_no_initial_state_provided() {
        assert!(StateStore::new().keys().is_empty());
    }

    #[test]
    fn creates_state_with_initial_values() {
        let state = store(json!({"key1": "value1", "key2": 42}));
        assert_eq!(state.get_value("key1"), Some(json!("value1")));
        assert_eq!(state.get_value("key2"), Some(json!(42)));
    }

    #[test]
    fn stores_deep_copy_of_initial_state() {
        let mut initial = json!({"nested": {"value": "test"}});
        let state = store(initial.clone());
        initial["nested"]["value"] = json!("changed");
        assert_eq!(state.get_value("nested"), Some(json!({"value": "test"})));
    }

    #[test]
    fn returns_undefined_when_key_does_not_exist() {
        let state = StateStore::new();
        assert_eq!(state.get_value("nonexistent"), None);
        assert_eq!(state.get::<String>("nonexistent").unwrap(), None);
    }

    #[test]
    fn returns_value_when_key_exists() {
        let state = store(json!({"key1": "value1"}));
        assert_eq!(state.get::<String>("key1").unwrap().as_deref(), Some("value1"));
    }

    #[test]
    fn returns_deep_copy_that_cannot_mutate_stored_state() {
        let state = store(json!({"nested": {"value": "test"}}));
        let mut retrieved = state.get_value("nested").unwrap();
        retrieved["value"] = json!("changed");
        assert_eq!(state.get_value("nested"), Some(json!({"value": "test"})));
    }

    #[test]
    fn infers_correct_type_with_generic_state_interface() {
        let state = store(json!({"user": {"name": "John", "age": 30}, "count": 5, "items": ["a", "b"]}));
        let user: Option<User> = state.get("user").unwrap();
        assert_eq!(
            user,
            Some(User {
                name: "John".into(),
                age: 30
            })
        );
        assert_eq!(state.get::<u32>("count").unwrap(), Some(5));
        assert_eq!(
            state.get::<Vec<String>>("items").unwrap(),
            Some(vec!["a".into(), "b".into()])
        );
    }

    #[test]
    fn returns_undefined_for_non_existent_key_with_typed_interface() {
        let state = store(json!({"existing": "value"}));
        assert_eq!(state.get::<String>("existing").unwrap().as_deref(), Some("value"));
        assert_eq!(StateStore::new().get::<String>("existing").unwrap(), None);
    }

    #[test]
    fn get_fails_when_the_value_does_not_deserialize_into_the_type() {
        let state = store(json!({"count": "five"}));
        let error = state.get::<u32>("count").unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("value for key \"count\" does not deserialize into the requested type: "),
            "{error}"
        );
    }

    #[test]
    fn update_reads_and_writes_in_one_step() {
        let state = StateStore::new();
        state
            .update("count", |count: Option<u32>| count.unwrap_or(0) + 1)
            .unwrap();
        state
            .update("count", |count: Option<u32>| count.unwrap_or(0) + 1)
            .unwrap();
        assert_eq!(state.get_value("count"), Some(json!(2)));
    }

    #[test]
    fn update_leaves_the_value_unchanged_when_it_does_not_decode() {
        let state = store(json!({"count": "five"}));
        let error = state
            .update("count", |count: Option<u32>| count.unwrap_or(0) + 1)
            .unwrap_err();
        assert!(error.to_string().contains("\"count\""), "{error}");
        assert_eq!(state.get_value("count"), Some(json!("five")));
    }

    #[test]
    fn concurrent_updates_do_not_lose_writes() {
        let state = StateStore::new();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let state = state.clone();
                std::thread::spawn(move || {
                    for _ in 0..100 {
                        state
                            .update("count", |count: Option<u32>| count.unwrap_or(0) + 1)
                            .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(state.get::<u32>("count").unwrap(), Some(800));
    }

    #[test]
    fn sets_string_number_boolean_null_object_and_array_values() {
        let state = StateStore::new();
        state.set("string", "value1").unwrap();
        state.set("number", 42).unwrap();
        state.set("boolean", true).unwrap();
        state.set("null", JsonValue::Null).unwrap();
        state.set("object", json!({"nested": "value"})).unwrap();
        state.set("array", [1, 2, 3]).unwrap();
        assert_eq!(
            JsonValue::Object(state.get_all()),
            json!({
                "string": "value1",
                "number": 42,
                "boolean": true,
                "null": null,
                "object": {"nested": "value"},
                "array": [1, 2, 3],
            })
        );
    }

    #[test]
    fn overwrites_existing_value() {
        let state = store(json!({"key1": "old"}));
        state.set("key1", "new").unwrap();
        assert_eq!(state.get_value("key1"), Some(json!("new")));
    }

    #[test]
    fn set_stores_deep_copy_that_cannot_mutate_stored_state() {
        let state = StateStore::new();
        let mut value = json!({"nested": {"value": "test"}});
        state.set("key1", &value).unwrap();
        value["nested"]["value"] = json!("changed");
        assert_eq!(state.get_value("key1"), Some(json!({"nested": {"value": "test"}})));
    }

    #[test]
    fn throws_error_for_a_value_that_cannot_be_serialized() {
        let state = StateStore::new();
        let value = BTreeMap::from([((1, 2), "tuple key")]);
        let error = state.set("key1", value).unwrap_err();
        assert_eq!(error.name(), "JsonValidationError");
        assert!(
            error
                .to_string()
                .starts_with("value for key \"key1\" cannot be serialized: "),
            "{error}"
        );
        assert_eq!(state.get_value("key1"), None);
    }

    #[test]
    fn accepts_typed_value_with_generic_state_interface() {
        let state = StateStore::new();
        state
            .set(
                "user",
                User {
                    name: "Alice".into(),
                    age: 25,
                },
            )
            .unwrap();
        state.set("count", 10).unwrap();
        assert_eq!(state.get_value("user"), Some(json!({"name": "Alice", "age": 25})));
        assert_eq!(state.get_value("count"), Some(json!(10)));
    }

    #[test]
    fn removes_existing_key() {
        let state = store(json!({"key1": "value1", "key2": "value2"}));
        state.delete("key1");
        assert_eq!(state.get_value("key1"), None);
        assert_eq!(state.get_value("key2"), Some(json!("value2")));
    }

    #[test]
    fn does_not_throw_error_for_non_existent_key() {
        StateStore::new().delete("nonexistent");
    }

    #[test]
    fn delete_supports_typed_usage_with_generic_state_interface() {
        let state = store(json!({"user": {"name": "Alice"}, "count": 5}));
        state.delete("user");
        assert_eq!(state.get::<User>("user").unwrap(), None);
        assert_eq!(state.get::<u32>("count").unwrap(), Some(5));
    }

    #[test]
    fn removes_all_values() {
        let state = store(json!({"key1": "value1", "key2": "value2"}));
        state.clear();
        assert!(state.keys().is_empty());
        assert_eq!(state.get_value("key1"), None);
        assert_eq!(state.get_value("key2"), None);
    }

    #[test]
    fn clear_works_on_empty_state() {
        let state = StateStore::new();
        state.clear();
        assert!(state.keys().is_empty());
    }

    #[test]
    fn returns_object_with_all_state() {
        let state = store(json!({"key1": "value1", "key2": 42}));
        assert_eq!(
            JsonValue::Object(state.get_all()),
            json!({"key1": "value1", "key2": 42})
        );
    }

    #[test]
    fn returns_empty_object_for_empty_state() {
        assert!(StateStore::new().get_all().is_empty());
    }

    #[test]
    fn keys_returns_empty_array_for_empty_state() {
        assert!(StateStore::new().keys().is_empty());
    }

    #[test]
    fn returns_array_of_all_keys() {
        let state = store(json!({"key1": "value1", "key2": "value2"}));
        assert_eq!(state.keys(), vec!["key1", "key2"]);
    }

    #[test]
    fn returns_deep_copy_of_state() {
        let state = store(json!({"key1": "value1", "nested": {"deep": true}}));
        let mut json = state.to_json();
        assert_eq!(json, json!({"key1": "value1", "nested": {"deep": true}}));
        json["nested"]["deep"] = json!(false);
        assert_eq!(state.get_value("nested"), Some(json!({"deep": true})));
    }

    #[test]
    fn replaces_state_with_json_data() {
        let state = store(json!({"old": "data"}));
        state.load_json(json!({"new": "data", "count": 42}));
        assert_eq!(state.to_json(), json!({"new": "data", "count": 42}));
    }

    #[test]
    fn clears_state_when_given_non_object() {
        let state = store(json!({"key": "value"}));
        state.load_json(JsonValue::Null);
        assert_eq!(state.to_json(), json!({}));
    }

    #[test]
    fn clones_share_state_and_snapshots_do_not() {
        let state = StateStore::new();
        let shared = state.clone();
        let snapshot = state.snapshot();
        shared.set("key", 1).unwrap();
        assert_eq!(state.get_value("key"), Some(json!(1)));
        assert_eq!(snapshot.get_value("key"), None);
        snapshot.set("other", 2).unwrap();
        assert_eq!(state.get_value("other"), None);
    }

    #[test]
    fn replace_with_copies_another_store() {
        let state = store(json!({"old": 1}));
        let next = store(json!({"responseId": "r1"}));
        state.replace_with(&next);
        next.set("later", true).unwrap();
        assert_eq!(state.to_json(), json!({"responseId": "r1"}));
    }
}
