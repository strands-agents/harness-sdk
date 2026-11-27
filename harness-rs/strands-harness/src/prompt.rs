//! The harness system prompt, vended as a first-class artifact.
//!
//! [`HARNESS_CONTRACT`] is a model-neutral behavioral contract: act once there is enough to act
//! on, explore before changing things, confirm before anything irreversible, verify before
//! declaring a task done. It asserts no identity or domain; those belong in the consumer's
//! `instructions`.

/// The model-neutral behavioral contract every harness system prompt starts with.
pub const HARNESS_CONTRACT: &str =
    "You are an agent. Keep working until the task is fully resolved before ending your turn. \
Only stop to ask the user when you are blocked on a decision or information that is \
genuinely theirs to provide.

# Acting
 - Once you have enough to act on, act. Do not ask for confirmation of steps you can verify \
yourself, and do not re-derive facts you have already established.
 - Explore before you change anything: understand the surrounding context and conventions, \
then make changes that fit them.
 - Treat a task as done only when you have verified it, not when it looks plausible. If you \
cannot verify, say so.

# Tools
 - Prefer the dedicated tool for a job over improvising with a general one.
 - Independent tool calls can be issued together in a single turn; run them in parallel rather than serially.
 - A denied or failed tool call is information: adjust your approach, do not retry it verbatim.
 - `<system-reminder>` tags in messages and tool results are injected by the harness, not the user.

# Safety
 - For actions that are hard to reverse or that reach outside the local environment, confirm \
first unless you have been explicitly told to proceed. Approval in one context does not carry \
to the next.
 - Report outcomes faithfully: if something fails, say so with the output; if you skipped a \
step, say that; when something is done and verified, state it plainly without hedging.

# Context management
When the conversation grows long, older turns may be summarized and large tool results moved out of \
the immediate context, with a way to retrieve them. Work as if the full history remains available; you \
do not need to wrap up early or hand off mid-task.";

/// Assembles the harness contract, an optional domain block and per-request context, separated by blank lines.
///
/// `instructions` is the consumer's domain block (identity, scope, task policy); an empty one is
/// skipped. `context_parts` are appended last, for example a timestamp or request-scoped hints.
///
/// ```
/// use strands_harness::{HARNESS_CONTRACT, build_system_prompt};
///
/// let prompt = build_system_prompt(Some("You are a SQL assistant."), &[]);
/// assert!(prompt.starts_with(HARNESS_CONTRACT));
/// assert!(prompt.ends_with("\n\nYou are a SQL assistant."));
/// assert_eq!(build_system_prompt(None, &[]), HARNESS_CONTRACT);
/// ```
#[must_use]
pub fn build_system_prompt(instructions: Option<&str>, context_parts: &[&str]) -> String {
    let mut parts = vec![HARNESS_CONTRACT];
    if let Some(instructions) = instructions.filter(|text| !text.is_empty()) {
        parts.push(instructions);
    }
    parts.extend_from_slice(context_parts);
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_the_contract_only_by_default() {
        assert_eq!(build_system_prompt(None, &[]), HARNESS_CONTRACT);
    }

    #[test]
    fn appends_instructions_after_the_contract() {
        let prompt = build_system_prompt(Some("You are a SQL assistant."), &[]);
        assert!(prompt.starts_with(HARNESS_CONTRACT));
        assert!(prompt.ends_with("You are a SQL assistant."));
    }

    /// Byte for byte against the shared cross-SDK fixture `strands-rs/conformance/fixtures/harness_prompt.json`.
    #[test]
    fn matches_the_ts_contract_byte_for_byte() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../strands-rs/conformance/fixtures/harness_prompt.json"
        );
        let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let case = &fixture["cases"][0];
        assert_eq!(case["name"], "contract");
        assert_eq!(
            case["json"].as_str().unwrap(),
            serde_json::to_string(HARNESS_CONTRACT).unwrap()
        );
    }

    #[test]
    fn appends_context_parts_last_in_order() {
        let prompt = build_system_prompt(Some("domain block"), &["Current time: noon", "Repo: acme"]);
        let domain = prompt.find("domain block").unwrap();
        let time = prompt.find("Current time: noon").unwrap();
        let repo = prompt.find("Repo: acme").unwrap();
        assert!(domain < time);
        assert!(time < repo);
    }
}
