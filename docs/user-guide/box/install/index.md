The installer downloads a Box release from `strands-agents/box` on GitHub, checks it, and puts `box` on your `PATH`. On macOS, the checks include Apple’s signing and notarization. To build `box` yourself instead, see [Build from source](#build-from-source).

## Requirements

An Apple Silicon Mac with macOS 15 or later. On Linux, ARM64 or x86\_64, you need glibc 2.34 or later, `libgcc`, Python 3, `curl`, and GNU utilities (`coreutils`, `diffutils`, `findutils`, `tar`, `gzip`, `awk`, `sed`, and `grep`). See [How Linux differs](/docs/user-guide/box/limitations/index.md#how-linux-differs) for what is different from a Mac. The installer refuses Intel Macs, older macOS versions, and other Linux architectures.

The installer downloads releases from GitHub with `curl`, so you don’t need a GitHub account. You don’t need sudo, Rust, or a checkout of the source either.

Install your agent, such as Claude Code, and set up its credentials first. The installer does neither.

## Install

Download the installer and run it:

```sh
curl -fsSL https://raw.githubusercontent.com/strands-agents/box/526b5a0cf70e792fb1e5e9ca9b11ba0ed58f3ba6/install.sh | sh
```

Example output on a Mac:

```text
Downloading box-cli-v0.3.0-aarch64-apple-darwin.tar.gz...
Verified checksum, archive, and Apple signature
Installed box 0.3.0.
Added box to $PATH in /Users/you/.zshrc
Open a new terminal, or run: export PATH="$HOME/.local/bin:$PATH"

box run <profile>       # Start an agent in a box, from your project
box profile <command>   # Create, show, and remove profiles

Example next steps (Claude Code with Bedrock):

box profile create claude --with bedrock   # Then set its model and sign in to Bedrock
box run claude                             # Run from your project

box sends usage telemetry to telemetry.strandsagents.com
To opt out, run: box telemetry off
To learn more: https://github.com/strands-agents/box/blob/526b5a0cf70e792fb1e5e9ca9b11ba0ed58f3ba6/CLI_TELEMETRY.md
```

In a color terminal, a progress bar replaces the `Downloading` and `Installed` lines. On Linux, the check line is `Verified checksum and archive`, because there are no Apple checks. The telemetry lines appear only while telemetry is on, so if you’ve already [turned it off](/docs/user-guide/box/reference/cli/index.md#box-telemetry), a new install keeps that choice and leaves them out.

Open a new terminal as it says, and check that `box` runs:

```console
$ box --version
box 0.3.0
```

The installer checks the download before it changes your installed release. If a check fails, or the new release doesn’t start, you keep the release you had.

Next, [create a Claude Code profile](/docs/user-guide/box/quickstart/index.md#2-create-a-claude-code-profile).

## What the installer adds

Each release gets its own folder in `~/.strands/box/packages`, and `current` points to the one you use. The installer links `~/.local/bin/box` to the `box` in `current`. The rest of `~/.strands/box` is in [Where Box keeps its files](/docs/user-guide/box/reference/files/index.md).

Only `box` goes in `~/.local/bin`, and an agent in a box can’t write there. If that folder isn’t on your `PATH`, the installer adds it to your shell’s startup files and prints each file it changes:

| Shell | Files |
| --- | --- |
| zsh | `~/.zshrc`, or `$ZDOTDIR/.zshrc` when `ZDOTDIR` is set |
| bash | `~/.bashrc`, and the first of `~/.bash_profile`, `~/.bash_login`, or `~/.profile` that exists (`~/.bash_profile` if none does) |
| fish | `~/.config/fish/conf.d/box.fish`, under `$XDG_CONFIG_HOME` when that is set |

The installer reads your shell from `SHELL`. If `SHELL` is unset, it uses zsh on macOS and bash on Linux.

## Upgrade or choose a version

To upgrade to the latest release, run the install command again. To install another release, run the installer again with its number in `BOX_VERSION`:

```sh
curl -fsSL https://raw.githubusercontent.com/strands-agents/box/526b5a0cf70e792fb1e5e9ca9b11ba0ed58f3ba6/install.sh | BOX_VERSION=0.3.1 sh
```

It switches `current` to that release, prints `Updated box 0.3.0 to 0.3.1.`, and then shows the same welcome as a first install. When you have that release already, it prints `box 0.3.1 is already installed.` and keeps your release, without the welcome. If you installed with any of the other [installer variables](#installer-variables), set them again.

Without `BOX_VERSION`, the installer takes the latest stable release. A pre-release, such as `0.3.0-preview.1` or `0.3.0-linux-preview.1`, is never the latest, so the installer picks one only when `BOX_VERSION` names it.

A release with no `box` archive for your computer stops the installer, which names the archive it couldn’t find. Releases before `0.3.0-preview.1` have no `box` archive at all.

box 0.2.2 and earlier installed into `~/.box`. The installer upgrades such an install the same way: it points `~/.local/bin/box` at the new release and leaves `~/.box` as it is. `box` no longer reads `~/.box`, so create your profiles again, and delete `~/.box` when you no longer need it.

On macOS, the installer accepts the current Box signing identity and the legacy CLI identity for older releases. Both must pass the same Apple publisher, signature, and notarization checks. You don’t need `BOX_ALLOW_UNSIGNED` to install a genuine older release.

The macOS CLI shares its code-signing identity with Box Core, the engine that runs workloads. Permissions based on that identity and certificate can apply to either program.

Old releases stay in `~/.strands/box/packages/`. Installing one you already have switches `current` back to it without touching its folder. To free the space, delete an old release’s folder, but not the one `current` points to.

## Install from a fork or an unsigned build

To install from another public repository, such as your own fork, name it in `BOX_GITHUB_REPO`. On macOS, a release that isn’t signed by the Box publisher, such as a fork’s own build, also needs `BOX_ALLOW_UNSIGNED=1`:

```sh
curl -fsSL https://raw.githubusercontent.com/strands-agents/box/526b5a0cf70e792fb1e5e9ca9b11ba0ed58f3ba6/install.sh |
  BOX_GITHUB_REPO=your-account/box BOX_ALLOW_UNSIGNED=1 sh
```

`BOX_ALLOW_UNSIGNED=1` skips Apple’s signature and Gatekeeper checks, and the installer says so with `Allowing unsigned release; Apple signature and Gatekeeper checks are skipped.` Use it only for a release you trust. The installer still checks the checksum, archive contents, metadata, and binary version.

## Manage PATH without the installer

```sh
curl -fsSL https://raw.githubusercontent.com/strands-agents/box/526b5a0cf70e792fb1e5e9ca9b11ba0ed58f3ba6/install.sh |
  BOX_NO_MODIFY_PATH=1 sh
```

This leaves your shell’s startup files alone, so put `~/.local/bin` on your `PATH` in your own setup.

## Build from source

To run your own build, you need [Rust](https://rustup.rs/) and [`just`](https://github.com/casey/just) as well. Build `box` and the Box Core helpers it runs, and put them on your `PATH`:

```sh
git clone https://github.com/strands-agents/box.git
cd box
just build-cli
export PATH="$PWD/target/debug:$PATH"
```

The build uses the packs and starters in the checkout’s `resources/`. The `export` lasts only in this terminal, so add `target/debug` to your `PATH` in your shell’s startup file to keep it. [CONTRIBUTING.md](https://github.com/strands-agents/box/blob/526b5a0cf70e792fb1e5e9ca9b11ba0ed58f3ba6/CONTRIBUTING.md) has more on building from source.

## Uninstall

Remove the releases and the link:

```sh
rm -rf ~/.strands/box/packages
rm ~/.local/bin/box
```

That keeps your profiles, packs, storage, and run records in `~/.strands/box`. To remove those too, delete `~/.strands/box` instead. If the installer edited a zsh or bash startup file, remove the lines from `# >>> Box PATH >>>` to `# <<< Box PATH <<<`. For fish, delete `conf.d/box.fish` in your fish config folder, `~/.config/fish` or `$XDG_CONFIG_HOME/fish`.

## Installer variables

`install.sh` reads these from the environment, and refuses arguments on its command line.

| Variable | What it does |
| --- | --- |
| `BOX_VERSION` | The release to install, such as `0.3.0` or its tag `v0.3.0`. Without it, the latest stable release. |
| `BOX_GITHUB_REPO` | The public GitHub repository that supplies releases, as `owner/repo`. Without it, `strands-agents/box`. |
| `BOX_ALLOW_UNSIGNED` | `1` skips Apple’s signature and Gatekeeper checks on macOS. It has no effect on Linux. |
| `BOX_NO_MODIFY_PATH` | `1` leaves your shell’s startup files alone. |