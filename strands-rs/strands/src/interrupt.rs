//! Human-in-the-loop interrupts and their persisted state.
//!
//! A hook or tool raises an [`Interrupt`]; the agent stops with `StopReason::Interrupt`; the caller
//! resumes it with `InterruptResponseContent` blocks, and the raiser then receives the response.
//! The interrupt state stored under `interrupts` in an agent snapshot is crate-internal.

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result as SdkResult, SessionError};
use crate::types::json::present;
use crate::types::{
    ContentBlock, InterruptParams, InterruptResponseContent, JsonObject, JsonValue, Message, Role, ToolResultBlock,
};

/// Where an interrupt was raised (`InterruptSource`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[non_exhaustive]
pub enum InterruptSource {
    /// A tool, through its context's `interrupt`.
    #[serde(rename = "tool")]
    Tool,
    /// An agent hook, such as `BeforeToolCallEvent::interrupt`. Snapshots from SDKs that did not
    /// record a source default to it.
    #[default]
    #[serde(rename = "hook")]
    Hook,
    /// Middleware.
    #[serde(rename = "middleware")]
    Middleware,
    /// A multi-agent orchestrator hook.
    #[serde(rename = "multiagent-hook")]
    MultiagentHook,
}

/// An interrupt that pauses agent execution for human input (`Interrupt`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Interrupt {
    /// Unique identifier, such as `tool:<toolUseId>:<name>`.
    pub id: String,
    /// The user-defined name.
    pub name: String,
    /// Why the interrupt was raised. A saved `null` stays `Some(JsonValue::Null)`.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub reason: Option<JsonValue>,
    /// The human response provided on resume. A saved `null` stays `Some(JsonValue::Null)`, which
    /// counts as answered.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub response: Option<JsonValue>,
    /// Where the interrupt was raised.
    #[serde(default)]
    pub source: InterruptSource,
}

impl Interrupt {
    /// Creates an interrupt raised by a hook, with no reason or response.
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            reason: None,
            response: None,
            source: InterruptSource::Hook,
        }
    }

    /// Sets the reason.
    #[must_use]
    pub fn with_reason(mut self, reason: impl Into<JsonValue>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    /// Sets the response.
    #[must_use]
    pub fn with_response(mut self, response: impl Into<JsonValue>) -> Self {
        self.response = Some(response.into());
        self
    }

    /// Sets the source.
    #[must_use]
    pub fn with_source(mut self, source: InterruptSource) -> Self {
        self.source = source;
        self
    }
}

/// One or more unanswered interrupts as an error (`InterruptError`).
///
/// [`ToolContext::interrupt`](crate::ToolContext::interrupt) and the hook events' `interrupt`
/// return it when no response is known yet. Propagate it with `?`: from a tool body it ends the
/// tool as [`ToolOutcome::Interrupt`](crate::ToolOutcome), from a hook it stops the invocation
/// with `StopReason::Interrupt` once every callback has run, and it survives conversion into a
/// [`BoxError`](crate::BoxError) or a [`ToolError`](crate::ToolError) on the way. The message is
/// `Interrupt raised: <name>`, or `<n> interrupts raised: <a>, <b>`.
///
/// ```
/// use strands::{Interrupt, InterruptError};
///
/// let error = InterruptError::from(Interrupt::new("hook:beforeTools:confirm", "confirm"));
/// assert_eq!(error.to_string(), "Interrupt raised: confirm");
/// assert_eq!(error.interrupts.len(), 1);
/// ```
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct InterruptError {
    /// The interrupts, in the order they were raised.
    pub interrupts: Vec<Interrupt>,
}

impl InterruptError {
    /// Creates the error from the interrupts it reports.
    pub fn new(interrupts: impl IntoIterator<Item = Interrupt>) -> Self {
        Self {
            interrupts: interrupts.into_iter().collect(),
        }
    }

    /// The interrupts, consuming the error.
    #[must_use]
    pub fn into_interrupts(self) -> Vec<Interrupt> {
        self.interrupts
    }
}

impl From<Interrupt> for InterruptError {
    fn from(interrupt: Interrupt) -> Self {
        Self {
            interrupts: vec![interrupt],
        }
    }
}

impl From<Vec<Interrupt>> for InterruptError {
    fn from(interrupts: Vec<Interrupt>) -> Self {
        Self { interrupts }
    }
}

impl fmt::Display for InterruptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self
            .interrupts
            .iter()
            .map(|interrupt| interrupt.name.as_str())
            .collect();
        match names.as_slice() {
            [name] => write!(f, "Interrupt raised: {name}"),
            _ => write!(f, "{} interrupts raised: {}", names.len(), names.join(", ")),
        }
    }
}

impl std::error::Error for InterruptError {}

