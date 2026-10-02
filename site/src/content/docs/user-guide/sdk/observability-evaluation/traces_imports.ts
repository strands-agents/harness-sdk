// @ts-nocheck: imports are duplicated across snippets for documentation display

// --8<-- [start:code_configuration_option1_imports]
import { Agent } from '@strands-agents/sdk'
// --8<-- [end:code_configuration_option1_imports]

// --8<-- [start:code_configuration_option2_imports]
import { Agent } from '@strands-agents/sdk'
import { setupTracer } from '@strands-agents/sdk/telemetry'
// --8<-- [end:code_configuration_option2_imports]

// --8<-- [start:code_configuration_option3_imports]
import { Agent } from '@strands-agents/sdk'
import { setupTracer } from '@strands-agents/sdk/telemetry'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
// --8<-- [end:code_configuration_option3_imports]

// --8<-- [start:console_exporter_imports]
import { setupTracer } from '@strands-agents/sdk/telemetry'
// --8<-- [end:console_exporter_imports]

// --8<-- [start:custom_attributes_imports]
import { Agent } from '@strands-agents/sdk'
// --8<-- [end:custom_attributes_imports]

// --8<-- [start:configuring_exporters_imports]
import { setupTracer } from '@strands-agents/sdk/telemetry'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
// --8<-- [end:configuring_exporters_imports]

// --8<-- [start:custom_spans_imports]
import { setupTracer, getTracer } from '@strands-agents/sdk/telemetry'
// --8<-- [end:custom_spans_imports]

// --8<-- [start:end_to_end_imports]
import { Agent } from '@strands-agents/sdk'
import { setupTracer } from '@strands-agents/sdk/telemetry'
// --8<-- [end:end_to_end_imports]
