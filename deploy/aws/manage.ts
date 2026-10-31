import { spawnSync } from "node:child_process";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
const command = process.argv[2] ?? "preflight",
  region = process.env.AWS_REGION ?? "ap-south-1",
  stage = process.env.KRONO_ENV ?? "development";
if (!["development", "staging", "production"].includes(stage))
  throw Error("Invalid environment");
function run(args: string[]) {
  const r = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) throw Error("Command failed");
}
async function identity() {
  const r = await new STSClient({
    region,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 5000 },
  }).send(new GetCallerIdentityCommand({}));
  if (!process.env.AWS_ACCOUNT_ID || process.env.AWS_ACCOUNT_ID !== r.Account)
    throw Error(
      "Set AWS_ACCOUNT_ID to match your authenticated target account",
    );
  console.log(
    JSON.stringify({
      account: r.Account,
      region,
      environment: stage,
      authenticated: true,
    }),
  );
}
async function deployChecks() {
  await identity();
  if (
    !(Number(process.env.KRONO_MONTHLY_BUDGET_USD) > 0) ||
    !process.env.KRONO_BUDGET_EMAIL?.includes("@")
  )
    throw Error(
      "Set a positive KRONO_MONTHLY_BUDGET_USD and KRONO_BUDGET_EMAIL before provisioning",
    );
  if (
    stage === "production" &&
    (!process.env.KRONO_DOMAIN_NAME ||
      !process.env.KRONO_HOSTED_ZONE_ID ||
      !process.env.KRONO_HOSTED_ZONE_NAME ||
      !process.env.KRONO_CLOUDFRONT_CERTIFICATE_ARN)
  )
    throw Error(
      "Production requires the reviewed domain, hosted zone and ACM certificate",
    );
}
try {
  if (command === "synth")
    run([
      "node_modules/aws-cdk/bin/cdk",
      "synth",
      "--quiet",
      "--app",
      "npx --no-install tsx infra/app.ts",
      "--output",
      "cdk.out",
    ]);
  else if (command === "preflight") {
    await identity();
    console.log(
      "Identity verified. Bedrock access, email delivery and deployments still require AWS acceptance checks.",
    );
  } else if (command === "bootstrap") {
    await deployChecks();
    run([
      "node_modules/aws-cdk/bin/cdk",
      "bootstrap",
      `aws://${process.env.AWS_ACCOUNT_ID}/${region}`,
    ]);
  } else if (command === "deploy") {
    await deployChecks();
    run([
      "node_modules/aws-cdk/bin/cdk",
      "deploy",
      "--app",
      "npx --no-install tsx infra/app.ts",
      "--outputs-file",
      `deploy/aws/outputs-${stage}.json`,
    ]);
  } else if (command === "outputs" || command === "publish") {
    await identity();
    const r = await new CloudFormationClient({ region }).send(
      new DescribeStacksCommand({ StackName: `krono-${stage}` }),
    );
    const outputs = Object.fromEntries(
      (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]),
    );
    if (command === "outputs") console.log(JSON.stringify(outputs, null, 2));
    else {
      const s3 = new S3Client({ region }),
        root = path.resolve("frontend/dist");
      const types: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webp": "image/webp",
        ".woff2": "font/woff2",
        ".json": "application/json",
      };
      async function upload(dir: string) {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, e.name);
          if (e.isDirectory()) await upload(file);
          else
            await s3.send(
              new PutObjectCommand({
                Bucket: outputs.FrontendBucket,
                Key: path.relative(root, file).split(path.sep).join("/"),
                Body: await readFile(file),
                ContentType:
                  types[path.extname(file)] ?? "application/octet-stream",
                CacheControl:
                  e.name === "index.html"
                    ? "no-cache"
                    : "public,max-age=31536000,immutable",
              }),
            );
        }
      }
      await upload(root);
      console.log(
        JSON.stringify({
          published: true,
          url: outputs.FrontendUrl,
          note: "Invalidate /index.html after subsequent deployments",
        }),
      );
    }
  } else
    throw Error("Use preflight, synth, bootstrap, deploy, outputs or publish");
} catch (e) {
  console.error(
    JSON.stringify({
      status: "FAILED",
      operation: command,
      errorType: (e as Error).name,
      message:
        (e as Error).name === "CredentialsProviderError"
          ? "Configure your AWS SSO/profile or task role; no AWS credentials were found"
          : (e as Error).message,
    }),
  );
  process.exitCode = 1;
}
