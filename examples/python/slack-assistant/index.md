Users appreciate UIs that are fast and responsive. Slack recently released new capabilities for AI-powered apps to [stream responses](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/) and [indicate thinking and tool call steps](https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks/) to users. Strands makes it easy to build custom agents that also support streaming responses and tool calls. This sample project demonstrates how to integrate Strands’ capabilities with the new Slack app APIs.

## Overview

This sample application demonstrates a simple chat assistant built with Strands that has two basic tools available: a calculator and a timer. Once installed into a Slack workspace, the app backend can be run on a development machine in socket mode or deployed to AWS and invoked via HTTP requests (see [Slack documentation](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode) on the two modes).

This sample app supports chatting via direct message or in the assistant panel on the right. Other interactions are possible by configuring additional events and permissions in the Slack app settings. Here is a demo of the installed application in action:

![app demo video](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/07-ux-demos/slack-assistant/demo.gif)

## Prerequisites

-   A Slack account to create and test your app - Note that some AI assistant capabilities may be limited to certain Slack plans. A [developer program](https://api.slack.com/developer-program) is available for development and testing.
-   An AWS account - *Note that this sample project will invoke APIs and provision AWS resources that incur charges*
-   The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-welcome.html) installed with credentials configured
-   A terminal with bash and [uv](https://docs.astral.sh/uv/) available
-   Docker installed with daemon running (only required if deploying Slack app backend to AWS)

## Install and run locally

This README will walk through all the steps necessary to install this sample application, but you can also refer to the Slack documentation on [creating apps](https://docs.slack.dev/tools/bolt-python/creating-an-app) with the Bolt for Python as well as [adding agent features](https://docs.slack.dev/tools/bolt-python/concepts/adding-agent-features). Start by running the app locally on a development machine.

### Step 1: Create and configure a Slack app

1.  Clone this repo and navigate to this sample project folder:

```plaintext
git clone https://github.com/strands-agents/samples.git strands-samples
cd strands-samples/python/07-ux-demos/slack-assistant/
```

2.  Copy the file `.slack_secrets.example` to `.slack_secrets` to store credentials for your Slack app:

```plaintext
cp .slack_secrets.example .slack_secrets
```

3.  Log into your Slack workspace and create a Slack app at [https://api.slack.com/apps/new](https://api.slack.com/apps/new). Select “From a manifest” and paste in the contents of the file `manifest.json` in this sample project.
    
4.  Once the app is created, navigate to “OAuth & Permissions” and click the “Install to `<workspace>`” button under “OAuth Tokens”. Copy the token into .slack\_secrets assigned to the `SLACK_BOT_TOKEN` environment variable.
    
5.  Navigate to “Basic Information” and click “Generate Token and Scopes” in the “App-Level Tokens” section. Give the token any name and add the `connections:write` scope. Click “Generate”, copy the token and assign to the `SLACK_APP_TOKEN` environment variable.
    

### Step 2: Run the app locally

1.  Run the script `run.sh` to run the app locally using the credentials configured above. You should see terminal output like the following:

```plaintext
$ ./run.sh
INFO:slack_bolt.App:A new session has been established (session id: f5bbd240-e6d0-4cc9-a7ef-6a482dff993c)
INFO:slack_bolt.App:⚡️ Bolt app is running!
INFO:slack_bolt.App:Starting to receive messages from a new connection (session id: f5bbd240-e6d0-4cc9-a7ef-6a482dff993c)
```

2.  Now you can test out the app in Slack. Once installed, you can find the app in slack by clicking “Add apps” in the left navigation bar or “Add agents” in the top bar. Once you initiate a chat with the agent, you should see the message “How can I help you?” along with some sample prompts (see demo video above).

## Deploy to AWS

Now that the app is working in socket mode and running locally, try deploying it to AWS. This sample deploys the app as an [ECS Express Mode](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html) service. Note that the deploy script uses the `us-west-2` region by default, but this can be customized with the `AWS_REGION` environment variable. The CloudFormation stack name and ECR repo name can also be customized with the `STACK_NAME` and `REPO` variables (both are `slack-assistant` by default).

### Step 1: Deploy the backend

1.  Retrieve the Slack signing secret in the “Basic Information” section of the API settings and assign it to the `SLACK_SIGNING_SECRET` environment variable in `.slack_secrets`.
    
2.  Run the deployment script. This script builds a Docker image, creates an ECR repository, pushes the image to the repository, then launches a CloudFormation stack to set up the backend on ECS. You should see output similar to the following:
    

```plaintext
$ ./deploy.sh
Creating ECR repo slack-assistant
Login Succeeded
...
Successfully created/updated stack - slack-assistant
------------------------------------------------------------------------------------------------------
|                                           DescribeStacks                                           |
+-----------------+----------------------------------------------------------------------------------+
|    OutputKey    |                                   OutputValue                                    |
+-----------------+----------------------------------------------------------------------------------+
|  SlackRequestURL|  https://sl-ffc14d9160a5491f8ba03e44c96faac2.ecs.us-west-2.on.aws/slack/events   |
+-----------------+----------------------------------------------------------------------------------+
```

### Step 2: Switch from socket mode to HTTP

1.  Navigate to the “Socket Mode” section of the Slack app settings, and uncheck “Enable Socket Mode”.
    
2.  Navigate to the “Event Subscriptions” section, and paste in the URL returned from the deploy script above. You should see an indication that says “Verified ✓” if successful.
    
3.  Test the app functionality as before. It should function the same as when running locally.
    

### Step 3: Clean up

Run the `cleanup.sh` script to tear down all provisioned AWS resources. You should see output similar to:

```plaintext
$ ./cleanup.sh
Deleting CloudFormation stack slack-assistant in us-west-2...
Waiting for stack deletion to complete...
Stack slack-assistant deleted.
Deleting ECR repository slack-assistant in us-west-2...
{...}
ECR repository slack-assistant deleted.
```

## Conclusion and next steps

This sample project serves as a basic demonstration of what is possible by combining the capabilities of Strands and Slack’s AI assistant UI elements. See how you can modify the sample to meet your organization’s or your customers’ needs. A few ideas for where to go from here include:

-   Add a secure code interpreter using the [integration between Bedrock AgentCore Code Interpreter and Strands](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-using-strands.html)
-   Use the built-in [RAG tools](https://strandsagents.com/docs/user-guide/concepts/tools/community-tools-package/#rag--memory) to let your assistant answer questions based on a knowledge base
-   Add rich messages including images, videos, and more using Slack [blocks](https://docs.slack.dev/reference/block-kit/blocks)

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/07-ux-demos/slack-assistant)
