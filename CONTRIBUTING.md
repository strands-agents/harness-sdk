# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.


## Reporting Bugs/Feature Requests

We welcome you to use the [Bug Reports](../../issues/new?template=bug_report.yml) file to report bugs or [Feature Requests](../../issues/new?template=feature_request.yml) to suggest features.

For a list of known bugs and feature requests:
- Check [Bug Reports](../../issues?q=is%3Aissue%20state%3Aopen%20label%3Abug) for currently tracked issues
- See [Feature Requests](../../issues?q=is%3Aissue%20state%3Aopen%20label%3Aenhancement) for requested enhancements

When filing an issue, please check for already tracked items

Please try to include as much information as you can. Details like these are incredibly useful:

* A reproducible test case or series of steps
* The version of our code being used (commit ID)
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment


## Finding contributions to work on
Looking at the existing issues is a great way to find something to contribute to. We label issues that are well-defined and ready for community contributions with the "ready for contribution" label.

Check our [Ready for Contribution](../../issues?q=is%3Aissue%20state%3Aopen%20label%3A%22ready%20for%20contribution%22) issues for items you can work on.

Before starting work on any issue:
1. Check if someone is already assigned or working on it
2. Comment on the issue to express your interest and ask any clarifying questions
3. Wait for maintainer confirmation before beginning significant work


## Development Tenets
Our team follows these core principles when designing and implementing features. These tenets help us make consistent decisions, resolve trade-offs, and maintain the quality and coherence of the SDK. When contributing, please consider how your changes align with these principles:

1. **Simple at any scale:** We believe that simple things should be simple. The same clean abstractions that power a weekend prototype should scale effortlessly to production workloads. We reject the notion that enterprise-grade means enterprise-complicated - Strands remains approachable whether it's your first agent or your millionth.
2. **Extensible by design:** We allow for as much configuration as possible, from hooks to model providers, session managers, tools, etc. We meet customers where they are with flexible extension points that are simple to integrate with.
3. **Composability:** Primitives are building blocks with each other. Each feature of Strands is developed with all other features in mind, they are consistent and complement one another.
4. **The obvious path is the happy path:** Through intuitive naming, helpful error messages, and thoughtful API design, we guide developers toward correct patterns and away from common pitfalls.
5. **We are accessible to humans and agents:** Strands is designed for both humans and AI to understand equally well. We don’t take shortcuts on curated DX for humans and we go the extra mile to make sure coding assistants can help you use those interfaces the right way.
6. **Embrace common standards:** We respect what came before, and do not want to reinvent something that is already widely adopted or done better.

When proposing solutions or reviewing code, we reference these principles to guide our decisions. If two approaches seem equally valid, we choose the one that best aligns with our tenets.

The `team/` folder holds the rest of our shared context: the full [tenets](./team/TENETS.md), [decision records](./team/DECISIONS.md), the [API bar-raising](./team/API_BAR_RAISING.md) and [feature lifecycle](./team/FEATURE_LIFECYCLE.md) processes, and our [design proposals](./team/designs/). For a significant feature or a breaking change, start with a design proposal in [`team/designs/`](./team/designs/) — see its [README](./team/designs/README.md) for the template and process.

## Development Environment

This is a monorepo containing the Python SDK, TypeScript SDK, MCP server, and documentation site. Each has its own toolchain:

| Area | Directory | Toolchain |
|------|-----------|-----------|
| Python SDK | `strands-py/` | hatch |
| TypeScript SDK | `strands-ts/` | npm workspace |
| MCP server | `strands-mcp/` | hatch |
| Docs site | `site/` | Astro (npm) |

### Python SDK

