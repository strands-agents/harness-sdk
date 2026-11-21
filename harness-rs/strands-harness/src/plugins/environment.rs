//! `EnvironmentContext`: surface the working environment and project docs to the model.
//!
//! Before each user turn an internal [`ContextInjector`] writes a small block: the platform, the
//! sandbox shell when it is PowerShell, the current date (injected rather than put in the system
//! prompt, so the cached prompt prefix stays warm), the working directory, the contents of the
//! project's `AGENTS.md`, and links to other `AGENTS.md` / `README.md` files a couple of levels
//! down (links, not contents, so the block stays small).
//!
//! Everything is read through the agent's sandbox, so it works against a local, Docker or SSH
//! sandbox. Discovery (the directory walk, platform and working directory) runs once per agent;
//! only the date is recomputed each turn. `AGENTS.md` contents are injected verbatim: repo docs
//! are trusted, the same files the agent's `read` tool already surfaces.

use std::sync::Arc;

use async_trait::async_trait;
use futures::future::BoxFuture;
use strands::Plugin;
use strands::agent::LocalAgent;
use strands::injection::InjectionTrigger;
use strands::sandbox::{ExecuteOptions, Sandbox};
use strands::vended_plugins::context_injector::{ContextInjector, ContextInjectorConfig};
use tokio::sync::OnceCell;

use crate::sandbox::{SandboxShell, shell_of};

const DEFAULT_NAME: &str = "strands:environment";

/// How many directory levels below the working directory discovery scans.
const DISCOVERY_DEPTH: usize = 2;

/// `AGENTS.md` is injected in full up to this many characters; a longer file is truncated with a
/// marker (`AGENTS_MD_CAP`).
pub(crate) const AGENTS_MD_CAP: usize = 16_000;

/// Dependency, build and VCS trees discovery skips; hidden directories are skipped too.
const SKIP_DIRS: [&str; 8] = [
    "node_modules",
    "dist",
    "build",
    "target",
    "__pycache__",
    "venv",
    "site-packages",
    "vendor",
];

const AGENTS_FILE: &str = "AGENTS.md";
const README_FILE: &str = "README.md";

/// `$IsLinux`/`$IsMacOS` are unset on Windows PowerShell 5.1.
const PWSH_PLATFORM_PROBE: &str = "if ($IsLinux -or $IsMacOS) { uname -s } else { 'Windows' }";

/// What discovery found, once per agent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Gathered {
    platform: Option<String>,
    cwd: Option<String>,
    shell: Option<SandboxShell>,
    agents_md: Option<String>,
    other_agents: Vec<String>,
    readmes: Vec<String>,
}

/// Configuration for the [`EnvironmentContext`] plugin (`EnvironmentContextConfig`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct EnvironmentContextConfig {
    /// Plugin name, for logging and duplicate detection. Defaults to `strands:environment`.
    pub name: Option<String>,
}

/// Injects working-environment and project-doc context before each user turn
/// (`EnvironmentContext`).
///
/// Reads through the agent's sandbox, so it honours whatever sandbox the agent runs against.
/// Sharing one instance across agents is safe: the memoized discovery is scoped per
/// [`init_agent`](Plugin::init_agent) call.
///
/// ```
/// use strands::Plugin;
/// use strands_harness::EnvironmentContext;
///
/// assert_eq!(EnvironmentContext::default().name(), "strands:environment");
/// ```
#[derive(Debug, Clone)]
pub struct EnvironmentContext {
    name: String,
}

impl Default for EnvironmentContext {
    fn default() -> Self {
        Self::new(EnvironmentContextConfig::default())
    }
}

impl EnvironmentContext {
    /// The plugin with `config`.
    #[must_use]
    pub fn new(config: EnvironmentContextConfig) -> Self {
        Self {
            name: config.name.unwrap_or_else(|| DEFAULT_NAME.to_owned()),
        }
    }
}

