// @ts-nocheck
// Import snippets — intentionally repeat imports across blocks so each
// rendered doc example is self-contained.

// --8<-- [start:web_fetch_import]
import { Agent } from '@strands-agents/sdk'
import { webFetch } from '@strands-agents/sdk/vended-tools/web-fetch'
// --8<-- [end:web_fetch_import]

// --8<-- [start:web_fetch_markdown_import]
import { Agent } from '@strands-agents/sdk'
import { makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'
// --8<-- [end:web_fetch_markdown_import]

// --8<-- [start:web_fetch_custom_import]
import { Agent } from '@strands-agents/sdk'
import { makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
// --8<-- [end:web_fetch_custom_import]
