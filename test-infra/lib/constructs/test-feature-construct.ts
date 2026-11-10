import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { TestFeature, ssmParameterPath } from '../constants';

export interface TestFeatureConstructProps {
  /**
   * Shared integration-test role granted scoped permissions by the feature.
   * When omitted the usage grant is skipped.
   */
  readonly role?: iam.IRole;
}

export abstract class TestFeatureConstruct extends Construct {
  abstract readonly featureName: TestFeature;

  protected ssmPath(...segments: string[]): string {
    return ssmParameterPath(this.featureName, ...segments);
  }

  /** Grant read on all SSM parameters this feature publishes. */
  protected grantSsmParameterRead(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: this.ssmPath('*').replace(/^\//, ''),
          }),
        ],
      }),
    );
  }
}
