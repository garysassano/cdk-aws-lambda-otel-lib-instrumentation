import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import { Schedule, ScheduleExpression } from "@aws-cdk/aws-scheduler-alpha";
import { LambdaInvoke } from "@aws-cdk/aws-scheduler-targets-alpha";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import {
  EndpointType,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  FunctionUrlAuthType,
  LoggingFormat,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  FilterPattern,
  LogGroup,
  RetentionDays,
  SubscriptionFilter,
} from "aws-cdk-lib/aws-logs";
import { LambdaDestination } from "aws-cdk-lib/aws-logs-destinations";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { RustFunction } from "cargo-lambda-cdk";
import { Construct } from "constructs";
import { join } from "path";
import { validateEnv } from "../utils/validate-env";

// Constants
const OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
const OTEL_EXPORTER_OTLP_COMPRESSION = "gzip";
const COLLECTORS_SECRETS_KEY_PREFIX = "lambda-otlp-forwarder/keys/";

// Required environment variables
const { OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS } = validateEnv(
  ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"],
);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // SECRETS MANAGER
    //==============================================================================

    new Secret(this, "VendorSecret", {
      secretName: `${COLLECTORS_SECRETS_KEY_PREFIX}vendor`,
      description: "Vendor API key for OTLP forwarder",
      secretStringValue: SecretValue.unsafePlainText(
        JSON.stringify({
          name: "vendor",
          endpoint: OTEL_EXPORTER_OTLP_ENDPOINT,
          auth: OTEL_EXPORTER_OTLP_HEADERS,
        }),
      ),
    });

    //==============================================================================
    // DYNAMODB
    //==============================================================================

    const quotesTable = new TableV2(this, "QuotesTable", {
      tableName: "quotes-table",
      partitionKey: { name: "pk", type: AttributeType.STRING },
      timeToLiveAttribute: "expiry",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //==============================================================================
    // API GATEWAY
    //==============================================================================

    const backendApi = new RestApi(this, "BackendApi", {
      restApiName: "backend-api",
      endpointTypes: [EndpointType.REGIONAL],
    });
    backendApi.node.tryRemoveChild("Endpoint");

    //==============================================================================
    // LAMBDA - SERVICE FUNCTIONS
    //==============================================================================

    // Backend Lambda
    const backendLambda = new RustFunction(this, "BackendLambda", {
      functionName: "backend-lambda",
      manifestPath: join(__dirname, "..", "functions/service", "Cargo.toml"),
      binaryName: "backend",
      bundling: { cargoLambdaFlags: ["--quiet"] },
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        RUST_LOG: "info",
        TABLE_NAME: quotesTable.tableName,
        OTEL_SERVICE_NAME: "backend-lambda",
        OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_EXPORTER_OTLP_PROTOCOL,
        OTEL_EXPORTER_OTLP_COMPRESSION,
      },
    });
    quotesTable.grantReadWriteData(backendLambda);

    // Frontend Lambda
    const frontendLambda = new RustFunction(this, "frontendLambda", {
      functionName: "frontend-lambda",
      manifestPath: join(__dirname, "..", "functions/service", "Cargo.toml"),
      binaryName: "frontend",
      bundling: { cargoLambdaFlags: ["--quiet"] },
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        RUST_LOG: "info",
        TARGET_URL: backendApi.url,
        OTEL_SERVICE_NAME: "frontend-lambda",
        OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_EXPORTER_OTLP_PROTOCOL,
        OTEL_EXPORTER_OTLP_COMPRESSION,
      },
    });
    const frontendLambdaUrl = frontendLambda.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    //==============================================================================
    // API GATEWAY INTEGRATIONS
    //==============================================================================

    // {api}/quotes
    const quotesResource = backendApi.root.addResource("quotes");
    quotesResource.addMethod("POST", new LambdaIntegration(backendLambda));
    quotesResource.addMethod("GET", new LambdaIntegration(backendLambda));

    // {api}/quotes/{id}
    const quoteByIdResource = quotesResource.addResource("{id}");
    quoteByIdResource.addMethod("GET", new LambdaIntegration(backendLambda));

    //==============================================================================
    // LAMBDA - CLIENT FUNCTIONS
    //==============================================================================

    // Client Node Lambda
    const clientNodeLambda = new NodejsFunction(this, "ClientNodeLambda", {
      functionName: "client-node-lambda",
      entry: join(__dirname, "..", "functions/client/node", "index.ts"),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        TARGET_URL: `${backendApi.url}quotes`,
        OTEL_SERVICE_NAME: "client-node-lambda",
        OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_EXPORTER_OTLP_PROTOCOL,
        OTEL_EXPORTER_OTLP_COMPRESSION,
      },
    });
    new Schedule(this, "ClientNodeLambdaSchedule", {
      scheduleName: `client-node-lambda-schedule`,
      description: `Trigger ${clientNodeLambda.functionName} every 5 minutes`,
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(clientNodeLambda),
    });

    // Client Python Lambda
    const clientPythonLambda = new PythonFunction(this, "ClientPythonLambda", {
      functionName: "client-python-lambda",
      entry: join(__dirname, "..", "functions/client/python"),
      runtime: Runtime.PYTHON_3_13,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        TARGET_URL: `${backendApi.url}quotes`,
        OTEL_SERVICE_NAME: "client-python-lambda",
        OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_EXPORTER_OTLP_PROTOCOL,
        OTEL_EXPORTER_OTLP_COMPRESSION,
      },
    });
    new Schedule(this, "ClientPythonLambdaSchedule", {
      scheduleName: `client-python-lambda-schedule`,
      description: `Trigger ${clientPythonLambda.functionName} every 5 minutes`,
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(clientPythonLambda),
    });

    // Client Rust Lambda
    const clientRustLambda = new RustFunction(this, "ClientRustLambda", {
      functionName: "client-rust-lambda",
      manifestPath: join(
        __dirname,
        "..",
        "functions/client/rust",
        "Cargo.toml",
      ),
      bundling: { cargoLambdaFlags: ["--quiet"] },
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        RUST_LOG: "info",
        OTEL_SERVICE_NAME: "client-rust-lambda",
        OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_EXPORTER_OTLP_PROTOCOL,
        OTEL_EXPORTER_OTLP_COMPRESSION,
      },
    });
    const clientRustLambdaUrl = clientRustLambda.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    //==============================================================================
    // LAMBDA - OTLP FORWARDER
    //==============================================================================

    // Forwarder Lambda
    const forwarderLambda = new RustFunction(this, "ForwarderLambda", {
      functionName: "forwarder-lambda",
      description: `Processes logs from AWS Account ${this.account}`,
      manifestPath: join(__dirname, "..", "functions/forwarder", "Cargo.toml"),
      binaryName: "log_processor",
      bundling: { cargoLambdaFlags: ["--quiet"] },
      architecture: Architecture.ARM_64,
      memorySize: 128,
      loggingFormat: LoggingFormat.JSON,
      environment: {
        RUST_LOG: "info",
        COLLECTORS_SECRETS_KEY_PREFIX,
        COLLECTORS_CACHE_TTL_SECONDS: "300",
        OTEL_SERVICE_NAME: "forwarder-lambda",
        OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_EXPORTER_OTLP_HEADERS,
        OTEL_EXPORTER_OTLP_PROTOCOL,
      },
    });
    forwarderLambda.grantInvoke(new ServicePrincipal("logs.amazonaws.com"));
    forwarderLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:BatchGetSecretValue",
          "secretsmanager:ListSecrets",
        ],
        resources: ["*"],
      }),
    );

    //==============================================================================
    // CLOUDWATCH LOGS
    //==============================================================================

    // Define the lambdas and their configurations
    const lambdaConfigs = [
      { lambda: backendLambda, name: "Backend" },
      { lambda: frontendLambda, name: "Frontend" },
      { lambda: clientNodeLambda, name: "ClientNode" },
      { lambda: clientPythonLambda, name: "ClientPython" },
      { lambda: clientRustLambda, name: "ClientRust" },
    ];

    // Create forwarder subscription for each lambda
    lambdaConfigs.forEach(({ lambda, name }) => {
      const logGroup = new LogGroup(this, `${name}LambdaLogGroup`, {
        logGroupName: `/aws/lambda/${lambda.functionName}`,
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });

      new SubscriptionFilter(this, `${name}LambdaSubscription`, {
        logGroup,
        destination: new LambdaDestination(forwarderLambda),
        filterPattern: FilterPattern.literal("{ $.__otel_otlp_stdout = * }"),
      });
    });

    //==============================================================================
    // OUTPUTS
    //==============================================================================

    new CfnOutput(this, "QuotesApiUrl", {
      value: `${backendApi.url}quotes`,
    });

    new CfnOutput(this, "FrontendLambdaUrl", {
      value: frontendLambdaUrl.url,
    });

    new CfnOutput(this, "ClientRustLambdaUrl", {
      value: clientRustLambdaUrl.url,
    });
  }
}
