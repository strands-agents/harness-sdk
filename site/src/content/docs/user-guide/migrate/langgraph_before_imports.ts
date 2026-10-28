// @ts-nocheck
// --8<-- [start:graph_before_imports]
import { tool } from '@langchain/core/tools'
import {
  END,
  MessagesValue,
  START,
  StateGraph,
  StateSchema,
  type GraphNode,
} from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt'
import { z } from 'zod'
// --8<-- [end:graph_before_imports]
