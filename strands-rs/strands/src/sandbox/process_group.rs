//! Process-group kills for the processes the SDK spawns. A shell runs each command of a script
//! as its own child, so killing only the shell leaves those commands running; on unix every
//! spawned process leads a new process group and the whole group is killed.

#[cfg(unix)]
use nix::sys::signal::{Signal, killpg};
#[cfg(unix)]
use nix::unistd::Pid;
use tokio::process::{Child, Command};

/// Makes the child the leader of a new process group (unix), so [`ProcessGroup::kill`] reaches
/// every process it starts that does not leave the group itself.
pub(crate) fn isolate(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

/// The process group a spawned child leads, recorded at spawn so the group can still be killed
/// after the child itself has exited and been reaped.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProcessGroup {
    id: Option<u32>,
}

impl ProcessGroup {
    /// The group of `child`, spawned from a command passed to [`isolate`].
    pub(crate) fn of(child: &Child) -> Self {
        Self { id: child.id() }
    }

    /// Kills every process in the group and starts killing `child`.
    pub(crate) fn kill(self, child: &mut Child) {
        self.kill_group();
        let _ = child.start_kill();
    }

    /// Kills every process in the group. Does nothing off unix, where the child is killed
    /// directly.
    pub(crate) fn kill_group(self) {
        kill_group(self.id);
    }
}

#[cfg(unix)]
fn kill_group(id: Option<u32>) {
    let Some(id) = id.and_then(|id| i32::try_from(id).ok()) else {
        return;
    };
    // ESRCH means the group has already ended; there is nothing else to do on failure.
    let _ = killpg(Pid::from_raw(id), Signal::SIGKILL);
}

#[cfg(not(unix))]
fn kill_group(_id: Option<u32>) {}

/// Kills a process group when dropped unless [`disarm`](Self::disarm)ed first, so a dropped
/// stream or future also ends the processes its command started.
#[derive(Debug)]
pub(crate) struct KillGroupOnDrop {
    group: Option<ProcessGroup>,
}

impl KillGroupOnDrop {
    pub(crate) fn new(group: ProcessGroup) -> Self {
        Self { group: Some(group) }
    }

    /// Leaves the group running when this guard drops.
    pub(crate) fn disarm(&mut self) {
        self.group = None;
    }
}

impl Drop for KillGroupOnDrop {
    fn drop(&mut self) {
        if let Some(group) = self.group.take() {
            group.kill_group();
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod tests;
