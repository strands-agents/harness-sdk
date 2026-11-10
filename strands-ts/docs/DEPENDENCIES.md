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

## Package Lock File

The `package-lock.json` file ensures reproducible builds by locking exact dependency versions.

| Command | When to Use |
|---------|-------------|
| `npm ci` | Installing dependencies without changes (fresh clone, after pulling, CI pipelines) |
| `npm install` | Adding, removing, or updating dependencies |

`npm ci` installs exactly what's in the lock file without modifying it, failing if there's a mismatch. This prevents accidental lock file changes.

**When to modify:**

- Adding, removing, or updating dependencies in `package.json`
- Running `npm audit fix` to patch security vulnerabilities

After modifying dependencies, regenerate the lock file for all platforms:

```bash
npm run lock:refresh
```

This generates a lock file that includes platform-specific optional dependencies for Linux, macOS, and Windows (both x64 and arm64), ensuring `npm ci` works in CI regardless of where the lock file was generated.

**Rules:**

1. Never manually edit `package-lock.json` - always use `npm install` or `npm update`
2. Always run `npm run lock:refresh` after modifying dependencies to ensure cross-platform compatibility
3. Commit `package-lock.json` changes in the same commit as the corresponding `package.json` changes
4. If `package-lock.json` has merge conflicts, delete it and run `npm run lock:refresh` to regenerate
