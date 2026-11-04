## Overview

This tutorial teaches you how to create custom evaluators for domain-specific evaluation criteria. You’ll learn to design rubrics, extend the base Evaluator class, and implement multi-metric evaluation workflows tailored to your specific requirements.

## Prerequisites

-   Python 3.11 or higher
-   AWS account with Bedrock access
-   AWS credentials configured (via AWS CLI, environment variables, or IAM role)
-   Access to Claude models in Amazon Bedrock
-   Basic understanding of Python and object-oriented programming
-   Completion of Tutorial 01 recommended (but not required)

## What You’ll Learn

-   How to extend the base `Evaluator` class to create custom evaluators
-   Design rubrics with clear scoring criteria (3-point and 5-point scales)
-   Create domain-specific evaluators for recipe quality, dietary compliance, and food safety
-   Implement an LLM-as-a-judge custom evaluator with a 5-point scale (1-5)
-   Combine multiple custom evaluators in a single evaluation workflow
-   Understand when to use custom evaluators versus built-in evaluators

## Key Differences from Tutorial 01

| Aspect | Tutorial 01 | Tutorial 02 |
| :-- | :-- | :-- |
| Evaluators | Built-in evaluators (OutputEvaluator, HelpfulnessEvaluator, etc.) | Custom evaluators (domain-specific) |
| Complexity | Uses pre-built evaluation logic | Implements custom evaluation logic |
| Rubrics | Implicit rubrics in built-in evaluators | Explicit rubric design (3-point and 5-point scales) |
| Use Case | General-purpose evaluation | Domain-specific evaluation (recipes) |
| Learning Focus | Understanding available evaluators | Creating new evaluators |

## Installation

1.  **Clone or download this tutorial**
    
    ```bash
    cd tutorials/02-custom-evaluators
    ```
    