/// Tool execution state saved when an interrupt stops a batch of tool calls
/// (`PendingToolExecution`), so resuming does not call the model again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingToolExecution {
    /// The assistant message with the tool uses.
    pub(crate) assistant_message_data: Message,
    /// Results of the tools that finished before the interrupt, by tool use id. Each serializes
    /// as `{"toolResult": {...}}`.
    #[serde(with = "wrapped_tool_results")]
    pub(crate) completed_tool_results: IndexMap<String, ToolResultBlock>,
}

impl PendingToolExecution {
    /// Creates pending state for an assistant message.
    pub(crate) fn new(
        assistant_message_data: Message,
        completed_tool_results: IndexMap<String, ToolResultBlock>,
    ) -> Self {
        Self {
            assistant_message_data,
            completed_tool_results,
        }
    }
}

/// The persisted interrupt state of an agent (`InterruptStateData`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InterruptStateData {
    /// Interrupts by id, in the order they were raised.
    pub(crate) interrupts: IndexMap<String, Interrupt>,
    /// The responses given when resuming.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) resume_responses: Option<Vec<InterruptResponseContent>>,
    /// Whether the agent is in an interrupted state.
    pub(crate) activated: bool,
    /// Tool execution to resume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pending_tool_execution: Option<PendingToolExecution>,
    /// State carried for the duration of an interrupt, such as an interrupted sub-agent turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) context: Option<JsonObject>,
}

impl InterruptStateData {
    /// Creates empty, inactive state.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Restores persisted state (`InterruptState.fromJSON`). A pending tool execution is kept only
    /// when the state is activated, and is then validated so a resume cannot run a corrupt batch.
    ///
    /// # Errors
    ///
    /// A `SessionError` naming the malformed pending-execution field, or a decode error for the
    /// rest of the state.
    pub(crate) fn from_json(value: JsonValue) -> SdkResult<Self> {
        let JsonValue::Object(mut object) = value else {
            return Err(Error::other("interrupt state must be an object"));
        };
        let pending = object.remove("pendingToolExecution");
        let mut data: Self = serde_json::from_value(JsonValue::Object(object))?;
        data.pending_tool_execution = match pending {
            Some(pending) if data.activated && !pending.is_null() => Some(validate_pending_tool_execution(pending)?),
            _ => None,
        };
        Ok(data)
    }
}

const PENDING_MESSAGE_FIELD: &str = "field=<pendingToolExecution.assistantMessageData>";
const PENDING_RESULTS_FIELD: &str = "field=<pendingToolExecution.completedToolResults>";

/// Checks that restored pending tool execution data can be resumed: an assistant message with
/// tool uses, and completed results keyed by tool use ids from that message.
fn validate_pending_tool_execution(pending: JsonValue) -> SdkResult<PendingToolExecution> {
    let mut pending = match pending {
        JsonValue::Object(object) => object,
        _ => JsonObject::new(),
    };
    let message_data = pending.remove("assistantMessageData").unwrap_or(JsonValue::Null);
    let assistant_message: Message = parse_restored(PENDING_MESSAGE_FIELD, message_data)?;
    if assistant_message.role != Role::Assistant {
        return Err(SessionError::new(
            "field=<pendingToolExecution.assistantMessageData.role> | pending tool execution message must be an assistant message",
        )
        .into());
    }
    let tool_use_ids: Vec<&str> = assistant_message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some(tool_use.tool_use_id.as_str()),
            _ => None,
        })
        .collect();
    if tool_use_ids.is_empty() {
        return Err(SessionError::new(
            "field=<pendingToolExecution.assistantMessageData.content> | pending tool execution message has no tool uses",
        )
        .into());
    }
    let Some(JsonValue::Object(results)) = pending.remove("completedToolResults") else {
        return Err(SessionError::new(format!(
            "{PENDING_RESULTS_FIELD} | completed tool results must be an object"
        ))
        .into());
    };
    let mut completed_tool_results = IndexMap::new();
    for (tool_use_id, value) in results {
        let field = format!("{PENDING_RESULTS_FIELD}, tool_use_id=<{tool_use_id}>");
        if !tool_use_ids.contains(&tool_use_id.as_str()) {
            return Err(SessionError::new(format!(
                "{field} | does not match a tool use in the pending assistant message"
            ))
            .into());
        }
        let wrapped = match value {
            JsonValue::Object(mut wrapped) => wrapped.remove("toolResult").unwrap_or(JsonValue::Null),
            _ => JsonValue::Null,
        };
        let result: ToolResultBlock = parse_restored(&field, wrapped)?;
        completed_tool_results.insert(tool_use_id, result);
    }
    Ok(PendingToolExecution::new(assistant_message, completed_tool_results))
}

/// Parses restored data, turning a failure into a `SessionError` with the field context and the
/// parse error as its source.
fn parse_restored<T: serde::de::DeserializeOwned>(field: &str, value: JsonValue) -> SdkResult<T> {
    serde_json::from_value(value).map_err(|error| {
        SessionError::new(format!("{field} | failed to parse restored pending tool execution"))
            .with_source(error)
            .into()
    })
}

