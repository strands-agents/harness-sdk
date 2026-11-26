// @ts-nocheck

// --8<-- [start:schema_validation_imports]
import { tool } from '@strands-agents/sdk'
import { realpath, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { z } from 'zod'
// --8<-- [end:schema_validation_imports]

// --8<-- [start:deterministic_rules_imports]
import { InterventionActions, InterventionHandler } from '@strands-agents/sdk'
import type { BeforeToolCallEvent, OnError } from '@strands-agents/sdk'
// --8<-- [end:deterministic_rules_imports]

// --8<-- [start:classifier_imports]
import { InterventionActions, InterventionHandler } from '@strands-agents/sdk'
import type { BeforeModelCallEvent, LocalAgent } from '@strands-agents/sdk'
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from '@aws-sdk/client-bedrock-runtime'
// --8<-- [end:classifier_imports]

// --8<-- [start:model_boundary_imports]
import { BedrockModel } from '@strands-agents/sdk'
// --8<-- [end:model_boundary_imports]

// --8<-- [start:confirm_imports]
import {
  Agent,
  InterruptResponseContent,
  InterventionActions,
  InterventionHandler,
  tool,
} from '@strands-agents/sdk'
import type { BeforeToolCallEvent } from '@strands-agents/sdk'
import { realpath, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { z } from 'zod'
// --8<-- [end:confirm_imports]

// --8<-- [start:tenant_policy_imports]
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
// --8<-- [end:tenant_policy_imports]

// --8<-- [start:audit_record_imports]
import {
  InterruptError,
  InterventionActions,
  InterventionHandler,
} from '@strands-agents/sdk'
import type { BeforeToolCallEvent, JSONValue, OnError } from '@strands-agents/sdk'
// --8<-- [end:audit_record_imports]

// --8<-- [start:retrieval_boundary_imports]
import {
  InterventionActions,
  InterventionHandler,
  TextBlock,
  ToolResultBlock,
} from '@strands-agents/sdk'
import type { AfterToolCallEvent } from '@strands-agents/sdk'
// --8<-- [end:retrieval_boundary_imports]

// --8<-- [start:compose_imports]
import {
  Agent,
  BedrockModel,
  InterruptError,
  InterventionActions,
  InterventionHandler,
  TextBlock,
  ToolResultBlock,
  tool,
} from '@strands-agents/sdk'
import type {
  AfterToolCallEvent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  JSONValue,
  LocalAgent,
  OnError,
} from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from '@aws-sdk/client-bedrock-runtime'
import { realpath, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { z } from 'zod'
// --8<-- [end:compose_imports]
