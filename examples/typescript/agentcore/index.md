This tutorial demonstrates how to deploy a Strands Agent to Amazon Bedrock AgentCore Runtime for production workloads.

![Agent Architecture](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/typescript/02-deploy/01-agentcore/images/architecture_runtime.png)

| Feature | Description |
| --- | --- |
| Deployment target | Amazon Bedrock AgentCore Runtime |
| Agent type | Single agent with Express server |
| Model | Claude Haiku 4.5 via Amazon Bedrock |

## Prerequisites

-   Node.js 20.x or later
-   AWS CLI configured with appropriate permissions
-   AWS account with AgentCore access
-   Docker with buildx support, or AWS CodeBuild permissions

## Running Locally

```bash
cd typescript/02-deploy/01-agentcore
npm install
npm run dev
```

Test the agent:

```bash
curl http://localhost:8080/ping
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"input": {"prompt": "What is the weather?"}}'
```

## Deploying to AgentCore

### Setup Prerequisites

Run the setup script to create the IAM role and ECR repository:

```bash
chmod +x setup-prerequisites.sh
./setup-prerequisites.sh
```

Export the variables printed by the script:

```bash
export ROLE_ARN=<role-arn-from-script>
export REPO_URI=<repo-uri-from-script>
export AWS_REGION=us-east-1
```

### Build and Push Docker Image

```bash
chmod +x build-image.sh
./build-image.sh
```

> **Note:** The script auto-detects your environment and uses local Docker or AWS CodeBuild accordingly.

### Create AgentCore Runtime

```bash
npm run deploy
```

### Invoke Deployed Agent

```bash
AGENT_RUNTIME_ARN=<arn-from-deploy> npm run invoke "What is the weather?"
```

## Key Concepts

### AgentCore Runtime Service Contract

AgentCore Runtime requires a containerized application exposing two HTTP endpoints: `/ping` for status tracking and `/invocations` for processing requests:

```typescript
app.get('/ping', (_req, res) => {
  res.json({ status: 'Healthy' });
});

app.post('/invocations', async (req, res) => {
  const prompt = req.body.input?.prompt;
  const result = await agent.invoke(prompt);
  res.type('text/plain').send(result.toString());
});
```

### Creating an AgentCore Runtime

Use the AWS SDK to create an AgentCore Runtime that references your container image:

```typescript
const command = new CreateAgentRuntimeCommand({
  agentRuntimeName: AGENT_NAME,
  agentRuntimeArtifact: {
    containerConfiguration: { containerUri: `${repositoryUri}:latest` }
  },
  networkConfiguration: { networkMode: 'PUBLIC' },
  roleArn
});
```

### Invoking the AgentCore Runtime

Send requests to the deployed agent using the InvokeAgentRuntime API:

```typescript
const command = new InvokeAgentRuntimeCommand({
  agentRuntimeArn: AGENT_RUNTIME_ARN,
  runtimeSessionId: sessionId,
  payload: new TextEncoder().encode(prompt),
  qualifier: 'DEFAULT'
});
```

## Project Structure

```plaintext
├── Dockerfile               # Container image for AgentCore
├── setup-prerequisites.sh   # Setup script (IAM role, ECR repo)
├── build-image.sh           # Build script (Docker or CodeBuild)
├── package.json
├── tsconfig.json
└── src/
    ├── agent.ts             # Express server with Strands Agent
    ├── deploy-agent.ts      # AgentCore deployment script
    └── invoke-agent.ts      # Remote invocation script
```

## Cleanup

```bash
# Delete AgentCore Runtime
aws bedrock-agentcore-control delete-agent-runtime \
  --agent-runtime-id <runtime-id> --region us-east-1

# Delete ECR repository
aws ecr delete-repository \
  --repository-name agentcore-deployment \
  --region us-east-1 --force

# Delete IAM role
aws iam delete-role-policy --role-name AgentCoreRuntimeRole --policy-name AgentCoreRuntimePolicy
aws iam delete-role --role-name AgentCoreRuntimeRole

# (Optional) Delete CodeBuild resources if created
aws codebuild delete-project --name agentcore-image-builder
aws iam delete-role-policy --role-name CodeBuildAgentCoreRole --policy-name CodeBuildPolicy
aws iam delete-role --role-name CodeBuildAgentCoreRole
```

## Additional Resources

-   [Deploy to Amazon Bedrock AgentCore (TypeScript)](https://strandsagents.com/latest/documentation/docs/user-guide/deploy/deploy_to_bedrock_agentcore/typescript/)
-   [Operating Agents in Production](https://strandsagents.com/latest/documentation/docs/user-guide/deploy/operating-agents-in-production/)
-   [Amazon Bedrock AgentCore Documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/)

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/typescript/02-deploy/01-agentcore)
