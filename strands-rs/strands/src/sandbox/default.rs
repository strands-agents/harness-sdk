//! The process-wide default sandbox.

use std::sync::{Arc, LazyLock};

use crate::sandbox::base::Sandbox;
use crate::sandbox::not_a_sandbox_local_environment::NotASandboxLocalEnvironment;

static DEFAULT_SANDBOX: LazyLock<Arc<dyn Sandbox>> = LazyLock::new(|| Arc::new(NotASandboxLocalEnvironment::new()));

/// The sandbox an agent uses when none is configured (`defaultSandbox.get()`): one shared
/// [`NotASandboxLocalEnvironment`].
pub(crate) fn default_sandbox() -> &'static Arc<dyn Sandbox> {
    &DEFAULT_SANDBOX
}

/// Also covers the registration of the tools a configured sandbox vends.
#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;
    use crate::Agent;
    use crate::error::Result;
    use crate::sandbox::{ExecuteOptions, ExecutionStream, FileInfo};
    use crate::test_support::MockTool;
    use crate::testing::MockModel;
    use crate::tools::Tool;

    fn agent(sandbox: Option<Arc<dyn Sandbox>>) -> Agent {
        Agent::builder()
            .model(MockModel::new())
            .printer(false)
            .maybe_sandbox(sandbox)
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn returns_the_instance_registered_by_the_setup_file() {
        let sandbox = default_sandbox();
        assert!(Arc::ptr_eq(sandbox, default_sandbox()));
        let command = if cfg!(windows) { "Write-Output hi" } else { "echo hi" };
        let result = sandbox.execute(command, ExecuteOptions::default()).await.unwrap();
        assert_eq!(result.stdout.trim(), "hi");
    }

    #[test]
    fn returns_the_configured_sandbox_when_one_is_provided() {
        let sandbox: Arc<dyn Sandbox> = Arc::new(NotASandboxLocalEnvironment::new());
        let agent = agent(Some(sandbox.clone()));
        assert!(Arc::ptr_eq(agent.sandbox(), &sandbox));
        assert!(Arc::ptr_eq(agent.local().sandbox(), &sandbox));
        assert!(Arc::ptr_eq(agent.local().tool_agent().sandbox(), &sandbox));
    }

    #[test]
    fn falls_back_to_the_registered_default_when_unconfigured() {
        let agent = agent(None);
        assert!(Arc::ptr_eq(agent.sandbox(), default_sandbox()));
        assert!(Arc::ptr_eq(agent.local().tool_agent().sandbox(), default_sandbox()));
    }

    #[test]
    fn treats_sandbox_false_the_same_as_unconfigured() {
        let agent = Agent::builder().model(MockModel::new()).printer(false).build().unwrap();
        assert!(Arc::ptr_eq(agent.sandbox(), default_sandbox()));
    }

    struct Vending;

    #[async_trait]
    impl Sandbox for Vending {
        fn execute_streaming(&self, command: &str, options: ExecuteOptions) -> ExecutionStream {
            default_sandbox().execute_streaming(command, options)
        }

        fn execute_code_streaming(&self, code: &str, language: &str, options: ExecuteOptions) -> ExecutionStream {
            default_sandbox().execute_code_streaming(code, language, options)
        }

        async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
            default_sandbox().read_file(path).await
        }

        async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
            default_sandbox().write_file(path, content).await
        }

        async fn remove_file(&self, path: &str) -> Result<()> {
            default_sandbox().remove_file(path).await
        }

        async fn list_files(&self, path: &str) -> Result<Vec<FileInfo>> {
            default_sandbox().list_files(path).await
        }

        fn get_tools(&self) -> Vec<Arc<dyn Tool>> {
            vec![
                Arc::new(MockTool::new("vended").with_description("from the sandbox")),
                Arc::new(MockTool::new("shared").with_description("from the sandbox")),
            ]
        }
    }

    #[tokio::test]
    async fn registers_the_tools_a_configured_sandbox_vends_at_initialization() {
        let mut agent = Agent::builder()
            .model(MockModel::new())
            .printer(false)
            .sandbox(Arc::new(Vending))
            .tools([MockTool::new("shared").with_description("from the user")])
            .build()
            .unwrap();
        assert!(agent.tool_registry().get("vended").is_none());
        agent.initialize().await.unwrap();
        assert!(agent.tool_registry().get("vended").is_some());
        let shared = agent.tool_registry().get("shared").unwrap();
        assert_eq!(shared.description(), "from the user");
    }

    #[tokio::test]
    async fn the_default_sandbox_vends_no_tools() {
        let mut agent = agent(None);
        agent.initialize().await.unwrap();
        assert!(agent.tool_registry().is_empty());
    }
}
