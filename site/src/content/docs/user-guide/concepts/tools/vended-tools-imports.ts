// @ts-nocheck
// This file contains import snippets used in documentation examples.
// Each snippet is a standalone import block for a specific tool.
// @ts-nocheck is used because imports are intentionally repeated across snippets
// for documentation clarity — each snippet shows the complete imports needed.

// --8<-- [start:bash_import]
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
// --8<-- [end:bash_import]

// --8<-- [start:file_editor_import]
import { Agent } from '@strands-agents/sdk'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
// --8<-- [end:file_editor_import]

// --8<-- [start:http_request_import]
import { Agent } from '@strands-agents/sdk'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
// --8<-- [end:http_request_import]

// --8<-- [start:notebook_import]
import { Agent } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
// --8<-- [end:notebook_import]

// --8<-- [start:notebook_persistence_import]
import { Agent, SessionManager, FileStorage } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
// --8<-- [end:notebook_persistence_import]

// --8<-- [start:combined_import]
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
// --8<-- [end:combined_import]

// --8<-- [start:sleep_import]
import { Agent } from '@strands-agents/sdk'
import { sleep } from '@strands-agents/sdk/vended-tools/sleep'
// --8<-- [end:sleep_import]

// --8<-- [start:sleep_custom_import]
import { Agent } from '@strands-agents/sdk'
import { makeSleep } from '@strands-agents/sdk/vended-tools/sleep'
// --8<-- [end:sleep_custom_import]

// --8<-- [start:stop_import]
import { Agent } from '@strands-agents/sdk'
import { stop } from '@strands-agents/sdk/experimental/vended-tools/stop'
// --8<-- [end:stop_import]

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