mod wrapped_tool_results {
    use indexmap::IndexMap;
    use serde::de::Error as _;
    use serde::ser::SerializeMap;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use crate::types::{JsonValue, ToolResultBlock};

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Wrapped<'a> {
        tool_result: &'a ToolResultBlock,
    }

    pub(super) fn serialize<S: Serializer>(
        results: &IndexMap<String, ToolResultBlock>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(results.len()))?;
        for (tool_use_id, result) in results {
            map.serialize_entry(tool_use_id, &Wrapped { tool_result: result })?;
        }
        map.end()
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<IndexMap<String, ToolResultBlock>, D::Error> {
        IndexMap::<String, JsonValue>::deserialize(deserializer)?
            .into_iter()
            .map(|(tool_use_id, value)| unwrap_tool_result(value).map(|result| (tool_use_id, result)))
            .collect::<Result<_, _>>()
            .map_err(D::Error::custom)
    }

    fn unwrap_tool_result(value: JsonValue) -> Result<ToolResultBlock, serde_json::Error> {
        let JsonValue::Object(mut map) = value else {
            return Err(serde_json::Error::custom("completed tool result must be an object"));
        };
        let Some(inner) = map.remove("toolResult") else {
            return Err(serde_json::Error::custom(
                "completed tool result must hold a toolResult",
            ));
        };
        ToolResultBlock::deserialize(inner)
    }
}

/// The live interrupt state of an agent (`InterruptState`), shared by the loop, hook events and
/// tool contexts. Clones share the same state.
#[derive(Debug, Clone, Default)]
pub(crate) struct InterruptState {
    data: Arc<Mutex<InterruptStateData>>,
}

impl InterruptState {
    /// Creates empty, inactive state.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, InterruptStateData> {
        self.data.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Returns the interrupt registered under `id`, registering a new one first.
    pub(crate) fn get_or_create_interrupt(
        &self,
        id: &str,
        params: &InterruptParams,
        source: InterruptSource,
    ) -> Interrupt {
        let mut data = self.lock();
        data.interrupts
            .entry(id.to_owned())
            .or_insert_with(|| Interrupt {
                id: id.to_owned(),
                name: params.name.clone(),
                reason: params.reason.clone(),
                response: params.response.clone(),
                source,
            })
            .clone()
    }

    /// The response stored for the interrupt `id`, without registering it.
    pub(crate) fn response(&self, id: &str) -> Option<JsonValue> {
        self.lock()
            .interrupts
            .get(id)
            .and_then(|interrupt| interrupt.response.clone())
    }

    /// Raises an interrupt: returns the stored response when the interrupt
    /// was answered (or `params` carries a preemptive response), otherwise the unanswered
    /// interrupt as the error.
    pub(crate) fn raise(
        &self,
        id: &str,
        params: &InterruptParams,
        source: InterruptSource,
    ) -> Result<JsonValue, InterruptError> {
        let interrupt = self.get_or_create_interrupt(id, params, source);
        match interrupt.response {
            Some(response) => Ok(response),
            None => Err(interrupt.into()),
        }
    }

    /// Records a response for an interrupt, as resuming does.
    /// Whether the agent stopped for interrupts and awaits responses (`activated`).
    pub(crate) fn activated(&self) -> bool {
        self.lock().activated
    }

    /// Marks the agent interrupted (`activate`).
    pub(crate) fn activate(&self) {
        self.lock().activated = true;
    }

    /// Clears every interrupt, response and stored execution (`deactivate`).
    pub(crate) fn deactivate(&self) {
        *self.lock() = InterruptStateData::new();
    }

    /// Records the responses of a resume on their interrupts (`resume`). Does nothing unless
    /// activated.
    ///
    /// # Errors
    ///
    /// `interrupt_id=<id> | no interrupt found` for a response to an unknown interrupt.
    pub(crate) fn resume(&self, responses: &[InterruptResponseContent]) -> crate::error::Result<()> {
        let mut data = self.lock();
        if !data.activated {
            return Ok(());
        }
        for content in responses {
            let id = &content.interrupt_response.interrupt_id;
            let Some(interrupt) = data.interrupts.get_mut(id) else {
                return Err(crate::error::Error::other(format!(
                    "interrupt_id=<{id}> | no interrupt found"
                )));
            };
            interrupt.response = Some(content.interrupt_response.response.clone());
        }
        data.resume_responses = Some(responses.to_vec());
        Ok(())
    }

    /// Registers an interrupt raised elsewhere without its response.
    pub(crate) fn register_interrupt(&self, interrupt: &Interrupt) -> Interrupt {
        let params = InterruptParams {
            name: interrupt.name.clone(),
            reason: interrupt.reason.clone(),
            response: None,
        };
        self.get_or_create_interrupt(&interrupt.id, &params, interrupt.source)
    }

