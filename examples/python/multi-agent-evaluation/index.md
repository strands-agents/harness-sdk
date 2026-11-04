## Overview

This tutorial demonstrates comprehensive evaluation of multi-agent systems where multiple specialized agents collaborate to complete complex tasks. You’ll learn to assess individual agent performance, collective system outcomes, and the quality of agent coordination using the InteractionsEvaluator.

## What You’ll Learn

-   Understand multi-agent architectures (agent-as-tool pattern)
-   Evaluate individual agent performance separately
-   Assess collective system performance as a whole
-   Measure coordination quality using InteractionsEvaluator
-   Analyze agent handoffs and collaboration patterns
-   Generate comprehensive multi-agent evaluation reports

## Prerequisites

### Required Knowledge

-   Basic understanding of Python programming
-   Familiarity with Jupyter notebooks
-   Understanding of AI agents and multi-agent systems
-   Completion of Tutorial 01 (Built-in Evaluators) recommended

### AWS Requirements

-   AWS account with Bedrock access
-   Claude Sonnet 4.6 model enabled in Amazon Bedrock
-   Appropriate IAM permissions for Bedrock API calls
-   AWS credentials configured locally

### Python Requirements

-   Python 3.11 or higher
-   pip package manager
-   Virtual environment (recommended)

## Installation

### Step 1: Create Virtual Environment

```bash
# Create virtual environment
python -m venv venv

# Activate virtual environment
# On macOS/Linux:
source venv/bin/activate
# On Windows:
venv\Scripts\activate
```

### Step 2: Install Dependencies

```bash
# Install required packages
pip install -r requirements.txt
```

### Step 3: Configure AWS Credentials

Ensure your AWS credentials are configured. You can do this by:

**Option 1: AWS CLI Configuration**

```bash
aws configure
```

**Option 2: Environment Variables**

```bash
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_DEFAULT_REGION=us-east-1
```

**Option 3: AWS Credentials File** Create or edit `~/.aws/credentials`:

```plaintext
[default]
aws_access_key_id = your_access_key
aws_secret_access_key = your_secret_key
```

## Running the Tutorial

### Option 1: Jupyter Notebook Interface

```bash
# Start Jupyter Notebook
jupyter notebook

# Navigate to and open: 06-multi-agent-evaluation.ipynb
```

### Option 2: JupyterLab Interface

```bash
# Start JupyterLab
jupyter lab

# Navigate to and open: 06-multi-agent-evaluation.ipynb
```

### Option 3: VS Code

```bash
# Open in VS Code
code 06-multi-agent-evaluation.ipynb

# Ensure the Python extension and Jupyter extension are installed
```

## Tutorial Structure

The notebook is organized into the following sections:

1.  **Introduction to Multi-Agent Systems**
    
    -   Agent-as-tool pattern explained
    -   Multi-agent architecture overview
    -   Three evaluation dimensions
2.  **Environment Setup**
    
    -   AWS configuration
    -   Library imports
    -   Tool consent bypass
3.  **Multi-Agent System Implementation**
    
    -   Fake database creation
    -   Database lookup tools
    -   Specialist agent definitions
    -   Orchestrator agent creation
4.  **Testing the System**
    
    -   Verify orchestrator routing
    -   Examine tool call patterns
5.  **Dimension 1: Individual Agent Performance**
    
    -   Test each specialist agent separately
    -   Evaluate output quality
    -   Assess tool selection accuracy
6.  **Dimension 2: Collective System Performance**
    
    -   Test complete system with orchestrator
    -   Evaluate end-to-end outcomes
    -   Measure overall quality
7.  **Dimension 3: Coordination Quality**
    
    -   Use InteractionsEvaluator
    -   Analyze routing decisions
    -   Assess handoff quality
8.  **Comprehensive Multi-Agent Report**
    
    -   Combine all three dimensions
    -   Generate evaluation summary
    -   Coordination metrics analysis
9.  **Best Practices**
    
    -   Multi-agent evaluation strategy
    -   When to use InteractionsEvaluator
    -   Interpreting results

## Expected Runtime

-   Full notebook execution: 15-20 minutes
-   Individual sections can be run independently
-   Evaluation steps may take 2-3 minutes each due to LLM API calls

## Cost Considerations

This tutorial makes multiple calls to Amazon Bedrock:

-   Orchestrator calls: ~4 per evaluation
-   Specialist agent calls: ~8 per evaluation
-   Evaluator calls: ~12 per evaluation

**Estimated cost**: $0.50-$1.00 per complete notebook run (varies by model and region)

## Key Concepts

### Multi-Agent System

A system with multiple specialized AI agents that collaborate under an orchestrator to solve complex problems.

### Agent-as-Tool Pattern

