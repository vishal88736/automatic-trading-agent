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
