// @ts-nocheck
// Import snippets for custom plugin documentation examples

// --8<-- [start:using_plugins_imports]
import { Agent, Plugin, Tool } from '@strands-agents/sdk'
// --8<-- [end:using_plugins_imports]

// --8<-- [start:basic_plugin_imports]
import { Agent, FunctionTool, Plugin, Tool } from '@strands-agents/sdk'
import { BeforeToolCallEvent, AfterToolCallEvent } from '@strands-agents/sdk'
// --8<-- [end:basic_plugin_imports]

// --8<-- [start:hook_decorator_alternative_imports]
import { Plugin } from '@strands-agents/sdk'
import { BeforeModelCallEvent, AfterModelCallEvent } from '@strands-agents/sdk'
// --8<-- [end:hook_decorator_alternative_imports]

// --8<-- [start:manual_registration_imports]
import { Plugin } from '@strands-agents/sdk'
import { BeforeToolCallEvent } from '@strands-agents/sdk'
// --8<-- [end:manual_registration_imports]

// --8<-- [start:state_management_imports]
import { Agent, Plugin } from '@strands-agents/sdk'
import { BeforeToolCallEvent } from '@strands-agents/sdk'
// --8<-- [end:state_management_imports]

// --8<-- [start:async_initialization_imports]
import { Plugin } from '@strands-agents/sdk'
import { BeforeToolCallEvent } from '@strands-agents/sdk'
// --8<-- [end:async_initialization_imports]
