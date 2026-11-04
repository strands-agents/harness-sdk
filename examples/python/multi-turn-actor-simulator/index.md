## Overview

This tutorial demonstrates how to use ActorSimulator to evaluate conversational agents through realistic multi-turn interactions. Learn how to create AI-powered user personas, test agents with diverse behaviors, and implement production-ready evaluation workflows.

## What You’ll Learn

-   Create realistic user simulations with ActorSimulator API
-   Design actor profiles with traits, context, and goals
-   Implement goal completion detection with stop tokens
-   Test agents with diverse personas (polite, demanding, confused)
-   Build automated multi-turn evaluation pipelines
-   Implement dev-to-prod workflow with metric comparison
-   Scale testing with datasets and automated simulation

## Prerequisites

### Required Knowledge

-   Python programming basics
-   Understanding of conversational AI agents
-   Familiarity with Strands Agents SDK
-   Basic knowledge of evaluation concepts

### System Requirements

-   Python 3.11 or higher
-   AWS account with Bedrock access
-   AWS credentials configured
-   500MB free disk space (for SQLite database)

### AWS Configuration

-   Amazon Bedrock access enabled
-   Claude Sonnet 4.6 model access
-   IAM permissions for Bedrock model invocation

## Installation

### 1\. Clone Repository (if not already done)

```bash
cd python/06-evaluate/multi-turn-actor-simulator
```

### 2\. Install Dependencies

```bash
pip install -r requirements.txt
```

### 3\. Configure AWS Credentials

Ensure your AWS credentials are configured:

```bash
aws configure
```

Or set environment variables:

```bash
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
```

### 4\. Verify Installation

Test that all dependencies are installed correctly:

```python
import strands
import strands_evals
from strands_evals.simulation import ActorSimulator
print("All dependencies installed successfully!")
```

## Running the Tutorial

### Option 1: Jupyter Notebook (Recommended)

1.  Start Jupyter Notebook:

```bash
jupyter notebook
```

2.  Open `05-multi-turn-actor-simulator.ipynb` in your browser
    
3.  Run cells sequentially using Shift+Enter
    
4.  Follow the inline explanations and observe outputs
    

### Option 2: JupyterLab

1.  Start JupyterLab:

```bash
jupyter lab
```

2.  Navigate to `05-multi-turn-actor-simulator.ipynb`
    
3.  Execute cells in order
    

### Option 3: VS Code

1.  Open the tutorial directory in VS Code
    
2.  Install the Jupyter extension if not already installed
    
3.  Open `05-multi-turn-actor-simulator.ipynb`
    
4.  Select Python kernel and run cells
    

## Tutorial Structure

The notebook is organized into the following sections:

### 1\. Introduction and Setup (Cells 0-5)

-   Understanding multi-turn evaluation
-   ActorSimulator architecture
-   Environment configuration
-   Imports and dependencies

### 2\. Personal Assistant Agent (Cells 6-13)

-   Calendar tools implementation
-   Agent creation
-   Basic testing

### 3\. Scenario 1: Basic User Simulation (Cells 14-19)

-   Single persona evaluation
-   ActorSimulator API usage
-   Goal completion detection
-   Conversation analysis

### 4\. Scenario 2: Diverse Personas (Cells 20-24)

-   Testing with multiple user types
-   Polite, demanding, and confused personas
-   Agent resilience assessment
-   Persona comparison

### 5\. Scenario 3: Automated Pipeline (Cells 25-30)

-   Dataset creation
-   Batch evaluation
-   Aggregate metrics
-   Results analysis

### 6\. Dev-to-Prod Workflow (Cells 31-33)

-   Development metrics
-   Production metrics simulation
-   Metric comparison
-   Deployment checklist

### 7\. Best Practices and Summary (Cells 34-35)

-   When to use ActorSimulator
-   Designing effective actor profiles
-   Scaling evaluation
-   Production monitoring

## Expected Runtime

-   **Full notebook execution**: 15-25 minutes
-   **Individual scenarios**: 3-7 minutes each
-   **Automated pipeline**: 5-10 minutes

Runtime varies based on:

-   Amazon Bedrock API response times
-   Number of conversation turns
-   Dataset size

## Key Concepts

### ActorSimulator

AI-powered user personas that engage in realistic multi-turn conversations with your agent. Actors have goals, personalities, and emit stop tokens when satisfied.

### Multi-turn Conversations

Unlike single-turn Q&A, multi-turn evaluation tests conversation flow, context maintenance, and follow-up handling.

### Goal Completion

Actors emit `<stop/>` tokens when their goals are achieved, enabling automated evaluation and efficient testing.

### Persona Diversity

Testing with varied user types (polite, demanding, confused) ensures agent robustness across different communication styles.

## Troubleshooting

### Issue: AWS Credentials Error

```plaintext
Error: Unable to locate credentials
```

**Solution:**

```bash
aws configure
# Enter your AWS credentials when prompted
```

### Issue: Bedrock Access Denied

