# Sleep Tool

Pauses agent execution for a bounded, cooperative duration.

The tool takes a `duration` in seconds. It listens to `context.cancelSignal`, so cancellation aborts the sleep immediately rather than waiting for the full duration. A configurable maximum (default: 60 s) rejects oversized requests before the sleep starts, and negative, `NaN`, `Infinity`, and non-numeric inputs are rejected at the tool boundary.

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { sleep } from '@strands-agents/sdk/vended-tools/sleep'

const agent = new Agent({ tools: [sleep] })
await agent.invoke('Pause for two seconds, then continue.')
```

Direct invocation:

```typescript
const result = await sleep.invoke({ duration: 0.5 })
// "Slept for 0.5 seconds"
```

Custom maximum:

```typescript
import { makeSleep } from '@strands-agents/sdk/vended-tools/sleep'

const shortSleep = makeSleep({ maxDuration: 5 })
const agent = new Agent({ tools: [shortSleep] })
```

## API

### `sleep`

The default tool, produced by `makeSleep()` with `maxDuration = 60`.

### `makeSleep(options?)`

| Option        | Type     | Default    | Description                                                         |
| ------------- | -------- | ---------- | ------------------------------------------------------------------- |
| `maxDuration` | `number` | `60`       | Upper bound on `duration`, in seconds. Must be finite and positive. |
| `name`        | `string` | `sleep`    | Tool name.                                                          |
| `description` | `string` | (built-in) | Description shown to the model.                                     |

Throws if `maxDuration` is not a positive, finite number.

### Input

| Property   | Type     | Required | Description                                                           |
| ---------- | -------- | -------- | --------------------------------------------------------------------- |
| `duration` | `number` | Yes      | Seconds to pause. Must be finite, non-negative, and `<= maxDuration`. |

### Output

Returns a string of the form `"Slept for <duration> seconds"`.
