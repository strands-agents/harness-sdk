In this lab, you will create a basic Agent, create tools that the Agent can use and integrate Amazon Bedrock Guardrails to add safety filters to the LLM outputs and inputs to the Agent. You will develop a budget analysis agent that can aid you in personal finance.

## Learning Objectives - AWS Workshop

**You’ll Learn These Core Strands Patterns:**

-   ✅ Create your first Strands agent: `Agent(model=BedrockModel(...))`
-   ✅ Build custom tools: `@tool def my_function()`
-   ✅ Make agents use tools automatically
-   ✅ Create reusable visualization tools
-   ✅ Add safety filters by integrating Amazon Bedrock Guardrails

> ⚠️ **EDUCATIONAL PURPOSE ONLY**: This lab demonstrates budget analysis and there are conversations with the agent about how to save and budget money. This is NOT financial advice and the soundness of the agent outputs should be verified against expert advice. All budget analysis is for educational demonstration of AI agents only.

## Step 1: Install and Import Strands

**Core Strands Pattern**: Import and configure

```bash
# Install Strands using pip

pip install -q strands-agents strands-agents-tools matplotlib pandas
```

```python
from strands import Agent, tool
from strands.models import BedrockModel

# Supporting libraries for our budget agent
import pandas as pd
import numpy as np
import json
import matplotlib.pyplot as plt
from datetime import datetime, timedelta
import warnings
warnings.filterwarnings('ignore')

print("🚀 Strands Agents SDK imported successfully!")
print("📊 AWS Workshop: Ready to build your first agent!")
```

```python
model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-6"
    # This connects to your AWS Bedrock service
)

print("✅ AWS Bedrock model configured for Strands!")
print("🎯 Ready to create your first agent")
```

## Step 2: Create Your First Strands Agent

**Core Strands Pattern**: `Agent(model=model)`

```python
basic_agent = Agent(model=model)

# Test your first Strands agent
response = basic_agent("What is the 50/30/20 budgeting rule?")
```

## Step 3: Add System Prompt for Specialization

**Core Strands Pattern**: `Agent(model=model, system_prompt="...")`

The system prompt acts as a guiding framework to the LLM for interpreting user queries, structuring responses and helps the agent to maintain a consistent tone and style.

```python
financial_agent = Agent(
    model=model,
    system_prompt= """ You are a helpful personal finance assistant. You provide general strategies
    to creating budgets, tips on finacial discipline to acheive financial milestones and analyse
    financial trends. You do not provide any investment advice.

    Keep responses concise and actionable.
    Always provide 2-3 specific steps the user can take.
    Focus on practical budgeting and spending advice.
    """
)

# Test the specialized agent
print("💰 Specialized Financial Agent Response:")

# TASK: Modify the user query and test the Agent
user_query = "I spend $800/month on dining out. Is this too much for someone making $5000/month?"
response = financial_agent(user_query)
```

### 🎯 Learning Milestone: How is this specialised agent different from one without a system prompt? Does it always provide concrete steps and avoid providing investment advice?

## Step 4: Create Custom Tools

**Core Strands Pattern**: `@tool` decorator for custom functions

```python
@tool
def calculate_budget(monthly_income: float) -> str:
    """Calculate 50/30/20 budget breakdown."""
    needs = monthly_income * 0.50
    wants = monthly_income * 0.30
    savings = monthly_income * 0.20
    return f"💰 Budget for ${monthly_income:,.0f}/month:\n• Needs: ${needs:,.0f} (50%)\n• Wants: ${wants:,.0f} (30%)\n• Savings: ${savings:,.0f} (20%)"

@tool
def create_financial_chart(data_dict: dict, chart_title: str = "Financial Chart") -> str:
    """Universal chart creator"""
    if not data_dict:
        return "❌ No data provided for chart"

    # Create pie chart
    labels = list(data_dict.keys())
    values = list(data_dict.values())
    colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57', '#FF9FF3']

    plt.figure(figsize=(8, 6))
    plt.pie(values, labels=labels, autopct='%1.1f%%', colors=colors[:len(values)], startangle=90)
    plt.title(f'📊 {chart_title}', fontsize=14, fontweight='bold')
    plt.axis('equal')
    plt.tight_layout()
    plt.show()

    return f"✅ {chart_title} visualization created!"

@tool
def generate_sample_data() -> str:
    """Generate sample financial data."""
    # Create sample spending data
    spending_data = {
        'Groceries': 400,
        'Dining': 300,
        'Transportation': 200,
        'Entertainment': 150,
        'Utilities': 250,
        'Shopping': 200
    }

    # Save for other labs to use
    global sample_spending_data
    sample_spending_data = spending_data

    # Create user profile
    user_profile = {
        "monthly_income": 5000,
        "budget_goal": 1000,
        "focus_areas": ["dining", "shopping"],
        "created_date": datetime.now().isoformat()
    }

    with open('user_profile.json', 'w') as f:
        json.dump(user_profile, f, indent=2)

    total_spending = sum(spending_data.values())
    return f"✅ Sample data created! Total monthly spending: ${total_spending:,}"

print("🛠️ Custom Strands tools created!")
print("🎯 Key Pattern: @tool decorator makes any function available to agents")
```

