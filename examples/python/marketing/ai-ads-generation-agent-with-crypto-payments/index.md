An AI agent that creates complete advertising campaigns while autonomously paying for premium services using cryptocurrency via the X402 payment protocol.

## Overview

### Sample Details

| Information | Details |
| --- | --- |
| **Agent Architecture** | Single-agent |
| **Native Tools** | image\_reader |
| **Custom Tools** | list\_available\_services, get\_service\_schema, create\_ad\_html, Agentkit\_action\_providers |
| **MCP Servers** | None |
| **Use Case Vertical** | Marketing & Advertising |
| **Complexity** | Advanced |
| **Model Provider** | Amazon Bedrock (Claude Sonnet 4.6) |
| **SDK Used** | Strands Agents SDK + Coinbase AgentKit |

### Architecture

![Ads Agent](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/marketing/ai-ads-generation-agent-with-crypto-payments/images/diagram.png)

The sample demonstrates integration between multiple systems:

-   **Strands AI Framework** → Agent reasoning and tool orchestration
-   **Coinbase AgentKit** → Blockchain wallet and transaction management
-   **X402 Protocol** → HTTP-based micropayment standard for API access
-   **External APIs** → Payment-gated image generation and weather services

### Key Features

-   **Economic Agency**: AI agent manages its own budget and purchases services autonomously
-   **Crypto-Native Payments**: Uses USDC on Base Sepolia testnet for service payments
-   **Multi-Service Integration**: Combines weather data and AI image generation for enhanced campaigns
-   **Complete Campaign Generation**: Produces ready-to-deploy HTML advertising assets

## Prerequisites

-   Python **3.10+**
-   [AWS CLI configured with appropriate credentials](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-quickstart.html)
-   [Model access](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-prereq.html) for Claude Sonnet 4.6 on Amazon Bedrock
-   [Coinbase Developer Platform account](https://docs.cdp.coinbase.com/get-started/quickstart) to get your coinbase API credentials and Wallet secret.
-   [OpenWeather API key](https://openweathermap.org/guide)
-   **⚠️ TESTNET ONLY**: Base Sepolia testnet wallet with test USDC

## Setup

1.  **Configure environment variables:**
    
    ```bash
    cp .env.example .env
    # Edit .env with your configuration:
    # - CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET (Coinbase Developer credentials)
    # - ADDRESS (Receiving Address of payment)
    # - OPENWEATHER_API_KEY
    ```
    
2.  **Install dependencies:**
    
    ```bash
    uv pip install requirements.txt
    ```
    
3.  **Start the payment server:**
    
    ```bash
    uv run paid_server.py
    ```
    

## Usage

**Run the advertising agent:**

**Execute the `agentkit-x402-strands` notebook:**

1.  Open the notebook and run cells sequentially
2.  The agent will automatically:
    -   Discover available services
    -   Make cryptocurrency payments for premium APIs
    -   Generate weather-responsive ad campaigns
    -   Create visual assets using AI image generation
    -   Output complete HTML advertising campaigns

**Example interaction:**

```python
response = advertising_agent("""Generate an ad for:
    product="ice cream shop promotion",
    city="Miami,US",
    platform="social-media"
""")
```

## Example Output

The agent produces:

-   Weather-responsive ad copy based on real-time conditions
-   AI-generated tropical imagery for campaigns stored in `output` dir
-   Complete HTML files with embedded visuals stored in `ad-creative` dir
-   Multi-platform advertising assets (social media, display, email)

## Troubleshooting

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| Payment failures | Insufficient testnet USDC | Fund wallet via Base Sepolia faucet |
| API key errors | Missing environment variables | Verify all required keys in `.env` |
| Image generation fails | Payment server not running | Start `paid_server.py` first |

## Safety Notice

**⚠️ TESTNET ONLY - DO NOT USE REAL FUNDS**

-   This sample uses Base Sepolia testnet exclusively
-   Only use test credentials and testnet tokens
-   Never run with production wallets or mainnet addresses
-   Educational demonstration purposes only

## Cleanup

Stop the payment server:

```bash
# Press Ctrl+C to stop paid_server.py
```

No additional infrastructure cleanup required.

---

## Disclaimer

This sample is provided for educational and demonstration purposes only. It is not intended for production use without further development, testing, and hardening.

For production deployments, consider:

-   Implementing appropriate content filtering and safety measures
-   Following security best practices for cryptocurrency handling
-   Conducting thorough testing on testnets before any mainnet deployment
-   Reviewing and adjusting payment amounts and security configurations
-   Implementing proper wallet management and key security practices

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/marketing/ai-ads-generation-agent-with-crypto-payments)
