---
title: "Amazon saves millions by replacing Sonnet 4.6 with Strands Decider"
date: 2026-11-09T00:00:00.000Z
description: "Two Amazon engineers swapped Claude Sonnet 4.6 for a decision model in one of the world's biggest internal ticketing systems."
tags: ["Use Cases", "Strands Labs", "Optimization"]
---
For a while, Amazon and AWS teams relied on Claude Sonnet 4.6 to label tickets in an internal system without breaking the bank.

Sonnet 4.6 fit the goldilocks choice of balancing intelligence with cost. Considering it dealt with one of the world’s largest internal ticketing systems, the nine month old model did well. However, two Amazon engineers recently swapped out Sonnet 4.6 for [Strands Decider](/blog/introducing-strands-decider/index.md), a decision model we launched a month ago, that performed just as well *at 98% less cost*. This change will save millions of dollars of token costs in a year.

Carr and Mehul, who work on the internal ticketing system, walk through how this happened below.

## Replacing an LLM’s job with a decision model

We had Sonnet 4.6 labeling tickets at enormous scale. The tickets could be customer escalations, capacity requests, automated alarms, security findings, or anything else across the company that needed to fit within 20 category types. The agent ran with a long system prompt on every ticket, generating JSON and reasoning against a fixed set of labels.

A decision model can’t generate text. It’s first given some state and a question with a set of options, then the decision model returns a probability for each option plus a confidence score. We saw this method fit perfectly with ticket labeling: the state is the ticket, the options are the label catalog.

We started with the original [Strands Decider 2B](/blog/introducing-strands-decider/index.md). On a test set of tickets, the [E4B Gemma 4 build](/blog/strands-decider-gemma-4-models/index.md) got clearly better results, so we switched to it. Afterwards, we tuned how confident the model needed to be before applying a label. The results showed E4B beating production Sonnet on a separate set of our tickets.

We ran E4B on SageMaker `ml.g5.xlarge` instances (one A10G, 24 GB each). The model used about 19 GiB, and one request took about 640 ms on one instance. The endpoint autoscales with traffic, but its network was isolated, preventing outbound access to the container. SageMaker copies the model weights in from S3 before start-up.

Customers can do this too! Apart from our ticketing APIs, everything in the path is a standard AWS service. Ticket events land in an SQS queue that then triggers a Lambda function. It reads the ticket data and calls the model, a SageMaker AI Endpoint with Strands Decider. AppConfig holds the switch (described below), and CloudWatch carries the logs, metrics and alarms. The stack is defined in CDK with deployment stages for Beta, Gamma, and Prod.

## Running Sonnet 4.6 and Strands Decider on the same tickets

We didn’t want to flip a switch and hope. The labeling Lambda reads a three-way setting from AWS AppConfig on every message:

-   `BEDROCK`: Sonnet labels every ticket, but Strands Decider isn’t called.
-   `DUAL`: Both the Sonnet and Strands Decider models are called in parallel. The results from the Sonnet model are applied to the ticket and compared with Strands Decider results.
-   `DECIDER`: Strands Decider labels every ticket and Bedrock isn’t called.

## What we measured

|  | Claude Sonnet 4.6 | Strands Decider E4B | % Improvement |
| --- | --- | --- | --- |
| Average time per call | 4,215 ms | 897 ms | 78% |
| Input tokens per ticket | 6,554 | 2,009 |  |
| Output tokens per ticket | 170 | 1 |  |
| Total tokens, per ticket | 6,724 | 2,010 | 70% |

The token drop had two sources. Strands Decider produced one output, the choice, instead of a JSON answer. Its prompt was also much shorter than Sonnet 4.6’s. Production’s label descriptions alone are longer than Strands Decider’s 4,096-token window, so we rewrote each of the 20 labels as a one- or two-sentence criterion and sent them as the options of a single choice question, plus a “none” option. The ticket data is the same as what Sonnet gets, except that on long tickets Strands Decider drops the oldest comments to fit.

Below is a graph of our Lambda durations on the day we turned off the Sonnet usage, showing the average Lambda execution duration dropping 74%.

## What it costs

At published us-east-1 on-demand prices:

|  | Claude Sonnet 4.6 (Bedrock, global endpoint) | Strands Decider E4B (SageMaker, `ml.g5.xlarge`) |
| --- | --- | --- |
| Price | $3.00 per 1M input, $15.00 per 1M output tokens | $1.408 per instance-hour |
| Per ticket | $0.0222 | about $0.0005 |
| Per million tickets | about $22,200 | about $500 |

Sonnet’s cost per ticket comes straight from the token counts above. Strands Decider’s depends on how busy each instance is. At about 640 ms per request, one instance can handle about 5,600 tickets an hour, which would be $250 per million tickets at full use. We keep headroom for bursts, and in practice it comes to about $500 per million. That is about 44 times cheaper than Sonnet, a 98% reduction.

These are published list prices. They leave out the Lambda, which also runs for less time per ticket now.

One thing that surprised us was that JSON key order changed the answer. Sending the same content with keys in a different order moved the output probabilities by up to 0.19. We now send every request with sorted keys, so if you serve a decision model behind an API, check this before you compare runs.

## Our lessons

This worked because the task is a closed choice from a known catalog, the volume is high, and the latency of the old path mattered. If your labels need explanation text, if the catalog changes weekly, or if you can’t fit the useful context into a few thousand tokens, a decision model probably can’t replace the LLM’s job.

The part we’d copy regardless of model is the three-way switch. Running both on real traffic, then judging every disagreement, told us more than any offline eval would have. It also meant going back was a 45-second config change.

The world of agents gets a lot more exciting (and less costly) with decision models. If you’re running a classification agent, try the [Strands Decider repo](https://github.com/strands-labs/strands-decider) and its [serving notes](https://github.com/strands-labs/strands-decider/blob/0ac22a97e584f3ccf87cc9b8cc5fdbad57cdf534/docs/inference.md#gemma-4-models).