# Models: Amazon Nova Sonic

Test Amazon Nova Sonic's event conversion, audio formats, history replay, timeout
handling, and cleanup through Amazon Bedrock.

Docs:

- [Amazon Nova Sonic](../../site/src/content/docs/user-guide/concepts/bidirectional-streaming/models/bedrock.mdx)

Template: [models-nova-sonic.py](../templates/models-nova-sonic.py)

---

## Prerequisites

- Python 3.12 or later
- Nova Sonic model access
- AWS credentials and a supported region
- PortAudio for the local microphone and speaker template

The implementation defaults to `amazon.nova-2-sonic-v1:0`. You can also test
`amazon.nova-sonic-v1:0`. Ask for access to Nova Sonic 2.5 model to test.

## What to test

- Input and output rates of 8, 16, and 24 kHz.
- Different input and output rates.
- Voice selection.
- User interruption.

