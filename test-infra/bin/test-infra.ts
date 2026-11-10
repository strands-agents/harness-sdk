#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StrandsTestInfraStack } from '../lib/stacks/test-infra-stack';
import { TestFeature, VALID_TEST_FEATURES } from '../lib/constants';

const app = new cdk.App();

// Optionally narrow which features deploy via `-c testFeatures=a,b`;
// defaults to all features when unset.
const featuresContext = app.node.tryGetContext('testFeatures');
const testFeatures =
  typeof featuresContext === 'string'
    ? featuresContext.split(',').map((g) => {
        const trimmed = g.trim();
        if (!VALID_TEST_FEATURES.includes(trimmed as TestFeature)) {
          throw new Error(
            `Unknown test feature: "${trimmed}". Valid features: ${VALID_TEST_FEATURES.join(', ')}`,
          );
        }
        return trimmed as TestFeature;
      })
    : undefined;

// Internal Strands deploys set this to attach the legacy base policy to the
// test role; community deploys leave it unset.
const internal = process.env.STRANDS_TEST_INFRA_INTERNAL === 'true';

const account = process.env.STRANDS_TEST_INFRA_DEPLOYMENT_ACCOUNT
  ?? process.env.CDK_DEFAULT_ACCOUNT
  ?? process.env.AWS_ACCOUNT_ID;
const region = process.env.STRANDS_TEST_INFRA_DEPLOYMENT_REGION
  ?? process.env.CDK_DEFAULT_REGION
  ?? process.env.AWS_REGION;
if (!account || !region) {
  throw new Error(
    'Could not determine deployment account/region. Either configure AWS CLI credentials or set STRANDS_TEST_INFRA_DEPLOYMENT_ACCOUNT and STRANDS_TEST_INFRA_DEPLOYMENT_REGION.',
  );
}

new StrandsTestInfraStack(app, 'StrandsTestInfraStack', {
  env: { account, region },
  testFeatures,
  internal,
});
