# Provider Example (Express)

This example shows how to add zauthSDK monitoring to an Express server that hosts x402 endpoints using real `@x402/express`.

## Setup

```bash
cd examples/provider-express
cp .env.example .env
# Edit .env with your keys
npm install
```

## Configuration

Required environment variables in `.env`:

- `X402_PRIVATE_KEY` - Your wallet private key for receiving payments
- `ZAUTH_API_KEY` - Your zauthx402 API key from the dashboard

Optional:

- `PORT` - Server port (default: 3002)
- `FACILITATOR_URL` - x402 facilitator (default: https://x402.dexter.cash)
- `ZAUTH_API_ENDPOINT` - zauth API endpoint (default: production)

## Run

```bash
npm start
```

## Endpoints

| Endpoint | Price | Description |
|----------|-------|-------------|
| `GET /api/data` | $0.001 | Returns sample data |
| `POST /api/process` | $0.005 | Processes input data |
| `GET /api/free` | Free | No payment required |
| `GET /health` | Free | Health check |

## Test

```bash
# Get 402 response (no payment)
curl http://localhost:3002/api/data

# Check health
curl http://localhost:3002/health
```

## How It Works

1. The `zauthProvider` middleware is added **before** your x402 middleware
2. It observes all requests and responses without modifying them
3. Events are batched and sent to your zauthx402 dashboard
4. Auto-refunds are triggered for server errors, empty responses, or low-quality data
5. Your existing x402 implementation continues to work unchanged

## Features Demonstrated

- Real x402 V2 integration with `@x402/express`
- PayAI facilitator for payment processing
- zauthSDK monitoring with response validation
- Auto-refunds for bad responses
- Graceful shutdown handling