The Python SDK uses [hatchling](https://hatch.pypa.io/latest/build/#hatchling) as the build backend and [hatch](https://hatch.pypa.io/latest/) for development workflow management.

All `hatch` commands should be run from the `strands-py/` subdirectory (where `pyproject.toml` lives):

```bash
cd strands-py
```

### Setting Up Your Development Environment

1. Entering virtual environment using `hatch` (recommended), then launch your IDE in the new shell.
   ```bash
   hatch shell
   ```


2. Set up pre-commit hooks:
   ```bash
   pre-commit install -t pre-commit -t commit-msg
   ```
   This will automatically run formatters and conventional commit checks on your code before each commit.

3. Run code formatters manually:
   ```bash
   hatch fmt --formatter
   ```

4. Run linters:
   ```bash
   hatch fmt --linter
   ```

5. Run unit tests:
   ```bash
   hatch test
   ```
   Or run them with coverage:
   ```bash
   hatch test -c
   ```

6. Run integration tests:
   ```bash
   hatch run test-integ
   ```

### Pre-commit Hooks

We use [pre-commit](https://pre-commit.com/) to automatically run quality checks before each commit. The hook will run `hatch run format`, `hatch run lint`, `hatch run test`, and `hatch run cz check` when you make a commit, ensuring code consistency.

The pre-commit hook is installed with:

```bash
pre-commit install
```

You can also run the hooks manually on all files:

```bash
pre-commit run --all-files
```

### Code Formatting and Style Guidelines

We use the following tools to ensure code quality:
1. **ruff** - For formatting and linting
2. **mypy** - For static type checking

These tools are configured in the [pyproject.toml](./strands-py/pyproject.toml) file. Please ensure your code passes all linting and type checks before submitting a pull request:

```bash
# Run all checks
hatch fmt --formatter
hatch fmt --linter
```

If you're using an IDE like VS Code or PyCharm, consider configuring it to use these tools automatically.

For additional details on styling, please see our dedicated [Style Guide](./strands-py/docs/STYLE_GUIDE.md).


### TypeScript SDK

The TypeScript SDK uses an npm workspace rooted at the repository root.

```bash
npm ci  # install dependencies (from repo root)
```

Before opening a TypeScript pull request, run the locally reproducible checks
exercised by PR CI:

```bash
npm run build                 # build
npm run lint                  # lint
npm run format:check          # formatting
npm run type-check            # type checking
npm run check:browser-bundle  # browser bundle
npm run test:browser:install  # install Chromium once for browser tests
npm run test:all:coverage     # Node.js and browser unit tests with coverage
npm run test:package          # package and local consumer checks
npm run test:integ:selective  # integration tests affected by your changes
```

PR CI also packs the SDK and installs the tarball outside the monorepo to catch
missing optional peer dependencies. That exact smoke test currently runs only
in the [TypeScript package-pack workflow](./.github/workflows/typescript-test-package-pack.yml);
`npm run test:package` is the closest local package check.

#### Running Selective Integration Tests Locally

The `test:integ:selective` command uses Vitest's module graph to run only the
`integ-node` and `integ-browser` specs that depend on the source files you
changed. If you alter a structural file (`package.json`, `package-lock.json`,
a `strands-ts` `tsconfig`, `vitest.config.ts`, a shared integration fixture
under `test/integ/__fixtures__/`, or a TypeScript CI workflow), the full
integration suite runs automatically.

### Documentation Site

The documentation site uses Astro with the Starlight theme.

```bash
cd site
npm install
npm run dev                # local dev server at http://localhost:4321/
npm run build              # production build
npm run typecheck          # type checking
npm run typecheck:snippets # type check code examples
```

For docs contribution guidelines, see [site/CONTRIBUTING.md](./site/CONTRIBUTING.md).

### PR Size and Complexity

Every PR is labeled with a `size/*` and a `complexity/*` label. Both are
informational — they help reviewers budget attention and neither blocks a merge.

You can see the same numbers before you push. From the repository root:

```bash
npm run complexity:setup   # once, to install the analyzers
npm run complexity         # report labels for your branch vs origin/main
```

Python contributors can use hatch instead, from `strands-py/`:

```bash
cd strands-py
hatch run complexity
```

**`size/*`** counts changed lines in source and prose, and **excludes tests,
lockfiles, and snapshots**. Thorough tests should never push a PR into a bigger
bucket, so write as many as the change deserves.

**`complexity/*`** reports the [cognitive complexity](https://www.sonarsource.com/docs/CognitiveComplexity.pdf)
of the most complex function your diff touches — roughly, how hard the control
flow is to hold in your head. It scores only the functions you actually
changed, and a touched function counts only if your change *increased* its
score over the merge base, so pre-existing complexity is never billed to you;
a PR that touches functions without increasing any lands at `complexity/low`.
`complexity/high` (above 25) is a hint
that a function may be worth splitting, not a rule; sometimes a complex
function is the honest solution.

A docs-only or test-only PR touches no SDK source and gets no complexity label.

The labels exist because review attention is the scarcest resource this
project has: they let maintainers triage which PRs need an unhurried senior
read, and they give you the same signal locally before a reviewer sees it. The
reasoning, the scoring model, and the practices that keep code under the
thresholds live in [team/COMPLEXITY.md](./team/COMPLEXITY.md).

## Using AI Tools

We love AI. We build with coding agents every day, and you're welcome to use them too — they're a great way to move fast and explore a codebase.

That said, **you are the author of your pull request, not your agent.** Before you open a PR, make sure you understand the code well enough to explain why it works, defend the design choices, and maintain it if asked. If you couldn't walk a reviewer through it line by line, it's not ready yet.

A few things that help us help you:

- **Keep changes small and incremental.** A focused PR that does one thing is far easier for us to understand, guide, and merge than a large one that touches many areas. When in doubt, split it up.
- **Open an issue first for anything significant**, so we can align on the approach before you (or your agent) invest the time.
- **Review every line your agent generates.** Delete what you don't need, simplify what's over-engineered, and make sure tests actually exercise the behavior — not just pass. Trim comments that narrate the agent's reasoning: a comment should state only what a reader cannot infer from the code.

High-quality PRs get reviewed faster and are far more likely to be accepted. Taking the time to understand and trim your changes is the single best thing you can do to get them merged.

## Contributing via Pull Requests
Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the *main* branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.

For guidance on writing effective PR descriptions, see our [PR Description Guidelines](./team/PR.md).

To send us a pull request, please:

1. Create a branch.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. Run the relevant formatting, linting, build, and test commands from the [Development Environment](#development-environment) section for the area you changed.
4. Commit to your branch using clear commit messages following the [Conventional Commits](https://www.conventionalcommits.org) specification.
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.


## Code of Conduct
This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.


## Security issue notifications
If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.


## Licensing

See the [LICENSE.APACHE](./LICENSE.APACHE) and [LICENSE.MIT](./LICENSE.MIT) files for our project's licensing. We will ask you to confirm the licensing of your contribution.
