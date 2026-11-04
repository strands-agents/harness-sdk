## Overview

This tutorial demonstrates how to systematically compare different language models in production agent systems through A/B testing. Learn to build multiple agent variants, evaluate them on identical tasks, and make data-driven model selection decisions based on quality, cost, and performance metrics.

## Tutorial Structure

This tutorial consists of two parts:

### Part 1: Building Agents (07a-ab-testing-build-agents.ipynb)

-   Use ReAct airline assistant agent from python/04-industry-use-cases/logistics/
-   Create three agent variants with different models
-   Configure identical prompts, tools, and orchestration
-   Test each agent independently with sample queries
-   Save configurations for systematic evaluation

### Part 2: Evaluation (07b-ab-testing-evaluate.ipynb)

-   Run all three agents on identical test dataset
-   Compare evaluation scores side-by-side
-   Analyze cost-performance trade-offs
-   Generate statistical comparisons
-   Produce model selection recommendations

## Models Compared

**Claude Haiku** (us.anthropic.claude-haiku-4-5-20251001-v1:0)

-   Fastest, most cost-effective
-   Optimized for simple, high-volume queries
-   Lower latency, lower cost per token

**Claude Sonnet** (us.anthropic.claude-sonnet-4-6)

-   Balanced speed and capability
-   Strong reasoning for complex tasks
-   Production-ready for most use cases

**Nova Lite** (us.amazon.nova-lite-v1:0)

-   AWS-native model
-   Cost-effective with multimodal capabilities
-   Seamless AWS ecosystem integration

## What You’ll Learn

-   Build ReAct agents with custom orchestration
-   Create multiple agent variants for A/B testing
-   Configure identical capabilities across models
-   Run systematic comparative evaluations
-   Analyze cost-performance trade-offs
-   Make data-driven model selection decisions
-   Understand when to use each model type

## Prerequisites

-   Completion of Tutorials 01-06 (recommended)
-   Understanding of agent evaluation concepts
-   Familiarity with Strands Agents and Strands Evals
-   AWS account with Bedrock access
-   Access to Claude and Nova models in your region

## Installation

```bash
pip install -r requirements.txt
```

## Dataset

This tutorial uses the TauBench airline customer service dataset from the repository. The dataset includes:

-   Flight search and booking queries
-   Reservation modification scenarios
-   Cancellation and refund requests
-   Policy-based customer service inquiries

## Running the Tutorial

### Step 1: Build Agents

Open and run `07a-ab-testing-build-agents.ipynb`:

-   Imports airline tools from python/04-industry-use-cases/logistics/custom-orchestration-airline-assistant/
-   Creates three agent variants
-   Tests basic functionality
-   Exports configuration for evaluation

### Step 2: Evaluate Agents

Open and run `07b-ab-testing-evaluate.ipynb`:

-   Loads agent configurations
-   Runs systematic evaluation
-   Generates comparative reports
-   Provides model recommendations

## Key Concepts

### A/B Testing

Controlled comparison of variants to determine optimal configuration based on measurable outcomes.

### ReAct Agent Pattern

Reasoning and Acting pattern where agent iteratively thinks, acts with tools, and observes results.

### Model Selection Criteria

-   **Quality**: Output accuracy and completeness
-   **Cost**: Tokens consumed and pricing per model
-   **Latency**: Response time and throughput
-   **Capability fit**: Match between model strengths and task requirements

## Expected Outcomes

After completing this tutorial, you will:

-   Understand how to structure A/B tests for agents
-   Be able to build multiple agent variants efficiently
-   Know how to evaluate models systematically
-   Understand cost-performance trade-offs
-   Make data-driven model selection decisions

## Tutorial Complexity

**Level**: Advanced **Estimated time**: 60-90 minutes (both parts) **Prerequisites**: Tutorials 01-06

## Agent Source

This tutorial uses the ReAct airline assistant agent from: `python/04-industry-use-cases/logistics/custom-orchestration-airline-assistant/`

The agent includes 14 airline domain tools for comprehensive customer service operations.

## Support

For issues or questions:

-   Review tutorial prerequisites
-   Check Amazon Bedrock model availability in your region
-   Verify required tools are in python/04-industry-use-cases/logistics/custom-orchestration-airline-assistant/
-   Ensure all required tools are imported correctly

## Next Steps

After completing this tutorial:

-   Experiment with additional models
-   Test temperature variations
-   Extend to multi-agent A/B testing
-   Apply to your own agent use cases

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/06-evaluate/ab-testing-models)
