// @ts-nocheck

// --8<-- [start:mr_fallback_imports]
import { Agent, BedrockModel, ModelRouter } from '@strands-agents/sdk'
// --8<-- [end:mr_fallback_imports]

// --8<-- [start:mr_classify_imports]
import {
  Agent,
  BedrockModel,
  ClassifierStrategy,
  ModelRouter,
  RoutingCandidate,
} from '@strands-agents/sdk'
// --8<-- [end:mr_classify_imports]

// --8<-- [start:mr_composed_imports]
import {
  Agent,
  BedrockModel,
  ClassifierStrategy,
  FallbackStrategy,
  ModelRouter,
  RoutingCandidate,
  type RoutingContext,
  type RoutingStrategy,
} from '@strands-agents/sdk'
// --8<-- [end:mr_composed_imports]
