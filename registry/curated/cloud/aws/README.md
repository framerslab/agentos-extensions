# AWS cloud

This pack gives agents tools to deploy S3 sites and Amplify apps, manage Lightsail instances and Route53 DNS, create CloudFront distributions, and deploy or invoke Lambda functions. It uses direct AWS REST API calls with SigV4 signing.

## Installation

```bash
npm install @framers/agentos-ext-cloud-aws
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-cloud-aws';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessKeyId` | `aws.accessKeyId` | `AWS_ACCESS_KEY_ID` | Yes | Empty string |
| `secretAccessKey` | `aws.secretAccessKey` | `AWS_SECRET_ACCESS_KEY` | Yes | Empty string |
| `region` | `aws.region` | `AWS_REGION` | No | `us-east-1` |
| `secrets` | | | No | `context.secrets`, then `{}` |

Explicit options take precedence over secrets, then environment variables. `options.secrets` takes precedence over `context.secrets`.

## Tools

| Tool | What it does |
| --- | --- |
| `awsDeployS3Site` | Deploys a local static site to an S3 bucket with website hosting and public read access. |
| `awsCreateLightsail` | Creates, lists, or deletes Lightsail instances. |
| `awsDeployAmplify` | Creates an Amplify app from a Git repository, sets up a branch, and triggers deployment. |
| `awsManageRoute53` | Adds, removes, upserts, or lists Route53 DNS records and lists hosted zones. |
| `awsConfigureCloudFront` | Creates a CloudFront distribution for an S3 bucket or custom origin. |
| `awsConfigureLambda` | Deploys, updates, invokes, or inspects a Lambda function. |

### `awsDeployS3Site`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `bucketName` | string | Yes | S3 bucket name, globally unique. |
| `sourceDir` | string | Yes | Path to the local directory containing static site files. |
| `indexDocument` | string | No | Index document filename, default `index.html`. |
| `errorDocument` | string | No | Error document filename, default `error.html`. |
| `region` | string | No | Bucket region, uses the configured default if omitted. |

### `awsCreateLightsail`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string: `create`, `list`, `delete` | No | Action to perform, default `create`. |
| `instanceName` | string | No | Instance name, required for create and delete. |
| `blueprintId` | string | No | OS or app image, default `ubuntu_22_04`. |
| `bundleId` | string | No | Instance size, default `nano_3_0`. |
| `availabilityZone` | string | No | Availability zone, default `{region}a`. |
| `userData` | string | No | User data script to run on instance launch. |
| `tags` | object[] | No | Tags to apply to the instance. |
| `tags[].key` | string | Yes, within each tag | |
| `tags[].value` | string | Yes, within each tag | |

### `awsDeployAmplify`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appName` | string | Yes | Application name in Amplify. |
| `repository` | string | Yes | Git repository URL. |
| `branch` | string | No | Branch to deploy, default `main`. |
| `oauthToken` | string | No | OAuth or personal access token for private repositories. |
| `framework` | string | No | Framework preset, auto-detected if omitted. |
| `buildSpec` | string | No | Amplify build specification, `amplify.yml` content. |
| `environmentVariables` | object | No | Environment variables as key-value pairs. |
| `stage` | string | No | Deployment stage, default `PRODUCTION`. |

### `awsManageRoute53`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string: `add`, `remove`, `upsert`, `list`, `list-zones` | Yes | Action to perform. |
| `hostedZoneId` | string | No | Hosted zone ID, required for add, remove, upsert, and list. |
| `recordName` | string | No | DNS record name. |
| `recordType` | string: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `SOA`, `SRV`, `CAA` | No | DNS record type. |
| `values` | string[] | No | Record values. |
| `ttl` | number | No | TTL in seconds, default 300. |
| `aliasTarget` | object | No | Alias target for Route53 alias records. |
| `aliasTarget.hostedZoneId` | string | Yes, within `aliasTarget` | Hosted zone ID of the alias target. |
| `aliasTarget.dnsName` | string | Yes, within `aliasTarget` | DNS name of the alias target. |
| `aliasTarget.evaluateTargetHealth` | boolean | No | Whether to evaluate target health, default `false`. |

### `awsConfigureCloudFront`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `originDomainName` | string | Yes | Origin domain name. |
| `originId` | string | No | Custom origin ID, auto-generated if omitted. |
| `isS3Origin` | boolean | No | Whether the origin is an S3 bucket, default `true`; use `false` for custom origins. |
| `enabled` | boolean | No | Whether the distribution is enabled, default `true`. |
| `defaultRootObject` | string | No | Default root object, default `index.html`. |
| `comment` | string | No | Comment or description for the distribution. |
| `priceClass` | string: `PriceClass_100`, `PriceClass_200`, `PriceClass_All` | No | Price class controlling edge locations. |
| `aliases` | string[] | No | Custom domain aliases or CNAMEs. |
| `viewerProtocolPolicy` | string: `redirect-to-https`, `allow-all`, `https-only` | No | Viewer protocol policy, default `redirect-to-https`. |
| `originProtocolPolicy` | string: `https-only`, `http-only`, `match-viewer` | No | Custom origin protocol policy, default `https-only`. |

### `awsConfigureLambda`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string: `deploy`, `invoke`, `get` | No | Action to perform, default `deploy`. |
| `functionName` | string | Yes | Lambda function name. |
| `runtime` | string | No | Runtime, required for deploy. |
| `handler` | string | No | Handler entry point, required for deploy. |
| `roleArn` | string | No | IAM execution role ARN, required for deploy. |
| `zipFilePath` | string | No | Path to the zip file containing function code, required for deploy. |
| `memorySize` | number | No | Memory in MB, default 128, maximum 10240. |
| `timeout` | number | No | Timeout in seconds, default 30, maximum 900. |
| `environment` | object | No | Environment variables as key-value pairs. |
| `description` | string | No | Function description. |
| `invokePayload` | | No | Payload to send for the invoke action. |

## Notes

Activation fails when either credential is missing and validates supplied credentials through STS `GetCallerIdentity`.

S3 deployment removes the bucket's public access block, enables website hosting, applies a public-read policy, and recursively uploads local files. The service sends file buffers as base64 text and returns an HTTP website URL.

Lightsail creation and deletion, DNS changes, Amplify deployment, CloudFront creation, and Lambda deployment or invocation change remote resources. Lightsail requires `instanceName` for creation and deletion. Route53 changes require `hostedZoneId`, `recordName`, `recordType`, and either nonempty `values` or `aliasTarget`.

Amplify deployment creates an app and triggers deployment without waiting for completion. CloudFront aliases return instructions for CNAME records and an ACM certificate in `us-east-1`; the tool does not provision that certificate.

Lambda deployment reads a local zip archive and requires `runtime`, `handler`, `roleArn`, and `zipFilePath`. An existing function has its code and configuration updated. The memory and timeout maxima in the schema descriptions are not enforced locally.

## License

Apache-2.0
