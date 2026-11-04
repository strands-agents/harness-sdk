This integration demonstrates how to use Strands Agents with OpenInference and Arize AI for observability. The example builds a restaurant assistant agent that helps customers with restaurant information and reservations.

## Prerequisites

-   Python 3.10+
-   AWS account with appropriate permissions
-   Anthropic Claude 3.7 enabled on Amazon Bedrock
-   IAM role with permissions to create Amazon Bedrock Knowledge Base, Amazon S3 bucket and Amazon DynamoDB
-   [Arize AI account](https://app.arize.com/signup) with API key and Space ID

## Setup Instructions

1.  Clone the repository:
    
    ```plaintext
    git clone https://github.com/strands-agents/samples.git
    cd python/03-integrate/observability/arize
    ```
    
2.  Run the notebook:
    
    ```plaintext
    Arize-Observability-openinference-strands.ipynb
    ```
    
3.  Update the Arize AI credentials in the notebook:
    
    -   Get your API key and Space ID from [Arize AI dashboard](https://app.arize.com/settings)
    -   Replace the placeholder values in the notebook
4.  View the traces in the [Arize AI dashboard](https://app.arize.com)
    

## Trace Visualization and Monitoring in Arize

After running the agent, you can explore the traces and set up monitoring in Arize AI:

### Trace Visualization

1.  **Project Traces**  
    ![1\. Project Traces](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize/images/project_traces.png)
    
2.  **Filtering Traces**  
    ![2\. Filter Traces](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize/images/filter_traces.png)
    
3.  **Filtering by Model ID**  
    ![3\. Filter by Model ID](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize/images/filter_trace_model_ID.png)
    
4.  **Trace Details**  
    ![4\. Trace Details](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize/images/trace_arize.png)
    
5.  **Execution Graph**  
    ![5\. Graph View](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize/images/graph.png)
    
6.  **Inspecting Execution Paths**  
    ![6\. Inspect Path](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize/images/inspect_path.png)
    
7.  **Session Information**  
    ![7\. View Sessions](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize/images/view_sessions.png)
    

### Monitoring

8.  **Pre-built Monitors**  
    ![8\. Pre-built Monitors](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize/images/prebuilt_monitors.png)
    
9.  **Monitor View**  
    ![9\. Monitor Explained](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize/images/monitor_explained.png)
    

For more information on monitoring, see the [Arize documentation on monitoring](https://arize.com/docs/ax/observe/production-monitoring).

## Cleanup Resources

When you’re done experimenting, please clean up the AWS resources:

```plaintext
sh cleanup.sh
```

## What You’ll Learn

-   How to set up OpenInference with Arize AI for Strands Agents
-   How to use the custom `StrandsToOpenInferenceProcessor` to convert telemetry
-   How to build a functional restaurant assistant with Strands
-   How to visualize and analyze agent behavior in Arize AI
-   How to set up monitoring for your agent in production

## Additional Resources

-   [Strands Agents Documentation](https://github.com/strands-agents/sdk-python)
-   [OpenInference Specification](https://openinference.ai/)
-   [Arize AI Documentation](https://docs.arize.com/)
-   [Amazon Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/03-integrate/observability/arize)