    /// The interrupts still awaiting a response, in registration order.
    pub(crate) fn unanswered_interrupts(&self) -> Vec<Interrupt> {
        self.lock()
            .interrupts
            .values()
            .filter(|interrupt| interrupt.response.is_none())
            .cloned()
            .collect()
    }

    /// Every registered interrupt, in registration order.
    pub(crate) fn interrupt_list(&self) -> Vec<Interrupt> {
        self.lock().interrupts.values().cloned().collect()
    }

    /// Forgets the response of an interrupt, so it is unanswered again.
    pub(crate) fn clear_response(&self, id: &str) {
        if let Some(interrupt) = self.lock().interrupts.get_mut(id) {
            interrupt.response = None;
        }
    }

    /// The responses of the latest resume.
    pub(crate) fn resume_responses(&self) -> Vec<InterruptResponseContent> {
        self.lock().resume_responses.clone().unwrap_or_default()
    }

    /// The tool batch to resume, when activated with one stored.
    pub(crate) fn pending_execution(&self) -> Option<PendingToolExecution> {
        let data = self.lock();
        if !data.activated {
            return None;
        }
        data.pending_tool_execution.clone()
    }

    /// Whether a tool batch is stored for resume.
    pub(crate) fn has_pending_tool_execution(&self) -> bool {
        self.lock().pending_tool_execution.is_some()
    }

    /// Stores the tool batch an interrupt stopped.
    pub(crate) fn set_pending_tool_execution(&self, pending: PendingToolExecution) {
        self.lock().pending_tool_execution = Some(pending);
    }

    /// Drops the stored tool batch.
    pub(crate) fn clear_pending_tool_execution(&self) {
        self.lock().pending_tool_execution = None;
    }

    /// A value of the free-form context that subsystems keep with the interrupt state.
    pub(crate) fn context_value(&self, key: &str) -> Option<JsonValue> {
        self.lock()
            .context
            .as_ref()
            .and_then(|context| context.get(key).cloned())
    }

    /// Sets (or with `None` removes) a value of the context.
    pub(crate) fn set_context_value(&self, key: &str, value: Option<JsonValue>) {
        let mut data = self.lock();
        let context = data.context.get_or_insert_with(JsonObject::new);
        match value {
            Some(value) => {
                context.insert(key.to_owned(), value);
            }
            None => {
                context.shift_remove(key);
            }
        }
        if context.is_empty() {
            data.context = None;
        }
    }

    /// A copy of the state as persisted.
    pub(crate) fn to_data(&self) -> InterruptStateData {
        self.lock().clone()
    }

    /// Replaces the state, keeping every clone attached. A stored batch is kept only
    /// when activated.
    pub(crate) fn load_data(&self, mut data: InterruptStateData) {
        if !data.activated {
            data.pending_tool_execution = None;
        }
        *self.lock() = data;
    }

    #[cfg(test)]
    pub(crate) fn respond(&self, id: &str, response: JsonValue) {
        if let Some(interrupt) = self.lock().interrupts.get_mut(id) {
            interrupt.response = Some(response);
        }
    }

