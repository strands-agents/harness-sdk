## Overview

In this example we will guide you through how to create your first Strands Agent using [Amazon Bedrock Guardrails](https://aws.amazon.com/bedrock/guardrails/) to safeguard the underlying Amazon Bedrock LLM model.

Amazon Bedrock Guardrails provides configurable safeguards to help safely build generative AI applications at scale. With a consistent and standard approach used across a wide range of foundation models (FMs) including FMs supported in Amazon Bedrock, fine-tuned models, and models hosted outside of Amazon Bedrock, Guardrails delivers industry-leading safety protections.

With Strands Agents, you can add Amazon Bedrock Guardrails directly to your Amazon Bedrock models. If you are not using Amazon Bedrock Models, you can use the [Apply Guardrail API](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html) to safeguard any model. In this case, you need to build the pipelines using the advance processing capabilities you just learned.

## Agent Details

| Feature | Description |
| --- | --- |
| AWS Services used | Amazon Bedrock Guardrails |
| Custom tools created | get\_customer\_profile, list\_customer\_purchases, list\_customer\_tickets, update\_customer\_profile |
| Agent Structure | Single agent architecture |

## Architecture

![Guardrails: Architecture diagram](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/05-guardrails/images/architecture.png)

## Key Features

-   **Single agent architecture**: this example creates a single agent that interacts with built-in and custom tools
-   **Custom tools**: learn how to create your own tools
-   **Amazon Bedrock Model as underlying LLM**: Used Anthropic Claude Sonnet 4.5 from Amazon Bedrock as the underlying LLM model
-   **Amazon Bedrock Guardrails as underlying safeguard**: Use Amazon Bedrock Guardrails to safe guard your agent application

## Setup and prerequisites

### Prerequisites

-   Python 3.10+
-   AWS account
-   Anthropic Claude Sonnet 4.5 enabled on Amazon Bedrock
-   IAM role with permissions to create Amazon Bedrock Guardrails

Let’s now install the requirement packages for our Strands Agent

```bash
pip install -U -r requirements.txt
```

### Importing dependency packages

Now let’s import the dependency packages

```python
import json
import boto3
import os
from strands import Agent, tool
from strands.models import BedrockModel
from customer_profiles import CustomerProfileManager, generate_synthetic_profiles
```

### Generating data

Let’s generate some synthetic data for this example. In reality, your agent would connect to an existing customer database, but we will use a JSON file for this example

```python
# Generate synthetic profiles if needed
profile_manager = CustomerProfileManager()
if not os.path.exists("customer_profiles.json"):
    print("Generating synthetic customer profiles")
    profiles = generate_synthetic_profiles(10)
    print(f"Generated {len(profiles)} synthetic customer profiles")
else:
    print("Using existing customer profiles")
    profiles = list(profile_manager.profiles.values())
    print(f"Loaded {len(profiles)} customer profiles")

# Display sample profile for reference
if profiles:
    sample_profile = profiles[0]
    print(f"\nSample Profile: {sample_profile.name}")
    print(f"Email: {sample_profile.email}")
    print(f"Customer ID: {sample_profile.customer_id}")
    print(f"Location: {sample_profile.state}, {sample_profile.country}")
    print(f"Purchases: {len(sample_profile.purchase_history)}")
    print(f"Support Tickets: {len(sample_profile.support_tickets)}")
```

### Importing the customer profile tools

```python
from customer_profile_tools import get_customer_profile, list_customer_purchases, list_customer_tickets, update_customer_profile
```

## Creating an Amazon Bedrock Guardrail

Let’s now create an Amazon Bedrock Guardrail to prevent providing financial advice and filter for common challenges in a customer facing application.

To create the guardrail, first we need to configure the Amazon Bedrock client:

```python
# Configure AWS clients
bedrock_client = boto3.client('bedrock')
bedrock_runtime = boto3.client('bedrock-runtime')
```

You can now use the `create_guardrail` method to create the `no-investment-advice` guardrail that will be used in our application. In this example, our guardrail will include a topic deny for `Fiduciary Advice` that will block our agent to provide any fiduciary advice. The guardrail will also contain some basic content policy to filter inappropriate content and a word policy configuration to detect specific pre-defined words.

```python
# Create a Bedrock guardrail
response = bedrock_client.create_guardrail(
    name='no-investment-advice',
    description='Prevents the model from providing fiduciary advice.',
    topicPolicyConfig={
        'topicsConfig': [
            {
                'name': 'Fiduciary Advice',
                'definition': 'Providing personalized advice or recommendations on managing financial assets, investments, or trusts in a fiduciary capacity or assuming related obligations and liabilities.',
                'examples': [
                    'What stocks should I invest in for my retirement?',
                    'Is it a good idea to put my money in a mutual fund?',
                    'How should I allocate my 401(k) investments?',
                    'What type of trust fund should I set up for my children?',
                    'Should I hire a financial advisor to manage my investments?'
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
            {'text': 'wealth management tips'},
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
    blockedInputMessaging='I apologize, but I am not able to provide fiduciary advice. For your privacy and security, please modify your input and try again without including any financial, or restricted details.',
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

### Testing the guardrail directly

To verify that the guardrail works as expected, we will create the `test_guardrail` support function. this function will use the `apply_guardrail` method to safeguard the input text and provide information about any actions taken by the guardrail

```python
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
print("Testing safe input:")
test_guardrail("Tell me about general financial literacy concepts.")

# Test input that should be blocked
print("\nTesting input that should be blocked:")
test_guardrail("What stocks should I invest in for my retirement?")
```

## Integrating with Strands Agent

Now that we confirmed the guardrail is working as expected, let’s integrate it the Amazon Bedrock Guardrail with a Strands Agent. This is done via the Bedrock Model object, by setting the `guardrail_id`, `guardrail_version` and `guardrail_trace`. Once the model object is created you can use it to create your agent. We will use a couple of custom tools in this agent: `get_customer_profile`, `list_customer_purchases`, `list_customer_tickets`, `update_customer_profile`. To see their implementation check the `customer_profile_tools.py` file

```python
guardrail_id, guardrail_version
```

```python
# Create a Bedrock model with guardrail configuration
bedrock_model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    guardrail_id=guardrail_id,
    guardrail_version=guardrail_version,
    # Enable trace info for debugging
    guardrail_trace="enabled"
)

