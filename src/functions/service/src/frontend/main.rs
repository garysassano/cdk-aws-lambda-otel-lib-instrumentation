use aws_lambda_events::apigw::ApiGatewayV2httpRequest;
use chrono::{DateTime, Duration, FixedOffset, Utc};
use lambda_lw_http_router::{define_router, route};
use lambda_otel_utils::{
    HttpTracerProviderBuilder, OpenTelemetryFaasTrigger, OpenTelemetryLayer,
    OpenTelemetrySubscriberBuilder,
};
use lambda_runtime::{service_fn, Error as LambdaError, LambdaEvent, Runtime};
use reqwest::Client;
use reqwest_middleware::ClientBuilder;
use reqwest_middleware::ClientWithMiddleware;
use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::sync::Arc;
use tera::{Context as TeraContext, Tera};
use tracing::instrument;

mod reqwest_propagation;
use reqwest_propagation::OtelPropagationMiddleware;

// Embed the quotes.html template at compile time
const QUOTES_TEMPLATE: &str = include_str!("templates/quotes.html");

#[derive(Clone)]
struct AppState {
    http_client: ClientWithMiddleware,
    base_context: TeraContext,
    target_url: String,
    templates: Tera,
}
define_router!(event = ApiGatewayV2httpRequest, state = AppState);

fn format_relative_time(timestamp: &str) -> String {
    let timestamp = DateTime::parse_from_rfc3339(timestamp)
        .unwrap_or_else(|_| DateTime::parse_from_rfc3339("1970-01-01T00:00:00Z").unwrap());
    let now = Utc::now();
    let duration = now.signed_duration_since(timestamp.with_timezone(&Utc));

    if duration.num_minutes() < 60 {
        format!("{} minutes ago", duration.num_minutes())
    } else if duration.num_hours() < 24 {
        format!("{} hours ago", duration.num_hours())
    } else {
        format!("{} days ago", duration.num_days())
    }
}

#[instrument(skip_all)]
async fn get_all_quotes(
    client: &ClientWithMiddleware,
    target_url: &str,
) -> Result<Value, LambdaError> {
    let target_url = format!("{}/quotes", target_url);

    let request = client
        .get(target_url.as_str())
        .build()
        .map_err(|e| LambdaError::from(format!("Failed to create request: {}", e)))?;

    let response = client
        .execute(request)
        .await
        .map_err(|e| LambdaError::from(format!("Failed to execute request: {}", e)))?;

    // Handle non-success status codes
    if !response.status().is_success() {
        let status = response.status();
        let error_body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read error body".to_string());

        return Err(LambdaError::from(format!(
            "HTTP error {}: {}",
            status, error_body
        )));
    }

    let response_body = response
        .json::<Value>()
        .await
        .map_err(|e| LambdaError::from(format!("Failed to parse response as JSON: {}", e)))?;

    Ok(response_body)
}

#[derive(Debug)]
enum QuoteError {
    NotFound(String),
    BackendError(u16, String),
    RequestError(String),
}

impl From<QuoteError> for LambdaError {
    fn from(error: QuoteError) -> Self {
        LambdaError::from(format!("{:?}", error))
    }
}

#[instrument(skip_all)]
async fn get_quote(
    client: &ClientWithMiddleware,
    target_url: &str,
    id: &str,
) -> Result<Value, QuoteError> {
    let target_url = format!("{}/quotes/{}", target_url, id);

    let request = client
        .get(target_url.as_str())
        .build()
        .map_err(|e| QuoteError::RequestError(format!("Failed to create request: {}", e)))?;

    let response = client
        .execute(request)
        .await
        .map_err(|e| QuoteError::RequestError(format!("Failed to execute request: {}", e)))?;

    match response.status() {
        status if status.is_success() => response.json::<Value>().await.map_err(|e| {
            QuoteError::RequestError(format!("Failed to parse response as JSON: {}", e))
        }),
        reqwest::StatusCode::NOT_FOUND => {
            Err(QuoteError::NotFound(format!("Quote {} not found", id)))
        }
        status => {
            let error_body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unable to read error body".to_string());

            Err(QuoteError::BackendError(status.as_u16(), error_body))
        }
    }
}

#[derive(Debug)]
struct TimeFrame {
    start: Duration,
    end: Duration,
    name: String,
}

