//! Ready-made intervention handlers.
//!
//! - [`hitl`]: [`HumanInTheLoop`](hitl::HumanInTheLoop) asks a human before tool calls.
//! - `cedar` (feature `cedar`): `CedarAuthorization` authorizes tool calls with Cedar policies.
//! - `dogwood` (feature `dogwood`): `DogwoodAuthorization` authorizes tool calls with Dogwood
//!   policies, including temporal rules over earlier calls.

#[cfg(feature = "cedar")]
pub mod cedar;
#[cfg(feature = "dogwood")]
pub mod dogwood;
pub mod hitl;