    /// The registered interrupts, in the order they were raised.
    #[cfg(test)]
    pub(crate) fn interrupts(&self) -> Vec<Interrupt> {
        self.lock().interrupts.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::types::{ContentBlock, InterruptResponse, Role, ToolResultContent, ToolUseBlock, UnknownBlock};

    fn pending_tool_execution() -> JsonValue {
        json!({
            "assistantMessageData": {
                "role": "assistant",
                "content": [
                    {"toolUse": {"name": "tool", "toolUseId": "t-0", "input": {}}},
                    {"toolUse": {"name": "tool", "toolUseId": "t-1", "input": {}}}
                ],
                "trackingId": "m-1"
            },
            "completedToolResults": {
                "t-0": {"toolResult": {"toolUseId": "t-0", "status": "success", "content": []}}
            }
        })
    }

    #[test]
    fn constructs_with_all_fields_and_supports_response_mutation() {
        let mut interrupt = Interrupt::new("int-1", "confirm_action")
            .with_reason("Please confirm")
            .with_response("approved");
        assert_eq!(
            serde_json::to_value(&interrupt).unwrap(),
            json!({"id": "int-1", "name": "confirm_action", "reason": "Please confirm", "response": "approved", "source": "hook"})
        );
        interrupt.response = Some(json!("changed"));
        assert_eq!(interrupt.response, Some(json!("changed")));
    }

    #[test]
    fn round_trips_through_json_serialization_with_complex_data() {
        let original = Interrupt::new("int-1", "test")
            .with_reason(json!({"complex": {"nested": "data"}}))
            .with_response(json!(["array", "response"]));
        let restored: Interrupt = serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
        assert_eq!(restored, original);
    }

    #[test]
    fn omits_undefined_reason_response_from_to_json() {
        assert_eq!(
            serde_json::to_value(Interrupt::new("int-1", "test")).unwrap(),
            json!({"id": "int-1", "name": "test", "source": "hook"})
        );
    }

    #[test]
    fn keeps_a_null_reason_and_response() {
        let wire = json!({"id": "int-1", "name": "test", "reason": null, "response": null, "source": "tool"});
        let interrupt: Interrupt = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(interrupt.response, Some(JsonValue::Null));
        assert_eq!(serde_json::to_value(&interrupt).unwrap(), wire);
    }

    fn persisted_interrupt_states() -> Vec<(String, String)> {
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/fixtures");
        let mut states = Vec::new();
        for area in ["interrupts", "snapshots", "sessions"] {
            let text = std::fs::read_to_string(fixtures.join(format!("{area}.json"))).unwrap();
            let fixture: JsonValue = serde_json::from_str(&text).unwrap();
            for case in fixture["cases"].as_array().unwrap() {
                let name = format!("{area}/{}", case["name"].as_str().unwrap());
                let json = case["json"].as_str().unwrap();
                if name.starts_with("interrupts/interrupt_state_") {
                    states.push((name, json.to_owned()));
                    continue;
                }
                let value: JsonValue = serde_json::from_str(json).unwrap();
                let state = &value["data"]["interrupts"];
                if state.is_object() {
                    states.push((name, serde_json::to_string(state).unwrap()));
                }
            }
        }
        states
    }

    #[test]
    fn interrupt_state_fixtures_round_trip_byte_identically() {
        let states = persisted_interrupt_states();
        assert!(states.len() >= 6);
        for (name, json) in states {
            let state: InterruptStateData = serde_json::from_str(&json).unwrap();
            assert_eq!(serde_json::to_string(&state).unwrap(), json, "{name}");
        }
    }

    #[test]
    fn legacy_interrupts_without_a_source_default_to_hook() {
        let interrupt: Interrupt = serde_json::from_value(json!({"id": "int-1", "name": "test"})).unwrap();
        assert_eq!(interrupt.source, InterruptSource::Hook);
    }

    #[test]
    fn round_trips_through_json_with_full_state() {
        let mut state = InterruptStateData::new();
        state.interrupts.insert(
            "int-1".into(),
            Interrupt::new("int-1", "test")
                .with_reason(json!({"complex": "reason"}))
                .with_response(json!(["array", "response"])),
        );
        state.activated = true;
        let text = serde_json::to_string(&state).unwrap();
        let restored: InterruptStateData = serde_json::from_str(&text).unwrap();
        assert_eq!(restored, state);
        assert_eq!(serde_json::to_string(&restored).unwrap(), text);
    }

    #[test]
    fn round_trips_pending_tool_execution_through_json() {
        let data = json!({"interrupts": {}, "activated": true, "pendingToolExecution": pending_tool_execution()});
        let state: InterruptStateData = serde_json::from_value(data.clone()).unwrap();
        let pending = state.pending_tool_execution.as_ref().unwrap();
        assert_eq!(pending.assistant_message_data.role, Role::Assistant);
        assert_eq!(
            pending.completed_tool_results["t-0"],
            ToolResultBlock::success("t-0", Vec::new())
        );
        assert_eq!(serde_json::to_value(&state).unwrap(), data);
    }

    #[test]
    fn deserializes_state_with_resume_responses() {
        let state: InterruptStateData = serde_json::from_value(json!({
            "interrupts": {"int-1": {"id": "int-1", "name": "test", "reason": "reason", "response": "yes"}},
            "resumeResponses": [{"interruptResponse": {"interruptId": "int-1", "response": "yes"}}],
            "activated": true
        }))
        .unwrap();
        assert!(state.activated);
        assert_eq!(state.interrupts["int-1"].response, Some(json!("yes")));
        assert_eq!(
            state.resume_responses,
            Some(vec![InterruptResponseContent::new(InterruptResponse::new(
                "int-1", "yes"
            ))])
        );
    }

    #[test]
    fn restores_a_pending_tool_execution_a_newer_sdk_saved_with_content_block_types_this_version_does_not_know() {
        let saved = json!({
            "assistantMessageData": {
                "role": "assistant",
                "content": [
                    {"futureBlock": {"value": 1}},
                    {"toolUse": {"name": "load_tools", "toolUseId": "t-0", "input": {}}},
                    {"toolUse": {"name": "tool", "toolUseId": "t-1", "input": {}}}
                ],
                "trackingId": "m-1"
            },
            "completedToolResults": {
                "t-0": {"toolResult": {
                    "toolUseId": "t-0",
                    "status": "success",
                    "content": [{"text": "loaded"}, {"futureBlock": {"name": "shell"}}]
                }}
            }
        });
        let data = json!({"interrupts": {}, "activated": true, "pendingToolExecution": saved});
        let state: InterruptStateData = serde_json::from_value(data.clone()).unwrap();
        let pending = state.pending_tool_execution.as_ref().unwrap();
        assert!(matches!(
            pending.assistant_message_data.content[0],
            ContentBlock::Unknown(_)
        ));
        assert_eq!(
            pending.assistant_message_data.content[1],
            ToolUseBlock::new("load_tools", "t-0", json!({})).into()
        );
        assert_eq!(
            pending.completed_tool_results["t-0"].content[1],
            ToolResultContent::Unknown(UnknownBlock::new(
                json!({"futureBlock": {"name": "shell"}}).as_object().unwrap().clone()
            ))
        );
        assert_eq!(serde_json::to_value(&state).unwrap(), data);
    }

    #[test]
    fn interrupts_keep_their_insertion_order() {
        let state: InterruptStateData = serde_json::from_value(json!({
            "interrupts": {
                "z": {"id": "z", "name": "z", "source": "tool"},
                "a": {"id": "a", "name": "a", "source": "middleware"}
            },
            "activated": true
        }))
        .unwrap();
        assert_eq!(state.interrupts.keys().collect::<Vec<_>>(), ["z", "a"]);
        assert_eq!(state.interrupts["a"].source, InterruptSource::Middleware);
    }
    fn params(name: &str, reason: Option<&str>) -> InterruptParams {
        let params = InterruptParams::new(name);
        match reason {
            Some(reason) => params.with_reason(reason),
            None => params,
        }
    }

    fn respond(id: &str, response: JsonValue) -> InterruptResponseContent {
        InterruptResponseContent::new(InterruptResponse::new(id, response))
    }

    fn pending() -> PendingToolExecution {
        serde_json::from_value(pending_tool_execution()).unwrap()
    }

    #[test]
    fn creates_new_interrupt_and_stores_it() {
        let state = InterruptState::new();
        let interrupt = state.get_or_create_interrupt("int-1", &params("test", Some("reason")), InterruptSource::Hook);
        assert_eq!(
            serde_json::to_value(&interrupt).unwrap(),
            json!({"id": "int-1", "name": "test", "reason": "reason", "source": "hook"})
        );
        assert_eq!(state.interrupt_list(), vec![interrupt]);
    }

    #[test]
    fn returns_existing_interrupt_by_id_without_overwriting() {
        let state = InterruptState::new();
        state.get_or_create_interrupt("int-1", &params("test", Some("reason")), InterruptSource::Hook);
        state.respond("int-1", json!("user response"));
        let second = state.get_or_create_interrupt(
            "int-1",
            &params("different", Some("different reason")),
            InterruptSource::Hook,
        );
        assert_eq!(second.name, "test");
        assert_eq!(second.response, Some(json!("user response")));
    }

    #[test]
    fn creates_separate_interrupts_for_different_ids_with_same_name() {
        let state = InterruptState::new();
        state.activate();
        let confirm = params("confirm", Some("reason"));
        state.get_or_create_interrupt("tool:tool-1:0:confirm", &confirm, InterruptSource::Tool);
        state.respond("tool:tool-1:0:confirm", json!({"approved": true}));
        let second = state.get_or_create_interrupt("tool:tool-2:0:confirm", &confirm, InterruptSource::Tool);
        assert_eq!(second.id, "tool:tool-2:0:confirm");
        assert_eq!(second.response, None);
        assert_eq!(state.interrupt_list().len(), 2);
    }

    #[test]
    fn creates_interrupt_with_preemptive_response() {
        let state = InterruptState::new();
        let interrupt = state.get_or_create_interrupt(
            "int-1",
            &params("confirm", Some("reason")).with_response("pre-approved"),
            InterruptSource::Hook,
        );
        assert_eq!(
            serde_json::to_value(&interrupt).unwrap(),
            json!({"id": "int-1", "name": "confirm", "reason": "reason", "response": "pre-approved", "source": "hook"})
        );
    }

    #[test]
    fn ignores_preemptive_response_when_interrupt_already_exists() {
        let state = InterruptState::new();
        state.get_or_create_interrupt("int-1", &params("confirm", Some("reason")), InterruptSource::Hook);
        state.respond("int-1", json!("user response"));
        let second = state.get_or_create_interrupt(
            "int-1",
            &params("confirm", Some("reason")).with_response("preemptive"),
            InterruptSource::Hook,
        );
        assert_eq!(
            serde_json::to_value(&second).unwrap(),
            json!({"id": "int-1", "name": "confirm", "reason": "reason", "response": "user response", "source": "hook"})
        );
    }

    #[test]
    fn deactivate_clears_all_state() {
        let state = InterruptState::new();
        state.get_or_create_interrupt("int-1", &params("test", None), InterruptSource::Hook);
        state.activate();
        state.set_pending_tool_execution(pending());
        state.set_context_value("key", Some(json!(1)));
        assert!(state.activated());

        state.deactivate();

        assert_eq!(state.to_data(), InterruptStateData::new());
        assert!(!state.activated());
        assert!(state.resume_responses().is_empty());
    }

    #[test]
    fn does_nothing_when_not_activated() {
        let state = InterruptState::new();
        state.get_or_create_interrupt("int-1", &params("test", None), InterruptSource::Hook);
        state.resume(&[respond("int-1", json!("yes"))]).unwrap();
        assert_eq!(state.interrupt_list()[0].response, None);
        assert!(state.resume_responses().is_empty());
    }

    #[test]
    fn populates_interrupt_responses_and_stores_resume_responses_when_activated() {
        let state = InterruptState::new();
        state.get_or_create_interrupt("int-1", &params("first", None), InterruptSource::Hook);
        state.get_or_create_interrupt("int-2", &params("second", None), InterruptSource::Hook);
        state.activate();
        let responses = vec![
            respond("int-1", json!("response1")),
            respond("int-2", json!({"complex": "data"})),
        ];
        state.resume(&responses).unwrap();
        let interrupts = state.interrupt_list();
        assert_eq!(interrupts[0].response, Some(json!("response1")));
        assert_eq!(interrupts[1].response, Some(json!({"complex": "data"})));
        assert_eq!(state.resume_responses(), responses);
        assert!(state.unanswered_interrupts().is_empty());
    }

    #[test]
    fn throws_error_for_unknown_interrupt_id() {
        let state = InterruptState::new();
        state.get_or_create_interrupt("int-1", &params("test", None), InterruptSource::Hook);
        state.activate();
        let error = state.resume(&[respond("unknown", json!("yes"))]).unwrap_err();
        assert_eq!(error.to_string(), "interrupt_id=<unknown> | no interrupt found");
    }

    #[test]
    fn drops_a_pending_tool_execution_when_the_interrupt_state_is_not_activated() {
        let data: InterruptStateData = serde_json::from_value(
            json!({"interrupts": {}, "activated": false, "pendingToolExecution": pending_tool_execution()}),
        )
        .unwrap();
        let state = InterruptState::new();
        state.load_data(data);
        assert!(!state.has_pending_tool_execution());
    }

    #[test]
    fn throws_session_error_when_the_restored_pending_tool_execution_has_description() {
        let pending = pending_tool_execution();
        let with = |key: &str, value: JsonValue| {
            let mut pending = pending.clone();
            pending[key] = value;
            pending
        };
        let mut user_message = pending["assistantMessageData"].clone();
        user_message["role"] = json!("user");
        let cases = [
            (
                with("assistantMessageData", user_message),
                "field=<pendingToolExecution.assistantMessageData.role>",
            ),
            (
                with(
                    "assistantMessageData",
                    json!({"role": "assistant", "content": "not-a-list"}),
                ),
                "field=<pendingToolExecution.assistantMessageData>",
            ),
            (
                json!({
                    "assistantMessageData": {"role": "assistant", "content": [{"text": "hello"}]},
                    "completedToolResults": {}
                }),
                "field=<pendingToolExecution.assistantMessageData.content>",
            ),
            (
                with("completedToolResults", json!(["t-0"])),
                "field=<pendingToolExecution.completedToolResults>",
            ),
            (
                with(
                    "completedToolResults",
                    json!({"t-9": {"toolResult": {"toolUseId": "t-9", "status": "success", "content": []}}}),
                ),
                "field=<pendingToolExecution.completedToolResults>, tool_use_id=<t-9>",
            ),
            (
                with(
                    "completedToolResults",
                    json!({"t-0": {"toolResult": {"toolUseId": "t-0"}}}),
                ),
                "field=<pendingToolExecution.completedToolResults>, tool_use_id=<t-0>",
            ),
        ];
        for (pending, message) in cases {
            let error = InterruptStateData::from_json(
                json!({"interrupts": {}, "activated": true, "pendingToolExecution": pending}),
            )
            .unwrap_err();
            assert_eq!(error.name(), "SessionError");
            assert!(error.to_string().contains(message), "{error} should contain {message}");
        }
    }

    #[test]
    fn keeps_the_parse_error_as_the_cause_when_the_restored_pending_assistant_message_is_unparseable() {
        let error = InterruptStateData::from_json(json!({
            "interrupts": {},
            "activated": true,
            "pendingToolExecution": {
                "assistantMessageData": {"role": "assistant", "content": "not-a-list"},
                "completedToolResults": {}
            }
        }))
        .unwrap_err();
        assert_eq!(error.name(), "SessionError");
        let Error::Session(session) = &error else {
            panic!("expected a SessionError, got {error:?}");
        };
        assert!(
            session
                .source
                .as_ref()
                .is_some_and(|source| source.is::<serde_json::Error>())
        );
    }

    #[test]
    fn from_json_drops_a_pending_tool_execution_when_not_activated() {
        let data = InterruptStateData::from_json(
            json!({"interrupts": {}, "activated": false, "pendingToolExecution": {"bogus": true}}),
        )
        .unwrap();
        assert!(data.pending_tool_execution.is_none());
    }

    #[test]
    fn returns_undefined_when_the_interrupt_state_is_not_activated() {
        let state = InterruptState::new();
        state.set_pending_tool_execution(pending());
        assert_eq!(state.pending_execution(), None);
    }

    #[test]
    fn returns_the_reconstructed_pending_execution_when_the_interrupt_state_is_activated() {
        let state = InterruptState::new();
        state.activate();
        state.set_pending_tool_execution(pending());
        let execution = state.pending_execution().unwrap();
        assert_eq!(
            serde_json::to_value(&execution.assistant_message_data).unwrap(),
            pending_tool_execution()["assistantMessageData"]
        );
        assert_eq!(execution.completed_tool_results.keys().collect::<Vec<_>>(), ["t-0"]);
        assert_eq!(
            execution.completed_tool_results["t-0"],
            ToolResultBlock::success("t-0", Vec::new())
        );
        state.clear_pending_tool_execution();
        assert!(!state.has_pending_tool_execution());
    }

    #[test]
    fn returns_preemptive_response_immediately_without_throwing() {
        let state = InterruptState::new();
        let result = state.raise(
            "test-id",
            &params("confirm", Some("need approval")).with_response("pre-approved"),
            InterruptSource::Tool,
        );
        assert_eq!(result.unwrap(), json!("pre-approved"));
        assert_eq!(
            serde_json::to_value(&state.interrupt_list()[0]).unwrap(),
            json!({"id": "test-id", "name": "confirm", "reason": "need approval", "response": "pre-approved", "source": "tool"})
        );
    }

    #[test]
    fn returns_resume_response_over_preemptive_response_for_existing_interrupt() {
        let state = InterruptState::new();
        state.get_or_create_interrupt(
            "test-id",
            &params("confirm", Some("need approval")),
            InterruptSource::Tool,
        );
        state.respond("test-id", json!("user-provided"));
        let result = state.raise(
            "test-id",
            &params("confirm", Some("need approval")).with_response("preemptive"),
            InterruptSource::Tool,
        );
        assert_eq!(result.unwrap(), json!("user-provided"));
        assert_eq!(state.interrupt_list()[0].response, Some(json!("user-provided")));
    }

    #[test]
    fn does_not_interrupt_when_preemptive_response_is_null() {
        let state = InterruptState::new();
        let result = state.raise(
            "test-id",
            &params("confirm", None).with_response(JsonValue::Null),
            InterruptSource::Tool,
        );
        assert_eq!(result.unwrap(), JsonValue::Null);
        assert_eq!(state.interrupt_list()[0].response, Some(JsonValue::Null));
    }

    #[test]
    fn an_unanswered_interrupt_is_raised_as_the_error() {
        let state = InterruptState::new();
        let error = state
            .raise("int-1", &params("confirm_delete", None), InterruptSource::Hook)
            .unwrap_err();
        assert_eq!(error.to_string(), "Interrupt raised: confirm_delete");
        assert_eq!(state.unanswered_interrupts(), error.interrupts);
    }

    #[test]
    fn registers_an_interrupt_without_its_response() {
        let state = InterruptState::new();
        let registered = state.register_interrupt(
            &Interrupt::new("int-1", "confirm")
                .with_response("ignored")
                .with_source(InterruptSource::Tool),
        );
        assert_eq!(registered.response, None);
        assert_eq!(registered.source, InterruptSource::Tool);
        state.respond("int-1", json!("yes"));
        state.clear_response("int-1");
        assert_eq!(state.unanswered_interrupts().len(), 1);
    }

    #[test]
    fn persists_the_stored_turn_through_interrupt_state_json() {
        let state = InterruptState::new();
        state.set_context_value("subAgentInterruptedTurns", Some(json!({"outer-1": {"data": {}}})));
        state.activate();
        let json = serde_json::to_string(&state.to_data()).unwrap();
        let restored = InterruptState::new();
        restored.load_data(serde_json::from_str(&json).unwrap());
        assert_eq!(
            restored.context_value("subAgentInterruptedTurns"),
            Some(json!({"outer-1": {"data": {}}}))
        );
        restored.deactivate();
        assert_eq!(restored.context_value("subAgentInterruptedTurns"), None);
        assert_eq!(restored.to_data().context, None);
    }

    #[test]
    fn removing_the_last_context_value_drops_the_context() {
        let state = InterruptState::new();
        state.set_context_value("k", Some(json!(1)));
        state.set_context_value("k", None);
        assert_eq!(state.to_data().context, None);
        assert_eq!(
            serde_json::to_value(state.to_data()).unwrap(),
            json!({"interrupts": {}, "activated": false})
        );
    }
}
