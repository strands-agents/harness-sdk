//! Sandbox helpers shared by the harness tools and plugins.
//!
//! [`shell_of`] tells which shell dialect a sandbox runs commands in. The sandbox contract names
//! none, so it asks: PowerShell prints its edition (`Desktop` or `Core`), `sh` expands the unset
//! variable to an empty line. Probed once per sandbox.

use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::Duration;

use strands::sandbox::{ExecuteOptions, Sandbox};

/// The shell a sandbox runs commands in (`SandboxShell`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxShell {
    Sh,
    PowerShell,
}

/// The probe command (`SHELL_PROBE`).
pub(crate) const SHELL_PROBE: &str = "echo \"${PSEdition}\"";

type Memo = Mutex<Vec<(Weak<dyn Sandbox>, SandboxShell)>>;

static SHELLS: Memo = Mutex::new(Vec::new());

fn same(a: &Weak<dyn Sandbox>, b: &Arc<dyn Sandbox>) -> bool {
    std::ptr::addr_eq(a.as_ptr(), Arc::as_ptr(b))
}

fn remembered(sandbox: &Arc<dyn Sandbox>) -> Option<SandboxShell> {
    let shells = SHELLS.lock().unwrap_or_else(PoisonError::into_inner);
    shells
        .iter()
        .find(|(known, _)| same(known, sandbox))
        .map(|(_, shell)| *shell)
}

fn remember(sandbox: &Arc<dyn Sandbox>, shell: SandboxShell) {
    let mut shells = SHELLS.lock().unwrap_or_else(PoisonError::into_inner);
    shells.retain(|(known, _)| known.strong_count() > 0);
    if !shells.iter().any(|(known, _)| same(known, sandbox)) {
        shells.push((Arc::downgrade(sandbox), shell));
    }
}

/// The shell `sandbox` runs commands in, probed once per sandbox. A probe that exits
/// non-zero is inconclusive: it answers `sh` for this call and probes again next time.
///
/// # Errors
///
/// When the sandbox fails to run the probe.
pub(crate) async fn shell_of(sandbox: &Arc<dyn Sandbox>) -> strands::Result<SandboxShell> {
    if let Some(shell) = remembered(sandbox) {
        return Ok(shell);
    }
    let options = ExecuteOptions {
        timeout: Some(Duration::from_secs(10)),
        ..ExecuteOptions::default()
    };
    let result = sandbox.execute(SHELL_PROBE, options).await?;
    if result.exit_code != 0 {
        return Ok(SandboxShell::Sh);
    }
    let shell = match result.stdout.trim() {
        "Desktop" | "Core" => SandboxShell::PowerShell,
        _ => SandboxShell::Sh,
    };
    remember(sandbox, shell);
    Ok(shell)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use strands::async_trait;
    use strands::sandbox::{ExecutionResult, ExecutionStream, FileInfo};

    use super::*;

    struct Answering {
        results: Mutex<Vec<(i32, &'static str)>>,
        probes: AtomicUsize,
    }

    impl Answering {
        fn new(results: &[(i32, &'static str)]) -> Arc<Self> {
            Arc::new(Self {
                results: Mutex::new(results.to_vec()),
                probes: AtomicUsize::new(0),
            })
        }
    }

    #[async_trait]
    impl Sandbox for Answering {
        fn execute_streaming(&self, _command: &str, _options: ExecuteOptions) -> ExecutionStream {
            unreachable!("the probe goes through execute")
        }

        fn execute_code_streaming(&self, _code: &str, _language: &str, _options: ExecuteOptions) -> ExecutionStream {
            unreachable!("the probe runs no code")
        }

        async fn execute(&self, command: &str, _options: ExecuteOptions) -> strands::Result<ExecutionResult> {
            assert_eq!(command, SHELL_PROBE);
            self.probes.fetch_add(1, Ordering::SeqCst);
            let mut results = self.results.lock().unwrap();
            let (exit_code, stdout) = if results.len() > 1 {
                results.remove(0)
            } else {
                results[0]
            };
            Ok(ExecutionResult::new(exit_code, stdout, ""))
        }

        async fn read_file(&self, path: &str) -> strands::Result<Vec<u8>> {
            Err(strands::SandboxPathNotFoundError::new(path).into())
        }

        async fn write_file(&self, _path: &str, _content: &[u8]) -> strands::Result<()> {
            Ok(())
        }

        async fn remove_file(&self, _path: &str) -> strands::Result<()> {
            Ok(())
        }

        async fn list_files(&self, _path: &str) -> strands::Result<Vec<FileInfo>> {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn recognises_powershell_by_its_edition_and_caches_the_answer_per_sandbox() {
        let answering = Answering::new(&[(0, "Core\r\n")]);
        let sandbox: Arc<dyn Sandbox> = answering.clone();
        assert_eq!(shell_of(&sandbox).await.unwrap(), SandboxShell::PowerShell);
        assert_eq!(shell_of(&sandbox).await.unwrap(), SandboxShell::PowerShell);
        assert_eq!(answering.probes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn treats_an_empty_expansion_as_sh() {
        let sandbox: Arc<dyn Sandbox> = Answering::new(&[(0, "\n")]);
        assert_eq!(shell_of(&sandbox).await.unwrap(), SandboxShell::Sh);
    }

    #[tokio::test]
    async fn does_not_cache_a_failed_probe() {
        let answering = Answering::new(&[(1, ""), (0, "Desktop\n")]);
        let sandbox: Arc<dyn Sandbox> = answering.clone();
        assert_eq!(shell_of(&sandbox).await.unwrap(), SandboxShell::Sh);
        assert_eq!(shell_of(&sandbox).await.unwrap(), SandboxShell::PowerShell);
        assert_eq!(answering.probes.load(Ordering::SeqCst), 2);
    }
}
