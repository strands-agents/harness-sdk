import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { TestFeatureConstruct, TestFeatureConstructProps } from './test-feature-construct';

export interface SshEc2TestResourcesProps extends TestFeatureConstructProps {}

/**
 * The smallest reachable Linux instance the SSH sandbox integration test can
 * connect to. There is no public IP and no inbound security-group rule: the
 * test reaches sshd by port-forwarding over SSM Session Manager
 * (`aws ssm start-session --document AWS-StartPortForwardingSession`), so the
 * only ingress is the SSM agent's outbound channel.
 *
 * The agent reaches SSM through interface VPC endpoints rather than a NAT
 * gateway, keeping the subnet fully isolated.
 *
 * The instance id and the SSH private key's SSM parameter name are published
 * to SSM under stable paths so concurrent test runners can resolve them at
 * runtime.
 */
export class SshEc2TestResources extends TestFeatureConstruct {
  readonly featureName = 'ssh-ec2' as const;

  /** The instance the SSH sandbox connects to. */
  public readonly instance: ec2.Instance;

  /** Key pair whose private key is auto-stored in SSM by the L2 construct. */
  public readonly keyPair: ec2.KeyPair;

  constructor(scope: Construct, id: string, props: SshEc2TestResourcesProps = {}) {
    super(scope, id);

    // Single-AZ, fully isolated: no public subnets, no NAT, no internet path.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // The SSM agent has no internet route, so reach the SSM control/data plane
    // through interface endpoints. These three are the minimum Session Manager
    // (and thus port forwarding) requires.
    vpc.addInterfaceEndpoint('SsmEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.SSM });
    vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
    });
    vpc.addInterfaceEndpoint('Ec2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
    });

    // ED25519 key pair; CDK stores the private key in SSM automatically.
    this.keyPair = new ec2.KeyPair(this, 'KeyPair', { type: ec2.KeyPairType.ED25519 });

    this.instance = new ec2.Instance(this, 'SshTargetInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      // Cheapest current-gen burstable; AL2023 ships and runs sshd by default.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      keyPair: this.keyPair,
      // Attaches AmazonSSMManagedInstanceCore so the agent can register and
      // accept port-forwarding sessions.
      ssmSessionPermissions: true,
      // No inbound rule is added; the default security group allows only
      // outbound, which is all the SSM agent needs.
      requireImdsv2: true,
    });

    this.publishToSsm();

    if (props.role) {
      this.grantUsage(props.role);
    }
  }

  /**
   * Publish what a test needs to connect — the instance id (the SSM
   * port-forward target) and the SSM parameter name holding the private key —
   * under stable paths.
   */
  private publishToSsm(): void {
    new ssm.StringParameter(this, 'InstanceIdParameter', {
      parameterName: this.ssmPath('instance-id'),
      stringValue: this.instance.instanceId,
    });
    new ssm.StringParameter(this, 'PrivateKeyParameterNameParameter', {
      parameterName: this.ssmPath('private-key-parameter-name'),
      stringValue: this.keyPair.privateKey.parameterName,
    });
  }

  /**
   * Grant a consumer (the integration-test role) permission to open an SSM
   * port-forwarding session to the instance and read the SSH private key.
   */
  private grantUsage(role: iam.IRole): void {
    // Open a Session Manager session to this instance.
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:StartSession'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'ec2',
            resource: 'instance',
            resourceName: this.instance.instanceId,
          }),
          // The managed port-forwarding document is an AWS-owned resource.
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            account: '',
            resource: 'document',
            resourceName: 'AWS-StartPortForwardingSession',
          }),
        ],
      }),
    );
    // The SSH-over-SSM data channel and session cleanup. Scoped to sessions
    // owned by the caller.
    const sessionArn = cdk.Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'session',
      resourceName: '${aws:userid}-*',
    });
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ssmmessages:OpenDataChannel'],
        resources: [sessionArn],
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:TerminateSession'],
        resources: [sessionArn],
      }),
    );
    // Read the SSH private key.
    this.keyPair.privateKey.grantRead(role);

    this.grantSsmParameterRead(role);
  }
}
