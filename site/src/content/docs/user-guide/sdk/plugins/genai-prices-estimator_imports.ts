// @ts-nocheck

// --8<-- [start:stream_imports]
import { Agent } from '@strands-agents/sdk'
import { GenAIPricesEstimator } from '@strands-agents/sdk/vended-plugins/cost-estimator'
// --8<-- [end:stream_imports]

// --8<-- [start:hook_imports]
import { CostEstimateEvent } from '@strands-agents/sdk/vended-plugins/cost-estimator'
// --8<-- [end:hook_imports]

// --8<-- [start:estimate_request_imports]
import { Agent, tool } from '@strands-agents/sdk'
import { GenAIPricesEstimator } from '@strands-agents/sdk/vended-plugins/cost-estimator'
import { z } from 'zod'
// --8<-- [end:estimate_request_imports]

// --8<-- [start:own_prices_imports]
import { GenAIPricesEstimator } from '@strands-agents/sdk/vended-plugins/cost-estimator'
// --8<-- [end:own_prices_imports]
