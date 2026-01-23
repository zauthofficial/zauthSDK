/**
 * Express middleware for x402 providers
 *
 * This middleware observes requests and responses without interfering
 * with your existing x402 implementation (coinbase/@x402, custom, etc.)
 *
 * Usage:
 *   import { createZauthMiddleware } from '@zauthx402/sdk/middleware';
 *
 *   app.use(createZauthMiddleware({
 *     apiKey: 'your-api-key',
 *     mode: 'provider'
 *   }));
 *
 *   // Your existing x402 middleware and routes continue to work unchanged
 *   app.use(x402Middleware(...));
 *   app.get('/api/paid', ...);
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ProviderMiddlewareConfig } from '../types/config.js';
import type { RequestEvent, ResponseEvent } from '../types/events.js';
import { ZauthClient } from '../client.js';
import { validateResponse } from '../validator.js';
import { RefundExecutor, createRefundExecutor } from '../refund.js';
import {
  getBaseUrl,
  parseQueryParams,
  redactHeaders,
  processBody,
  getByteSize,
  shouldSample,
  extractPaymentFromHeaders,
  extractPaymentFromRequest,
  decodePaymentHeader,
  baseUnitsToUsdc,
} from '../utils.js';

/**
 * Middleware options
 */
export interface ZauthMiddlewareOptions extends ProviderMiddlewareConfig {
  /**
   * Custom function to determine if a route should be monitored
   */
  shouldMonitor?: (req: Request) => boolean;
}

/**
 * Create zauth monitoring middleware for Express
 * Returns both the middleware and a cleanup function
 */