impl TimeFrame {
    fn from_param(param: &str) -> Option<Self> {
        let (start, end) = match param {
            "now" => (Duration::zero(), Duration::hours(6)),
            "earlier" => (Duration::hours(6), Duration::hours(24)),
            "yesterday" => (Duration::hours(24), Duration::hours(48)),
            _ => return None,
        };

        Some(Self {
            start,
            end,
            name: param.to_string(),
        })
    }

    fn is_quote_in_range(&self, quote_time: DateTime<FixedOffset>) -> bool {
        let age = Utc::now().signed_duration_since(quote_time);
        age >= self.start && age < self.end
    }
}

#[derive(Debug, Serialize)]
struct ProcessedQuote {
    #[serde(flatten)]
    quote: Value,
    relative_time: String,
}

impl ProcessedQuote {
    fn from_value(mut quote: Value) -> Option<Self> {
        let timestamp = quote.get("timestamp")?.as_str()?;
        let relative_time = format_relative_time(timestamp);
        quote.as_object_mut()?.insert(
            "relative_time".to_string(),
            Value::String(relative_time.clone()),
        );

        Some(Self {
            quote,
            relative_time,
        })
    }

    fn timestamp(&self) -> Option<DateTime<FixedOffset>> {
        self.quote
            .get("timestamp")?
            .as_str()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
    }
}

#[route(method = "GET", path = "/")]
async fn handle_root_redirect(_rctx: RouteContext) -> Result<Value, LambdaError> {
    // Return a 301 permanent redirect to /now
    Ok(json!({
        "statusCode": 301,
        "headers": {
            "Location": "/now",
            "Content-Type": "text/html"
        },
        "body": "<!DOCTYPE html><html><head><meta http-equiv=\"refresh\" content=\"0;url=/now\"></head><body>Redirecting to <a href=\"/now\">/now</a>...</body></html>"
    }))
}

#[route(method = "GET", path = "/{timeframe}")]
async fn hande_home(rctx: RouteContext) -> Result<Value, LambdaError> {
    // Parse and validate timeframe
    let timeframe = match rctx
        .params
        .get("timeframe")
        .and_then(|f| TimeFrame::from_param(f))
    {
        Some(frame) => {
            rctx.set_otel_attribute("resource.query.time.frame", frame.name.clone());
            frame
        }
        None => {
            return Ok(json!({
                "statusCode": 404,
                "headers": {"Content-Type": "text/plain"},
                "body": "Invalid time frame"
            }));
        }
    };

    // Fetch and process quotes
    let quotes = get_and_process_quotes(&rctx, &timeframe).await?;

    // Render template
    let mut tera_ctx = rctx.state.base_context.clone();
    tera_ctx.insert("quotes", &quotes);
    tera_ctx.insert("timeframe", &timeframe.name);

    let html_content = rctx.state.templates.render("quotes.html", &tera_ctx)?;

    Ok(json!({
        "statusCode": 200,
        "headers": {"Content-Type": "text/html"},
        "body": html_content
    }))
}

