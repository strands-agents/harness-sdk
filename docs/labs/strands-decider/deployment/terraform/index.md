Deploy Strands Decider with Terraform if you’d rather not run CDK, or you need the same recipe across different cloud providers or on-prem. There is no SDK module yet — this page shows the shape so you can wire your own.

Decider serves plain HTTP (`strands-decider serve`), so the Terraform shape is the usual one: build a container image, push it to a registry, and point your compute at it.

-   **When to pick it:** you already use Terraform for your stack; you want the same deploy against more than one cloud provider; you need to layer Decider into existing VPCs, IAM, or networking you control with Terraform.

## Container image

Decider is a pip install plus `strands-decider serve`; package that into a container and push it to your cloud provider’s container registry:

```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir strands-decider
EXPOSE 8000
CMD ["strands-decider", "serve", \
     "StrandsAgents/strands-decider-E2B-gemma4-v1-2610", \
     "--port", "8000"]
```

Build `--platform linux/amd64` for most cloud hosts; use a GPU-capable base and host for the Gemma 4 12B / 26B-A4B models ([designs/inference](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/designs/inference.md#environments-for-serving)).

## AWS ECS / Fargate

The most portable Terraform target: ECS with a Fargate task running the container, fronted by a public ALB.

```hcl
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_ecs_cluster" "decider" {
  name = "strands-decider"
}

resource "aws_cloudwatch_log_group" "decider" {
  name              = "/ecs/strands-decider"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "decider" {
  family                   = "strands-decider"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "2048"
  memory                   = "8192"
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([{
    name         = "decider"
    image        = var.decider_image
    portMappings = [{ containerPort = 8000, hostPort = 8000 }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.decider.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "decider"
      }
    }
  }])
}

resource "aws_ecs_service" "decider" {
  name            = "strands-decider"
  cluster         = aws_ecs_cluster.decider.id
  task_definition = aws_ecs_task_definition.decider.arn
  launch_type     = "FARGATE"
  desired_count   = 1

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.decider.id]
    assign_public_ip = true
  }
}
```

Wire an ALB target group at port 8000 for public access, or front it with API Gateway + a VPC Link if you want IAM-authenticated requests. Hit `POST /v1/systemone` once the service is healthy — same request shape as [Local](/docs/labs/strands-decider/deployment/local/index.md).

### Variables

| Variable | Purpose |
| --- | --- |
| `decider_image` | The image URI in ECR (or a public registry) |
| `aws_region` | The region to deploy into |
| `subnet_ids` | Subnets for the Fargate task (two in different AZs for the ALB) |

## Other targets

Same pattern, different resources — pick the module that matches your cloud provider:

-   **Serverless container service** — a single resource per provider (`google_cloud_run_v2_service`, `azurerm_container_app`, etc.); set a minimum instance count to keep a warm replica, or let it scale to zero for bursty traffic.
-   **Managed Kubernetes** — `kubernetes_deployment` + `kubernetes_service` with a GPU node pool for the larger models.
-   **Bare metal** — any Linux VM; a `null_resource` with a `remote-exec` provisioner to run `strands-decider serve` under systemd works.

## Deploy

```bash
terraform init
terraform plan
terraform apply
```

Rebuild the image and re-apply when the Decider version you serve changes. `terraform destroy` removes the stack.

## Additional resources

-   [Strands Docker Deploy Documentation](https://strandsagents.com/docs/user-guide/sdk/deploy/deploy_to_docker/)
-   [Terraform Documentation](https://www.terraform.io/docs/)
-   [Terraform AWS Provider](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
-   [Terraform Google Provider](https://registry.terraform.io/providers/hashicorp/google/latest/docs)
-   [Terraform Azure Provider](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs)

## See also

-   Full core-site guide (general Strands agents, more targets): [Deploy with Terraform](https://strandsagents.com/docs/user-guide/sdk/deploy/deploy_to_terraform/)
-   No SDK Terraform module yet — the strands-decider repo ships CDK stacks for [SageMaker](/docs/labs/strands-decider/deployment/sagemaker/index.md) and [Lambda](/docs/labs/strands-decider/deployment/lambda/index.md). PRs welcome at [github.com/strands-labs/strands-decider](https://github.com/strands-labs/strands-decider).