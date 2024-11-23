# cdk-aws-lambda-otel-code-instrumentation

CDK app that demonstrates OpenTelemetry [code-based instrumentation](https://opentelemetry.io/docs/concepts/instrumentation/code-based/) in AWS Lambda using several runtimes. Includes a forwarder that sends telemetry data via OTLP to any OTel-compatible vendor.

This project reimplements [serverless-otlp-forwarder](https://github.com/dev7a/serverless-otlp-forwarder) (originally built with AWS SAM) using AWS CDK with some tweaks.

## Application Diagram

![Application Diagram](./src/assets/app-diagram.svg)
