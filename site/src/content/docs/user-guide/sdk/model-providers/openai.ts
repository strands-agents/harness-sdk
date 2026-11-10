/**
 * TypeScript examples for OpenAI model provider documentation.
 * These examples demonstrate common usage patterns for the OpenAIModel.
 */
// @ts-nocheck
// Imports are in openai_imports.ts

import OpenAI from 'openai'
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { z } from 'zod'

// Basic usage
async function basicUsage() {
  // --8<-- [start:basic_usage]
  const model = new OpenAIModel({
    api: 'chat',
    apiKey: process.env.OPENAI_API_KEY || '<KEY>',
    modelId: 'gpt-5.4',
    maxTokens: 1000,
    temperature: 0.7,
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2')
  console.log(response)
  // --8<-- [end:basic_usage]
}

// Custom server
async function customServer() {
  // --8<-- [start:custom_server]
  const model = new OpenAIModel({
    api: 'chat',
    apiKey: '<KEY>',
    clientConfig: {
      baseURL: '<URL>',
    },
    modelId: 'gpt-5.4',
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('Hello!')
  // --8<-- [end:custom_server]
}

// Custom client
async function customClient() {
  // --8<-- [start:custom_client]
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '<KEY>',
  })

  const model = new OpenAIModel({
    api: 'chat',
    client,
    modelId: 'gpt-5.4',
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2?')
  console.log(response)
  // --8<-- [end:custom_client]
}

// Configuration
async function customConfig() {
  // --8<-- [start:custom_config]
  const model = new OpenAIModel({
    api: 'chat',
    apiKey: process.env.OPENAI_API_KEY || '<KEY>',
    modelId: 'gpt-5.4',
    maxTokens: 1000,
    temperature: 0.7,
    topP: 0.9,
    frequencyPenalty: 0.5,
    presencePenalty: 0.5,
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('Write a short poem')
  console.log(response)
  // --8<-- [end:custom_config]
}

// Update configuration
async function updateConfig() {
  // --8<-- [start:update_config]
  const model = new OpenAIModel({
    api: 'chat',
    apiKey: process.env.OPENAI_API_KEY || '<KEY>',
    modelId: 'gpt-5.4',
    temperature: 0.7,
  })

  // Update configuration later
  model.updateConfig({
    temperature: 0.3,
    maxTokens: 500,
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('Summarize this in one sentence')
  // --8<-- [end:update_config]
}

async function structuredOutput() {
  // --8<-- [start:structured_output]
  const PersonInfo = z.object({
    name: z.string().describe('Full name of the person'),
    age: z.number().describe('Age in years'),
    occupation: z.string().describe('Job or profession'),
  })

  const model = new OpenAIModel({
    api: 'chat',
    apiKey: process.env.OPENAI_API_KEY || '<KEY>',
    modelId: 'gpt-4o',
  })

  const agent = new Agent({ model, structuredOutputSchema: PersonInfo })

  const result = await agent.invoke(
    'John Smith is a 30-year-old software engineer working at a tech startup.'
  )

  const person = result.structuredOutput as z.infer<typeof PersonInfo>
  console.log(`Name: ${person.name}`) // "John Smith"
  console.log(`Age: ${person.age}`) // 30
  console.log(`Job: ${person.occupation}`) // "software engineer"
  // --8<-- [end:structured_output]
}
