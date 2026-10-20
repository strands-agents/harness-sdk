// @ts-nocheck
// NOTE: Snippets re-import the same identifiers so each rendered block is self-contained.

// --8<-- [start:server_config_imports]
import { Agent } from '@strands-agents/sdk'
import { A2AExpressServer } from '@strands-agents/sdk/a2a/express'
// --8<-- [end:server_config_imports]

// --8<-- [start:express_middleware_imports]
import express from 'express'
import { Agent } from '@strands-agents/sdk'
import { A2AExpressServer } from '@strands-agents/sdk/a2a/express'
// --8<-- [end:express_middleware_imports]

// --8<-- [start:user_builder_imports]
import type { Request } from 'express'
import type { User } from '@a2a-js/sdk/server'
import { Agent } from '@strands-agents/sdk'
import { A2AExpressServer } from '@strands-agents/sdk/a2a/express'
// --8<-- [end:user_builder_imports]
