import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as discovery from "aws-cdk-lib/aws-servicediscovery";
import type { Construct } from "constructs";

interface ProductOptions {
  prefix: string;
  namespace: string;
  production: boolean;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  gateway: ec2.ISecurityGroup;
  encryption: kms.IKey;
  repository: ecr.IRepository;
  imageDigest: string;
  credentialKeyArn?: string;
}

const productPort = 8794;
const databaseName = "krono";

export function createProductServices(scope: Construct, options: ProductOptions) {
  const {
    vpc, cluster, production, prefix, encryption, gateway, repository, imageDigest,
  } = options;
  const apiSg = new ec2.SecurityGroup(scope, "ProductApiSecurity", {
    vpc,
    allowAllOutbound: false,
  });
  const workerSg = new ec2.SecurityGroup(scope, "PaperWorkerSecurity", {
    vpc,
    allowAllOutbound: false,
  });
  const databaseSg = new ec2.SecurityGroup(scope, "ProductDatabaseSecurity", {
    vpc,
    allowAllOutbound: false,
  });
  gateway.connections.allowTo(apiSg, ec2.Port.tcp(productPort), "Private product API");
  for (const group of [apiSg, workerSg]) {
    group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Providers and AWS HTTPS APIs");
    group.connections.allowTo(databaseSg, ec2.Port.tcp(5432), "Product PostgreSQL");
  }

  const database = new rds.DatabaseCluster(scope, "ProductDatabase", {
    engine: rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_17_6,
    }),
    writer: rds.ClusterInstance.serverlessV2("Writer", { publiclyAccessible: false }),
    readers: production
      ? [rds.ClusterInstance.serverlessV2("Reader", {
          publiclyAccessible: false,
          scaleWithWriter: true,
        })]
      : [],
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    securityGroups: [databaseSg],
    defaultDatabaseName: databaseName,
    credentials: rds.Credentials.fromGeneratedSecret("krono", {
      encryptionKey: encryption,
    }),
    parameters: { "rds.force_ssl": "1" },
    serverlessV2MinCapacity: 0.5,
    serverlessV2MaxCapacity: 4,
    storageEncrypted: true,
    storageEncryptionKey: encryption,
    backup: { retention: Duration.days(7) },
    deletionProtection: production,
    removalPolicy: RemovalPolicy.SNAPSHOT,
  });
  const signingKey = new secrets.Secret(scope, "ProductSigningKey", {
    encryptionKey: encryption,
    generateSecretString: { passwordLength: 64, excludePunctuation: true },
  });
  const credentialKey = options.credentialKeyArn
    ? secrets.Secret.fromSecretCompleteArn(scope, "ExchangeCredentialKey", options.credentialKeyArn)
    : undefined;
  const exchangeSecrets = credentialKey
    ? { KRONO_CREDENTIAL_KEY: ecs.Secret.fromSecretsManager(credentialKey) }
    : {};
  const databaseSecrets = {
    KRONO_DATABASE_USER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
    KRONO_DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
  };
  const databaseEnv = {
    KRONO_DATABASE_HOST: database.clusterEndpoint.hostname,
    KRONO_DATABASE_PORT: String(database.clusterEndpoint.port),
    KRONO_DATABASE_NAME: databaseName,
    KRONO_DATABASE_SSLROOTCERT: "/etc/ssl/certs/rds-global-bundle.pem",
  };
  const dispatch = (id: string) =>
    new ecs.FargateTaskDefinition(scope, id, { cpu: 512, memoryLimitMiB: 1024 });
  const image = ecs.ContainerImage.fromEcrRepository(repository, imageDigest);
  const logging = ecs.LogDrivers.awsLogs({
    streamPrefix: "product",
    logGroup: new logs.LogGroup(scope, "ProductLogs", {
      logGroupName: `/${prefix}/product`,
      encryptionKey: encryption,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    }),
  });
  const container = { image, logging, readonlyRootFilesystem: true, user: "10001:10001" };
  const apiTask = dispatch("ProductApiTask");
  const migration = apiTask.addContainer("migrate", {
    ...container,
    essential: false,
    command: ["python", "-m", "scripts.platform_database"],
    environment: databaseEnv,
    secrets: databaseSecrets,
  });
  const api = apiTask.addContainer("product-api", {
    ...container,
    environment: databaseEnv,
    secrets: {
      ...databaseSecrets,
      ...exchangeSecrets,
      KRONO_PRODUCT_API_KEY: ecs.Secret.fromSecretsManager(signingKey),
    },
    healthCheck: {
      command: [
        "CMD", "python", "-c",
        "from urllib.request import urlopen; urlopen('http://127.0.0.1:8794/healthz', timeout=4).close()",
      ],
      interval: Duration.seconds(15),
      timeout: Duration.seconds(6),
      retries: 4,
      startPeriod: Duration.seconds(60),
    },
  });
  api.addPortMappings({ containerPort: productPort });
  api.addContainerDependencies({ container: migration, condition: ecs.ContainerDependencyCondition.SUCCESS });
  const namespace = new discovery.PrivateDnsNamespace(scope, "ProductNamespace", {
    name: options.namespace,
    vpc,
  });
  const service = {
    cluster,
    assignPublicIp: false,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    circuitBreaker: { rollback: true },
    enableECSManagedTags: true,
  };
  const apiService = new ecs.FargateService(scope, "ProductApiService", {
    ...service,
    taskDefinition: apiTask,
    desiredCount: production ? 2 : 1,
    minHealthyPercent: 100,
    securityGroups: [apiSg],
    cloudMapOptions: { cloudMapNamespace: namespace, name: "product", dnsTtl: Duration.seconds(10) },
  });

  const workerTask = dispatch("PaperWorkerTask");
  workerTask.addContainer("paper-worker", {
    ...container,
    command: ["python", "-m", "backend.product.worker"],
    environment: databaseEnv,
    secrets: { ...databaseSecrets, ...exchangeSecrets },
    healthCheck: {
      command: ["CMD", "python", "-m", "backend.product.worker", "--health"],
      interval: Duration.seconds(15),
      timeout: Duration.seconds(8),
      retries: 4,
      startPeriod: Duration.seconds(60),
    },
  });
  const workerService = new ecs.FargateService(scope, "PaperWorkerService", {
    ...service,
    taskDefinition: workerTask,
    desiredCount: 1,
    minHealthyPercent: 0,
    maxHealthyPercent: 100,
    securityGroups: [workerSg],
  });
  workerService.node.addDependency(apiService);
  return { apiService, workerService, signingKey, url: `http://product.${namespace.namespaceName}:${productPort}` };
}
