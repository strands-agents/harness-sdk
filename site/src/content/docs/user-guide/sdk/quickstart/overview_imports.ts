// @ts-nocheck

// --8<-- [start:chat_server_imports]
import { Agent } from '@strands-agents/sdk'
import express, { type Request, type Response } from 'express'
// --8<-- [end:chat_server_imports]

// --8<-- [start:provider_bedrock_imports]
import { Agent } from '@strands-agents/sdk'
// --8<-- [end:provider_bedrock_imports]

// --8<-- [start:provider_anthropic_imports]
import { Agent } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
// --8<-- [end:provider_anthropic_imports]

// --8<-- [start:provider_openai_imports]
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
// --8<-- [end:provider_openai_imports]

// --8<-- [start:provider_google_imports]
import { Agent } from '@strands-agents/sdk'
import { GoogleModel } from '@strands-agents/sdk/models/google'
// --8<-- [end:provider_google_imports]
