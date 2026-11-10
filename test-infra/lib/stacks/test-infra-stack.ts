import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TestFeature } from '../constants';
import { IntegTestRole } from '../constructs/integ-test-role';
import { BedrockKnowledgeBaseTestResources } from '../constructs/bedrock-knowledge-base-test-resources';
import { SshEc2TestResources } from '../constructs/ssh-ec2-test-resources';

export interface StrandsTestInfraStackProps extends cdk.StackProps {
  /**
   * Which features to provision. `all` (the default) selects every feature;
   * otherwise only the listed features are created.
   */
  readonly testFeatures?: TestFeature[];

  /**
   * Attach the legacy internal base policy to the test role. Off for community
   * deploys; see {@link IntegTestRole}.
   */
  readonly internal?: boolean;
}

export class StrandsTestInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StrandsTestInfraStackProps = {}) {
    super(scope, id, props);

    const selected = props.testFeatures ?? ['all'];
    const enabled = (feature: TestFeature): boolean =>
      selected.includes('all') || selected.includes(feature);

    // Each feature construct layers its own scoped grants onto this role.
    const { role } = new IntegTestRole(this, 'StrandsTestRole', { internal: props.internal });

    if (enabled('bedrock-knowledge-base')) {
      new BedrockKnowledgeBaseTestResources(this, 'StrandsBedrockKnowledgeBase', { role });
    }

    if (enabled('ssh-ec2')) {
      new SshEc2TestResources(this, 'StrandsSshEc2', { role });
    }
  }
}
