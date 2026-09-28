// @ts-nocheck
// Import snippets — intentionally repeat imports across blocks so each
// rendered doc example is self-contained.

// --8<-- [start:getting_started]
import { Agent } from '@strands-agents/sdk'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'
// --8<-- [end:getting_started]

// --8<-- [start:word_count_validator]
import { Message } from '@strands-agents/sdk'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'
// --8<-- [end:word_count_validator]

// --8<-- [start:async_validator]
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'
// --8<-- [end:async_validator]

// --8<-- [start:judge_config]
import { BedrockModel } from '@strands-agents/sdk'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'
// --8<-- [end:judge_config]

// --8<-- [start:custom_judge]
import { Agent } from '@strands-agents/sdk'
import {
  GoalLoop,
  ValidationOutcome,
  buildJudgePrompt,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_OUTCOME_SCHEMA,
} from '@strands-agents/sdk/vended-plugins/goal'
// --8<-- [end:custom_judge]
