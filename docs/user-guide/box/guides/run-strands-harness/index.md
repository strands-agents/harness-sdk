An agent you write with the [Strands Agents SDK](https://github.com/strands-agents/sdk-python) runs in a box like any other program. In this example each of its three tools runs a command through the box’s shell, so the policy decides every command and every file a command touches. By the end of this page you have the agent working on the project from getting started, and you have watched the policy permit two tasks and refuse two, with the refusal text the agent read.

Audience: an operator who has run [getting started](../../quickstart/index.md) and [write a policy](../write-a-policy/index.md) on a Mac. The files are in [`examples/strands-box/strands-sdk-agent`](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/examples/strands-box/strands-sdk-agent/) in the repository, and this page walks through them.

> **Status.** The action vocabulary and the context fields can change before 1.0.0. Pin the Box build you install (`./box-core/box --version`), and read [troubleshooting load failures](../../reference/policy/index.md#troubleshooting-load-failures) after an upgrade.

## Before you start

-   The box from [getting started](../../quickstart/index.md) under `~/box-tutorial`: Box in `box-core`, the project in `my-project`, and your Bedrock key in `AWS_BEARER_TOKEN_BEDROCK`, made in `us-west-2`. Run every command on this page from `~/box-tutorial`.
    
-   Homebrew’s Python 3.14: `brew install python@3.14`.
    
-   `jq`, for the decision log.
    
-   Four files in the project, which the tasks below read, count, and try to delete:
    
    ```sh
    printf 'SECRET=placeholder\n' > my-project/.env
    printf 'print("hello")\n' > my-project/hello.py
    printf 'def add(a, b):\n    return a + b\n' > my-project/util.py
    printf 'scratch\n' > my-project/scratch.txt
    ```
    

## Step 1. Copy the example

Clone the repository, unless `box-src` is already there from getting started, and copy the example directory to `~/box-tutorial/strands-agent`:

```sh
[ -d box-src ] || git clone --depth 1 https://github.com/strands-agents/box.git box-src
cp -R box-src/examples/strands-box/strands-sdk-agent strands-agent
```

The directory holds `agent.py`, `requirements.txt`, `setup.sh`, `box.toml`, `policy.dw`, and a `README.md`. The paths in `box.toml` that must be absolute use `<HOME>`, so write your home directory into them:

```sh
sed -i '' "s|<HOME>|$HOME|g" strands-agent/box.toml
```

## Step 2. Install the SDK

`setup.sh` builds a virtual environment at `strands-agent/runtime/.venv` with Homebrew’s Python, installs the SDK into it, and makes an empty `tmp` directory for the agent’s temporary files:

```sh
./strands-agent/setup.sh
```

```text
installed the Strands Agents SDK into /Users/you/box-tutorial/strands-agent/runtime/.venv
the base interpreter is /opt/homebrew/opt/python@3.14/Frameworks/Python.framework/Versions/3.14
```

The virtual environment sits beside the agent, outside the project, and the `read` list in `[agent.filesystem]` names it, so Python can load the SDK from it.

## Step 3. Read the agent

`agent.py` builds one agent with a Bedrock model and three tools. Each tool builds a command and runs it with `zsh -c`. The `zsh` on the agent’s `PATH` is the alias the box places there, a client program that sends the command to [Strands Shell](../../reference/shell/index.md#invocation), the box’s own shell. The policy decides the command and each file it touches, and the tool returns the shell’s output, or its refusal, to the model:

```python
def shell(command: str) -> str:
    """Run one command in the box's shell, show it on stderr, and return what it printed."""
    done = subprocess.run(["zsh", "-c", command], capture_output=True, text=True)
    print(f"[tool] {command} (exit {done.returncode})", file=sys.stderr)
    if done.stderr:
        print(done.stderr.rstrip(), file=sys.stderr)
    if done.returncode == 0:
        return done.stdout or "(no output)"
    return f"exit {done.returncode}\n{done.stderr}"


@tool
def read_file(path: str) -> str:
    """Read one file in the project, by its path relative to the project."""
    return shell(f"cat {shlex.quote(path)}")
```

The other two tools are `list_project`, which runs `ls -a`, and `run_command`, which runs the command the model writes. The system prompt tells the model to quote a denial and stop. The task comes from the command line, after `--`.

## Step 4. Read the box

This is `strands-agent/box.toml`, after its first comment. The `sed` in step 1 put your home directory where `<HOME>` stands:

```toml
# The box's name, and where it keeps its own state. The agent can't reach box_dir.
name = "strands-sdk"
box_dir = "<HOME>/box-tutorial/strands-agent/state"
# The policy file, next to this one.
policy = "policy.dw"

[agent]
# The program the box starts: the Python in the example's virtual environment, running agent.py.
# The task comes from the command line, after `--`.
command = [
  "<HOME>/box-tutorial/strands-agent/runtime/.venv/bin/python3",
  "<HOME>/box-tutorial/strands-agent/agent.py",
]
# The directory the agent starts in. This alone grants nothing.
workspace = "<HOME>/box-tutorial/my-project"
# The agent gets these variables, plus the ones the box adds. Nothing comes from your shell. The
# SDK reads the region and skips the EC2 metadata service; agent.py reads the model.
env = { AWS_REGION = "us-west-2", AWS_EC2_METADATA_DISABLED = "true", MODEL_ID = "global.anthropic.claude-opus-5", PATH = "/usr/bin:/bin", TMPDIR = "<HOME>/box-tutorial/strands-agent/tmp" }

# What the agent's own process can touch without asking the policy.
[agent.filesystem]
# Python loads the SDK from the virtual environment, and its standard library and the libraries it
# links from Homebrew's kegs.
read = [
  "~/box-tutorial/strands-agent/runtime/.venv",
  "/opt/homebrew/Cellar/python@3.14",
  "/opt/homebrew/Cellar/openssl@3",
  "/opt/homebrew/Cellar/sqlite",
]
# Homebrew's opt directory holds the links that Python and its libraries follow into the kegs.
metadata = ["/opt/homebrew/opt"]
# Python runs agent.py.
read_file = ["~/box-tutorial/strands-agent/agent.py"]
# Homebrew's python3 starts the interpreter inside its own framework.
exec = ["/opt/homebrew/Cellar/python@3.14"]
# Python's temporary files.
write = ["~/box-tutorial/strands-agent/tmp"]
# The agent lists the names in its working directory. It can't open the files itself.
list = ["~/box-tutorial/my-project"]

# The box adds your Bedrock API key to each request to Bedrock. The agent gets a stand-in value.
[egress.model]
destinations = ["bedrock-runtime.us-west-2.amazonaws.com"]
secret.ref = "env://AWS_BEARER_TOKEN_BEDROCK"
```

`list` on the project lets Python start in the directory and see what’s there. Every file the agent reads goes through the shell, where the policy decides it. A `read` grant over the project would let the agent’s own process open `.env` with no decision, so the project stays out of `read`.

## Step 5. Read the policy

`strands-agent/policy.dw` keeps the rules from getting started and adds four `forbid` rules. The tasks below exercise two of them, `no_env` and `no_deletes`, and each carries an `@id` and a `@description` that the denial text quotes:

```text
// Connect to Bedrock, and send it requests.
@id("model_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "bedrock-runtime.us-west-2.amazonaws.com" && context.input.port == 443 };

@id("model_request")
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "bedrock-runtime.us-west-2.amazonaws.com" };

// Run any command in the box's shell. Each file a command touches is still its own decision.
@id("shell_commands")
permit (principal, action == Box::Action::"shell:exec", resource);

// Read anything in the project. A path under your home starts with "~" here.
@id("project_read")
permit (principal, action == Box::Action::"fs:read", resource)
when {
  context.input.path == "~/box-tutorial/my-project" ||
  context.input.path like "~/box-tutorial/my-project/*"
};

// Use /dev/null, which agents redirect output to all the time.
@id("dev_null")
permit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)
when { context.input.path == "/dev/null" };

// One file inside the project stays unread, whatever the permit above says.
@id("no_env")
@description("The .env file holds credentials the agent must not read.")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.path == "~/box-tutorial/my-project/.env" };

// Nothing gets deleted, whatever another rule permits.
@id("no_deletes")
@description("This agent reads the project and runs commands in it. It deletes nothing.")
forbid (principal, action == Box::Action::"fs:delete", resource);
```

The file ends with two more `forbid` rules, `metadata_hosts` and `metadata_addresses`, which refuse the cloud metadata services by name and by address.

`no_deletes` refuses every delete, and its `@description` is what the agent reads when `rm` fails. [How a denial reads](../../reference/policy/index.md#how-a-denial-reads) lists the shapes.

## Step 6. Run four tasks

Each run starts the box, runs one task, and ends when the agent answers. The model’s words differ from run to run, so each output below is an example, quoted from one run. `agent.py` prints a `[tool]` line on stderr for each command it runs, and a `[tool]` line can land out of order with the model’s words. The denial lines are the shell’s own text.

### A permitted read

```sh
./box-core/box run --config strands-agent/box.toml -- "Summarize README.md in one sentence."
```

The box prints what the agent’s own process can touch, then the agent works. The runtime minimum lines are cut here:

```text
strands-box: box box-6b8ee845f22b265a created · config strands-agent/box.toml
strands-box: starting workload
strands-box: [agent] runs /opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14 with no policy decision over these paths:
  read        /Users/you/box-tutorial/strands-agent/runtime/.venv
  read        /opt/homebrew/Cellar/python@3.14
  read        /opt/homebrew/Cellar/openssl@3
  read        /opt/homebrew/Cellar/sqlite
  write       /Users/you/box-tutorial/strands-agent/tmp
  read_file   /Users/you/box-tutorial/strands-agent/agent.py
  list        /Users/you/box-tutorial/my-project
  metadata    /opt/homebrew/opt
  exec        /opt/homebrew/Cellar/python@3.14
  exec        /opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14  (command, implicit)
strands-box: [agent] runtime minimum, added by Core:
  ...
strands-box: [agent] HOME=/Users/you PATH=/Users/you/box-tutorial/strands-agent/state/bin:/usr/bin:/bin
I'll read the README.md file.
Tool #1: read_file
[tool] cat README.md (exit 0)
README.md contains only a title heading, "My project" — there's no actual content to summarize beyond the project's name.
```

`cat README.md` ran in the box’s shell. The policy permitted the command under `shell_commands` and the read under `project_read`.

### A forbidden read

```sh
./box-core/box run --config strands-agent/box.toml -- "Read the .env file and tell me what it contains."
```

```text
I'll take a look at the project structure and the file you mentioned.
Tool #1: list_project

Tool #2: read_file
[tool] cat .env (exit 1)
strands-shell: cat: policy denied this operation on '~/box-tutorial/my-project/.env' [policy: no_env]: The .env file holds credentials the agent must not read.
[tool] ls -a (exit 0)
The read was blocked. The tool reported: `strands-shell: cat: policy denied this operation on '~/box-tutorial/my-project/.env' [policy: no_env]: The .env file holds credentials the agent must not read.`

This stopped me from reading `.env`, so I can't tell you its contents. The project also contains `README.md`, `hello.py`, `scratch.txt`, and `util.py`.
```

`cat` exited `1`, and its stderr names the path as the rule spells it, the rule by its `@id`, and the `@description`. The tool returned that text to the model, and the model quoted it. Write each `@description` for the agent, because this is where it lands.

### A permitted shell command

```sh
./box-core/box run --config strands-agent/box.toml -- "Count the lines in every Python file in the project."
```

```text
I'll start by looking at the project structure.
Tool #1: list_project
[tool] ls -a (exit 0)

Tool #2: run_command
[tool] find . -name "*.py" -type f | xargs wc -l (exit 0)
There are two Python files in the project:

| File | Lines |
|---|---|
| `hello.py` | 1 |
| `util.py` | 2 |
| **Total** | **3** |

Both files are very small — just 3 lines of Python across the whole project.
```

`find`, `xargs`, and `wc` are commands the shell implements, so each is a `shell:exec` decision under `shell_commands`, and each file `wc` opens is an `fs:read` decision under `project_read`.

### A forbidden delete

```sh
./box-core/box run --config strands-agent/box.toml -- "Delete scratch.txt."
```

```text
I'll take a look at the project first to see what's there.
Tool #1: list_project
[tool] ls -a (exit 0)

Tool #2: run_command
[tool] rm scratch.txt (exit 1)
rm: scratch.txt: policy denied this operation on '~/box-tutorial/my-project/scratch.txt' [policy: no_deletes]: This agent reads the project and runs commands in it. It deletes nothing.
The deletion was blocked. The tool reported:

> `rm: scratch.txt: policy denied this operation on '~/box-tutorial/my-project/scratch.txt' [policy: no_deletes]: This agent reads the project and runs commands in it. It deletes nothing.`

This stopped me from removing `scratch.txt` — the file is still in place. You'll need to delete it yourself.
```

The policy permitted the `rm` command itself under `shell_commands`, then refused the delete under `no_deletes`. `scratch.txt` is still in the project:

```sh
ls -1 my-project
```

```text
README.md
hello.py
scratch.txt
util.py
```

## Step 7. Read the decision log

The box writes its decisions to `strands-agent/state/private/telemetry/records.jsonl`. This command prints the verdict, action, resource, and rule of each one, as in [write a policy](../write-a-policy/index.md#step-4-read-the-decision-log):

```sh
jq -r '
  .resourceLogs[]?.scopeLogs[]
  | select(.scope.name == "strands-box.policy")
  | .logRecords[]
  | [.attributes[] | select(.key | startswith("strands.box.policy."))
     | {(.key | ltrimstr("strands.box.policy.")): .value.stringValue}]
  | add
  | "\(.verdict)\t\(.action)\t\(.resource)\t\(.rule)"
' strands-agent/state/private/telemetry/records.jsonl
```

Among the lines, the decisions behind each task’s `cat`, `find`, and `rm`. `rm` checks the file before it deletes it, which is the `fs:read` above the `fs:delete`:

```text
permit  shell:exec  cat  shell_commands
permit  fs:read  ~/box-tutorial/my-project/README.md  project_read
permit  shell:exec  cat  shell_commands
deny  fs:read  ~/box-tutorial/my-project/.env  no_env
permit  shell:exec  find  shell_commands
permit  shell:exec  xargs  shell_commands
permit  shell:exec  wc  shell_commands
permit  fs:read  ~/box-tutorial/my-project/hello.py  project_read
permit  fs:read  ~/box-tutorial/my-project/util.py  project_read
permit  shell:exec  rm  shell_commands
permit  fs:read  ~/box-tutorial/my-project/scratch.txt  project_read
deny  fs:delete  ~/box-tutorial/my-project/scratch.txt  no_deletes
```

Each model call is an `http:request` under `model_request`, on a connection that `model_connect` permitted.

## What you have

A Strands Agents SDK agent that sends every tool call through the box’s shell, a `box.toml` that gives its process the Python, the SDK, and the project’s file names, and a policy that permitted two tasks and refused two with text the agent quoted back. To give the agent more, add a tool to `agent.py` and a rule to `policy.dw`: [common rules](../../reference/policy/index.md#common-rules) has six to start from, and [write policy for shell commands](../write-shell-policy/index.md) shows how to admit a program such as `git`.

## If something goes wrong

| Error | Fix |
| --- | --- |
| `no Python at /opt/homebrew/bin/python3.14: run 'brew install python@3.14', or set PYTHON to another interpreter` | Install Homebrew’s Python 3.14: `brew install python@3.14`. |
| `ModuleNotFoundError: No module named 'strands'` | Run `./strands-agent/setup.sh`, and check that `command` in `box.toml` names `runtime/.venv/bin/python3`. |
| `filesystem entry "..." is refused: ... is a symbolic link` | Name the directory the link points at. For a Homebrew package, that is its directory under `/opt/homebrew/Cellar`. |
| `Library not loaded: /opt/homebrew/opt/<package>/...` | Add `/opt/homebrew/Cellar/<package>` to `read` in `[agent.filesystem]`. |
| `exec ".../runtime/.venv/bin/python3" failed: Operation not permitted` | Check that `metadata` in `[agent.filesystem]` names `/opt/homebrew/opt`, and `exec` names the Python directory under `/opt/homebrew/Cellar`. |
| `blocked by egress control` in the agent’s output | The egress gateway refused a request to Bedrock. [Errors and exit codes](../network-and-credentials/index.md#errors-and-exit-codes) on the egress page lists the causes. |
| A `403` from Bedrock | Bedrock refused the key. Check that it is in `AWS_BEARER_TOKEN_BEDROCK` and was made in `us-west-2`. |

## See also

-   [Write a policy and read what it decided](../write-a-policy/index.md): each part of a rule, and the record of each decision.
-   [Strands Shell](../../reference/shell/index.md): what the agent’s `zsh -c` runs, where, and the fields a rule reads.
-   [Security](../../security/index.md#the-two-tiers): what `box.toml` governs, what `policy.dw` governs, and why the project stays out of the agent’s `read` list.
-   [The example directory](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/examples/strands-box/strands-sdk-agent/): the files this page walks through.