## Step 5: Create Agent with Tools

**Core Strands Pattern**: `Agent(model=model, tools=[tool1, tool2], system_prompt="...")`

```python
budget_agent = Agent(
    model=model,
    tools=[calculate_budget, create_financial_chart, generate_sample_data],
    system_prompt="""
    You are a helpful personal finance assistant. You provide general strategies
    to creating budgets, tips on finacial discipline to acheive financial milestones and analyse
    financial trends. You do not provide any investment advice.

    Keep responses concise and actionable.
    Always provide 2-3 specific steps the user can take.
    Focus on practical budgeting and spending advice.

    Your capabilities:
    - Calculate 50/30/20 budgets using calculate_budget tool
    - Create visual charts using create_financial_chart tool
    - Generate sample data using generate_sample_data tool

    Always be concise and use tools when appropriate.
    Provide visual output whenever possible.
    """
)

print("🎯 Budget Agent with Tools Ready!")
print("✨ This agent can automatically choose which tools to use!")
```

## Step 6: Test Your Strands Agent with Tools

Watch your agent automatically choose and use tools!

```python
# Step 7: Test Autonomous Tool Selection
print("🧪 Testing: Agent automatically chooses tools based on request")
print("="*60)

# Test 1: Budget calculation
print("🤖 Agent Response - Budget Request:")

sample_query = "I make $6000 per month. Can you create a budget breakdown for me?"
response1 = budget_agent(sample_query)
```

## Test 2: Data generation + visualization

```python
# Test 3: Create spending analysis chart

print("\n🤖 Agent Response - Chart Request:")
response3 = budget_agent("Can you create a pie chart showing my spending breakdown by category?")
```

## Safety - Layer Amazon Bedrock Guardrail as safeguards

A LLM is guided by the system prompt but need not always align with the instructions in the system prompt. To ensure user safety from LLM based risks such as hallucinations, it is important to add additional safeguards like guardrails, and consider architectural patterns like Retrieval Augmented Generation to introduce contextual data and human in the loop to verify responses.

### ⚠️ Test the budget agent to see if you breaks “out of character” and provides investment advice although we have instructed it not to do so. You can engage in multi-turn conversation and to break out of the chat, type “exit”

```python
# ⚠️ If you use the query below and engage in multi-turn conversations with the budget_agent that you created, you might be able to
# get the model to generate stock investment advice, which may be risky for the user. ⚠️

# sample_query = budget_agent("How should I invest my savings to make it future proof?")

# Start conversation
while True:
    user_input = input("\nYou: ")

    if user_input.lower() == "exit":
        print("Goodbye!")
        break

    # Process the user input and get a response
    response = budget_agent(user_input)
```

### To prevent the agent from providing stock investment advice in specific stocks, let’s create safety filters in Amazon Bedrock Guardrails

```python
# Configure AWS clients
import boto3
bedrock_client = boto3.client('bedrock')
bedrock_runtime = boto3.client('bedrock-runtime')
```

You can now use the `create_guardrail` method to create the no-stock-investment-advice guardrail that will be used in our application. In this example, our guardrail will include a denied-topic filter for “Stock Investment Advice” that will block our agent from providing any advice on investing in specific stocks. We will also create content policy to filter innapropriated content and a word policy to detect specific pre-defined words.

```python
# Create a Bedrock guardrail
response = bedrock_client.create_guardrail(
    name='guardrail-no-investment-advice',
    description='Prevents the model from providing stock investment advice.',
    topicPolicyConfig={
        'topicsConfig': [
            {
                'name': 'Stock Investment Advice',
                'definition': 'Providing personalized advice or recommendations on investing in financial instruments such as stocks or trusts in a fiduciary capacity or assuming related obligations and liabilities.',
                'examples': [
                    'What stocks should I invest in for my retirement?',
                    'Is it a good idea to put my money in a mutual fund?',
                    'How should I allocate my 401(k) investments?',
                    'What type of trust fund should I set up for my children?',
                    'Which stocks have the highest returns?'
                ],
                'type': 'DENY'
            }
        ]
    },
    contentPolicyConfig={
        'filtersConfig': [
            {
                'type': 'SEXUAL',
                'inputStrength': 'HIGH',
                'outputStrength': 'HIGH'
            },
            {
                'type': 'VIOLENCE',
                'inputStrength': 'HIGH',
                'outputStrength': 'HIGH'
            },
            {
                'type': 'HATE',
                'inputStrength': 'HIGH',
                'outputStrength': 'HIGH'
            },
            {
                'type': 'INSULTS',
                'inputStrength': 'HIGH',
                'outputStrength': 'HIGH'
            },
            {
                'type': 'MISCONDUCT',
                'inputStrength': 'HIGH',
                'outputStrength': 'HIGH'
            },
            {
                'type': 'PROMPT_ATTACK',
                'inputStrength': 'HIGH',
                'outputStrength': 'NONE'
            }
        ]
    },
    wordPolicyConfig={
        'wordsConfig': [
            {'text': 'fiduciary advice'},
            {'text': 'investment recommendations'},
            {'text': 'stock picks'},
            {'text': 'financial planning guidance'},
            {'text': 'portfolio allocation advice'},
            {'text': 'retirement fund suggestions'},
            {'text': 'trust fund setup'},
            {'text': 'investment strategy'},
            {'text': 'financial advisor recommendations'}
        ],
        'managedWordListsConfig': [
            {
                'type': 'PROFANITY'
            }
        ]
    },
    blockedInputMessaging='I apologize, but I am not able to provide fiduciary advice. It is best to consult with trusted finance specialists to learn how to invest your money',
    blockedOutputsMessaging='I apologize, but I am not able to provide fiduciary advice. For your privacy and security, please modify your input and try again without including financial, or restricted details.',
)

# Print the response to get the guardrail ID
print("Guardrail ID:", response.get('guardrailId'))
print("Guardrail ARN:", response.get('guardrailArn'))

# Store the guardrail ID for later use
```

