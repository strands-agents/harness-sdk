//! Agent metadata passed to models.

/// Read-only view of the invoking agent, passed to a model with each request (`AgentMetadata`).
///
/// The agent fills it per request, so one model shared by several agents sees each agent's own
/// identity rather than a value fixed at construction.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct AgentMetadata {
    /// The agent's persisted session id; present only when a session manager is attached.
    pub session_id: Option<String>,
}

impl AgentMetadata {
    /// Creates empty metadata.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the session id.
    #[must_use]
    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }
}