#[async_trait]
impl Plugin for EnvironmentContext {
    fn name(&self) -> &str {
        &self.name
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> strands::Result<()> {
        let memo: Arc<OnceCell<Gathered>> = Arc::default();
        let config = ContextInjectorConfig::new(move |context| {
            let memo = memo.clone();
            let sandbox = context.agent.sandbox().clone();
            async move { Ok(Some(render_environment(&sandbox, &memo).await)) }
        })
        .with_name(format!("{}:injector", self.name))
        .with_trigger(InjectionTrigger::UserTurn);
        ContextInjector::new(config).init_agent(agent).await
    }
}

/// The injected block, gathering (and memoizing) the static parts on the first call.
async fn render_environment(sandbox: &Arc<dyn Sandbox>, memo: &OnceCell<Gathered>) -> String {
    let gathered = memo.get_or_init(|| gather(sandbox)).await;
    render(gathered, &today_iso())
}

/// The local calendar date, not UTC: an evening turn at a negative offset is still today.
fn today_iso() -> String {
    jiff::Zoned::now().date().to_string()
}

fn render(gathered: &Gathered, date: &str) -> String {
    let mut env = Vec::new();
    if let Some(platform) = &gathered.platform {
        env.push(format!("Platform: {platform}"));
    }
    if gathered.shell == Some(SandboxShell::PowerShell) {
        env.push("Shell: PowerShell (the shell tool runs commands in it, not sh)".to_owned());
    }
    env.push(format!("Date: {date}"));
    if let Some(cwd) = &gathered.cwd {
        env.push(format!("Working directory: {cwd}"));
    }
    let mut sections = vec![format!("<environment>\n{}\n</environment>", env.join("\n"))];
    if let Some(agents_md) = gathered.agents_md.as_deref().filter(|text| !text.is_empty()) {
        sections.push(format!("<AGENTS.md>\n{agents_md}\n</AGENTS.md>"));
    }
    if !gathered.other_agents.is_empty() {
        sections.push(format!(
            "Other AGENTS.md files nearby (read as needed): {}",
            gathered.other_agents.join(", ")
        ));
    }
    if !gathered.readmes.is_empty() {
        sections.push(format!(
            "README files nearby (read as needed): {}",
            gathered.readmes.join(", ")
        ));
    }
    format!("<system-reminder>\n{}\n</system-reminder>", sections.join("\n\n"))
}

/// Platform and working directory come from the sandbox (`uname`, `$PWD`), not the host
/// process, so they describe where the agent actually runs.
async fn gather(sandbox: &Arc<dyn Sandbox>) -> Gathered {
    let shell = shell_of(sandbox).await.ok();
    let platform_probe = if shell == Some(SandboxShell::PowerShell) {
        PWSH_PLATFORM_PROBE
    } else {
        "uname -s"
    };
    let platform = probe(sandbox.as_ref(), platform_probe).await;
    let cwd = probe(sandbox.as_ref(), "echo \"$PWD\"").await;
    let agents_md = read_capped(sandbox.as_ref(), AGENTS_FILE).await;
    let mut found = Found::default();
    visit(sandbox.as_ref(), String::new(), 0, &mut found).await;
    Gathered {
        platform,
        cwd,
        shell,
        agents_md,
        other_agents: found.agents.into_iter().filter(|path| path != AGENTS_FILE).collect(),
        readmes: found.readmes,
    }
}

async fn probe(sandbox: &dyn Sandbox, command: &str) -> Option<String> {
    let result = sandbox.execute(command, ExecuteOptions::default()).await.ok()?;
    let out = result.stdout.trim();
    if result.exit_code != 0 || out.is_empty() {
        return None;
    }
    out.lines().next().map(|line| line.trim_end_matches('\r').to_owned())
}

async fn read_capped(sandbox: &dyn Sandbox, path: &str) -> Option<String> {
    let text = sandbox.read_text(path).await.ok()?;
    if text.chars().count() <= AGENTS_MD_CAP {
        return Some(text);
    }
    let kept: String = text.chars().take(AGENTS_MD_CAP).collect();
    Some(format!(
        "{kept}\n\u{2026} (truncated \u{2014} read the full file if you need the rest)"
    ))
}

#[derive(Default)]
struct Found {
    agents: Vec<String>,
    readmes: Vec<String>,
}

fn visit<'a>(sandbox: &'a dyn Sandbox, rel: String, depth: usize, found: &'a mut Found) -> BoxFuture<'a, ()> {
    Box::pin(async move {
        let listed = if rel.is_empty() { "." } else { rel.as_str() };
        let Ok(entries) = sandbox.list_files(listed).await else {
            return;
        };
        for entry in entries {
            let path = if rel.is_empty() {
                entry.name.clone()
            } else {
                format!("{rel}/{}", entry.name)
            };
            if entry.is_dir == Some(true) {
                let descend = depth < DISCOVERY_DEPTH
                    && !SKIP_DIRS.contains(&entry.name.as_str())
                    && !entry.name.starts_with('.');
                if descend {
                    visit(sandbox, path, depth + 1, found).await;
                }
                continue;
            }
            match entry.name.as_str() {
                AGENTS_FILE => found.agents.push(path),
                README_FILE => found.readmes.push(path),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests;
