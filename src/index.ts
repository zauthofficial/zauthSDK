/**
 * @zauthx402/sdk
 *
 * Monitoring, verification, and refund SDK for x402 payment endpoints.
 * Works with any x402 implementation (coinbase/@x402, custom, etc.)
 *
 * @example Provider usage (Express)
 * ```ts
 * import { zauthProvider } from '@zauthx402/sdk/middleware';
 *
 * // Add before your existing x402 middleware
 * app.use(zauthProvider('your-api-key'));
 *
 * // Your existing x402 setup continues unchanged
 * app.use(x402Middleware(...));
 * app.get('/api/paid', ...);
 * ```
 */

// Core client
export { ZauthClient, createClient } from './client.js';

// Types
export * from './types/index.js';

// Middleware (provider mode)
export { createZauthMiddleware, zauthProvider } from './middleware/index.js';
export type { ZauthMiddlewareOptions } from './middleware/index.js';

// Validation
export { validateResponse, validateSchema, createSchemaValidator } from './validator.js';

// Refunds (optional)
export { RefundHandler, createRefundHandler } from './refund.js';
export type { RefundRequest, RefundResult } from './refund.js';

// Utilities
export {
  getBaseUrl,
  parseQueryParams,
  redactHeaders,
  isEmptyResponse,
  hasErrorIndicators,
  detectX402Version,
} from './utils.js';
