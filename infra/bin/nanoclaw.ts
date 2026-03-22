#!/usr/bin/env node
import * as os from 'os';
import * as cdk from 'aws-cdk-lib';
import { NanoclawStack } from '../lib/nanoclaw-stack';

const app = new cdk.App();

cdk.Tags.of(app).add('Owner', os.userInfo().username);

new NanoclawStack(app, 'NanoclawStack', {
  // Deploys into whichever account/region is active in your AWS CLI profile.
  // Override with CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION env vars, or pass
  // --profile <name> to cdk deploy.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'NanoClaw personal AI assistant infrastructure',
});
