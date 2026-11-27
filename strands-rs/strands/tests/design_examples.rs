//! The tools of the design's developer experience examples ("Agent, tool and streaming" and
//! "Tools with state"), checked without an agent: their specs and results. The examples
//! themselves, with the agent, are the doctests in `strands::agent`.

#![allow(clippy::unwrap_used, reason = "test helpers report failures by panicking")]

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use futures::StreamExt;
use serde_json::json;
use strands::testing::tool_context;
use strands::tools::{ToolRegistry, ToolStreamItem};
use strands::{Tool, ToolContext, ToolOutcome, ToolSource, ToolUse, tool, tools};

/// Get the current weather for a city.
#[tool]
async fn get_weather(
    /// City name, for example "Seattle".
    city: String,
) -> Result<String, strands::ToolError> {
    Ok(format!("Sunny in {city}"))
}

#[derive(Debug)]
struct PoolError;

impl fmt::Display for PoolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("unknown sku")
    }
}

impl std::error::Error for PoolError {}

struct Pool {
    stock: HashMap<String, u32>,
}

impl Pool {
    async fn stock(&self, sku: &str) -> Result<u32, PoolError> {
        self.stock.get(sku).copied().ok_or(PoolError)
    }
}

struct Inventory {
    db: Pool,
}

#[tools]
impl Inventory {
    /// Look up stock for a product.
    #[tool]
    async fn check_stock(&self, #[tool(context)] ctx: &ToolContext, sku: String) -> Result<u32, strands::ToolError> {
        let _ = ctx.agent().app_state().get::<String>("region");
        Ok(self.db.stock(&sku).await?)
    }
}

async fn run(tool: &dyn Tool, input: serde_json::Value) -> serde_json::Value {
    let mut stream = tool.stream(tool_context(ToolUse::new(tool.name(), "t-1", input)));
    while let Some(item) = stream.next().await {
        if let ToolStreamItem::Outcome(ToolOutcome::Result(result)) = item {
            return serde_json::to_value(result).unwrap();
        }
    }
    serde_json::Value::Null
}

#[tokio::test]
async fn agent_tool_and_streaming_example_tool() {
    assert_eq!(
        serde_json::to_value(GetWeather.tool_spec()).unwrap(),
        json!({
            "name": "get_weather",
            "description": "Get the current weather for a city.",
            "inputSchema": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "City name, for example \"Seattle\"."}},
                "required": ["city"],
                "additionalProperties": false
            }
        })
    );
    let mut registry = ToolRegistry::new();
    registry.add(vec![GetWeather]).unwrap();
    assert_eq!(registry.list().len(), 1);
    assert_eq!(
        run(&GetWeather, json!({"city": "Seattle"})).await,
        json!({"toolUseId": "t-1", "status": "success", "content": [{"text": "Sunny in Seattle"}]})
    );
}

#[tokio::test]
async fn tools_with_state_example_tools() {
    let db = Pool {
        stock: HashMap::from([("sku-1".to_owned(), 7)]),
    };
    let inventory = Arc::new(Inventory { db });
    let tools: Vec<ToolSource> = inventory.tools();
    let tools: Vec<Arc<dyn Tool>> = tools.into_iter().flat_map(ToolSource::into_tools).collect();
    assert_eq!(tools.len(), 1);
    let check_stock = &tools[0];
    assert_eq!(
        check_stock.tool_spec().input_schema.unwrap(),
        json!({
            "type": "object",
            "properties": {"sku": {"type": "string"}},
            "required": ["sku"],
            "additionalProperties": false
        })
    );
    assert_eq!(
        run(check_stock.as_ref(), json!({"sku": "sku-1"})).await,
        json!({"toolUseId": "t-1", "status": "success", "content": [{"text": "7"}]})
    );
    assert_eq!(
        run(check_stock.as_ref(), json!({"sku": "sku-2"})).await,
        json!({"toolUseId": "t-1", "status": "error", "content": [{"text": "Error: unknown sku"}]})
    );
}
