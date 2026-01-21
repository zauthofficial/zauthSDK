/**
 * Example: Express Provider with zauthSDK monitoring
 *
 * This shows how to add zauth monitoring to your existing x402 Express server.
 * The SDK is non-invasive - your existing x402 middleware continues to work.
 *
 * Setup:
 *   1. Copy .env.example to .env and fill in your keys
 *   2. npm install
 *   3. npm start
 */

import 'dotenv/config';
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { privateKeyToAccount } from 'viem/accounts';
import { zauthProvider } from '@zauthx402/sdk/middleware';

const app = express();
app.use(express.json());

// ============================================
// Configuration
// ============================================

const PORT = process.env.PORT || 3002;
const X402_PRIVATE_KEY = process.env.X402_PRIVATE_KEY;
const ZAUTH_API_KEY = process.env.ZAUTH_API_KEY;
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://x402.dexter.cash';

if (!X402_PRIVATE_KEY) {
  console.error('Error: X402_PRIVATE_KEY is required in .env');
  process.exit(1);
}

const account = privateKeyToAccount(X402_PRIVATE_KEY as `0x${string}`);
const payTo = account.address;

// ============================================
// Step 1: Add zauth monitoring middleware
// ============================================

// Add BEFORE your x402 middleware
if (ZAUTH_API_KEY) {
  const zauthMiddleware = zauthProvider(ZAUTH_API_KEY, {
    // Point to local server for development, or omit for production
    apiEndpoint: process.env.ZAUTH_API_ENDPOINT || 'http://localhost:3001',

    // Payment amount for analytics (should match your x402 pricing)
    defaultPaymentAmountUsdc: '0.001',

    // Optional: Configure response validation
    validation: {
      requiredFields: ['data', 'success'],
      errorFields: ['error', 'errors'],
    },

    // Optional: Enable auto-refunds (uses same wallet that receives payments)
    refund: {
      enabled: true,
      privateKey: X402_PRIVATE_KEY,
      network: 'base',
      maxRefundUsd: 0.01,
      dailyCapUsd: 1.00,
      triggers: {
        serverError: true,
        emptyResponse: true,
        minMeaningfulness: 0.5,
      },
      onRefund: (refund) => {
        console.log('Refund executed:', {
          amount: `$${refund.amountUsd}`,
          to: refund.recipient,
          tx: refund.txHash,
          reason: refund.reason,
        });
      },
    },

    debug: true,
  });

  app.use(zauthMiddleware);
  console.log('zauthSDK middleware enabled');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await zauthMiddleware.shutdown();
    process.exit(0);
  });
} else {
  console.log('Warning: ZAUTH_API_KEY not set - monitoring disabled');
}

// ============================================
// Step 2: Set up x402 payment middleware
// ============================================

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const x402Server = new x402ResourceServer(facilitatorClient);
x402Server.register('eip155:*', new ExactEvmScheme());

app.use(
  paymentMiddleware(
    {
      'GET /api/data': {
        accepts: {
          scheme: 'exact',
          price: '$0.001',
          network: 'eip155:8453', // Base mainnet
          payTo: payTo,
        },
        description: 'Get data endpoint',
        mimeType: 'application/json',
      },
      'POST /api/process': {
        accepts: {
          scheme: 'exact',
          price: '$0.005',
          network: 'eip155:8453',
          payTo: payTo,
        },
        description: 'Process data endpoint',
        mimeType: 'application/json',
      },
    },
    x402Server
  )
);

// ============================================
// Step 3: Your routes (unchanged)
// ============================================

app.get('/api/data', (req, res) => {
  res.json({
    success: true,
    data: {
      items: [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ],
      timestamp: new Date().toISOString(),
    },
  });
});

app.post('/api/process', (req, res) => {
  res.json({
    success: true,
    data: {
      processed: true,
      input: req.body,
      result: 'Processed successfully',
    },
  });
});

// Free endpoint (not behind x402 paywall)
app.get('/api/free', (req, res) => {
  res.json({ message: 'This endpoint is free!' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    payTo,
    facilitator: FACILITATOR_URL,
  });
});

// ============================================
// Start server
// ============================================

app.listen(PORT, () => {
  console.log(`
Provider server with zauthSDK monitoring
========================================
Listening on http://localhost:${PORT}
Pay to: ${payTo}
Facilitator: ${FACILITATOR_URL}

Endpoints:
  GET  /api/data    - Paid ($0.001 USDC)
  POST /api/process - Paid ($0.005 USDC)
  GET  /api/free    - Free
  GET  /health      - Health check

All x402 payments are monitored by zauthSDK.
  `);
});