Specialized agents are wrapped as callable tools that can be invoked by an orchestrator agent.

### Three Evaluation Dimensions

1.  **Individual Performance**: How well each specialist performs its specific task
2.  **Collective Performance**: How well the overall system performs end-to-end
3.  **Coordination Quality**: How well agents collaborate and hand off information

### InteractionsEvaluator

A specialized evaluator that assesses multi-agent interactions by analyzing:

-   Node names (which agent handled the interaction)
-   Dependencies (what information was passed)
-   Messages (the output from the agent)

## Troubleshooting

### Issue: AWS Credentials Not Found

**Symptoms**:

```plaintext
NoCredentialsError: Unable to locate credentials
```

**Solution**:

-   Verify AWS credentials are configured using `aws configure`
-   Check environment variables are set correctly
-   Ensure `~/.aws/credentials` file exists and is properly formatted

### Issue: Bedrock Model Access Denied

**Symptoms**:

```plaintext
AccessDeniedException: User is not authorized to perform: bedrock:InvokeModel
```

**Solution**:

-   Verify your AWS account has Bedrock access enabled
-   Check IAM permissions include `bedrock:InvokeModel`
-   Ensure Claude Sonnet 4.6 model is enabled in your region

### Issue: Import Errors

**Symptoms**:

```plaintext
ModuleNotFoundError: No module named 'strands'
```

**Solution**:

-   Ensure virtual environment is activated
-   Run `pip install -r requirements.txt`
-   Verify Python version is 3.10 or higher

### Issue: Slow Evaluation Performance

**Symptoms**: Evaluations take significantly longer than expected

**Solution**:

-   This is normal for multi-agent evaluations with many API calls
-   Consider reducing test case count for faster iterations
-   Check AWS region latency (use region closer to you)
-   Verify network connectivity

### Issue: InteractionsEvaluator Returns Empty Results

**Symptoms**: No interactions captured or empty interaction list

**Solution**:

-   Ensure the task function returns a dictionary with ‘interactions’ key
-   Verify `tools_use_extractor.extract_agent_tools_used_from_messages()` is called
-   Check that orchestrator.messages contains tool call records
-   Confirm agents are actually being invoked (not just responding directly)

### Issue: Orchestrator Not Routing Correctly

**Symptoms**: Orchestrator answers directly instead of calling specialist agents

**Solution**:

-   Review orchestrator prompt to ensure clear routing instructions
-   Verify specialist agents are passed as tools to orchestrator
-   Check that queries clearly require specialist expertise
-   Consider adjusting orchestrator temperature or instructions

## Expected Outputs

After running the complete notebook, you should see:

1.  **Individual Agent Reports**: Evaluation results for each of the 4 specialist agents
2.  **System-Level Report**: Overall system performance across all test cases
3.  **Coordination Report**: InteractionsEvaluator results showing routing and handoff quality
4.  **Comprehensive Multi-Agent Report**: Summary combining all three dimensions with:
    -   Overall metrics table
    -   Individual agent scores
    -   System performance assessment
    -   Coordination quality analysis
    -   Recommendations for improvement

## Learning Outcomes

By completing this tutorial, you will be able to:

1.  Design and implement multi-agent systems using the agent-as-tool pattern
2.  Evaluate individual agent performance in isolation
3.  Assess collective system performance end-to-end
4.  Measure coordination quality using InteractionsEvaluator
5.  Interpret multi-dimensional evaluation results
6.  Generate comprehensive multi-agent evaluation reports
7.  Identify strengths and weaknesses in multi-agent architectures
8.  Apply best practices for multi-agent system evaluation

## Next Steps

After completing this tutorial:

1.  **Experiment with Different Architectures**: Try different multi-agent patterns (sequential, parallel, hierarchical)
2.  **Expand Test Coverage**: Add more edge cases and complex scenarios
3.  **Custom Coordination Metrics**: Design domain-specific coordination evaluators
4.  **Production Monitoring**: Implement continuous evaluation pipelines for deployed systems
5.  **Advanced Patterns**: Explore Tutorial 07 for A/B testing different agent configurations

## Additional Resources

-   [Strands Agents Documentation](https://github.com/awslabs/strands-agents)
-   [Strands Evals Documentation](https://github.com/awslabs/strands-evals)
-   [Amazon Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
-   [Claude API Documentation](https://docs.anthropic.com/)
-   [Multi-Agent Systems Research](https://arxiv.org/list/cs.MA/recent)

## Support

For issues or questions:

-   Check the troubleshooting section above
-   Review the Strands documentation
-   Open an issue on the GitHub repository
-   Contact AWS Support for Bedrock-related issues

## License

This tutorial is provided as part of the Strands Agent Evaluation framework.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/06-evaluate/multi-agent-evaluation)
