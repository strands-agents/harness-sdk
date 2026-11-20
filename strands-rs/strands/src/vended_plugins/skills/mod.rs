//! [AgentSkills.io](https://agentskills.io) skills for agents.
//!
//! Skills disclose instructions progressively: [`AgentSkills`] lists each skill's name and
//! description in the system prompt, and the agent loads a skill's full instructions on demand
//! through the `skills` tool. A skill is a directory with a `SKILL.md` file (YAML frontmatter and
//! markdown instructions), raw `SKILL.md` content, an `https://` URL of that content, or a
//! [`Skill`] built in code.
//!
//! ```no_run
//! use strands::Agent;
//! use strands::vended_plugins::skills::{AgentSkills, AgentSkillsConfig};
//!
//! let skills = AgentSkills::new(
//!     AgentSkillsConfig::builder()
//!         .skills(["./skills/pdf-processing", "./skills/"])
//!         .build(),
//! );
//! let agent = Agent::builder().plugins([skills]).build()?;
//! # let _ = agent;
//! # Ok::<(), strands::Error>(())
//! ```

mod agent_skills;
mod skill;

pub use agent_skills::{AgentSkills, AgentSkillsConfig, AgentSkillsConfigBuilder, SkillSource};
pub use skill::{Skill, SkillConfig, SkillConfigBuilder, SkillLoadOptions, SkillLoadOptionsBuilder};
