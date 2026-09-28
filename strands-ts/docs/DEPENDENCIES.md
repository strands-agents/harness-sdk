# Dependency Guidelines - Strands TypeScript SDK

> **IMPORTANT**: When adding or modifying dependencies, you **MUST** follow the guidelines in this document. These patterns ensure proper dependency resolution for SDK consumers and avoid version conflicts.

| Category               | When to Use                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `dependencies`         | Core SDK functionality that users don't interact with directly          |
| `peerDependencies`     | Dependencies that cross API boundaries (users construct/pass instances) |
| `devDependencies`      | Build tools, testing frameworks, linters - not shipped to users         |
| `peerDependenciesMeta` | Mark peer dependencies as optional when not all users need them         |

## Peer Dependencies

Peer dependencies are packages the consuming application provides. The SDK relies on the user's installed version, ensuring both operate on the same instance and avoiding version conflicts.

**Rule**: If a dependency crosses an API boundary, it **MUST** be a peer dependency.

**Example**: `zod` is a peer dependency because users construct Zod schemas and pass them to the SDK:

```typescript
import { z } from 'zod'
import { Agent, tool } from '@strands-agents/sdk'

const calculator = tool({
  name: 'calculator',
  inputSchema: z.object({ value: z.number() }),
  callback: (input) => input.value * 2,
})

const agent = new Agent({ model, tools: [calculator] })
```

Mark peer dependencies as **optional** when not all users need them (e.g., model provider SDKs). Optional peer dependencies must also be added to `devDependencies` for SDK development and testing.

## Lock File

The repo-root `pnpm-lock.yaml` locks exact dependency versions for the SDK, its examples, and test infrastructure.

| Command                                  | When to Use                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`         | Installing dependencies without changes (fresh clone, after pulling, CI pipelines) |
| `pnpm add`, `pnpm remove`, `pnpm update` | Changing dependencies and refreshing the lock file                                 |

`pnpm install --frozen-lockfile` fails when the lock file and manifests disagree.

**When to modify:**

- Adding, removing, or updating dependencies in `package.json`
- Running `pnpm audit --fix` to patch security vulnerabilities

From the repository root, refresh the lock file after modifying dependencies:

```bash
npm run lock:refresh --prefix strands-ts
```

**Rules:**

1. Never manually edit `pnpm-lock.yaml` - always use `pnpm install` or `pnpm update`
2. Commit `pnpm-lock.yaml` changes in the same commit as the corresponding `package.json` changes
3. If `pnpm-lock.yaml` has merge conflicts, regenerate it with `npm run lock:refresh --prefix strands-ts`
