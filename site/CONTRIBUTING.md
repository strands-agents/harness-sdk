# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.

## Development Setup

The documentation site is built with [Astro](https://astro.build/) and the [Starlight](https://starlight.astro.build/) theme.

### Prerequisites

- Python 3.10+
- Node.js 22+, npm

### Install and Run

```bash
npm install
npm run dev        # starts dev server at http://localhost:4321/
npm run build      # generates static site
```

### Writing Docs

- Content lives in `docs/` as standard Markdown files
- Navigation structure is defined in `src/config/navigation.yml`
- Use `<Tabs>` / `<Tab label="...">` for Python/TypeScript code tabs (auto-imported)
- Use `<Syntax py="python_name" ts="tsName" />` for inline language-specific identifiers in prose (auto-imported). Renders as `<code>` by default; pass `plain` for plain text. Reacts live to the global language toggle.
- Use `--8<-- "path/to/file.ts:snippet_name"` to pull in code snippets from external files
- Relative file links (e.g. `../tools/index.md`) resolve automatically — no need to use slugs
- Link to API reference pages with the `@api` shorthand: `[@api/python/strands.agent.agent](#Class)`

For full details on the Astro setup, custom components, frontmatter fields, and API doc generation, see [Site Architecture](SITE-ARCHITECTURE.md).

### Quality Checks

Before committing, run:

```bash
npm test              # run tests
npm run typecheck     # TypeScript type checking
npm run format:check  # formatting
```

Pre-commit hooks run these automatically.

### Sync Docs with Source Code Updates

After merging source code changes, run 

```bash
npm run sdk:sync
```

to make the doc types and generated API pages even with the new source code state.
New implementations should link to the API page from the User Guide.

## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already
reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

* A reproducible test case or series of steps
* The version of our code being used
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment

## Finding contributions to work on
Looking at the existing issues is a great way to find something to contribute to. We label issues that are well-defined and ready for community contributions with the "ready for contribution" label. As our projects, by default, use the default GitHub issue labels (enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.

Check our "Ready for Contribution" issues for items you can work on:
- [SDK Issues](https://github.com/strands-agents/harness-sdk/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22ready%20for%20contribution%22)
- [Tools Issues](https://github.com/strands-agents/tools/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22ready%20for%20contribution%22)

Before starting work on any issue:
1. Check if someone is already assigned or working on it
2. Comment on the issue to express your interest and ask any clarifying questions
3. Wait for maintainer confirmation before beginning significant work

## Contributing via Pull Requests
Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the *main* branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. Ensure local tests pass.
4. Commit to your fork using clear commit messages.
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

## Code of Conduct
This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.


## Security issue notifications
If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.


## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.
