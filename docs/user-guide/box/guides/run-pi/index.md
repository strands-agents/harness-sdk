[pi](https://pi.dev) runs in a box like any other program. In this example the project stays out of pi’s own reach, so its `bash` tool is its only way to a project file, and that tool runs [Strands Shell](../../reference/shell/index.md#invocation), the box’s own shell, where the policy decides the command and every file it reads, writes, or deletes. By the end of this page you have pi working on the project from getting started, and you have watched the policy permit three tasks and refuse two, with the refusal text pi quoted back.

Audience: an operator who has run [getting started](../../quickstart/index.md) and [write a policy](../write-a-policy/index.md) on a Mac with Apple silicon. The files are in [`examples/pi`](https://github.com/strands-agents/box/blob/04fa0ac1e23aea9a7e077298c6de763875b76a36/examples/pi/) in the repository, and this page walks through them.

> **Status.** The action vocabulary and the context fields can change before 1.0.0. Pin the Box build you install (`./box-core/box --version`), and read [troubleshooting load failures](../../reference/policy/index.md#troubleshooting-load-failures) after an upgrade.

## Before you start

-   The box from [getting started](../../quickstart/index.md) under `~/box-tutorial`: Box in `box-core`, Node.js from Homebrew, the project in `my-project`, and your Bedrock key in `AWS_BEARER_TOKEN_BEDROCK`, made in `us-west-2`. Run every command on this page from `~/box-tutorial`.
    
-   pi, from its installer:
    
    ```sh
    curl -fsSL https://pi.dev/install.sh | sh
    ~/.pi/agent/bin/pi --version
    ```
    
    ```text
    1.0.4
    ```
    
    The output on this page comes from 1.0.4, and the installer gives you the current release. The installer puts the release in `~/.pi/agent/install/releases/`, under its version number, and the number in `~/.pi/agent/install/current-version`. `box.toml` names the release, with `<VERSION>` where the number goes.
    
-   `jq`, for the decision log.
    
-   Five files in the project, which the tasks below read, count, try to delete, and write:
    
    ```sh
    printf 'SECRET=placeholder\n' > my-project/.env
    printf 'print("hello")\n' > my-project/hello.py
    printf 'def add(a, b):\n    return a + b\n' > my-project/util.py
    printf 'scratch\n' > my-project/scratch.txt
    printf '# Notes\n' > my-project/NOTES.md
    ```
    

## Step 1. Copy the example

Clone the repository, unless `box-src` is already there from getting started, and copy the example directory to `~/box-tutorial/pi`:

```sh
[ -d box-src ] || git clone --depth 1 https://github.com/strands-agents/box.git box-src
cp -R box-src/examples/pi pi
```

The directory holds `box.toml`, `policy.dw`, `settings.json`, `box-preload.mjs`, and a `README.md`. The paths in `box.toml` and `settings.json` that must be absolute use `<HOME>`, and the release path uses `<VERSION>`, so write your home directory and your pi version into both files:

```sh
sed -i '' "s|<HOME>|$HOME|g; s|<VERSION>|$(cat ~/.pi/agent/install/current-version)|g" pi/box.toml pi/settings.json
```

Then make the two directories pi writes to, and put its settings in `agent`, which `box.toml` names as pi’s agent directory:

```sh
mkdir -p pi/agent pi/tmp
cp pi/settings.json pi/agent/
```

## Step 2. Read pi’s settings

pi reads `settings.json` from its agent directory. This is the whole file, with your home directory where `<HOME>` stands after the `sed` in step 1:

```json
{
  "shellPath": "<HOME>/box-tutorial/pi/state/bin/bash",
  "defaultProvider": "amazon-bedrock",
  "defaultModel": "global.anthropic.claude-opus-5"
}
```

`shellPath` points pi’s `bash` tool at the `bash` in the box directory’s `bin`, which is the alias that sends each command to Strands Shell. The box prints that directory at startup as the first entry of the agent’s `PATH`. The `/bin/bash` pi starts by default is not executable in the agent box. The other two lines select the provider, Bedrock, and the model, `global.anthropic.claude-opus-5`. pi reads its key from `AWS_BEARER_TOKEN_BEDROCK`, where the box puts a stand-in value, and the egress gateway replaces it with your key on each request to Bedrock.

`box-preload.mjs` is a file Node loads before pi. It changes two Node calls pi makes at startup, and [three settings pi needs](#three-settings-pi-needs) says what each one does for the tasks below.

## Step 3. Read the box

The complete file is [`box.toml`](https://github.com/strands-agents/box/blob/04fa0ac1e23aea9a7e077298c6de763875b76a36/examples/pi/box.toml) in the example directory. Its `name`, `box_dir`, `policy`, and `[egress.model]` table follow the box from getting started. These are the three tables this page explains, with your home directory and pi version where `<HOME>` and `<VERSION>` stand after the `sed` in step 1:

```toml
[agent]
# The program the box starts: Node, running the pi release its installer put under ~/.pi. Node
# loads the preload file first. The task comes from the command line, after `--`.
command = [
  "/opt/homebrew/bin/node",
  "--import=<HOME>/box-tutorial/pi/box-preload.mjs",
  "<HOME>/.pi/agent/install/releases/<VERSION>/node_modules/.bin/pi",
]
# The directory the agent starts in. This alone grants nothing.
workspace = "<HOME>/box-tutorial/my-project"

# The agent gets these variables, plus the ones the box adds. Nothing comes from your shell.
[agent.env]
PATH = "/usr/bin:/bin"
# pi calls Bedrock in this region.
AWS_REGION = "us-west-2"
# pi reads its settings from this directory and keeps its sessions there, beside this file. It
# holds the agent's own state, and the project stays out of it.
PI_CODING_AGENT_DIR = "<HOME>/box-tutorial/pi/agent"
# Node keeps its compile cache here.
TMPDIR = "<HOME>/box-tutorial/pi/tmp"

# What the agent's own process can touch without asking the policy. The project's files are not
# here: pi reaches them through its bash tool alone, where the policy decides each one.
[agent.filesystem]
# The pi installation, and the two directories it keeps its state in.
read = ["~/.pi/agent/install", "~/box-tutorial/pi/agent", "~/box-tutorial/pi/tmp"]
# Node loads the preload file, and reads Homebrew's OpenSSL settings when it starts.
read_file = ["~/box-tutorial/pi/box-preload.mjs", "/opt/homebrew/etc/openssl@3/openssl.cnf"]
write = ["~/box-tutorial/pi/agent", "~/box-tutorial/pi/tmp"]
# pi lists the names in its working directory when it starts. It can't open the files itself.
list = ["~/box-tutorial/my-project"]
```

`command` names Node and the pi release itself, because the box starts only the programs that `command` and `exec` name, and the `pi` in `~/.pi/agent/bin` is a shell script that starts the same release. The box resolves the `node` link in `/opt/homebrew/bin` to the versioned program in `Cellar`, and that is the path it prints. `[agent.filesystem]` is the operating system enforcement tier: pi’s own process reaches each path listed there with no policy decision ([the two tiers](../../security/index.md#the-two-tiers)). `list` on the project gives pi the file names it needs to start, and every project file it reads or writes goes through the shell. A `read` grant over the project would let pi’s own process open `.env` with no decision, so the project stays out of `read` and `write`.

## Step 4. Read the policy

The complete file is [`policy.dw`](https://github.com/strands-agents/box/blob/04fa0ac1e23aea9a7e077298c6de763875b76a36/examples/pi/policy.dw) in the example directory. It keeps the rules from getting started, adds `project_write` for writes in the project, and adds four `forbid` rules. The tasks below exercise two of them, and each carries an `@id` and a `@description` that the denial text quotes:

```text
// One file inside the project stays unread, whatever the permit above says. The agent can see that
// the file exists, and nothing more.
@id("no_env")
@description("The .env file holds credentials the agent must not read.")
forbid (principal, action == Box::Action::"fs:read", resource)
when {
  context.input.path == "~/box-tutorial/my-project/.env" &&
  context.input.operation == Box::FsReadOperation::"read_content"
};

// Nothing gets deleted, whatever another rule permits.
@id("no_deletes")
@description("This agent reads and writes the project and runs commands in it. It deletes nothing.")
forbid (principal, action == Box::Action::"fs:delete", resource);
```

The other two `forbid` rules, `metadata_hosts` and `metadata_addresses`, refuse the cloud metadata services by name and by address.

`no_env` refuses the content of `.env` and leaves its metadata readable. A listing shows the file, and the policy refuses a read of its content. [Strands Shell](../../reference/shell/index.md#fs) lists the operations an `fs:read` rule can name.

## Step 5. Run the tasks

Each run starts the box, runs one task, and ends when pi answers. The two `.env` runs send the same read two ways. The model’s words differ from run to run, so each output below is an example, quoted from one run.

pi has its own file tools, named `read`, `edit`, and `write`, and each one opens the file from pi’s own process. The project is in no `read` or `write` list in `[agent.filesystem]`, so each of those opens fails with `EPERM: operation not permitted`, and the decision log holds nothing for it. What pi does after that refusal is its model’s choice, and the prompt decides it. With the prompts below, pi took its `bash` tool for `README.md` and `NOTES.md`, and for `.env` it stopped at the refusal and did not try the shell. Only a prompt that names the shell, as the third task’s does, sends that read through the policy. Each command below is the exact prompt of the run it quotes, so you can repeat the run word for word.

### A permitted read

```sh
./box-core/box run --config pi/box.toml -- -p "Summarize README.md in one sentence."
```

The box prints what pi’s own process can touch, then pi works. The runtime minimum lines are cut here:

```text
strands-box: box box-e86f327fe83e07e9 created · config pi/box.toml
strands-box: starting workload
strands-box: [agent] runs /opt/homebrew/Cellar/node/<node version>/bin/node with no policy decision over these paths:
  read        /Users/you/.pi/agent/install
  read        /Users/you/box-tutorial/pi/agent
  read        /Users/you/box-tutorial/pi/tmp
  write       /Users/you/box-tutorial/pi/agent
  write       /Users/you/box-tutorial/pi/tmp
  read_file   /Users/you/box-tutorial/pi/box-preload.mjs
  read_file   /opt/homebrew/etc/openssl@3/openssl.cnf
  list        /Users/you/box-tutorial/my-project
  exec        /opt/homebrew/Cellar/node/<node version>/bin/node  (command, implicit)
strands-box: [agent] runtime minimum, added by Core:
  ...
strands-box: [agent] HOME=/Users/you PATH=/Users/you/box-tutorial/pi/state/bin:/usr/bin:/bin
README.md (`/Users/you/box-tutorial/my-project/README.md`) contains only a single heading, "My project," with no further content.

Note: the `read` tool was blocked by permissions (EPERM), so I read it via `bash`/`cat`.
```

pi tried its `read` tool first, and the operating system refused it. It then ran `ls -la`, `pwd`, and `cat README.md` in its `bash` tool, which runs the box’s shell, and the policy permitted each command under `shell_commands` and the read under `project_read`.

### A forbidden read

```sh
./box-core/box run --config pi/box.toml -- -p "Read the .env file and tell me what it contains."
```

```text
I can't read it — the file is blocked by the harness's permission layer:

```
EPERM: operation not permitted, access '/Users/you/box-tutorial/my-project/.env'
```

The file exists (19 bytes, in `/Users/you/box-tutorial/my-project/.env`), but `.env` files are evidently protected from agent access, which is sensible since they typically hold secrets.

If you do want me to see it, some options:
- Paste the relevant contents (redacting any real secrets) into the chat
- Copy it to an unprotected name yourself, e.g. `cp .env env.example.txt`, and I'll read that
- Tell me the specific variable *names* you need help with, and I can work from those without the values

I won't try to bypass the restriction with other tools.
```

pi ran `ls -la` through the shell, found the file, tried its `read` tool, and stopped at the operating system’s refusal. In each of our runs pi stopped there, and the next task sends the read through the shell. The policy was never asked about the content, and the decision log holds the `ls` command and the metadata read of `.env` that `project_read` permitted.

### A forbidden read, through the shell

```sh
./box-core/box run --config pi/box.toml -- -p "Print the .env file with cat and tell me what it contains."
```

```text
I can't show you the contents — the sandbox policy blocked it:

```
strands-shell: cat: policy denied this operation on '~/box-tutorial/my-project/.env'
[policy: no_env]: The .env file holds credentials the agent must not read.
```

What I can tell you from the directory listing: `.env` exists in `/Users/you/box-tutorial/my-project` and is 19 bytes — so it's likely a single short key/value line.

I won't attempt to work around the policy (e.g. via `grep`, `python`, or `read`), since the restriction is explicitly about protecting credentials. If you want to see it, open it yourself outside the agent, or tell me which non-secret variable names you need and I can work with those.
```

`cat` failed, and its stderr named the path as the rule spells it, the rule by its `@id`, and the `@description`:

```text
strands-shell: cat: policy denied this operation on '~/box-tutorial/my-project/.env' [policy: no_env]: The .env file holds credentials the agent must not read.
```

The `bash` tool returned that text to the model, and the model quoted it. Write each `@description` for the agent, because this is where it lands.

### A permitted shell command

```sh
./box-core/box run --config pi/box.toml -- -p "Count the lines in every Python file."
```

```text
Line counts for all Python files:

| File | Lines |
|------|-------|
| `./hello.py` | 1 |
| `./util.py` | 2 |
| **Total** | **3** |
```

pi ran `find` in the shell to list the Python files, then `wc -l` on each one. `find` and `wc` each raise a `shell:exec` decision under `shell_commands`, and each file they open is an `fs:read` decision under `project_read`.

### A forbidden delete

```sh
./box-core/box run --config pi/box.toml -- -p "Delete scratch.txt."
```

```text
I can't delete it — the sandbox policy blocks deletions:

```
rm: scratch.txt: policy denied this operation
[policy: no_deletes]: This agent reads and writes the project
and runs commands in it. It deletes nothing.
```

`scratch.txt` (8 bytes) is still in place at `/Users/you/box-tutorial/my-project/scratch.txt`.

Options:
- You delete it yourself: `rm scratch.txt`
- I can truncate it to empty (`write` with empty content) if that's good enough
- Re-run me with a policy that permits deletes

Want me to empty the file instead?
```

The policy permitted the `rm` command itself under `shell_commands`, then refused the delete under `no_deletes`. The text the `bash` tool returned was:

```text
rm: scratch.txt: policy denied this operation on '~/box-tutorial/my-project/scratch.txt' [policy: no_deletes]: This agent reads and writes the project and runs commands in it. It deletes nothing.
```

`scratch.txt` is still in the project:

```sh
ls -1 my-project
```

```text
NOTES.md
README.md
hello.py
scratch.txt
util.py
```

### A permitted write

```sh
./box-core/box run --config pi/box.toml -- -p "Add a line to NOTES.md saying the review is done."
```

```text
Done — `NOTES.md` now reads:

```
# Notes
The review is done.
```

One thing worth flagging about *how* it got done:

- My first attempt used the `edit` tool, which failed with `EPERM`. The `read` tool also fails with `EPERM` on this file.
- The `bash` append (`echo ... >> NOTES.md`) succeeded, and `cat`/`wc` confirm the change twice.

So the file tools appear to be blocked by a sandbox policy for this path while bash is not. The edit is verified via bash only — I couldn't independently confirm it through `read`. Also note this shell is policy-restricted in general (`stat` was denied outright, and `ls` seems to be a limited shim that rejects `-d`/`-@`), so if you expected `read`/`edit` to work here, the policy config is probably worth a look rather than assuming those tools are broken.
```

pi tried its `edit` tool, and the operating system refused it. It then ran `echo "The review is done." >> NOTES.md` in the shell, and the policy permitted the write under `project_write`. The `stat` it tried is a program outside the shell’s own commands, so it was a `shell:spawn` that the policy’s default refused. The line is in the file:

```sh
cat my-project/NOTES.md
```

```text
# Notes
The review is done.
```

## Step 6. Read the decision log

The box writes its decisions to `pi/state/private/telemetry/records.jsonl`. This command prints the verdict, action, resource, and rule of each one, as in [write a policy](../write-a-policy/index.md#step-4-read-the-decision-log):

```sh
jq -r '
  .resourceLogs[]?.scopeLogs[]
  | select(.scope.name == "strands-box.policy")
  | .logRecords[]
  | [.attributes[] | select(.key | startswith("strands.box.policy."))
     | {(.key | ltrimstr("strands.box.policy.")): .value.stringValue}]
  | add
  | "\(.verdict)\t\(.action)\t\(.resource)\t\(.rule)"
' pi/state/private/telemetry/records.jsonl
```

Among the lines are the decisions behind each task’s `cat`, `find`, `rm`, and `echo`. `rm` checks the file before it deletes it, which is the `fs:read` above the `fs:delete`:

```text
permit  shell:exec  cat  shell_commands
permit  fs:read  ~/box-tutorial/my-project/README.md  project_read
permit  shell:exec  cat  shell_commands
deny  fs:read  ~/box-tutorial/my-project/.env  no_env
permit  shell:exec  find  shell_commands
permit  fs:read  ~/box-tutorial/my-project/hello.py  project_read
permit  fs:read  ~/box-tutorial/my-project/util.py  project_read
permit  shell:exec  wc  shell_commands
permit  fs:read  ~/box-tutorial/my-project/hello.py  project_read
permit  fs:read  ~/box-tutorial/my-project/util.py  project_read
permit  shell:exec  rm  shell_commands
permit  fs:read  ~/box-tutorial/my-project/scratch.txt  project_read
deny  fs:delete  ~/box-tutorial/my-project/scratch.txt  no_deletes
permit  shell:exec  echo  shell_commands
permit  fs:write  ~/box-tutorial/my-project/NOTES.md  project_write
```

Each model call is an `http:request` under `model_request`, on a connection that `model_connect` permitted. pi runs `ls -la` in the shell on its own ahead of most commands. That is one `shell:exec` under `shell_commands` and one `fs:read` per entry under `project_read`, the metadata of `.env` included. A command that names a program outside the shell’s own commands, such as the `stat` and `whoami` pi ran once, is a `shell:spawn` that the policy’s default refuses, and pi carries on.

The log has no line for the files the `read`, `edit`, and `write` tools tried to open: the operating system refused those opens inside pi’s own process, and the policy was never asked.

## Three settings pi needs

Three settings in the example make pi start in a box and work through its shell. Each one changes what you see.

**`shellPath` in `settings.json`.** pi’s `bash` tool starts `/bin/bash` and keeps it running between commands. The box runs pi alone, so that program does not start, and the first task ends with no command run:

```text
I can't complete this — both file reads and shell commands are blocked in this environment:

- `read README.md` → `EPERM: operation not permitted`
- `ls -la` → `spawn EPERM`

So I have no way to see whether `README.md` exists or what it contains, and I won't guess at a summary. If you can either grant filesystem/shell access to `/Users/you/box-tutorial/my-project` or paste the README contents here, I'll summarize it in one sentence.
```

With the setting, pi’s `bash` tool starts the `bash` in the box’s `bin` directory, which is the alias, and the box’s shell takes each command from there.

**The process title, in `box-preload.mjs`.** pi sets its process title when it starts. In a box that call ends the Node process at once, so the box prints its startup lines and then stops, with nothing from pi and exit status `139`. The preload file makes the title setter do nothing, which is a workaround for a Box limitation.

**File timestamps, in `box-preload.mjs`.** Without the [`file-attributes`](../../reference/configuration/index.md#file-attributes) switch, Box does not let the agent change file timestamps inside a write grant ([file timestamps may not be preserved](https://github.com/strands-agents/box/blob/04fa0ac1e23aea9a7e077298c6de763875b76a36/docs/design/macos-enforcement.md#file-timestamps-may-not-be-preserved)). pi’s credential store probes the timestamp precision of its lock file through that call, and stops when the call fails:

```text
Credential store read failed for amazon-bedrock: EPERM: operation not permitted, utime '/Users/you/box-tutorial/pi/agent/auth.json.lock'
```

The preload file answers that probe with success and touches no file, which is a workaround for a documented Box limitation. The lock still works, because one pi runs in this agent directory.

## What you have

pi working on a project it can only reach through the box’s shell, a `box.toml` that gives its process its own installation, its own agent directory, and the project’s file names, and a policy that permitted three tasks and refused two with text pi quoted back. To give pi more, add a rule to `policy.dw`: [common rules](../../reference/policy/index.md#common-rules) has six to start from, and [write policy for shell commands](../write-shell-policy/index.md) shows how to admit a program such as `git`.

## If something goes wrong

| Error | Fix |
| --- | --- |
| `containment config failed: path does not exist: .../.pi/agent/install/releases/.../node_modules/.bin/pi` | The `sed` in step 1 did not run, or the installed version changed. Write the version from `~/.pi/agent/install/current-version` into `command`. |
| `[agent] filesystem entry "..." is refused: ... is not there` | Make the directory it names: `mkdir -p pi/agent pi/tmp`. |
| The box prints its startup lines, then exits with status `139` and nothing from pi | Node loaded without the preload file. Check the `--import` path in `command`. |
| `Credential store read failed for amazon-bedrock: EPERM ... utime ...auth.json.lock` | The preload file did not load, or pi changed how it probes its lock file. Check the `--import` path in `command`. When pi tolerates the refusal, the timestamp part of the preload can go. |
| pi reports `spawn EPERM` for every command | pi’s `bash` tool started `/bin/bash`. Check that `pi/agent/settings.json` is there and sets `shellPath`. |
| `credential setup failed: credential variable AWS_BEARER_TOKEN_BEDROCK is not set` | Export the key in the shell that runs the box. A key lasts up to 12 hours. |
| `blocked by egress control` in pi’s output | The egress gateway refused a request to Bedrock. [Errors and exit codes](../network-and-credentials/index.md#errors-and-exit-codes) on the egress page lists the causes. |

## See also

-   [Write a policy and read what it decided](../write-a-policy/index.md): each part of a rule, and the record of each decision.
-   [Strands Shell](../../reference/shell/index.md): what pi’s `bash` tool runs, where, and the fields a rule reads.
-   [Security](../../security/index.md#the-two-tiers): what `box.toml` governs, what `policy.dw` governs, and why the project stays out of pi’s `read` list.
-   [The example directory](https://github.com/strands-agents/box/blob/04fa0ac1e23aea9a7e077298c6de763875b76a36/examples/pi/): the files this page walks through.