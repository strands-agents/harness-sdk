# Proactive restart

Verify that a long-running conversation moves to a replacement connection before the
provider limit without losing usable context or corrupting the event stream.

Docs:

- [BidiAgent connection lifecycle](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/agent.mdx)
- [Bidi hooks](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/hooks.mdx)

Template: [proactive-restart.py](../templates/proactive-restart.py)

---

## Memory test

The template shortens the proactive restart deadline to 30 seconds.

1. Immediately say: "Remember that I am traveling to Tokyo on December 1, 2026."
2. Ask the model to repeat the fact before restart.
3. Wait for the warning, restart, and second connection-start event.
4. Ask: "Where am I traveling, and on what date?"

Expected result:

- A warning arrives before restart.
- A scheduled restart event arrives before the replacement connection starts.
- The second connection answers Tokyo and December 1, 2026.
- The model does not greet or introduce itself again.
- The session remains usable for additional turns.

Model responses are non-deterministic. Judge whether the context remains available,
not whether the wording matches exactly.

## What to test

- Restart while idle.
- Restart during user speech.
- Restart during model speech.
- A response that exceeds the turn-alignment wait.
- Several consecutive proactive restarts.
- Stop the agent while a warning or restart is pending.
- Slow event consumption during the warning.
- `auto_reconnect=False`.

The loop waits up to ten seconds for an active or owed response to finish. If the wait
expires, `BidiConnectionRestartEvent.turn_interrupted` should be `True`.

## Watch for

- No warning or restart event.
- Duplicate restarts from scheduled and timeout paths.
- Sends never resume after restart.
- Events from the old connection appear after the new connection starts.
- User speech during restart is lost or heavily clipped.
- A question spoken before restart is never answered.
- Reconnect failure leaves the process hanging.
