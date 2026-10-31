import {
  Stack,
  Duration,
  RemovalPolicy,
  CfnOutput,
  SecretValue,
  Aws,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as dynamo from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as eventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as waf from "aws-cdk-lib/aws-wafv2";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as routeTargets from "aws-cdk-lib/aws-route53-targets";
import * as resolver from "aws-cdk-lib/aws-route53resolver";

interface Props extends StackProps {
  stage: "development" | "staging" | "production";
  domainName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  cloudFrontCertificateArn?: string;
  budgetUsd?: number;
  budgetEmail?: string;
  apiImageDigest?: string;
  agentImageDigest?: string;
  githubRepository?: string;
  githubOidcProviderArn?: string;
  modelId?: string;
  runtimeSettings?: Record<string, string>;
}
export class KronoStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const prefix = `krono-${props.stage}`,
      production = props.stage === "production",
      retention = RemovalPolicy.RETAIN;
    const modelId = props.modelId ?? "minimax.minimax-m2.5";
    if (!/^[a-z0-9][a-z0-9.:-]{2,120}$/.test(modelId))
      throw Error("Invalid Bedrock model ID");
    this.tags.setTag("Project", "KRONO");
    this.tags.setTag("Environment", props.stage);
    const key = new kms.Key(this, "DataKey", {
      enableKeyRotation: true,
      removalPolicy: retention,
      description: `${prefix} data encryption`,
    });
    const vpc = new ec2.Vpc(this, "VPC", {
      maxAzs: 2,
      natGateways: production ? 2 : 1,
      subnetConfiguration: [
        { name: "edge", subnetType: ec2.SubnetType.PUBLIC },
        { name: "application", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    vpc.addGatewayEndpoint("DynamoEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    const apiSg = new ec2.SecurityGroup(this, "ApiSecurity", {
        vpc,
        allowAllOutbound: false,
      }),
      agentSg = new ec2.SecurityGroup(this, "AgentSecurity", {
        vpc,
        allowAllOutbound: false,
      });
    apiSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "AWS HTTPS APIs",
    );
    agentSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Approved market/news HTTPS providers and AWS APIs",
    );
    const domains = new resolver.CfnFirewallDomainList(this, "EgressDomains", {
      name: `${prefix}-approved`,
      domains: [
        "*.amazonaws.com",
        "*.amazonaws.com.cn",
        "api.coinbase.com",
        "api.exchange.coinbase.com",
        "cryptocurrency.cv",
      ],
    });
    const dnsRules = new resolver.CfnFirewallRuleGroup(this, "DnsRules", {
      name: `${prefix}-dns`,
      firewallRules: [
        {
          action: "ALLOW",
          firewallDomainListId: domains.attrId,
          priority: 100,
        },
        {
          action: "BLOCK",
          firewallDomainListId: new resolver.CfnFirewallDomainList(
            this,
            "AllDomains",
            { domains: ["*"] },
          ).attrId,
          priority: 200,
          blockResponse: "NXDOMAIN",
        },
      ],
    });
    new resolver.CfnFirewallRuleGroupAssociation(this, "DnsAssociation", {
      vpcId: vpc.vpcId,
      firewallRuleGroupId: dnsRules.attrId,
      priority: 101,
    });
    const table = (name: string) =>
      new dynamo.Table(this, name, {
        tableName: `${prefix}-${name.toLowerCase()}`,
        partitionKey: { name: "pk", type: dynamo.AttributeType.STRING },
        sortKey: { name: "sk", type: dynamo.AttributeType.STRING },
        billingMode: dynamo.BillingMode.PAY_PER_REQUEST,
        encryption: dynamo.TableEncryption.CUSTOMER_MANAGED,
        encryptionKey: key,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: production,
        timeToLiveAttribute: "expiresAt",
        removalPolicy: retention,
      });
    const control = table("Control"),
      agentControl = table("AgentControl"),
      runtime = table("Runtime");
    const bucket = (name: string) =>
      new s3.Bucket(this, name, {
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: key,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        removalPolicy: retention,
        lifecycleRules: [
          {
            noncurrentVersionExpiration: Duration.days(30),
            abortIncompleteMultipartUploadAfter: Duration.days(1),
          },
        ],
      });
    const artifacts = bucket("Artifacts"),
      frontend = new s3.Bucket(this, "Frontend", {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
        removalPolicy: retention,
        versioned: true,
      });
    const pool = new cognito.UserPool(this, "Users", {
      userPoolName: prefix,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: retention,
      featurePlan: production
        ? cognito.FeaturePlan.PLUS
        : cognito.FeaturePlan.ESSENTIALS,
      ...(production
        ? {
            standardThreatProtectionMode:
              cognito.StandardThreatProtectionMode.FULL_FUNCTION,
          }
        : {}),
    });
    const client = pool.addClient("WebClient", {
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userPassword: true, userSrp: true },
      accessTokenValidity: Duration.minutes(30),
      idTokenValidity: Duration.minutes(30),
      refreshTokenValidity: Duration.days(7),
      enableTokenRevocation: true,
    });
    const apiRepo = new ecr.Repository(this, "ApiImages", {
        repositoryName: `${prefix}/api`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        removalPolicy: retention,
        lifecycleRules: [{ maxImageCount: 20 }],
      }),
      agentRepo = new ecr.Repository(this, "AgentImages", {
        repositoryName: `${prefix}/agent`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        removalPolicy: retention,
        lifecycleRules: [{ maxImageCount: 30 }],
      });
    if (props.githubRepository) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(props.githubRepository))
        throw Error("Invalid GitHub repository");
      const provider = props.githubOidcProviderArn
        ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this,
            "GithubProvider",
            props.githubOidcProviderArn,
          )
        : new iam.OpenIdConnectProvider(this, "GithubProvider", {
            url: "https://token.actions.githubusercontent.com",
            clientIds: ["sts.amazonaws.com"],
          });
      const publisher = new iam.Role(this, "ImagePublisher", {
        assumedBy: new iam.WebIdentityPrincipal(
          provider.openIdConnectProviderArn,
          {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub": `repo:${props.githubRepository}:environment:${props.stage}`,
            },
          },
        ),
      });
      apiRepo.grantPullPush(publisher);
      agentRepo.grantPullPush(publisher);
      new CfnOutput(this, "ImagePublisherRoleArn", {
        value: publisher.roleArn,
      });
      new CfnOutput(this, "GithubOidcProviderArn", {
        value: provider.openIdConnectProviderArn,
      });
    }
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: prefix,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });
    const agentLog = new logs.LogGroup(this, "AgentLogs", {
      logGroupName: `/${prefix}/agents`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: key,
      removalPolicy: retention,
    });
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [
          new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
        ],
        actions: [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ],
        resources: ["*"],
        conditions: {
          ArnLike: {
            "kms:EncryptionContext:aws:logs:arn": `arn:aws:logs:${this.region}:${this.account}:log-group:/${prefix}/*`,
          },
        },
      }),
    );
    const taskExecution = new iam.Role(this, "AgentExecution", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    agentRepo.grantPull(taskExecution);
    agentLog.grantWrite(taskExecution);
    const dlq = new sqs.Queue(this, "CoordinationDLQ", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const queue = new sqs.Queue(this, "Coordination", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });
    const analysisDlq = new sqs.Queue(this, "AnalysisDLQ", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      enforceSSL: true,
    });
    const analysisQueue = new sqs.Queue(this, "AnalysisQueue", {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: analysisDlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });
    const boundary = new iam.ManagedPolicy(this, "AgentBoundary", {
      managedPolicyName: `${prefix}-agent-boundary`,
      statements: [
        new iam.PolicyStatement({
          actions: ["dynamodb:GetItem", "dynamodb:ConditionCheckItem"],
          resources: [agentControl.tableArn],
        }),
        new iam.PolicyStatement({
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:Query",
            "dynamodb:ConditionCheckItem",
          ],
          resources: [runtime.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
          resources: [artifacts.arnForObjects("tenants/*/agents/*")],
        }),
        new iam.PolicyStatement({
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: [key.keyArn],
        }),
        new iam.PolicyStatement({
          actions: ["sqs:SendMessage"],
          resources: [queue.queueArn, analysisQueue.queueArn],
        }),
      ],
    });
    const provisioner = new iam.Role(this, "Provisioner", {
      roleName: `${prefix}-provisioner`,
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
    });
    const dynamicRole = `arn:aws:iam::${this.account}:role/${prefix}-agent-*-task`;
    provisioner.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:CreateRole", "iam:PutRolePermissionsBoundary"],
        resources: [dynamicRole],
        conditions: {
          StringEquals: {
            "iam:PermissionsBoundary": boundary.managedPolicyArn,
          },
        },
      }),
    );
    provisioner.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "iam:GetRole",
          "iam:DeleteRole",
          "iam:PutRolePolicy",
          "iam:GetRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
        ],
        resources: [dynamicRole],
      }),
    );
    provisioner.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [dynamicRole, taskExecution.roleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
        },
      }),
    );
    provisioner.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:RegisterTaskDefinition",
          "ecs:DeregisterTaskDefinition",
          "ecs:DescribeTaskDefinition",
        ],
        resources: ["*"],
      }),
    );
    provisioner.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:CreateService",
          "ecs:UpdateService",
          "ecs:DeleteService",
          "ecs:DescribeServices",
          "ecs:TagResource",
          "ecs:UntagResource",
        ],
        resources: [
          `arn:aws:ecs:${this.region}:${this.account}:service/${prefix}/${prefix}-agent-*`,
        ],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    const workflowRole = new iam.Role(this, "DeploymentRole", {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
    });
    workflowRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudformation:CreateStack",
          "cloudformation:DescribeStacks",
        ],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${prefix}-agent-*/*`,
        ],
      }),
    );
    workflowRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [provisioner.roleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "cloudformation.amazonaws.com",
          },
        },
      }),
    );
    const workflow = new sfn.CfnStateMachine(this, "DeploymentWorkflow", {
      stateMachineName: `${prefix}-deployment`,
      roleArn: workflowRole.roleArn,
      stateMachineType: "STANDARD",
      definition: {
        StartAt: "Provision",
        TimeoutSeconds: 2700,
        States: {
          Provision: {
            Type: "Task",
            Resource: "arn:aws:states:::aws-sdk:cloudformation:createStack",
            Parameters: {
              "StackName.$": "$.stackName",
              "TemplateBody.$": "$.templateBody",
              Capabilities: ["CAPABILITY_NAMED_IAM"],
              RoleARN: provisioner.roleArn,
              OnFailure: "ROLLBACK",
            },
            ResultPath: "$.provision",
            Next: "Wait",
            Catch: [{ ErrorEquals: ["States.ALL"], Next: "Failed" }],
          },
          Wait: { Type: "Wait", Seconds: 15, Next: "Inspect" },
          Inspect: {
            Type: "Task",
            Resource: "arn:aws:states:::aws-sdk:cloudformation:describeStacks",
            Parameters: { "StackName.$": "$.stackName" },
            ResultPath: "$.stack",
            Next: "Ready",
            Catch: [{ ErrorEquals: ["States.ALL"], Next: "Failed" }],
          },
          Ready: {
            Type: "Choice",
            Choices: [
              {
                Variable: "$.stack.Stacks[0].StackStatus",
                StringEquals: "CREATE_COMPLETE",
                Next: "Provisioned",
              },
              {
                Variable: "$.stack.Stacks[0].StackStatus",
                StringMatches: "*FAILED*",
                Next: "Failed",
              },
              {
                Variable: "$.stack.Stacks[0].StackStatus",
                StringMatches: "*ROLLBACK*",
                Next: "Failed",
              },
            ],
            Default: "Wait",
          },
          Provisioned: { Type: "Succeed" },
          Failed: {
            Type: "Fail",
            Error: "DeploymentFailed",
            Cause: "Infrastructure provisioning did not complete",
          },
        },
      },
    });
    const apiRole = new iam.Role(this, "ApiRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    control.grantReadWriteData(apiRole);
    agentControl.grantReadWriteData(apiRole);
    runtime.grantReadWriteData(apiRole);
    artifacts.grantReadWrite(apiRole);
    queue.grantSendMessages(apiRole);
    analysisQueue.grantConsumeMessages(apiRole);
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/${modelId}`,
        ],
      }),
    );
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["states:StartExecution"],
        resources: [workflow.attrArn],
      }),
    );
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["states:DescribeExecution"],
        resources: [
          `arn:aws:states:${this.region}:${this.account}:execution:${prefix}-deployment:*`,
        ],
      }),
    );
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudformation:DescribeStacks",
          "cloudformation:DeleteStack",
        ],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${prefix}-agent-*/*`,
        ],
      }),
    );
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [provisioner.roleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "cloudformation.amazonaws.com",
          },
        },
      }),
    );
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:DescribeServices",
          "ecs:UpdateService",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
        ],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    agentLog.grant(apiRole, "logs:FilterLogEvents");
    apiRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:GetMetricStatistics"],
        resources: ["*"],
      }),
    );
    const apiTask = new ecs.FargateTaskDefinition(this, "ApiTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: apiRole,
    });
    const originSecret = new secrets.Secret(this, "OriginSecret", {
      encryptionKey: key,
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      dropInvalidHeaderFields: true,
    });
    alb.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      "CloudFront VPC origin ENIs",
    );
    const listener = alb.addListener("HTTP", {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        messageBody: "Use the KRONO distribution",
      }),
    });
    const cert = props.cloudFrontCertificateArn
      ? acm.Certificate.fromCertificateArn(
          this,
          "Certificate",
          props.cloudFrontCertificateArn,
        )
      : undefined;
    const apiOrigin = origins.VpcOrigin.withApplicationLoadBalancer(alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      customHeaders: {
        "x-krono-origin": originSecret.secretValue.unsafeUnwrap(),
      },
      readTimeout: Duration.seconds(120),
    });
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate: cert,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontend),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "/platform/*": {
          origin: apiOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        },
      },
    });
    const apiContainer = apiTask.addContainer("api", {
      image: ecs.ContainerImage.fromEcrRepository(
        apiRepo,
        props.apiImageDigest || "bootstrap",
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "api",
        logGroup: new logs.LogGroup(this, "ApiLog", {
          logGroupName: `/${prefix}/api`,
          retention: logs.RetentionDays.ONE_MONTH,
          encryptionKey: key,
          removalPolicy: retention,
        }),
      }),
      readonlyRootFilesystem: true,
      user: "10001",
      environment: {
        KRONO_HOST: "0.0.0.0",
        KRONO_PORT: "8790",
        NODE_ENV: "production",
        AWS_REGION: this.region,
        KRONO_ENV: props.stage,
        KRONO_PUBLIC_ORIGIN: props.domainName
          ? `https://${props.domainName}`
          : `https://${distribution.distributionDomainName}`,
        COGNITO_USER_POOL_ID: pool.userPoolId,
        COGNITO_CLIENT_ID: client.userPoolClientId,
        KRONO_CONTROL_TABLE: control.tableName,
        KRONO_AGENT_CONTROL_TABLE: agentControl.tableName,
        KRONO_RUNTIME_TABLE: runtime.tableName,
        KRONO_ARTIFACT_BUCKET: artifacts.bucketName,
        KRONO_CLUSTER_ARN: cluster.clusterArn,
        KRONO_DEPLOYMENT_WORKFLOW_ARN: workflow.attrArn,
        KRONO_PROVISIONER_ROLE_ARN: provisioner.roleArn,
        KRONO_TASK_EXECUTION_ROLE_ARN: taskExecution.roleArn,
        KRONO_AGENT_BOUNDARY_ARN: boundary.managedPolicyArn,
        KRONO_AGENT_IMAGE: `${agentRepo.repositoryUri}@${props.agentImageDigest || "sha256:" + "0".repeat(64)}`,
        KRONO_PRIVATE_SUBNETS: vpc.privateSubnets
          .map((s) => s.subnetId)
          .join(","),
        KRONO_AGENT_SECURITY_GROUP: agentSg.securityGroupId,
        KRONO_RUNTIME_KMS_ARN: key.keyArn,
        KRONO_AGENT_LOG_GROUP: agentLog.logGroupName,
        KRONO_COORDINATION_QUEUE_URL: queue.queueUrl,
        KRONO_ANALYSIS_QUEUE_URL: analysisQueue.queueUrl,
        BEDROCK_MODEL_ID: modelId,
        ...props.runtimeSettings,
      },
    });
    apiContainer.addPortMappings({ containerPort: 8790 });
    apiContainer.addEnvironment(
      "KRONO_IMAGE_CONFIGURED",
      props.agentImageDigest ? "true" : "false",
    );
    const service = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: apiTask,
      desiredCount: props.apiImageDigest ? (production ? 2 : 1) : 0,
      securityGroups: [apiSg],
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: production ? 100 : 0,
      healthCheckGracePeriod: Duration.seconds(60),
      enableECSManagedTags: true,
    });
    listener.addTargets("ApiTarget", {
      port: 8790,
      protocol: elbv2.ApplicationProtocol.HTTP,
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.httpHeader("x-krono-origin", [
          originSecret.secretValue.unsafeUnwrap(),
        ]),
      ],
      targets: [service],
      healthCheck: {
        path: "/platform/health",
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
      },
    });
    const webAcl = new waf.CfnWebACL(this, "WAF", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: prefix,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "RateLimit",
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 50000, aggregateKeyType: "IP" },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${prefix}-rate`,
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "Common",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${prefix}-common`,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new waf.CfnWebACLAssociation(this, "WafAssociation", {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });
    const lambdaCode = () => lambda.Code.fromAsset("infra/dist");
    const janitor = new lambda.Function(this, "RuntimeJanitor", {
      reservedConcurrentExecutions: 1,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "janitor.handler",
      code: lambdaCode(),
      timeout: Duration.seconds(120),
      memorySize: 256,
      environment: {
        CLUSTER: cluster.clusterArn,
        RUNTIME_TABLE: runtime.tableName,
      },
      logGroup: new logs.LogGroup(this, "JanitorLog", {
        logGroupName: `/${prefix}/janitor`,
        retention: logs.RetentionDays.ONE_MONTH,
        encryptionKey: key,
        removalPolicy: retention,
      }),
    });
    runtime.grantReadData(janitor);
    janitor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:ListServices",
          "ecs:DescribeServices",
          "ecs:UpdateService",
        ],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    new events.Rule(this, "BudgetSweep", {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(janitor)],
    });
    const broker = new lambda.Function(this, "CoordinationBroker", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "broker.handler",
      code: lambdaCode(),
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        CONTROL_TABLE: control.tableName,
        AGENT_CONTROL_TABLE: agentControl.tableName,
        RUNTIME_TABLE: runtime.tableName,
      },
      logGroup: new logs.LogGroup(this, "BrokerLog", {
        logGroupName: `/${prefix}/broker`,
        retention: logs.RetentionDays.ONE_MONTH,
        encryptionKey: key,
        removalPolicy: retention,
      }),
    });
    control.grantReadData(broker);
    agentControl.grantReadData(broker);
    runtime.grantReadWriteData(broker);
    broker.addEventSource(
      new eventSources.SqsEventSource(queue, {
        batchSize: 5,
        reportBatchItemFailures: true,
        maxConcurrency: 2,
      }),
    );
    const dashboard = new cw.Dashboard(this, "Monitoring", {
      dashboardName: prefix,
    });
    dashboard.addWidgets(
      new cw.GraphWidget({
        title: "API load and failures",
        left: [
          alb.metrics.requestCount(),
          alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT),
        ],
      }),
      new cw.GraphWidget({
        title: "Agent messages and dead letters",
        left: [
          queue.metricApproximateNumberOfMessagesVisible(),
          dlq.metricApproximateNumberOfMessagesVisible(),
        ],
      }),
      new cw.GraphWidget({
        title: "Runtime budget enforcement",
        left: [janitor.metricErrors(), broker.metricErrors()],
      }),
    );
    for (const [name, metric] of [
      ["JanitorFailure", janitor.metricErrors()],
      ["CoordinationFailure", dlq.metricApproximateNumberOfMessagesVisible()],
    ] as const)
      new cw.Alarm(this, name, {
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
    if (props.budgetUsd && props.budgetEmail)
      new budgets.CfnBudget(this, "Budget", {
        budget: {
          budgetName: prefix,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: props.budgetUsd, unit: "USD" },
          costFilters: { TagKeyValue: [`user:Project$KRONO`] },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "ACTUAL",
              threshold: 80,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [
              { address: props.budgetEmail, subscriptionType: "EMAIL" },
            ],
          },
        ],
      });
    if (props.domainName && props.hostedZoneId) {
      if (!props.hostedZoneName)
        throw Error("Provide KRONO_HOSTED_ZONE_NAME for the existing DNS zone");
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });
      new route53.ARecord(this, "Alias", {
        zone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(
          new routeTargets.CloudFrontTarget(distribution),
        ),
      });
    }
    for (const [name, value] of Object.entries({
      DistributionId: distribution.distributionId,
      FrontendUrl: props.domainName
        ? `https://${props.domainName}`
        : `https://${distribution.distributionDomainName}`,
      FrontendBucket: frontend.bucketName,
      ApiRepository: apiRepo.repositoryUri,
      AgentRepository: agentRepo.repositoryUri,
      UserPoolId: pool.userPoolId,
      UserPoolClientId: client.userPoolClientId,
      ControlTable: control.tableName,
      RuntimeTable: runtime.tableName,
      AgentControlTable: agentControl.tableName,
      Cluster: cluster.clusterArn,
      ApiService: service.serviceName,
      DeploymentWorkflow: workflow.attrArn,
    }))
      new CfnOutput(this, `Output${name}`, { value }).overrideLogicalId(name);
  }
}
