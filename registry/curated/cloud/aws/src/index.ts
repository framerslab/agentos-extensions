// @ts-nocheck
/**
 * @fileoverview AWS Cloud Extension for AgentOS.
 *
 * Provides 6 tools for deploying static sites to S3, managing Lightsail instances,
 * configuring Route53 DNS, deploying via Amplify, creating CloudFront distributions,
 * and deploying Lambda functions — all via direct REST API calls with SigV4 signing.
 *
 * @module @framers/agentos-ext-cloud-aws
 */

import { AWSService } from './AWSService.js';
import type { AWSConfig } from './AWSService.js';
import { AWSDeployS3SiteTool } from './tools/deployS3Site.js';
import { AWSCreateLightsailTool } from './tools/createLightsail.js';
import { AWSDeployAmplifyTool } from './tools/deployAmplify.js';
import { AWSManageRoute53Tool } from './tools/manageRoute53.js';
import { AWSConfigureCloudFrontTool } from './tools/configureCloudFront.js';
import { AWSConfigureLambdaTool } from './tools/configureLambda.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AWSCloudOptions {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: AWSCloudOptions, secrets: Record<string, string>): AWSConfig {
  return {
    accessKeyId:
      opts.accessKeyId ?? secrets['aws.accessKeyId']
      ?? process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey:
      opts.secretAccessKey ?? secrets['aws.secretAccessKey']
      ?? process.env.AWS_SECRET_ACCESS_KEY ?? '',
    region:
      opts.region ?? secrets['aws.region']
      ?? process.env.AWS_REGION ?? 'us-east-1',
  };
}

// ---------------------------------------------------------------------------
// Extension Context
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
  getSecret?: (key: string) => string | undefined;
  logger?: { info: (msg: string) => void };
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{ id: string; kind: string; priority?: number; payload: unknown }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const opts = (context.options ?? {}) as AWSCloudOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new AWSService(config);

  const deployS3SiteTool = new AWSDeployS3SiteTool(service);
  const createLightsailTool = new AWSCreateLightsailTool(service);
  const deployAmplifyTool = new AWSDeployAmplifyTool(service);
  const manageRoute53Tool = new AWSManageRoute53Tool(service);
  const configureCloudFrontTool = new AWSConfigureCloudFrontTool(service);
  const configureLambdaTool = new AWSConfigureLambdaTool(service);

  return {
    name: '@framers/agentos-ext-cloud-aws',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'awsDeployS3Site', kind: 'tool', priority: 40, payload: deployS3SiteTool },
      { id: 'awsCreateLightsail', kind: 'tool', priority: 40, payload: createLightsailTool },
      { id: 'awsDeployAmplify', kind: 'tool', priority: 40, payload: deployAmplifyTool },
      { id: 'awsManageRoute53', kind: 'tool', priority: 40, payload: manageRoute53Tool },
      { id: 'awsConfigureCloudFront', kind: 'tool', priority: 40, payload: configureCloudFrontTool },
      { id: 'awsConfigureLambda', kind: 'tool', priority: 40, payload: configureLambdaTool },
    ],
    onActivate: async () => {
      if (!config.accessKeyId || !config.secretAccessKey) {
        throw new Error(
          'AWS: no credentials provided. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY '
          + 'environment variables, or provide them via secrets["aws.accessKeyId"] and secrets["aws.secretAccessKey"].',
        );
      }
      await service.initialize();
    },
    onDeactivate: async () => {
      await service.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { AWSService } from './AWSService.js';
export type {
  AWSConfig,
  S3DeployResult,
  LightsailInstance,
  Route53HostedZone,
  Route53Record,
  AmplifyApp,
  AmplifyDeployResult,
  CloudFrontDistribution,
  LambdaFunction,
} from './AWSService.js';
export { AWSDeployS3SiteTool } from './tools/deployS3Site.js';
export { AWSCreateLightsailTool } from './tools/createLightsail.js';
export { AWSDeployAmplifyTool } from './tools/deployAmplify.js';
export { AWSManageRoute53Tool } from './tools/manageRoute53.js';
export { AWSConfigureCloudFrontTool } from './tools/configureCloudFront.js';
export { AWSConfigureLambdaTool } from './tools/configureLambda.js';

export default createExtensionPack;