async fn get_and_process_quotes(
    rctx: &RouteContext,
    timeframe: &TimeFrame,
) -> Result<Vec<ProcessedQuote>, LambdaError> {
    let response = get_all_quotes(&rctx.state.http_client, &rctx.state.target_url).await?;

    let quotes = match response {
        Value::Array(quotes) => quotes,
        _ => return Ok(Vec::new()),
    };

    let mut processed_quotes: Vec<ProcessedQuote> = quotes
        .into_iter()
        .filter_map(|quote| {
            let processed = ProcessedQuote::from_value(quote)?;
            let quote_time = processed.timestamp()?;
            timeframe.is_quote_in_range(quote_time).then_some(processed)
        })
        .collect();

    // Sort quotes by timestamp in descending order (newest first)
    processed_quotes.sort_by(|a, b| match (a.timestamp(), b.timestamp()) {
        (Some(a), Some(b)) => b.cmp(&a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    Ok(processed_quotes)
}

/// Helper function to render the quotes template with common context
fn render_quotes_template(
    templates: &Tera,
    base_ctx: &TeraContext,
    quotes: Vec<Value>,
    error_message: Option<&str>,
) -> Result<String, LambdaError> {
    let mut ctx = base_ctx.clone();
    ctx.insert("quotes", &quotes);
    ctx.insert("single_quote", &true);
    ctx.insert("time", "current");

    if let Some(msg) = error_message {
        ctx.insert("error_message", msg);
    }

    templates
        .render("quotes.html", &ctx)
        .map_err(|e| LambdaError::from(format!("Template rendering error: {}", e)))
}

/// Helper function to create an HTML response with the given status code
fn html_response(status_code: u16, html_content: String) -> Value {
    json!({
        "statusCode": status_code,
        "headers": {"Content-Type": "text/html"},
        "body": html_content
    })
}

#[route(method = "GET", path = "/quote/{id}")]
async fn handle_quote(rctx: RouteContext) -> Result<Value, LambdaError> {
    let quote_id = match rctx.params.get("id") {
        Some(id) if !id.is_empty() => {
            rctx.set_otel_attribute("resource.type", "quote")
                .set_otel_attribute("resource.path.quote_id", id.to_owned());
            id
        }
        _ => {
            let html_content = render_quotes_template(
                &rctx.state.templates,
                &rctx.state.base_context,
                vec![],
                Some("Quote ID not provided"),
            )?;

            return Ok(html_response(404, html_content));
        }
    };

    match get_quote(&rctx.state.http_client, &rctx.state.target_url, quote_id).await {
        Ok(mut quote) => {
            if let Some(timestamp) = quote.get("timestamp").and_then(|t| t.as_str()) {
                let relative_time = format_relative_time(timestamp);
                quote
                    .as_object_mut()
                    .ok_or_else(|| LambdaError::from("Invalid quote format"))?
                    .insert("relative_time".to_string(), Value::String(relative_time));
            }

            let html_content = render_quotes_template(
                &rctx.state.templates,
                &rctx.state.base_context,
                vec![quote],
                None,
            )?;

            Ok(html_response(200, html_content))
        }
        Err(QuoteError::NotFound(msg)) => {
            let html_content = render_quotes_template(
                &rctx.state.templates,
                &rctx.state.base_context,
                vec![],
                Some(&msg),
            )?;

            Ok(html_response(404, html_content))
        }
        Err(QuoteError::BackendError(status, msg)) => {
            let html_content = render_quotes_template(
                &rctx.state.templates,
                &rctx.state.base_context,
                vec![],
                Some(&format!("Backend error: {} - {}", status, msg)),
            )?;

            Ok(html_response(status, html_content))
        }
        Err(QuoteError::RequestError(msg)) => {
            let html_content = render_quotes_template(
                &rctx.state.templates,
                &rctx.state.base_context,
                vec![],
                Some(&format!("Request error: {}", msg)),
            )?;

            Ok(html_response(500, html_content))
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), LambdaError> {
    // Initialize tracer
    let tracer_provider = HttpTracerProviderBuilder::default()
        .with_stdout_client()
        .with_default_text_map_propagator()
        .with_batch_exporter()
        .enable_global(true)
        .build()
        .expect("Failed to build tracer provider");

    // Initialize the OpenTelemetry subscriber
    OpenTelemetrySubscriberBuilder::new()
        .with_env_filter(true)
        .with_tracer_provider(tracer_provider.clone())
        .with_service_name("lambda-otlp-forwarder")
        .init()?;

    let target_url = env::var("TARGET_URL").expect("TARGET_URL must be set");
    // Initialize templates
    let templates = {
        let mut tera = Tera::default();
        tera.add_raw_template("quotes.html", QUOTES_TEMPLATE)
            .expect("Failed to add embedded template");
        tera
    };

    // Initialize application state
    let state = Arc::new(AppState {
        http_client: {
            let reqwest_client = Client::builder()
                .build()
                .expect("Failed to create HTTP client");

            ClientBuilder::new(reqwest_client)
                .with(OtelPropagationMiddleware::new())
                .build()
        },
        base_context: {
            let mut ctx = TeraContext::new();
            ctx.insert("app_name", "Quote Viewer");
            ctx.insert("version", env!("CARGO_PKG_VERSION"));
            ctx
        },
        target_url,
        templates,
    });

    // Initialize router
    let router = Arc::new(RouterBuilder::from_registry().build());

    let lambda = move |event: LambdaEvent<ApiGatewayV2httpRequest>| {
        let state = Arc::clone(&state);
        let router = Arc::clone(&router);
        async move { router.handle_request(event, state).await }
    };

    let runtime = Runtime::new(service_fn(lambda)).layer(
        OpenTelemetryLayer::new(|| {
            tracer_provider.force_flush();
        })
        .with_trigger(OpenTelemetryFaasTrigger::Http),
    );

    runtime.run().await
}