//! Enabled by default and opting out with an empty list go through `create_harness`, so those
//! cases are in the agent tests.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use strands::sandbox::{ExecutionResult, ExecutionStream, FileInfo, NotASandboxLocalEnvironment};
use strands::testing::MockModel;
use strands::types::ContentBlock;
use strands::{Agent, Error};

use super::*;
use crate::sandbox::SHELL_PROBE;

struct FakeSandbox {
    files: HashMap<String, String>,
    tree: HashMap<String, Vec<FileInfo>>,
    cwd: Option<String>,
    powershell_platform: Option<String>,
    list_calls: AtomicUsize,
    commands: Mutex<Vec<String>>,
}

fn file(name: &str) -> FileInfo {
    FileInfo::new(name).with_is_dir(false)
}

fn dir(name: &str) -> FileInfo {
    FileInfo::new(name).with_is_dir(true)
}

impl FakeSandbox {
    fn new(files: &[(&str, &str)], tree: Vec<(&str, Vec<FileInfo>)>) -> Self {
        Self {
            files: files.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
            tree: tree.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
            cwd: Some("/work".to_owned()),
            powershell_platform: None,
            list_calls: AtomicUsize::new(0),
            commands: Mutex::new(Vec::new()),
        }
    }

    fn with_cwd(mut self, cwd: Option<&str>) -> Self {
        self.cwd = cwd.map(str::to_owned);
        self
    }

    fn powershell(mut self, platform: &str) -> Self {
        self.powershell_platform = Some(platform.to_owned());
        self
    }

    fn into_sandbox(self) -> Arc<dyn Sandbox> {
        Arc::new(self)
    }

    fn answer(&self, command: &str) -> strands::Result<ExecutionResult> {
        let Some(cwd) = &self.cwd else {
            return Err(Error::other("no shell"));
        };
        if let Some(platform) = &self.powershell_platform {
            return Ok(match command {
                SHELL_PROBE => ExecutionResult::new(0, "Desktop\r\n", ""),
                _ if command.starts_with("if ($IsLinux") => ExecutionResult::new(0, format!("{platform}\r\n"), ""),
                _ if command.starts_with("uname") => ExecutionResult::new(1, "", "The term 'uname' is not recognized"),
                _ => ExecutionResult::new(0, format!("{cwd}\r\n"), ""),
            });
        }
        if command == SHELL_PROBE {
            return Ok(ExecutionResult::new(0, "\n", ""));
        }
        let out = if command.starts_with("uname") { "Linux" } else { cwd };
        Ok(ExecutionResult::new(0, format!("{out}\n"), ""))
    }
}

#[async_trait]
impl Sandbox for FakeSandbox {
    fn execute_streaming(&self, _command: &str, _options: ExecuteOptions) -> ExecutionStream {
        Box::pin(futures::stream::empty())
    }

    fn execute_code_streaming(&self, _code: &str, _language: &str, _options: ExecuteOptions) -> ExecutionStream {
        Box::pin(futures::stream::empty())
    }

    async fn execute(&self, command: &str, _options: ExecuteOptions) -> strands::Result<ExecutionResult> {
        self.commands.lock().unwrap().push(command.to_owned());
        self.answer(command)
    }

    async fn read_file(&self, path: &str) -> strands::Result<Vec<u8>> {
        self.files
            .get(path)
            .map(|text| text.as_bytes().to_vec())
            .ok_or_else(|| Error::other(format!("not found: {path}")))
    }

    async fn write_file(&self, _path: &str, _content: &[u8]) -> strands::Result<()> {
        Err(Error::other("unsupported"))
    }

    async fn remove_file(&self, _path: &str) -> strands::Result<()> {
        Err(Error::other("unsupported"))
    }

    async fn list_files(&self, path: &str) -> strands::Result<Vec<FileInfo>> {
        self.list_calls.fetch_add(1, Ordering::SeqCst);
        self.tree
            .get(path)
            .cloned()
            .ok_or_else(|| Error::other(format!("not found: {path}")))
    }
}

fn repo_tree() -> Vec<(&'static str, Vec<FileInfo>)> {
    vec![
        (
            ".",
            vec![
                file("AGENTS.md"),
                file("README.md"),
                dir("harness-py"),
                dir("node_modules"),
                dir(".git"),
            ],
        ),
        ("harness-py", vec![file("AGENTS.md"), file("README.md"), dir("src")]),
        ("harness-py/src", vec![file("AGENTS.md")]),
        ("node_modules", vec![file("README.md")]),
    ]
}

async fn render_once(sandbox: Arc<dyn Sandbox>) -> String {
    render_environment(&sandbox, &OnceCell::new()).await
}

#[tokio::test]
async fn injects_env_agents_md_contents_and_nearby_links() {
    let sandbox = FakeSandbox::new(&[("AGENTS.md", "root agents doc")], repo_tree()).into_sandbox();
    let out = render_once(sandbox).await;
    let date = today_iso();
    assert_eq!(
        out,
        format!(
            "<system-reminder>\n<environment>\nPlatform: Linux\nDate: {date}\nWorking directory: /work\n</environment>\n\n<AGENTS.md>\nroot agents doc\n</AGENTS.md>\n\nOther AGENTS.md files nearby (read as needed): harness-py/AGENTS.md, harness-py/src/AGENTS.md\n\nREADME files nearby (read as needed): README.md, harness-py/README.md\n</system-reminder>"
        )
    );
    assert!(!out.contains("node_modules"));
    assert!(!out.contains(".git"));
}

