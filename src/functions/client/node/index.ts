import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  trace,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  propagation,
  Exception,
  Tracer,
} from "@opentelemetry/api";
import { StdoutOTLPExporterNode } from "@dev7a/otlp-stdout-exporter";
import { AwsLambdaDetectorSync } from "@opentelemetry/resource-detector-aws";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { Context as LambdaContext } from "aws-lambda";
import { ScheduledEvent } from "aws-lambda";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

// Constants
const QUOTES_URL = "https://dummyjson.com/quotes/random";
const TARGET_URL = process.env.TARGET_URL;

// Types
interface Quote {
  id: number;
  quote: string;
  author: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

// Add a type guard to validate Quote object
function isQuote(obj: any): obj is Quote {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof obj.id === "number" &&
    typeof obj.quote === "string" &&
    typeof obj.author === "string"
  );
}

let isFirstInvocation = true;

/**
 * Creates and configures the OpenTelemetry TracerProvider
 * @returns Configured NodeTracerProvider
 */
function createProvider(): NodeTracerProvider {
  // Detect AWS Lambda resources synchronously
  const awsResource = new AwsLambdaDetectorSync().detect();

  // Create a resource merging AWS detection with service name
  const resource = new Resource({
    [ATTR_SERVICE_NAME]:
      process.env.AWS_LAMBDA_FUNCTION_NAME || "quotes-function",
  }).merge(awsResource);

  // Initialize provider with resource
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(
        new StdoutOTLPExporterNode({
          timeoutMillis: 5000,
          compression: CompressionAlgorithm.GZIP,
        }),
      ),
    ],
  });

  return provider;
}

// Initialize OpenTelemetry
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
const provider = createProvider();
provider.register();

registerInstrumentations({
  instrumentations: [new UndiciInstrumentation()],
});

const tracer: Tracer = trace.getTracer("quotes-function");

/**
 * Fetches a random quote from the quotes API
 * @returns Promise<Quote>
 */
async function getRandomQuote(): Promise<Quote> {
  const parentContext = otelContext.active();
  const span = tracer.startSpan(
    "get_random_quote",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.url": QUOTES_URL,
        "http.method": "GET",
      },
    },
    parentContext,
  );

  return await otelContext.with(
    trace.setSpan(parentContext, span),
    async () => {
      try {
        const response = await fetch(QUOTES_URL);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        // Validate the response data
        if (!isQuote(data)) {
          throw new Error("Invalid quote data received");
        }

        // Add success attributes to span
        span.setAttribute("http.status_code", response.status);
        return data;
      } catch (error) {
        span.recordException(error as Exception);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Saves a quote to the target service
 * @param quote Quote object to save
 * @returns Promise with the save response
 */
async function saveQuote(quote: Quote): Promise<any> {
  const parentContext = otelContext.active();
  const span = tracer.startSpan(
    "save_quote",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.url": TARGET_URL,
        "http.method": "POST",
      },
    },
    parentContext,
  );

  return await otelContext.with(
    trace.setSpan(parentContext, span),
    async () => {
      try {
        if (!TARGET_URL) {
          throw new Error("TARGET_URL environment variable is not set");
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        // Inject trace context into headers
        propagation.inject(otelContext.active(), headers);

        const response = await fetch(TARGET_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(quote),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        span.setAttribute("http.status_code", response.status);
        return await response.json();
      } catch (error) {
        span.recordException(error as Exception);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Lambda handler function for scheduled events
 */
export const handler = async (
  event: ScheduledEvent,
  lambdaContext: LambdaContext,
): Promise<LambdaResponse> => {
  const parentSpan = tracer.startSpan("lambda_handler", {
    kind: SpanKind.SERVER,
    attributes: {
      "aws.lambda.invoked_arn": lambdaContext.invokedFunctionArn,
      "aws.log.group.names": [lambdaContext.logGroupName],
      "cloud.account.id": event.account,
      "cloud.platform": "aws_lambda",
      "cloud.provider": "aws",
      "cloud.region": event.region,
      "cloud.resource_id": `arn:aws:lambda:${event.region}:${event.account}:function:${lambdaContext.functionName}`,
      "faas.coldstart": isFirstInvocation,
      "faas.instance": lambdaContext.logStreamName,
      "faas.invocation_id": lambdaContext.awsRequestId,
      "faas.max_memory": parseInt(lambdaContext.memoryLimitInMB) * 1024 * 1024,
      "faas.name": lambdaContext.functionName,
      "faas.time": new Date().toISOString(),
      "faas.trigger": "timer",
      "faas.version": lambdaContext.functionVersion,
    },
  });

  isFirstInvocation = false;

  return await otelContext.with(
    trace.setSpan(otelContext.active(), parentSpan),
    async () => {
      try {
        // Log scheduled event details
        parentSpan.addEvent("Scheduled Lambda Invocation Started", {
          schedule_time: event.account,
          schedule_region: event.region,
        });

        // Log lambda invocation
        parentSpan.addEvent("Lambda Invocation Started");

        // Get and save quote
        const quote = await getRandomQuote();

        parentSpan.addEvent("Quote Fetched", {
          quote_text: quote.quote,
          quote_author: quote.author,
          quote_id: quote.id,
        });

        const savedResponse = await saveQuote(quote);
        parentSpan.addEvent("Quote Saved Successfully");

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Quote processed successfully",
            quote,
            savedResponse,
          }),
        };
      } catch (error) {
        parentSpan.recordException(error as Exception);
        parentSpan.setStatus({ code: SpanStatusCode.ERROR });

        return {
          statusCode: 500,
          body: JSON.stringify({
            message: "Error processing quote",
            error: (error as Error).message,
          }),
        };
      } finally {
        parentSpan.end();
        // Ensure all spans are exported before Lambda freezes
        await provider.forceFlush();
      }
    },
  );
};