# Create agent with the guardrail-protected model
agent = Agent(
    system_prompt="You are a helpful assistant that provides customer support for retail products.",
    model=bedrock_model,
    tools=[
        get_customer_profile,
        list_customer_purchases,
        list_customer_tickets,
        update_customer_profile
    ]
)
```

### Testing the Strands Agent with Guardrails

Let’s test our agent with both safe and risky inputs. To do so we will process the agent’s response and check if the `stop_reason` is due to a guardrail intervention.

```python
# Helper function to test the agent and check for guardrail interventions
def test_agent_with_guardrail(prompt):
    print(f"\nUser: {prompt}")

    # Get agent response
    response = agent(prompt)

    # Check for guardrail intervention
    if hasattr(response, 'stop_reason') and response.stop_reason == "guardrail_intervened":
        print("\n ⚠️ GUARDRAIL INTERVENED!")
        #print(f"Response: {response}")
    else:
        return response
```

```python
# Test with a safe question
test_agent_with_guardrail(
    " what is my latest purchase my Customer ID is CUST100?"
)
```

```python
# Test with a question that asks about investment recommendation, or hate or violence
test_agent_with_guardrail(
    "My SSN is 123-45-6789. Can you help me understand how to protect my retirement account?"
)
```

## Inspecting Conversation History

Let’s examine the conversation history to see how guardrails affected it:

```python
# Print the conversation history
print(f"Conversation history: {json.dumps(agent.messages, indent=4)}")
```

## Integrating Bedrock guardrails to a chatbot

Amazon Bedrock provides a built-in guardrails framework that integrates directly with Strands Agents SDK. If a guardrail is triggered, the Strands Agents SDK will automatically overwrite the users input in conversation history. This is done so that follow-up questions are not also blocked by the same questions. This can be configured with the guardrail\_redact\_input boolean, and the guardrail\_redact\_input\_message string to change the overwrite message. Additionally, the same functionality is built for the model’s output, but this is disabled by default. You can enable this with the guardrail\_redact\_output boolean, and change the overwrite message with the guardrail\_redact\_output\_message string. Below is an example of how to leverage Bedrock guardrails in your code:

```python
bedrock_model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    guardrail_id=guardrail_id,         # Your Bedrock guardrail ID
    guardrail_version=guardrail_version,             # Guardrail version
    guardrail_trace="enabled",
    guardrail_redact_output = True,
    guardrail_redact_input = True  ,
    guardrail_redact_input_message = "Guardrail Intervened and Redacted"
)

# Create agent with the guardrail-protected model
agent = Agent(
    system_prompt="You are a helpful assistant that provides customer support for retail products.",
    model=bedrock_model,
    tools=[
        get_customer_profile,
        list_customer_purchases,
        list_customer_tickets,
        update_customer_profile
    ]
)
```

```python
# Test a safe question for the customer support Agent
agent(f"what is the data from customer_id {sample_profile.customer_id}?")
```

```python
# Test with user input in which guardrail is intervened and input is redacted with custom message
agent("How should I allocate my 401(k) investments?")
```

The custom message for the redacted input is stored in the conversation history like this :

```python
print(f"Conversation history: {json.dumps(agent.messages, indent=4)}")
```

## Clean up

Please delete the guardrail as follows :

```python
bedrock_client.delete_guardrail(guardrailIdentifier=guardrail_id)
```

## Congratulations!

In this notebook, we demonstrated how to:

1.  Create an Amazon Bedrock guardrail that prevents providing financial advice
2.  Test the guardrail directly using the Bedrock Runtime API
3.  Integrate the guardrail with a Strands agent
4.  Test the agent with various inputs to see the guardrail in action
5.  Integrate bedrock guardrails in a chatbot with Strands agent.
6.  Delete the Guardrail

Guardrails help in keeping AI responses remain safe, compliant, and appropriate for your use case.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/05-guardrails)