#[tokio::test]
async fn reports_the_real_working_directory_from_the_local_sandbox_shell() {
    let sandbox: Arc<dyn Sandbox> = Arc::new(NotASandboxLocalEnvironment::new());
    let out = render_once(sandbox).await;
    let cwd = std::env::current_dir().unwrap();
    let line = out
        .lines()
        .find(|line| line.starts_with("Working directory: "))
        .unwrap_or_else(|| panic!("{out}"));
    let name = cwd.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        line.ends_with(&format!("/{name}")) || line.ends_with(&format!("\\{name}")),
        "{out}"
    );
    let platform = out
        .lines()
        .find_map(|line| line.strip_prefix("Platform: "))
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        assert_eq!(platform, "Darwin");
    } else if cfg!(target_os = "linux") {
        assert_eq!(platform, "Linux");
    }
}

#[tokio::test]
async fn reaches_nested_agents_md_within_the_depth_limit() {
    let out = render_once(FakeSandbox::new(&[("AGENTS.md", "x")], repo_tree()).into_sandbox()).await;
    assert!(out.contains("harness-py/src/AGENTS.md"));
}

#[tokio::test]
async fn stops_at_the_depth_limit() {
    let tree = vec![
        (".", vec![dir("a")]),
        ("a", vec![dir("b")]),
        ("a/b", vec![dir("c"), file("AGENTS.md")]),
        ("a/b/c", vec![file("AGENTS.md")]),
    ];
    let out = render_once(FakeSandbox::new(&[], tree).into_sandbox()).await;
    assert!(out.contains("a/b/AGENTS.md"));
    assert!(!out.contains("a/b/c/AGENTS.md"));
}

#[tokio::test]
async fn omits_the_agents_md_section_when_there_is_none() {
    let out = render_once(FakeSandbox::new(&[], vec![(".", vec![file("main.ts")])]).into_sandbox()).await;
    assert!(!out.contains("<AGENTS.md>"));
    assert!(out.contains("<environment>"));
}

#[tokio::test]
async fn truncates_an_oversize_agents_md() {
    let big = "a".repeat(AGENTS_MD_CAP + 500);
    let sandbox = FakeSandbox::new(&[("AGENTS.md", &big)], vec![(".", vec![file("AGENTS.md")])]).into_sandbox();
    let out = render_once(sandbox).await;
    assert!(out.contains(&format!(
        "{}\n\u{2026} (truncated \u{2014} read the full file if you need the rest)\n</AGENTS.md>",
        "a".repeat(AGENTS_MD_CAP)
    )));
    assert!(out.len() < big.len());
}

#[tokio::test]
async fn reports_windows_and_the_powershell_shell_when_the_sandbox_runs_powershell() {
    let sandbox = FakeSandbox::new(&[("AGENTS.md", "x")], vec![(".", vec![file("AGENTS.md")])])
        .with_cwd(Some("C:\\Users\\me\\proj"))
        .powershell("Windows")
        .into_sandbox();
    let out = render_once(sandbox).await;
    assert!(out.contains("Platform: Windows\nShell: PowerShell (the shell tool runs commands in it, not sh)\n"));
    assert!(out.contains("Working directory: C:\\Users\\me\\proj"));
}

#[tokio::test]
async fn asks_a_pwsh_sandbox_for_its_platform_instead_of_assuming_windows() {
    let sandbox = FakeSandbox::new(&[], vec![(".", Vec::new())])
        .powershell("Linux")
        .into_sandbox();
    let out = render_once(sandbox).await;
    assert!(out.contains("Platform: Linux"));
    assert!(out.contains("Shell: PowerShell"));
}

#[tokio::test]
async fn adds_no_shell_line_for_an_sh_sandbox() {
    let out = render_once(FakeSandbox::new(&[], vec![(".", Vec::new())]).into_sandbox()).await;
    assert!(out.contains("Platform: Linux"));
    assert!(!out.contains("Shell:"));
}

#[tokio::test]
async fn omits_platform_and_working_directory_when_the_probes_fail() {
    let sandbox = FakeSandbox::new(&[("AGENTS.md", "x")], vec![(".", vec![file("AGENTS.md")])])
        .with_cwd(None)
        .into_sandbox();
    let out = render_once(sandbox).await;
    assert!(!out.contains("Working directory"));
    assert!(!out.contains("Platform"));
    assert!(out.contains("Date:"));
}

#[tokio::test]
async fn memoizes_discovery_across_turns() {
    let fake = Arc::new(FakeSandbox::new(&[("AGENTS.md", "x")], repo_tree()));
    let sandbox: Arc<dyn Sandbox> = fake.clone();
    let memo = OnceCell::new();
    render_environment(&sandbox, &memo).await;
    let after_first = fake.list_calls.load(Ordering::SeqCst);
    let commands = fake.commands.lock().unwrap().len();
    render_environment(&sandbox, &memo).await;
    assert_eq!(fake.list_calls.load(Ordering::SeqCst), after_first);
    assert_eq!(fake.commands.lock().unwrap().len(), commands);
}

#[tokio::test]
async fn injects_the_block_into_the_first_user_turn() {
    let sandbox = FakeSandbox::new(&[("AGENTS.md", "docs")], vec![(".", vec![file("AGENTS.md")])]).into_sandbox();
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("ok"))
        .plugins([EnvironmentContext::default()])
        .sandbox(sandbox)
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("hi").await.unwrap();
    let injected: Vec<&ContentBlock> = agent.messages()[0]
        .content
        .iter()
        .filter(|block| matches!(block, ContentBlock::Injected(_)))
        .collect();
    assert_eq!(injected.len(), 1);
    let text = serde_json::to_string(injected[0]).unwrap();
    assert!(text.contains("<AGENTS.md>\\ndocs\\n</AGENTS.md>"), "{text}");
}
