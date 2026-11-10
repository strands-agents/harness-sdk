/**
 * TypeScript examples for Google model provider documentation.
 * These examples demonstrate common usage patterns for the GoogleModel.
 */

import { GoogleGenAI } from '@google/genai'
import {
  Agent,
  DocumentBlock,
  ImageBlock,
  TextBlock,
  VideoBlock,
} from '@strands-agents/sdk'
import { GoogleModel } from '@strands-agents/sdk/models/google'
import { z } from 'zod'

// Basic usage
async function basicUsage() {
  // --8<-- [start:basic_usage]
  const model = new GoogleModel({
    apiKey: '<KEY>',
    modelId: 'gemini-2.5-flash',
    params: {
      temperature: 0.7,
      maxOutputTokens: 2048,
      topP: 0.9,
      topK: 40,
    },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2')
  console.log(response)
  // --8<-- [end:basic_usage]
}

// Model parameters example
async function paramsExample() {
  // --8<-- [start:params_example]
  const params = {
    temperature: 0.8,
    maxOutputTokens: 4096,
    topP: 0.95,
    topK: 40,
    candidateCount: 1,
    stopSequences: ['STOP!'],
  }
  // --8<-- [end:params_example]
}

// Built-in tools
async function builtInTools() {
  // --8<-- [start:builtin_tools]
  const model = new GoogleModel({
    apiKey: '<KEY>',
    modelId: 'gemini-2.5-flash',
    builtInTools: [{ googleSearch: {} }],
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What are the latest AI news today?')
  console.log(response)
  // --8<-- [end:builtin_tools]
}

// Error handling
async function errorHandling() {
  const agent = new Agent({ model: new GoogleModel({ apiKey: '<KEY>' }) })
  // --8<-- [start:error_handling]
  try {
    const response = await agent.invoke('Your query here')
  } catch (error) {
    console.error('Error:', error)
    // Implement backoff strategy
  }
  // --8<-- [end:error_handling]
}

// Custom client
async function customClient() {
  // --8<-- [start:custom_client]
  const client = new GoogleGenAI({ apiKey: '<KEY>' })

  const model = new GoogleModel({
    client,
    modelId: 'gemini-2.5-flash',
    params: {
      temperature: 0.7,
      maxOutputTokens: 2048,
      topP: 0.9,
      topK: 40,
    },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2')
  console.log(response)
  // --8<-- [end:custom_client]
}

// Image input
async function imageInput() {
  const imageBytes = new Uint8Array()
  // --8<-- [start:image_input]
  const model = new GoogleModel({
    apiKey: '<KEY>',
    modelId: 'gemini-2.5-flash',
  })

  const agent = new Agent({ model })

  // Process image with text
  const result = await agent.invoke([
    new TextBlock('What do you see in this image?'),
    new ImageBlock({
      format: 'png',
      source: { bytes: imageBytes },
    }),
  ])
  // --8<-- [end:image_input]
}

// Document input
async function documentInput() {
  const agent = new Agent({ model: new GoogleModel({ apiKey: '<KEY>' }) })
  const pdfBytes = new Uint8Array()
  // --8<-- [start:document_input]
  const result = await agent.invoke([
    new TextBlock('Summarize this document'),
    new DocumentBlock({
      name: 'my-document',
      format: 'pdf',
      source: { bytes: pdfBytes },
    }),
  ])
  // --8<-- [end:document_input]
}

// Video input
async function videoInput() {
  const agent = new Agent({ model: new GoogleModel({ apiKey: '<KEY>' }) })
  const videoBytes = new Uint8Array()
  // --8<-- [start:video_input]
  const result = await agent.invoke([
    new TextBlock('Describe what happens in this video'),
    new VideoBlock({
      format: 'mp4',
      source: { bytes: videoBytes },
    }),
  ])
  // --8<-- [end:video_input]
}

// Structured output
async function structuredOutputExample() {
  // --8<-- [start:structured_output]
  const MovieReview = z.object({
    title: z.string().describe('Movie title'),
    rating: z.number().min(1).max(10).describe('Rating from 1-10'),
    genre: z.string().describe('Primary genre'),
    sentiment: z.enum(['positive', 'negative', 'neutral']).describe('Overall sentiment'),
    summary: z.string().describe('Brief summary of the review'),
  })

  const model = new GoogleModel({
    apiKey: '<KEY>',
    modelId: 'gemini-2.5-flash',
  })

  const agent = new Agent({ model, structuredOutputSchema: MovieReview })

  const result = await agent.invoke(
    `Just watched "The Matrix" - what an incredible sci-fi masterpiece!
     The groundbreaking visual effects and philosophical themes make this
     a must-watch. Keanu Reeves delivers a solid performance. 9/10!`
  )

  const review = result.structuredOutput as z.infer<typeof MovieReview>
  console.log(`Movie: ${review.title}`)
  console.log(`Rating: ${review.rating}/10`)
  console.log(`Genre: ${review.genre}`)
  console.log(`Sentiment: ${review.sentiment}`)
  // --8<-- [end:structured_output]
}

void structuredOutputExample