```python
guardrail_id = response.get('guardrailId')
guardrail_version = "DRAFT"  # Initial version is always 1
```

```python
## Test the Guardrail directly
# Test function to check if input/output is blocked by guardrail
def test_guardrail(text, source_type='INPUT'):
      response = bedrock_runtime.apply_guardrail(
          guardrailIdentifier=guardrail_id,
          guardrailVersion=guardrail_version,
          source=source_type,  # can be 'INPUT' or 'OUTPUT'
          content=[{"text": {"text": text}}]
      )

      # New response format uses different fields
      print(f"Action: {response.get('action')}")
      print(f"Action Reason: {response.get('actionReason', 'None')}")

      # Check if content was blocked
      is_blocked = response.get('action') == 'GUARDRAIL_INTERVENED'
      print(f"Content {source_type} blocked: {is_blocked}")

      if is_blocked:
          # Print topic policies that were triggered
          assessments = response.get('assessments', [])
          if assessments and 'topicPolicy' in assessments[0]:
              print("Blocked topics:", [topic.get('name') for topic in
  assessments[0]['topicPolicy'].get('topics', [])
                                       if topic.get('action') == 'BLOCKED'])

          # Print the modified output if available
          if 'outputs' in response and response['outputs']:
              print("Modified content:", response['outputs'][0].get('text', 'None'))

      return response

# Test some safe input
print(" 🧪 Testing safe input 🧪:")
test_guardrail("Tell me about general financial literacy concepts.")

# Test input that should be blocked
print("\n ⚠️ Testing input that should be blocked ⚠️:")
test_guardrail("What stocks should I invest in for my retirement?")
```

Now that we confirmed the guardrail is working as expected, let’s integrate Amazon Bedrock Guardrail with a Strands Agent. This is done via the Bedrock Model object, by setting the `guardrail_id`, `guardrail_version` and `guardrail_trace`. Once the model object is created you can use it to create your agent.

```python
# Create a Bedrock model with guardrail configuration
bedrock_model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-6",
    guardrail_id=guardrail_id,
    guardrail_version=guardrail_version,
    # Enable trace info for debugging
    guardrail_trace="enabled"
)

# Create agent with the guardrail-protected model
agent_with_guardrail = Agent(
    model=bedrock_model,
    tools=[calculate_budget, create_financial_chart, generate_sample_data],
    system_prompt="""
        You are a helpful personal finance assistant. You provide general strategies
    to creating budgets, tips on finacial discipline to acheive financial milestones and analyse
    financial trends. You do not provide any investment advice.

    Keep responses concise and actionable.
    Always provide 2-3 specific steps the user can take.
    Focus on practical budgeting and spending advice.

    Your capabilities:
    - Calculate 50/30/20 budgets using calculate_budget tool
    - Create visual charts using create_financial_chart tool
    - Generate sample data using generate_sample_data tool

    Always be concise and use tools when appropriate.
    Provide visual output whenever possible.
    """
)
```

### ⚠️ Test the budget agent to test the guardrail that blocks any investment advice related to specific stocks.

```python
# Testing the Agent with Guardrail
Sample_query =  "I earn $3500. How should I set up a monthly savings and how should I invest these savings?"

# Process the user input and get a response
response = agent_with_guardrail(Sample_query)
```

## Lab 1 Complete - AWS Workshop

### 🎉 What You’ve Mastered:

✅ **Core Strands Patterns:**

-   `Agent(model=BedrockModel(...))` - Basic agent creation
-   `@tool def function()` - Custom tool development
-   `Agent(model=model, tools=[...], system_prompt="...")` - Full agent setup
-   Autonomous tool selection by agents
-   Integrate Amazon Bedrock Guardrails to add safety filters

✅ **Key Skills Gained:**

-   Created AWS Bedrock + Strands integration
-   Integrated Amazon Bedrock Guardrails to add safety filters to the agent
-   Made agents that automatically choose appropriate tools

**🎯 You now understand the core building blocks of Strands Agents!**

### 🚀 Next: Lab 2 - Memory Integration

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/6226307ed8f6de1face333d3daec638593aeedf3/python/04-industry-use-cases/finance/personal-finance-assistant)
