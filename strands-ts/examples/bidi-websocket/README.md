# Bidirectional WebSocket

A voice agent served over a WebSocket: a browser captures microphone audio, sends it as
`audioDelta` frames, and plays the audio the agent streams back.

## Run the server

```bash
npm install
npm start   # ws://localhost:8080
```

The server needs AWS credentials with Amazon Bedrock access for Nova Sonic in `us-east-1`.

## Wire protocol

Both directions carry JSON text frames. Inbound frames are any JSON form of `BidiAgentInput`;
outbound frames are one `BidiOutputEvent`, discriminated by `type`, with `bidiAudioDelta` audio
base64-encoded.

```json
{ "text": "hello" }
{ "audioDelta": { "format": "pcm", "source": { "bytes": "<base64 PCM16>" } } }
```

## Browser client

Nova Sonic expects 16-bit PCM at 16 kHz in and emits 24 kHz out.

```html
<button onclick="talk()">Talk</button>
<script type="module">
  const socket = new WebSocket('ws://localhost:8080')
  const player = new AudioContext({ sampleRate: 24000 })
  let playAt = 0

  socket.onmessage = async ({ data }) => {
    const event = JSON.parse(data)
    if (event.type !== 'bidiAudioDelta') return

    const bytes = Uint8Array.from(atob(event.audio), (character) => character.charCodeAt(0))
    const samples = new Int16Array(bytes.buffer)
    const buffer = player.createBuffer(1, samples.length, event.sampleRate)
    buffer.copyToChannel(
      Float32Array.from(samples, (sample) => sample / 32768),
      0
    )

    const source = player.createBufferSource()
    source.buffer = buffer
    source.connect(player.destination)
    playAt = Math.max(playAt, player.currentTime)
    source.start(playAt)
    playAt += buffer.duration
  }

  window.talk = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recorder = new AudioContext({ sampleRate: 16000 })
    const source = recorder.createMediaStreamSource(stream)
    const chunker = recorder.createScriptProcessor(2048, 1, 1)

    chunker.onaudioprocess = ({ inputBuffer }) => {
      const samples = Int16Array.from(inputBuffer.getChannelData(0), (sample) => sample * 32767)
      const bytes = new Uint8Array(samples.buffer)
      const base64 = btoa(String.fromCharCode(...bytes))
      socket.send(JSON.stringify({ audioDelta: { format: 'pcm', source: { bytes: base64 } } }))
    }

    source.connect(chunker)
    chunker.connect(recorder.destination)
  }
</script>
```
