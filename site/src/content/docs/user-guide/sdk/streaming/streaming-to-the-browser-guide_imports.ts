// @ts-nocheck
// Rendered import sets. Local modules (./public-events, ./agent-runs, @/lib/...) are the
// files the page tells readers to create, so they do not resolve here.

// --8<-- [start:event_mapper_imports]
import type { AgentResult, AgentStreamEvent, ModelStreamEvent } from '@strands-agents/sdk'
// --8<-- [end:event_mapper_imports]

// --8<-- [start:agent_runs_imports]
import { randomUUID } from 'node:crypto'
import { Agent } from '@strands-agents/sdk'
import { createEventMapper, errorFinalEvent, toFinalEvent } from './public-events'
import type { PublicEnvelope, PublicEvent } from './public-events'
// --8<-- [end:agent_runs_imports]

// --8<-- [start:express_sse_imports]
import express, { type Request } from 'express'
import { getRun, startRun } from './agent-runs'
// --8<-- [end:express_sse_imports]

// --8<-- [start:express_long_poll_imports]
import type { PublicEnvelope } from './public-events'
// --8<-- [end:express_long_poll_imports]

// --8<-- [start:nextjs_runs_route_imports]
import { startRun } from '@/lib/agent-runs'
// --8<-- [end:nextjs_runs_route_imports]

// --8<-- [start:nextjs_events_route_imports]
import { getRun } from '@/lib/agent-runs'
import type { AgentRun } from '@/lib/agent-runs'
// --8<-- [end:nextjs_events_route_imports]

// --8<-- [start:browser_client_imports]
import type { PublicEnvelope } from './public-events'
// --8<-- [end:browser_client_imports]