2.  **Create a virtual environment (recommended)**
    
    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows: venv\Scripts\activate
    ```
    
3.  **Install dependencies**
    
    ```bash
    pip install -r requirements.txt
    ```
    
4.  **Configure AWS credentials**
    
    Ensure your AWS credentials are configured. You can use any of these methods:
    
    -   AWS CLI: `aws configure`
    -   Environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
    -   IAM role (if running on EC2 or ECS)
5.  **Verify Bedrock access**
    
    Ensure you have access to Claude models in Amazon Bedrock:
    
    ```bash
    aws bedrock list-foundation-models --region us-east-1
    ```
    

## Running the Notebook

1.  **Start Jupyter**
    
    ```bash
    jupyter notebook 02-custom-evaluators.ipynb
    # or
    jupyter lab 02-custom-evaluators.ipynb
    ```
    
2.  **Run all cells**
    
    -   Execute cells sequentially from top to bottom
    -   Each cell includes comments explaining its purpose
    -   Wait for each evaluation to complete (API calls may take a few seconds)
3.  **Expected runtime**
    
    -   Complete notebook execution: 3-5 minutes
    -   Most time spent on agent responses and web searches

## Expected Outcomes

After completing this tutorial, you will have:

1.  **Four custom evaluators**:
    
    -   `RecipeQualityEvaluator`: Evaluates recipe completeness (ingredients, steps, timing) using a 5-point scale (0-4)
    -   `DietaryComplianceEvaluator`: Checks dietary restrictions (vegan, gluten-free, etc.) using a 3-point scale
    -   `RecipeSafetyEvaluator`: Validates food safety information using a 3-point scale
    -   `RecipeHelpfulnessLLMJudge`: LLM-as-a-judge evaluator for overall helpfulness using a 5-point scale (1-5)
2.  **Multi-metric evaluation results**:
    
    -   Each test case evaluated against all four custom evaluators
    -   Structured results with scores, labels, and explanations
    -   Clear rubric-based assessment
    -   LLM-powered nuanced evaluation
3.  **Understanding of rubric design**:
    
    -   3-point scale for simple binary/ternary assessments
    -   5-point scale (0-4) for detailed granular evaluation
    -   5-point scale (1-5) for LLM-as-judge evaluations
    -   Clear criteria definitions for each score level
4.  **Practical knowledge**:
    
    -   When to create custom evaluators vs use built-in ones
    -   Differences between rule-based and LLM-as-judge evaluators
    -   How to combine multiple evaluators for comprehensive assessment
    -   Best practices for domain-specific evaluation

## Tutorial Structure

The notebook follows this structure:

1.  **Environment Setup**: Configure AWS and model settings
2.  **Agent Creation**: Recipe Bot agent with web search capabilities
3.  **Custom Evaluator Development**:
    -   RecipeQualityEvaluator (5-point scale: 0-4)
    -   DietaryComplianceEvaluator (3-point scale)
    -   RecipeSafetyEvaluator (3-point scale)
    -   RecipeHelpfulnessLLMJudge (5-point scale: 1-5, LLM-as-judge)
4.  **Test Case Creation**: Three balanced examples covering different scenarios
5.  **Multi-Metric Evaluation**: Run all four evaluators on all test cases
6.  **Results Analysis**: View formatted results with explanations
7.  **LLM-as-Judge Explanation**: Understanding rule-based vs LLM-based evaluation
8.  **Best Practices**: Guidance on when to use custom vs built-in evaluators

## Troubleshooting

### Common Issues

1.  **ModuleNotFoundError: No module named ‘strands’**
    
    -   Solution: Ensure you’ve installed all dependencies: `pip install -r requirements.txt`
2.  **AWS Credentials Error**
    
    -   Solution: Configure AWS credentials using `aws configure` or set environment variables
    -   Verify with: `aws sts get-caller-identity`
3.  **Bedrock Access Denied**
    
    -   Solution: Ensure your AWS account has access to Bedrock and Claude models
    -   Check IAM permissions for `bedrock:InvokeModel`
4.  **Rate Limiting from Web Search**
    
    -   Solution: This is expected with DuckDuckGo’s free tier. Wait a few seconds and retry
    -   The websearch tool includes built-in error handling
5.  **Custom Evaluator Returns Unexpected Scores**
    
    -   Solution: Review the rubric criteria in the evaluator code
    -   Check that your test case input triggers the expected evaluation logic
    -   Custom evaluators use keyword matching; adjust keywords if needed
6.  **Jupyter Kernel Issues**
    
    -   Solution: Restart the kernel (Kernel > Restart) and run all cells again
    -   Ensure virtual environment is activated before starting Jupyter

### Getting Help

-   Review the code comments in the notebook for detailed explanations
-   Check Tutorial 01 for foundational concepts
-   Consult Strands documentation for API details
-   Verify Amazon Bedrock service status if experiencing connectivity issues

## File Structure

```plaintext
02-custom-evaluators/
├── 02-custom-evaluators.ipynb  # Main tutorial notebook
├── README.md                     # This file
└── requirements.txt              # Python dependencies
```

## Next Steps

After completing this tutorial, you can:

1.  **Experiment with different rubrics**: Modify the scoring scales and criteria
2.  **Create your own custom evaluators**: Extend the patterns to your domain
3.  **Combine with built-in evaluators**: Use both custom and built-in evaluators together
4.  **Proceed to Tutorial 03**: Learn about automated dataset generation
5.  **Apply to production**: Use custom evaluators to validate real agent deployments

## Additional Resources

-   Strands Agents Documentation: [https://strandsagents.com/latest/user-guide/](https://strandsagents.com/latest/user-guide/)
-   Strands Evals Documentation: [https://strandsagents.com/latest/user-guide/concepts/evaluate/](https://strandsagents.com/latest/user-guide/concepts/evaluate/)
-   Amazon Bedrock Documentation: [https://docs.aws.amazon.com/bedrock/](https://docs.aws.amazon.com/bedrock/)
-   Tutorial 01: Getting Started with Built-In Evaluators
-   Tutorial 03: Dataset Generation

## License

This tutorial is part of the Strands Agent Evaluation Tutorial series.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/06-evaluate/custom-evaluators)
