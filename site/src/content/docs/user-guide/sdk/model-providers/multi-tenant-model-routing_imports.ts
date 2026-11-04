// @ts-nocheck

// --8<-- [start:mtr_tracing_imports]
import { setupTracer } from '@strands-agents/sdk/telemetry'
// --8<-- [end:mtr_tracing_imports]

// --8<-- [start:mtr_candidates_imports]
import { BedrockModel, RoutingCandidate } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
// --8<-- [end:mtr_candidates_imports]

// --8<-- [start:mtr_strategy_imports]
import {
  DecisionModel,
  FallbackStrategy,
  RoutingCandidate,
  type RoutingContext,
  type RoutingStrategy,
} from '@strands-agents/sdk'
// --8<-- [end:mtr_strategy_imports]

// --8<-- [start:mtr_decider_imports]
import {
  DecisionModel,
  type DecisionInput,
  type DecisionResult,
  type Question,
} from '@strands-agents/sdk'
// --8<-- [end:mtr_decider_imports]

// --8<-- [start:mtr_swap_imports]
import { BedrockModel, LLMDecisionModel } from '@strands-agents/sdk'
// --8<-- [end:mtr_swap_imports]

// --8<-- [start:mtr_agent_imports]
import { Agent, ModelRouter, tool } from '@strands-agents/sdk'
import { z } from 'zod'
// --8<-- [end:mtr_agent_imports]
