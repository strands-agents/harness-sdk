# Tool calling

Exercise successful, failed, concurrent, and long-running tools while the audio
connection remains active.

Docs:

- [BidiAgent](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/agent.mdx)
- [Hooks](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/hooks.mdx)

Template: [tool-calling.py](../templates/tool-calling.py)

---

## Baseline

1. Ask the model to look up a trip using `trip_lookup`.
2. Confirm that the spoken answer contains the tool result.
3. Ask for the special destination `error` to trigger a tool failure.

Expected result:

- The model emits a tool-use event.
- The tool runs without blocking event consumption.
- Successful results return to the model.
- Tool use and tool result messages appear next to each other in `agent.messages`.
- A failed tool returns an error-status tool result without corrupting the session.

## What to test

- Text and JSON tool results.
- Tool exceptions.
- A tool called while the model is speaking.
- User interruption during a slow tool.


## Test a tool across restart

We will do this as part of the next bug bash.

Current behavior:

- The tool keeps running.
- The completed tool exchange is recorded in local message history.
- The result is not sent to the replacement connection because that connection did
  not issue the original tool-use ID.
- The session should remain healthy.

Report a crash or stale-result provider error as a bug. Also record the user
experience when the replacement model never receives the late result.

## Watch for

- Tool messages are duplicated or separated in history.
- A tool error closes an otherwise healthy model connection.
- The model claims a tool result that the tool did not return.