export function createZauthMiddleware(options: ZauthMiddlewareOptions): RequestHandler & {
  shutdown: () => Promise<void>;
  refundExecutor?: RefundExecutor;
} {
  const client = new ZauthClient(options);
  const config = client.getConfig();

  // Build route matchers
  const includePatterns = options.includeRoutes?.map(p => new RegExp(p)) || [];
  const excludePatterns = options.excludeRoutes?.map(p => new RegExp(p)) || [];

  // Initialize refund executor if refunds are enabled
  let refundExecutor: RefundExecutor | undefined;
  if (config.refund.enabled && (config.refund.signer || config.refund.privateKey)) {
    refundExecutor = createRefundExecutor(client, config.refund, config.debug);
    refundExecutor.start();
    if (config.debug) {
      console.log('[zauthSDK] Refund executor started');
    }
  }

  /**
   * Check if route should be monitored
   */
  function shouldMonitorRoute(req: Request): boolean {
    // Custom override
    if (options.shouldMonitor) {
      return options.shouldMonitor(req);
    }

    const path = req.path;

    // Skip health checks if configured
    if (options.skipHealthChecks !== false) {
      if (path === '/health' || path === '/healthz' || path === '/ready' || path === '/_health') {
        return false;
      }
    }

    // Check excludes first
    for (const pattern of excludePatterns) {
      if (pattern.test(path)) {
        return false;
      }
    }

    // If includes specified, must match one
    if (includePatterns.length > 0) {
      for (const pattern of includePatterns) {
        if (pattern.test(path)) {
          return true;
        }
      }
      return false;
    }

    // Default: monitor all
    return true;
  }

  /**
   * The middleware function
   */
  const zauthMiddleware = function(req: Request, res: Response, next: NextFunction): void {
    // Check if should monitor
    if (!shouldMonitorRoute(req)) {
      next();
      return;
    }

    // Check sampling
    if (!shouldSample(config.telemetry.sampleRate)) {
      next();
      return;
    }

    const startTime = Date.now();

    // Build full URL
    const protocol = req.protocol;
    const host = req.get('host') || 'unknown';
    const fullUrl = `${protocol}://${host}${req.originalUrl}`;

    // Extract payment header from incoming request
    const incomingPaymentHeader = extractPaymentFromHeaders(req.headers as Record<string, string>).paymentHeader;

    // Debug: log incoming payment header
    if (config.debug && incomingPaymentHeader) {
      console.log('[zauthSDK:provider] Incoming X-PAYMENT header found for', fullUrl);
      console.log('[zauthSDK:provider] Header (first 100 chars):', incomingPaymentHeader.substring(0, 100));
    }

    // Create request event
    const requestEvent: RequestEvent = {
      ...client.createEventBase('request'),
      type: 'request',
      url: fullUrl,
      baseUrl: getBaseUrl(fullUrl),
      method: req.method,
      headers: redactHeaders(req.headers as Record<string, string>, config.telemetry.redactHeaders),
      queryParams: parseQueryParams(fullUrl),
      body: config.telemetry.includeRequestBody
        ? processBody(req.body, config.telemetry)
        : undefined,
      requestSize: getByteSize(req.body),
      sourceIp: req.ip || req.socket.remoteAddress,
      userAgent: req.get('user-agent'),
      paymentHeader: incomingPaymentHeader || undefined,
    };

    // Queue request event
    client.queueEvent(requestEvent);

    // Capture original response methods
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    const originalEnd = res.end.bind(res);

    let responseSent = false;

    /**
     * Handle response capture
     */
    function captureResponse(body: unknown): void {
      if (responseSent) return;
      responseSent = true;

      const responseTime = Date.now() - startTime;
      const statusCode = res.statusCode;

      // Validate response
      const validationResult = validateResponse(body, statusCode, config.validation);

      // Extract payment response from response headers
      const { paymentResponse: headerPaymentResponse } = extractPaymentFromHeaders(
        res.getHeaders() as Record<string, string>
      );

      // Also check the request object (x402 middleware may attach payment info there)
      const reqPaymentInfo = extractPaymentFromRequest(req as unknown as Record<string, unknown>);

      // Try to decode payer from request's X-PAYMENT header
      const incomingPaymentHeader = requestEvent.paymentHeader;
      const decodedPayment = decodePaymentHeader(incomingPaymentHeader || null);

      // Debug: log decoded payment info
      if (config.debug && decodedPayment?.payer) {
        console.log('[zauthSDK:provider] Decoded payer from X-PAYMENT:', decodedPayment.payer);
      }

      // Also try to extract from X-PAYMENT-RESPONSE header on response (from facilitator)
      const xPaymentResponseHeader = res.getHeader('payment-response') || res.getHeader('x-payment-response');

      // Debug: log response headers for paid endpoints
      if (config.debug && fullUrl.includes('/api/paid')) {
        console.log('[zauthSDK:provider] Response headers for', fullUrl);
        const headers = res.getHeaders();
        Object.keys(headers).forEach(key => {
          const val = headers[key];
          console.log(`  ${key}: ${typeof val === 'string' ? val.substring(0, 80) : val}`);
        });
      }

      let facilitatorResponse: { payer?: string; transaction?: string; network?: string } | null = null;
      if (xPaymentResponseHeader && typeof xPaymentResponseHeader === 'string') {
        try {
          const decoded = Buffer.from(xPaymentResponseHeader, 'base64').toString('utf-8');
          facilitatorResponse = JSON.parse(decoded);
          if (config.debug) {
            console.log('[zauthSDK:provider] Decoded facilitator response:', JSON.stringify(facilitatorResponse));
          }
        } catch {
          // Not valid base64 JSON
        }
      }

      // Merge payment info from all sources (prioritize facilitator response)
      let paymentResponse = reqPaymentInfo || headerPaymentResponse;

      // If we have facilitator response with payer, use that
      if (facilitatorResponse?.payer) {
        // Get default amount from config if available
        const defaultAmount = (options as unknown as Record<string, unknown>).defaultPaymentAmountUsdc as string | undefined;
        paymentResponse = {
          transactionHash: facilitatorResponse.transaction || null,
          amountPaid: null, // Amount not in facilitator response
          amountPaidUsdc: defaultAmount || null,
          network: facilitatorResponse.network || 'base',
          payTo: null,
          asset: 'USDC',
          payer: facilitatorResponse.payer,
        };
      }
      // Otherwise if we have decoded payment header, use that
      else if (!paymentResponse && decodedPayment?.payer && incomingPaymentHeader) {
        const defaultAmount = (options as unknown as Record<string, unknown>).defaultPaymentAmountUsdc as string | undefined;
        // decodedPayment.amount is in base units, convert to USDC
        const amountUsdc = decodedPayment.amount
          ? baseUnitsToUsdc(decodedPayment.amount)
          : defaultAmount || null;
        paymentResponse = {
          transactionHash: null,
          amountPaid: decodedPayment.amount,
          amountPaidUsdc: amountUsdc,
          network: decodedPayment.network || 'base',
          payTo: null,
          asset: 'USDC',
          payer: decodedPayment.payer,
        };
        if (config.debug) {
          console.log('[zauthSDK:provider] Created paymentResponse from X-PAYMENT header:', {
            payer: paymentResponse.payer,
            amountUsdc: paymentResponse.amountPaidUsdc,
          });
        }
      }

      // Fill in missing payer from decoded payment header
      if (paymentResponse && !paymentResponse.payer && decodedPayment?.payer) {
        paymentResponse = { ...paymentResponse, payer: decodedPayment.payer };
      }

      // If we have payment info, emit a separate payment event for tracking
      if (paymentResponse && (paymentResponse.transactionHash || paymentResponse.payer)) {
        const paymentEvent = {
          ...client.createEventBase('payment'),
          type: 'payment' as const,
          requestEventId: requestEvent.eventId,
          url: fullUrl,
          network: paymentResponse.network || 'base',
          transactionHash: paymentResponse.transactionHash || '',
          amountPaid: paymentResponse.amountPaid || '0',
          amountPaidUsdc: paymentResponse.amountPaidUsdc || '0',
          payTo: paymentResponse.payTo || '',
          asset: paymentResponse.asset || 'USDC',
          payer: paymentResponse.payer || '',
          scheme: 'exact',
        };
        client.queueEvent(paymentEvent);
      }

      // Look up expectedResponse from refund endpoint config
      let expectedResponse: string | undefined;
      if (config.refund.endpoints) {
        const requestPath = req.path;
        for (const [pattern, endpointConfig] of Object.entries(config.refund.endpoints)) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          if (regex.test(requestPath) || regex.test(fullUrl)) {
            expectedResponse = endpointConfig.expectedResponse;
            break;
          }
        }
      }

      // Create response event
      const responseEvent: ResponseEvent = {
        ...client.createEventBase('response'),
        type: 'response',
        requestEventId: requestEvent.eventId,
        url: fullUrl,
        statusCode,
        headers: redactHeaders(
          res.getHeaders() as Record<string, string>,
          config.telemetry.redactHeaders
        ),
        body: config.telemetry.includeResponseBody
          ? processBody(body, config.telemetry)
          : undefined,
        responseSize: getByteSize(body),
        responseTimeMs: responseTime,
        success: validationResult.valid,
        meaningful: validationResult.meaningfulnessScore >= 0.7,
        validationResult,
        paymentResponse: paymentResponse || undefined,
        errorMessage: validationResult.reason,
        expectedResponse,
      };

      // Queue response event
      client.queueEvent(responseEvent);
    }

    // Override res.json
    res.json = function (body: unknown): Response {
      captureResponse(body);
      return originalJson(body);
    };

    // Override res.send
    res.send = function (body: unknown): Response {
      // Try to parse as JSON for validation
      if (typeof body === 'string') {
        try {
          captureResponse(JSON.parse(body));
        } catch {
          captureResponse(body);
        }
      } else {
        captureResponse(body);
      }
      return originalSend(body);
    };

    // Override res.end for cases where neither json nor send is used
    res.end = function (chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): Response {
      if (!responseSent && chunk) {
        const body = typeof chunk === 'string' ? chunk : chunk?.toString();
        try {
          captureResponse(JSON.parse(body || ''));
        } catch {
          captureResponse(body);
        }
      } else if (!responseSent) {
        captureResponse(null);
      }

      // Handle overloaded signatures
      if (typeof encoding === 'function') {
        return originalEnd(chunk, encoding);
      }
      if (encoding) {
        return originalEnd(chunk, encoding, callback);
      }
      return originalEnd(chunk, callback);
    };

    // Handle errors
    res.on('error', (error: Error) => {
      if (!responseSent) {
        captureResponse({ error: error.message });
      }
    });

    next();
  };

  // Attach shutdown function and refund executor to middleware
  const middlewareWithExtras = zauthMiddleware as RequestHandler & {
    shutdown: () => Promise<void>;
    refundExecutor?: RefundExecutor;
  };

  middlewareWithExtras.shutdown = async () => {
    if (refundExecutor) {
      refundExecutor.stop();
    }
    await client.shutdown();
  };

  middlewareWithExtras.refundExecutor = refundExecutor;

  return middlewareWithExtras;
}

/**
 * Create middleware with simpler configuration
 */
export function zauthProvider(
  apiKey: string,
  options?: Partial<Omit<ZauthMiddlewareOptions, 'apiKey' | 'mode'>>
): RequestHandler & { shutdown: () => Promise<void>; refundExecutor?: RefundExecutor } {
  return createZauthMiddleware({
    apiKey,
    mode: 'provider',
    ...options,
  });
}

/**
 * Re-export RefundExecutor for direct access
 */
export { RefundExecutor } from '../refund.js';
