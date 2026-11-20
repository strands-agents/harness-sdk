//! Ready-made intervention handlers.
//!
//! - [`hitl`]: [`HumanInTheLoop`](hitl::HumanInTheLoop) asks a human before tool calls.
//! - `cedar` (feature `cedar`): `CedarAuthorization` authorizes tool calls with Cedar policies.

#[cfg(feature = "cedar")]
pub mod cedar;
pub mod hitl;
