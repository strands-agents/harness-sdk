# Bidi playground

A Nova Sonic `BidiAgent` with three tools (`get_time`, `get_weather`, `roll_dice`), bidi hooks
(response stop, barge-in, connection restart) and a callback output that tallies tool calls and tokens.

```bash
npx tsc && node dist/index.js          # text mode: type, read reply transcripts
npx tsc && node dist/index.js voice    # voice mode: mic in, speaker out (grant your terminal mic access)
```

Env: `AWS_REGION` (default `us-east-1`), `NOVA_MODEL_ID` (default `amazon.nova-2-5-sonic`).
Ctrl+C prints a session summary; hook activity goes to `bidi-playground.log` (`tail -f` it in another pane).

Text mode streams silence alongside the keyboard because Nova Sonic does not respond until an audio
input stream is open.
