Move a Strands agent from development to production and you take on new concerns: locking down which tools it can reach, bounding its runtime and cost, and keeping it observable. This guide covers the configuration, security, and performance settings that matter before you ship, and points to the deployment target guides once you do.

## Production Configuration

Configure the agent explicitly rather than relying on defaults. The settings below cover the model, tools, and safety boundaries you want pinned down before an agent serves real traffic.

### Agent Initialization

Initialize agents with explicit configuration tailored to your production requirements rather than relying on defaults.

#### Model configuration

Pass a model with the specific configuration properties you want:

```python
agent_model = BedrockModel(
    model_id="us.amazon.nova-premier-v1:0",
    temperature=0.3,
    max_tokens=2000,
    top_p=0.8,
)

agent = Agent(model=agent_model)
```

See:

-   [Bedrock Model Usage](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md#basic-usage)
-   [Ollama Model Usage](/docs/user-guide/sdk/model-providers/ollama/index.md#basic-usage)

### Tool Management

Control which tools the agent can reach in production:

-   **Explicitly Specify Tools**: Always provide an explicit list of tools rather than loading all available tools
-   **Keep Automatic Tool Loading Disabled**: For stability in production, keep automatic loading and reloading of tools disabled (the default behavior)
-   **Audit Tool Usage**: Regularly review which tools are being used and remove any that aren’t necessary for your use case

```python
agent = Agent(
    ...,
    # Explicitly specify tools
    tools=[weather_research, weather_analysis, summarizer],
    # Automatic tool loading is disabled by default (recommended for production)
    # load_tools_from_directory=False,  # This is the default
)
```

See [Adding Tools to Agents](/docs/user-guide/sdk/tools/using-tools/index.md#adding-tools-to-agents) and [Auto reloading tools](/docs/user-guide/sdk/tools/using-tools/index.md#auto-loading-and-reloading-tools) for more information.

### Security Considerations

For production environments:

1.  **Tool Permissions**: Review and restrict the permissions of each tool to follow the principle of least privilege
2.  **Input Validation**: Always validate user inputs before passing to Strands Agents
3.  **Output Sanitization**: Sanitize outputs for sensitive information. Use [guardrails](/docs/user-guide/sdk/safety-security/guardrails/index.md) as an automated mechanism.

## Performance Optimization

### Execution Limits

Every production agent should have explicit execution boundaries. Choose limits that match the request’s service-level objective and cost budget, then monitor how often each limit is reached. A useful baseline covers four independent dimensions:

1.  **Agent loop iterations**: Set per-invocation turn limits by passing `limits`, which is named the same in both SDKs. A turn limit bounds repeated model and tool cycles and prevents an agent from running indefinitely.
2.  **Tool invocations**: Put quotas around tools that are costly, rate-limited, or have side effects. The [Limit Tool Counts hook](/docs/user-guide/sdk/agents/hooks/index.md#limit-tool-counts) shows the same pattern for Python and TypeScript and resets counts for each invocation.
3.  **Token consumption**: Use the invocation’s total-token and output-token limits for an end-to-end budget. Also configure the model’s `max_tokens``maxTokens` setting to cap a single response. Invocation token limits are checked between turns, so one model call can exceed the configured total before the loop stops.
4.  **Wall-clock time**: Enforce a deadline outside the invocation and cancel the agent when it expires. Python can call `agent.cancel()` from a watchdog; TypeScript can pass a `cancelSignal` to `invoke()`/`stream()` (for example, `AbortSignal.timeout(30_000)`) or call `agent.cancel()`. Cancellation is cooperative for work already running inside a tool, so propagate the same deadline to downstream network calls and blocking operations.

See [Invocation Limits](/docs/user-guide/sdk/agents/agent-loop/index.md#invocation-limits) for turn and token budgets, [Cancellation](/docs/user-guide/sdk/agents/agent-loop/index.md#cancellation) for timeout patterns, and [Stop Reasons](/docs/user-guide/sdk/agents/agent-loop/index.md#stop-reasons) for handling exhausted limits as expected outcomes rather than generic errors.

#### Multi-agent safety boundaries

Apply limits at both the orchestrator and node levels:

-   **Swarm**: Bound handoffs/iterations and total/per-node execution time in Python; use `maxSteps`, `timeout`, and `nodeTimeout` in TypeScript. See [Swarm Safety Mechanisms](/docs/user-guide/sdk/multi-agent/swarm/index.md#safety-mechanisms).
-   **Graph**: Bound total node executions and total/per-node execution time. The exact configuration names differ by SDK; see [Graph Components](/docs/user-guide/sdk/multi-agent/graph-components/index.md).

Do not rely on only one boundary. For example, a turn limit does not constrain a single slow tool, while a timeout alone does not provide a predictable token budget.

### Conversation Management

Optimize memory usage and context window management in production:

```python
from strands import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager

# Configure conversation management for production
conversation_manager = SlidingWindowConversationManager(
    window_size=10,  # Limit history size
)

agent = Agent(
    ...,
    conversation_manager=conversation_manager
)
```

The [`SlidingWindowConversationManager`](/docs/user-guide/sdk/agents/conversation-management/index.md#slidingwindowconversationmanager) helps prevent context window overflow exceptions by maintaining a reasonable conversation history size.

### Streaming for Responsiveness

Stream responses with `stream_async()` to deliver content to the caller as it arrives, which lowers perceived latency in production applications:

```python
# For web applications
async def stream_agent_response(prompt):
    agent = Agent(...)

    ...

    async for event in agent.stream_async(prompt):
        if "data" in event:
            yield event["data"]
```

See [Async Iterators](/docs/user-guide/sdk/streaming/async-iterators/index.md) for more information.

### Error Handling

Handle errors explicitly in production: log the failure and fall back rather than letting an exception propagate to the caller.

```python
try:
    result = agent("Execute this task")
except Exception as e:
    # Log the error
    logger.error(f"Agent error: {str(e)}")
    # Implement appropriate fallback
    handle_agent_error(e)
```

## Deployment Patterns

Strands agents can be deployed using various options from serverless to dedicated server machines.

Built-in guides are available for several AWS services:

-   **Bedrock AgentCore** - A secure, serverless runtime for deploying and scaling dynamic AI agents and tools. [Learn more](/docs/user-guide/sdk/deploy/deploy_to_bedrock_agentcore/index.md)
    
-   **AWS Lambda** - Serverless option for short-lived agent interactions and batch processing with minimal infrastructure management. [Learn more](/docs/user-guide/sdk/deploy/deploy_to_aws_lambda/index.md)
    
-   **AWS Fargate** - Containerized deployment with streaming support, ideal for interactive applications requiring real-time responses or high concurrency. [Learn more](/docs/user-guide/sdk/deploy/deploy_to_aws_fargate/index.md)
    
-   **AWS App Runner** - Containerized deployment with streaming support, automated deployment, scaling, and load balancing, ideal for interactive applications requiring real-time responses or high concurrency. [Learn more](/docs/user-guide/sdk/deploy/deploy_to_aws_apprunner/index.md)
    
-   **Amazon EKS** - Containerized deployment with streaming support, ideal for interactive applications requiring real-time responses or high concurrency. [Learn more](/docs/user-guide/sdk/deploy/deploy_to_amazon_eks/index.md)
    
-   **Amazon EC2** - Maximum control and flexibility for high-volume applications or specialized infrastructure requirements. [Learn more](/docs/user-guide/sdk/deploy/deploy_to_amazon_ec2/index.md)
    

## Monitoring and Observability

Monitor these signals for every production deployment:

1.  **Tool Execution Metrics**: Monitor execution time and error rates for each tool.
2.  **Token Usage**: Track token consumption for cost optimization.
3.  **Response Times**: Monitor end-to-end response times.
4.  **Error Rates**: Track and alert on agent errors.

Consider integrating with AWS CloudWatch for metrics collection and alerting.

See [Observability](/docs/user-guide/sdk/observability-evaluation/observability/index.md) for more information.

## Summary

Running an agent in production comes down to pinning its configuration, restricting its tools, bounding its execution, and watching it once it serves traffic. Pick the deployment pattern that fits your workload, wire up error handling and observability, and monitor how often each limit is reached so you can tune it.

## Related Topics

-   [Conversation Management](/docs/user-guide/sdk/agents/conversation-management/index.md)
-   [Streaming - Async Iterator](/docs/user-guide/sdk/streaming/async-iterators/index.md)
-   [Tool Development](/docs/user-guide/sdk/tools/index.md)
-   [Guardrails](/docs/user-guide/sdk/safety-security/guardrails/index.md)
-   [Responsible AI](/docs/user-guide/sdk/safety-security/responsible-ai/index.md)

## Related pages

- [Root cause analysis](/docs/user-guide/evals-sdk/detectors/root_cause_analysis/index.md) (2 shared tags)
- [Session diagnosis](/docs/user-guide/evals-sdk/detectors/diagnosis/index.md) (2 shared tags)
- [Evaluating remote traces](/docs/user-guide/evals-sdk/how-to/trace_providers/index.md) (1 shared tag)
- [Metrics](/docs/user-guide/sdk/observability-evaluation/metrics/index.md) (1 shared tag)
- [Observability](/docs/user-guide/sdk/observability-evaluation/observability/index.md) (1 shared tag)
- [Observe your agent](/docs/user-guide/sdk/observability-evaluation/index.md) (1 shared tag)
- [Task decorator](/docs/user-guide/evals-sdk/how-to/eval_task/index.md) (1 shared tag)
- [Traces](/docs/user-guide/sdk/observability-evaluation/traces/index.md) (1 shared tag)
- [Deploy to Kubernetes](/docs/user-guide/sdk/deploy/deploy_to_kubernetes/index.md) (1 shared tag)
- [Deploy to production](/docs/user-guide/sdk/deploy/index.md) (1 shared tag)
