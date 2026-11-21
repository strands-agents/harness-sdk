//! Agent snapshots: point-in-time captures of an agent's messages, state, system prompt, model
//! state and interrupts, in the persisted layout shared with the other Strands SDKs.

use std::fmt;
use std::str::FromStr;

use super::local_agent::LocalAgent;
use crate::clock::iso_timestamp;
use crate::error::{Error, Result};
use crate::interrupt::InterruptStateData;
use crate::types::{JsonObject, JsonValue, Message, SNAPSHOT_SCHEMA_VERSION, Scope, Snapshot, SystemPrompt};

/// A field an agent snapshot can capture (`SnapshotField`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SnapshotField {
    /// The conversation history, `"messages"`.
    Messages,
    /// The app state, `"state"`.
    State,
    /// The system prompt, `"systemPrompt"`.
    SystemPrompt,
    /// The model provider's state, `"modelState"`.
    ModelState,
    /// The interrupt state, `"interrupts"`.
    Interrupts,
}

/// Every snapshot field, in the order a snapshot writes them (`ALL_SNAPSHOT_FIELDS`).
pub(crate) const ALL_SNAPSHOT_FIELDS: [SnapshotField; 5] = [
    SnapshotField::Messages,
    SnapshotField::State,
    SnapshotField::SystemPrompt,
    SnapshotField::ModelState,
    SnapshotField::Interrupts,
];

impl SnapshotField {
    /// The field's key in `Snapshot::data`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Messages => "messages",
            Self::State => "state",
            Self::SystemPrompt => "systemPrompt",
            Self::ModelState => "modelState",
            Self::Interrupts => "interrupts",
        }
    }
}

impl fmt::Display for SnapshotField {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SnapshotField {
    type Err = Error;

    /// Parses a field key, failing on an unknown one.
    fn from_str(name: &str) -> Result<Self> {
        ALL_SNAPSHOT_FIELDS
            .into_iter()
            .find(|field| field.as_str() == name)
            .ok_or_else(|| {
                let valid: Vec<&str> = ALL_SNAPSHOT_FIELDS.iter().map(|field| field.as_str()).collect();
                Error::other(format!(
                    "Invalid snapshot field: {name}. Valid fields are: {}",
                    valid.join(", ")
                ))
            })
    }
}

/// A named set of snapshot fields (`SnapshotPreset`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SnapshotPreset {
    /// Everything a session needs to resume the agent, `"session"`: all five fields.
    Session,
}

impl SnapshotPreset {
    /// The preset's name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
        }
    }

    /// The fields the preset captures (`SNAPSHOT_PRESETS`).
    #[must_use]
    pub fn fields(self) -> &'static [SnapshotField] {
        match self {
            Self::Session => &ALL_SNAPSHOT_FIELDS,
        }
    }
}

impl FromStr for SnapshotPreset {
    type Err = Error;

    /// Parses a preset name, failing on an unknown one.
    fn from_str(name: &str) -> Result<Self> {
        match name {
            "session" => Ok(Self::Session),
            _ => Err(Error::other(format!(
                "Invalid preset: {name}. Valid presets are: session"
            ))),
        }
    }
}

/// Which fields [`Agent::take_snapshot`](crate::Agent::take_snapshot) captures
/// (`TakeSnapshotOptions`): the preset's fields, plus `include`, minus `exclude`.
///
/// ```
/// use strands::agent::{SnapshotField, SnapshotPreset, TakeSnapshotOptions};
///
/// let options = TakeSnapshotOptions {
///     preset: Some(SnapshotPreset::Session),
///     exclude: vec![SnapshotField::Interrupts],
///     ..Default::default()
/// };
/// # let _ = options;
/// ```
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct TakeSnapshotOptions {
    /// The starting set of fields; none when unset.
    pub preset: Option<SnapshotPreset>,
    /// Fields added to the preset's.
    #[builder(default)]
    pub include: Vec<SnapshotField>,
    /// Fields removed after the preset and `include` are applied.
    #[builder(default)]
    pub exclude: Vec<SnapshotField>,
    /// Application-owned data stored in the snapshot; Strands never reads it (`appData`).
    pub app_data: Option<JsonObject>,
}

impl TakeSnapshotOptions {
    /// The `session` preset (`{ preset: 'session' }`).
    #[must_use]
    pub fn session() -> Self {
        Self {
            preset: Some(SnapshotPreset::Session),
            ..Self::default()
        }
    }
}

impl From<SnapshotPreset> for TakeSnapshotOptions {
    fn from(preset: SnapshotPreset) -> Self {
        Self {
            preset: Some(preset),
            ..Self::default()
        }
    }
}

impl LocalAgent {
    /// Captures a point-in-time snapshot of the agent's state.
    ///
    /// # Errors
    ///
    /// When the options select no field, or a value fails to serialize.
    pub fn take_snapshot(&self, options: impl Into<TakeSnapshotOptions>) -> Result<Snapshot> {
        take_snapshot(self, &options.into())
    }

