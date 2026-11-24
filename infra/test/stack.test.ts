import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { KronoStack } from "../stack.js";
test("AWS foundation isolates data and runtimes, has real orchestration, encryption and budget enforcement", () => {
  const app = new App(),
    stack = new KronoStack(app, "krono-test", {
      stage: "development",
      env: { account: "111111111111", region: "ap-south-1" },
      budgetUsd: 100,
      budgetEmail: "operator@example.org",
    });
  const t = Template.fromStack(stack);
  t.resourceCountIs("AWS::DynamoDB::Table", 3);
  t.hasResourceProperties("AWS::DynamoDB::Table", {
    SSESpecification: {
      SSEEnabled: true,
      SSEType: "KMS",
      KMSMasterKeyId: Match.anyValue(),
    },
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
  });
  t.hasResourceProperties("AWS::ECS::Service", {
    DesiredCount: 0,
    NetworkConfiguration: {
      AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED" }),
    },
  });
  t.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
    Scheme: "internal",
  });
  t.resourceCountIs("AWS::CloudFront::VpcOrigin", 1);
  t.hasResourceProperties("AWS::Cognito::UserPool", {
    AutoVerifiedAttributes: ["email"],
    UsernameAttributes: ["email"],
  });
  t.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream",
          ],
          Resource:
            "arn:aws:bedrock:ap-south-1::foundation-model/minimax.minimax-m2.5",
        }),
      ]),
    }),
  });
  t.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
  t.resourceCountIs("AWS::Budgets::Budget", 1);
  t.hasResourceProperties("AWS::Events::Rule", {
    ScheduleExpression: "rate(1 minute)",
  });
  const json = JSON.stringify(t.toJSON());
  assert.ok(json.includes("iam:PermissionsBoundary"));
  assert.ok(!json.includes('"Action":"iam:*"'));
  assert.ok(json.includes("RuntimeJanitor"));
  assert.ok(json.includes("CoordinationBroker"));
});

test("production deploys the private product and worker after migration and shares only its signing key", () => {
  const stack = new KronoStack(new App(), "krono-product-test", {
    stage: "production",
    env: { account: "111111111111", region: "ap-south-1" },
    apiImageDigest: "sha256:" + "1".repeat(64),
    productImageDigest: "sha256:" + "2".repeat(64),
    egressHosts: ["news.example.com"],
    llmProvider: "groq",
    groqBaseUrl: "https://models.example.com/v1",
    groqKeyArn:
      "arn:aws:secretsmanager:ap-south-1:111111111111:secret:krono-groq-a1b2c3",
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::ECS::Service", 3);
  template.hasResourceProperties("AWS::RDS::DBCluster", {
    Engine: "aurora-postgresql",
    StorageEncrypted: true,
    DeletionProtection: true,
    ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
  });
  template.hasResourceProperties("AWS::RDS::DBInstance", {
    PubliclyAccessible: false,
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: "product-api",
        DependsOn: [{ Condition: "SUCCESS", ContainerName: "migrate" }],
        Secrets: Match.arrayWith([
          Match.objectLike({ Name: "KRONO_PRODUCT_API_KEY" }),
        ]),
      }),
    ]),
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: "paper-worker",
        Command: ["python", "-m", "backend.product.worker"],
      }),
    ]),
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: "api",
        Environment: Match.arrayWith([
          {
            Name: "KRONO_PRODUCT_API_URL",
            Value: "http://product.krono-production.internal:8794",
          },
          { Name: "GROQ_BASE_URL", Value: "https://models.example.com/v1" },
        ]),
        Secrets: Match.arrayWith([
          Match.objectLike({ Name: "KRONO_PRODUCT_API_KEY" }),
          Match.objectLike({ Name: "GROQ_API_KEY" }),
        ]),
      }),
    ]),
  });
  template.hasResourceProperties("AWS::Route53Resolver::FirewallDomainList", {
    Domains: Match.arrayWith([
      "api.binance.com",
      "data-stream.binance.vision",
      "api.bybit.com",
      "www.okx.com",
      "api.groq.com",
      "product.krono-production.internal",
      "models.example.com",
      "news.example.com",
    ]),
  });
  assert.throws(
    () =>
      new KronoStack(new App(), "missing-product", {
        stage: "production",
        apiImageDigest: "sha256:" + "1".repeat(64),
      }),
    /KRONO_PRODUCT_IMAGE_DIGEST/,
  );
});