```plaintext
Error: User is not authorized to perform: bedrock:InvokeModel
```

**Solution:** Ensure your AWS IAM user/role has Bedrock permissions:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream"
  ],
  "Resource": "*"
}
```

### Issue: Model Not Found

```plaintext
Error: Could not resolve model: claude-sonnet-4-0
```

**Solution:**

1.  Verify model access in Amazon Bedrock console
2.  Check model ID in notebook configuration
3.  Update `DEFAULT_MODEL` variable if using different model

### Issue: SQLite Database Locked

```plaintext
Error: database is locked
```

**Solution:**

```python
# Close any existing connections
import sqlite3
conn = sqlite3.connect("appointments.db")
conn.close()

# Or delete the database file and restart
import os
if os.path.exists("appointments.db"):
    os.remove("appointments.db")
```

### Issue: Conversation Doesn’t Complete

```plaintext
Actor reaches max_turns without emitting <stop/>
```

**Solution:**

-   Check task\_description in case metadata is clear
-   Increase max\_turns parameter
-   Simplify the goal to be more achievable
-   Review agent responses for completion signals

### Issue: Import Errors

```plaintext
ModuleNotFoundError: No module named 'strands_evals'
```

**Solution:**

```bash
pip install -r requirements.txt --upgrade
```

### Issue: Slow Performance

```plaintext
Cells take very long to execute
```

**Solution:**

-   Reduce max\_turns in ActorSimulator
-   Decrease dataset size for testing
-   Check AWS region latency (use closer region)
-   Verify network connection

## Data Files

This tutorial creates the following files:

### appointments.db

SQLite database storing calendar appointments created during evaluation.

**Location**: Same directory as notebook

**Schema**:

```sql
CREATE TABLE appointments (
    id TEXT PRIMARY KEY,
    date TEXT,
    location TEXT,
    title TEXT,
    description TEXT
)
```

**Cleanup**: Delete file to reset calendar state

```bash
rm appointments.db
```

## Extending the Tutorial

### Add More Personas

```python
Case(
    name="Impatient User",
    input="Need meeting ASAP!",
    metadata={
        "task_description": "User schedules urgent meeting",
        "traits": ["impatient", "urgent", "brief"]
    }
)
```

### Custom Evaluation Metrics

```python
def calculate_custom_metrics(result):
    return {
        "efficiency_score": result['turns'] / expected_turns,
        "completeness": check_all_details_provided(result),
        "user_satisfaction": analyze_sentiment(result)
    }
```

### Different Agent Types

Replace Personal Assistant with:

-   Customer support agent
-   Technical troubleshooting agent
-   Sales/booking agent
-   Educational tutor agent

### Production Integration

```python
# Log conversations to production monitoring
def log_to_monitoring(result):
    metrics = {
        "timestamp": datetime.now(),
        "turns": result['turns'],
        "completed": result['goal_completed'],
        "agent_version": "v1.2.3"
    }
    # Send to your monitoring system
```

## Additional Resources

### Documentation

-   [Strands Agents SDK](https://docs.strands.ai/agents)
-   [Strands Evals Documentation](https://docs.strands.ai/evals)
-   [ActorSimulator API Reference](https://docs.strands.ai/evals/actor-simulator)
-   [Amazon Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)

### Related Tutorials

-   Tutorial 01: Built-in Evaluators (single-turn evaluation basics)
-   Tutorial 02: Custom Evaluators (creating custom evaluation logic)
-   Tutorial 03: Dataset Generation (automated test case creation)
-   Tutorial 04: Trajectory Evaluation (analyzing agent execution paths)

### Example Code

-   Personal Assistant sample: `python/04-industry-use-cases/productivity/personal-assistant/`
-   Multi-agent samples: `python/01-learn/` (folders 09-11 for swarm, graph, and bidirectional streaming)

## Support

### Getting Help

-   Check troubleshooting section above
-   Review Amazon Bedrock service status
-   Verify AWS credentials and permissions
-   Check Strands SDK documentation

### Common Questions

**Q: How many test cases should I create?** A: Start with 5-10 cases covering critical scenarios. Scale to 20+ for comprehensive evaluation. Production monitoring should track 100+ conversations.

**Q: What’s a good success rate?** A: Aim for 90%+ in development. Production rates of 85-95% are typical depending on use case complexity.

**Q: How do I choose max\_turns?** A: Most conversations complete in 3-5 turns. Set max\_turns to 5-7 to allow for complex scenarios while preventing infinite loops.

**Q: Should I test every conversation path?** A: Focus on critical happy paths, common edge cases, and known failure modes. Use diverse personas to discover unexpected issues.

**Q: How often should I run evaluations?** A: Run full evaluation suite before each deployment. Use automated CI/CD integration for continuous testing.

## License

This tutorial is part of the Strands Evaluation framework and follows the same license terms.

## Feedback

Found issues or have suggestions? Please provide feedback through your organization’s channels or Strands support.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/06-evaluate/multi-turn-actor-simulator)