    /// Restores the agent's state from a snapshot. Only the fields present in
    /// `snapshot.data` are restored; the others stay as they are. Once the agent is initialized,
    /// its background tasks refuse the load while they track tasks, and reload theirs from a
    /// restored `state`, as [`Agent::load_snapshot`](crate::Agent::load_snapshot) does.
    ///
    /// # Errors
    ///
    /// A snapshot of another scope or schema version, data that does not decode, or background
    /// tasks still tracked. Nothing is restored when an error is returned.
    pub fn load_snapshot(&mut self, snapshot: &Snapshot) -> Result<()> {
        let background_tasks = self.background_tasks().cloned();
        if let Some(background_tasks) = &background_tasks {
            background_tasks.assert_can_load_snapshot()?;
        }
        load_snapshot(self, snapshot)?;
        if let Some(background_tasks) = background_tasks
            && snapshot.data.contains_key("state")
        {
            background_tasks.load_app_state(self);
        }
        Ok(())
    }
}

/// Resolves the fields a snapshot captures, in [`ALL_SNAPSHOT_FIELDS`] order.
///
/// # Errors
///
/// When no field is left: `No fields to include in snapshot. Specify a preset or include fields.`
pub(crate) fn resolve_snapshot_fields(options: &TakeSnapshotOptions) -> Result<Vec<SnapshotField>> {
    let preset = options.preset.map(SnapshotPreset::fields).unwrap_or_default();
    let fields: Vec<SnapshotField> = ALL_SNAPSHOT_FIELDS
        .into_iter()
        .filter(|field| preset.contains(field) || options.include.contains(field))
        .filter(|field| !options.exclude.contains(field))
        .collect();
    if fields.is_empty() {
        return Err(Error::other(
            "No fields to include in snapshot. Specify a preset or include fields.",
        ));
    }
    Ok(fields)
}

/// Captures the agent's state.
pub(crate) fn take_snapshot(agent: &LocalAgent, options: &TakeSnapshotOptions) -> Result<Snapshot> {
    let mut data = JsonObject::new();
    for field in resolve_snapshot_fields(options)? {
        let value = match field {
            SnapshotField::Messages => serde_json::to_value(agent.messages())?,
            SnapshotField::State => agent.app_state().to_json(),
            SnapshotField::SystemPrompt => match agent.system_prompt() {
                Some(system_prompt) => serde_json::to_value(system_prompt)?,
                None => JsonValue::Null,
            },
            SnapshotField::ModelState => agent.model_state().to_json(),
            SnapshotField::Interrupts => serde_json::to_value(agent.interrupt_state().to_data())?,
        };
        data.insert(field.as_str().to_owned(), value);
    }
    Ok(Snapshot::new(Scope::Agent, iso_timestamp(), data).with_app_data(options.app_data.clone().unwrap_or_default()))
}

/// The `session` snapshot agents as tools use to reset a sub-agent and to persist its interrupted
/// turn.
pub(crate) fn take_session_snapshot(agent: &LocalAgent) -> Result<Snapshot> {
    take_snapshot(agent, &TakeSnapshotOptions::session())
}

/// Restores the fields present in a snapshot; absent fields stay as they are.
/// A `null` system prompt clears it; `null` interrupts leave the interrupt state alone.
pub(crate) fn load_snapshot(agent: &mut LocalAgent, snapshot: &Snapshot) -> Result<()> {
    if snapshot.scope != Scope::Agent {
        return Err(Error::other(format!(
            "Expected snapshot scope 'agent', got '{}'",
            serde_json::to_value(snapshot.scope)?.as_str().unwrap_or_default()
        )));
    }
    if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(Error::other(format!(
            "Unsupported snapshot schema version: {}. Current version: {SNAPSHOT_SCHEMA_VERSION}",
            snapshot.schema_version
        )));
    }
    let data = &snapshot.data;
    let messages = data
        .get("messages")
        .map(|messages| serde_json::from_value::<Vec<Message>>(messages.clone()))
        .transpose()?;
    let system_prompt = data
        .get("systemPrompt")
        .map(|system_prompt| match system_prompt {
            JsonValue::Null => Ok(None),
            value => serde_json::from_value::<SystemPrompt>(value.clone()).map(Some),
        })
        .transpose()?;
    let interrupts = data
        .get("interrupts")
        .filter(|value| !value.is_null())
        .map(|value| InterruptStateData::from_json(value.clone()))
        .transpose()?;

    if let Some(messages) = messages {
        *agent.messages_mut() = messages;
    }
    if let Some(state) = data.get("state") {
        agent.app_state().load_json(state.clone());
    }
    if let Some(system_prompt) = system_prompt {
        agent.set_system_prompt(system_prompt);
    }
    if let Some(model_state) = data.get("modelState") {
        agent.model_state().load_json(model_state.clone());
    }
    if let Some(interrupts) = interrupts {
        agent.interrupt_state().load_data(interrupts);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
