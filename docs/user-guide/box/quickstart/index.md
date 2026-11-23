On this page, you install Box and run Claude Code in a box in one of your own projects. The agent can change files in your project, talk to its model, and look things up on the internet, but the rest of your machine is out of its reach: your other files, your keys, and the services that listen only on localhost.

## Requirements

-   An Apple Silicon Mac with macOS 15 or later, or Linux on ARM64 or x86\_64. [Install Box](/docs/user-guide/box/install/index.md#requirements) lists what Linux needs.
    
-   The [AWS CLI](https://aws.amazon.com/cli/), to look up a model ID and check your sign-in.
    
-   Claude Code from its native installer. The box starts the native executable, and the `npm` package is a Node script, so if you installed Claude Code with `npm`, reinstall it:
    
    ```sh
    curl -fsSL https://claude.ai/install.sh | bash
    ```
    
-   An AWS account that can call Claude models on Amazon Bedrock, and an AWS profile for it on this machine. If the model refuses you, [Every model request fails with 403](https://github.com/strands-agents/box/blob/4bdcea8013143a36a34cd23f6565fd1f8dc18b1f/resources/packs/bedrock/README.md#every-model-request-fails-with-403) lists what an account needs. With a claude.ai Pro or Max plan instead, you need neither AWS nor the AWS CLI: in step 2, make the profile as [`@box/claude-subscription`](https://github.com/strands-agents/box/blob/4bdcea8013143a36a34cd23f6565fd1f8dc18b1f/resources/packs/claude-subscription/README.md) shows, then skip step 3.
    

## 1\. Install Box

Download the installer and run it:

```sh
curl -fsSL https://raw.githubusercontent.com/strands-agents/box/4bdcea8013143a36a34cd23f6565fd1f8dc18b1f/install.sh | sh
```

It installs the latest stable release, puts `box` on your `PATH`, and ends with example next steps. Usage telemetry is on by default, and the installer says how to turn it off ([Usage telemetry](https://github.com/strands-agents/box/blob/4bdcea8013143a36a34cd23f6565fd1f8dc18b1f/CLI_TELEMETRY.md)).

Open a new terminal, and do every step from here on in it, because later steps use variables that earlier ones set. Check that `box` runs:

```console
$ box --version
box 0.3.0
```

If the installer stops instead, it says why. [Install Box](/docs/user-guide/box/install/index.md) covers what it adds, upgrading, and uninstalling.

## 2\. Create a Claude Code profile

A [profile](/docs/user-guide/box/profiles/index.md) tells `box` how to run one agent: which program to start, which tools to give it, and which model service it may reach. Make one for Claude Code on Amazon Bedrock:

```sh
box profile create claude --with bedrock
```

`box` asks for the region, how the box signs in to Bedrock, whether to bring in your MCP servers and hooks, and the policy. Press Enter to accept each default: `us-west-2`, your AWS credentials (`aws`), no MCP servers or hooks, and the Open policy, which lets the agent search the web and read docs. If your Claude Code settings or your shell (`AWS_REGION` or `AWS_DEFAULT_REGION`) already name a region, `box` doesn’t ask, and the Review tab lists it under **DETECTED OPTIONS**. To pick another policy later, see [Pick the agent’s policy](/docs/user-guide/box/starters/index.md#pick-the-agents-policy).

On Review, choose **Save profile**. `box` then shows what it saved and what to do before the first run:

```text
  BEFORE RUNNING

  • Skipped tools: pnpm (@box/pnpm), yarn (@box/yarn).
  • The bedrock route signs with your default AWS identity. Box Core warns about it.
```

Your list may differ. A skipped tool is one that `box` didn’t find on your machine. Install it whenever you like, and the next run picks it up. The second line says how the box signs in to Bedrock (step 3). Choose **Exit**, not **Run**, because Claude Code still needs a model.

The profile is in `~/.strands/box/profiles/claude/profile.toml`, and its first lines look like this:

```toml
# Written by `box profile create`. Your values go here, and the packs hold the rest.
# `box profile show claude` prints what a run gets.
# For help from a coding agent, tell it: Run box help agent and follow it.
packs = ["@box/claude", "@box/bedrock", "@box/cargo", "@box/git", "@box/node", "@box/npm", "@box/pnpm", "@box/yarn"]
policies = ["policy.dw"]
```

The `@box/` names are packs that come with Box. They hold the details of running Claude Code, reaching Amazon Bedrock, and using each tool, so your own file stays short. `policy.dw`, beside it, is your copy of the policy you picked. [Profiles](/docs/user-guide/box/profiles/index.md) shows how to change either file.

## 3\. Connect to Bedrock

The box signs each request to Bedrock with your AWS credentials, outside the box, so the agent never sees them. It uses the AWS identity that the AWS CLI uses in the terminal where you run `box run`. Point this terminal at your AWS profile and check it:

```sh
export AWS_PROFILE=your-profile
aws sts get-caller-identity
```

`your-profile` is a profile in `~/.aws/config` or `~/.aws/credentials`, not the Box profile from step 2.

If that AWS profile signs in with AWS IAM Identity Center (SSO) or `aws login`, the box can’t read it yet. Sign in, and export its temporary keys in this terminal:

```sh
aws sso login   # or: aws login
eval "$(aws configure export-credentials --format env)"
```

The keys end with the sign-in session, so run this again in each new terminal and after you sign in again. [Which AWS profiles work](/docs/user-guide/box/reference/profiles/index.md#aws-credentials) is in the reference. To sign in with a Bedrock API key instead, see [Sign in with a Bedrock API key](https://github.com/strands-agents/box/blob/4bdcea8013143a36a34cd23f6565fd1f8dc18b1f/resources/packs/bedrock/README.md#sign-in-with-a-bedrock-api-key).

A run that has already started keeps its old sign-in, so start a new run after you change it.

### Choose the model

If Claude Code on your machine already uses a Bedrock model ID that your account can call in this region (`model` or `ANTHROPIC_MODEL` in `~/.claude/settings.json`, or `ANTHROPIC_MODEL` in your shell), the box uses it, so skip to step 4. Otherwise Claude Code uses its default model, and if your account can’t call that one, Claude Code keeps retrying and the run looks stuck.

List the Claude models on Bedrock in the profile’s region (`us-west-2` unless you picked another):

```sh
aws bedrock list-inference-profiles --region us-west-2 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'anthropic')].inferenceProfileId" \
  --output text
```

Pick one your account is allowed to call (if you don’t know, ask whoever runs the account) and copy its full ID as the command prints it, such as `global.anthropic.claude-opus-5-5`. A short name such as `opus` won’t work. Then add it to the end of `~/.strands/box/profiles/claude/profile.toml`:

```toml
[agent.env]
ANTHROPIC_MODEL = "global.anthropic.claude-opus-5-5"
```

## 4\. Run Claude Code in a project

The agent can read and change the files in the directory where you start it, and nothing outside it unless the profile adds it. Start it in the project you want it to work on, not in a folder that holds keys or credentials:

```sh
cd ~/src/my-app
box run claude
```

`box` shows a loading display until Claude Code is ready, and then Claude Code starts with an [activity banner](/docs/user-guide/box/reference/cli/index.md#the-activity-banner) below it. Press **Ctrl+\]** to expand the banner.

If you already use Claude Code in this project, it goes straight to the prompt, because `box` brings in your finished onboarding and your answer to the folder trust question. Otherwise Claude Code asks its first-time questions: a color theme, some security notes, and whether you trust the folder. That last one defaults to **No, exit**, so press the down arrow to pick **Yes, I trust this folder** before you press Enter. It won’t ask you to log in, since the profile points it at Bedrock.

Claude Code starts with the permission settings from your machine, so it may ask before it edits a file or runs a command, and the box checks each action either way. [How Claude Code asks before it acts](https://github.com/strands-agents/box/blob/4bdcea8013143a36a34cd23f6565fd1f8dc18b1f/resources/packs/claude/README.md#how-claude-code-asks-before-it-acts) shows how to change that.

Now watch the box work. Ask Claude Code to create `hello.txt` with the word hi in it, and say yes if it asks. The file shows up in `~/src/my-app`. Then ask Claude Code to run `echo hi > ~/outside.txt` in its shell, and say yes if it asks. The box stops that command, and Claude Code tells you it couldn’t write the file. Press **Ctrl+\]** to see the denial in the banner. If Claude Code uses its own Write tool instead, the box stops that too, but the banner doesn’t show it ([The box](/docs/user-guide/box/how-box-works/index.md#the-box) says why).

Quit Claude Code with `/exit` to end the run. `box` then shows any messages saved during the run, and [`box runs history`](/docs/user-guide/box/reference/cli/index.md#box-runs-history) lists every decision the box made. To pick up where you left off next time, pass Claude Code’s own flag after `--`:

```sh
box run claude -- --continue
```

### If the run doesn’t start

| What you see | What to do |
| --- | --- |
| `AWS default credential chain resolved no credentials` | Set `AWS_PROFILE`, or export the SSO keys, in this terminal (step 3). |
| `credential variable AWS_BEARER_TOKEN_BEDROCK is not set` | The profile signs in with a key. Make the key in this terminal ([Sign in with a Bedrock API key](https://github.com/strands-agents/box/blob/4bdcea8013143a36a34cd23f6565fd1f8dc18b1f/resources/packs/bedrock/README.md#sign-in-with-a-bedrock-api-key)). |
| Claude Code starts, but after you give it a task it says `API error` and keeps retrying | Check the model ID from step 3. |
| A `403` error from the model | Check the sign-in from step 3. With a key, make a new one for the profile’s region. If that doesn’t help, work through [Every model request fails with 403](https://github.com/strands-agents/box/blob/4bdcea8013143a36a34cd23f6565fd1f8dc18b1f/resources/packs/bedrock/README.md#every-model-request-fails-with-403). |

## What’s set up

You have a `claude` profile, and `box run claude` uses it in any project. Every new terminal finds `box`. `AWS_PROFILE`, exported keys, and a Bedrock API key last only in the terminal that set them, so run step 3 again in each new one. To get a newer release, see [Upgrade or choose a version](/docs/user-guide/box/install/index.md#upgrade-or-choose-a-version).

`box` keeps the profile, Claude Code’s settings and history, and a record of each run in `~/.strands/box`. [Where Box keeps its files](/docs/user-guide/box/reference/files/index.md) says what each folder holds, and which files the tools write into your project.

## Clean up

Each run leaves a folder in `~/.strands/box/r`, and they pile up. `box profile clean --all` asks, then removes them. It keeps the profile, and Claude Code’s settings and history. If one of the boxes is still running, it removes nothing and names that box, so exit it first. To start over, run `box profile delete --all`, which also asks first, and redo steps 2 and 3.

## Where to go next

-   [How Box works](/docs/user-guide/box/how-box-works/index.md): what the box, profiles, packs, and policies are, and how they fit together.
-   [Profiles](/docs/user-guide/box/profiles/index.md): give the agent another host, folder, or tool, change its region, or set up another agent.
-   [Starters](/docs/user-guide/box/starters/index.md): switch the policy, or answer the questions from a script.
-   [Limitations](/docs/user-guide/box/limitations/index.md): what a box doesn’t protect you from. Read it before you trust a run with work that matters.