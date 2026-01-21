/**
 * Event types for monitoring and telemetry
 */

import type { X402Network, X402PaymentInfo, X402PaymentRequirement } from './x402.js';

/**
 * Status of an endpoint based on monitoring
 */
export type EndpointStatus =
  | 'UNTESTED'
  | 'WORKING'
  | 'FAILING'
  | 'FLAKY'
  | 'OVER_BUDGET';

/**
 * Base event structure
 */
export interface ZauthEventBase {
  /** Unique event ID */
  eventId: string;
  /** ISO timestamp */
  timestamp: string;
  /** Event type */
  type: string;
  /** API key used */
  apiKey: string;
  /** SDK version */
  sdkVersion: string;
}

/**
 * Request event - sent when a request is received (provider) or made (client)
 */
export interface RequestEvent extends ZauthEventBase {
  type: 'request';
  /** Full URL of the endpoint */
  url: string;
  /** Base URL without query params */
  baseUrl: string;
  /** HTTP method */
  method: string;
  /** Request headers (sensitive ones redacted) */
  headers: Record<string, string>;
  /** Query parameters */
  queryParams: Record<string, string>;
  /** Request body (if JSON) */
  body: unknown;
  /** Size of request in bytes */
  requestSize: number;
  /** Source IP (for providers) */
  sourceIp?: string;
  /** User agent */
  userAgent?: string;
  /** Payment header if present */
  paymentHeader?: string;
}

/**
 * Response event - sent after response is generated/received
 */
export interface ResponseEvent extends ZauthEventBase {
  type: 'response';
  /** Request event ID this responds to */
  requestEventId: string;
  /** Full URL of the endpoint */
  url: string;
  /** HTTP status code */
  statusCode: number;
  /** Response headers */
  headers: Record<string, string>;
  /** Response body (if JSON, truncated if large) */
  body: unknown;
  /** Size of response in bytes */
  responseSize: number;
  /** Time to generate/receive response in ms */
  responseTimeMs: number;
  /** Whether response was successful (2xx and meaningful) */
  success: boolean;
  /** Was response meaningful according to validator */
  meaningful: boolean;
  /** Validation result details */
  validationResult?: ValidationResult;
  /** Payment response info */
  paymentResponse?: X402PaymentInfo;
  /** Error message if failed */
  errorMessage?: string;
}

/**
 * Payment event - sent when a payment is made or received
 */
export interface PaymentEvent extends ZauthEventBase {
  type: 'payment';
  /** Request event ID this payment is for */
  requestEventId: string;
  /** Endpoint URL */
  url: string;
  /** Payment network */
  network: X402Network;
  /** Transaction hash/signature */
  transactionHash: string;
  /** Amount paid in base units */
  amountPaid: string;
  /** Amount paid in USDC */
  amountPaidUsdc: string;
  /** Recipient address */
  payTo: string;
  /** Asset address/identifier */
  asset: string;
  /** Payer address */
  payer: string;
  /** Payment scheme used */
  scheme: string;
}

/**
 * Refund event - sent when a refund is triggered
 */
export interface RefundEvent extends ZauthEventBase {
  type: 'refund';
  /** Original request event ID */
  requestEventId: string;
  /** Original payment event ID */
  paymentEventId: string;
  /** Endpoint URL */
  url: string;
  /** Refund transaction hash */
  refundTransactionHash: string;
  /** Amount refunded in base units */
  amountRefunded: string;
  /** Amount refunded in USDC */
  amountRefundedUsdc: string;
  /** Recipient of refund */
  refundTo: string;
  /** Reason for refund */
  reason: RefundReason;
  /** Additional details */
  details?: string;
}

/**
 * Refund reasons
 */
export type RefundReason =
  | 'empty_response'
  | 'invalid_response'
  | 'schema_validation_failed'
  | 'timeout'
  | 'server_error'
  | 'custom';

/**
 * Error event - sent when an error occurs
 */
export interface ErrorEvent extends ZauthEventBase {
  type: 'error';
  /** Request event ID if applicable */
  requestEventId?: string;
  /** Endpoint URL */
  url: string;
  /** Error code */
  errorCode: string;
  /** Error message */
  errorMessage: string;
  /** Stack trace (in development mode only) */
  stackTrace?: string;
  /** Whether this was a provider failure (5xx) vs client error (4xx) */
  isProviderFailure: boolean;
}

/**
 * Health check event - periodic health status
 */
export interface HealthCheckEvent extends ZauthEventBase {
  type: 'health_check';
  /** Endpoint URL */
  url: string;
  /** Whether endpoint responded */
  responsive: boolean;
  /** Whether 402 payment requirements are valid */
  paymentRequirementsValid: boolean;
  /** Payment requirements if valid */
  paymentRequirements?: X402PaymentRequirement[];
  /** Response time in ms */
  responseTimeMs: number;
  /** Error if not responsive */
  error?: string;
}

/**
 * Validation result from response validator
 */
export interface ValidationResult {
  /** Overall validation passed */
  valid: boolean;
  /** Individual check results */
  checks: ValidationCheck[];
  /** Computed meaningfulness score (0-1) */
  meaningfulnessScore: number;
  /** Reason if not meaningful */
  reason?: string;
}

/**
 * Individual validation check
 */
export interface ValidationCheck {
  name: string;
  passed: boolean;
  message?: string;
}

/**
 * Union of all event types
 */
export type ZauthEvent =
  | RequestEvent
  | ResponseEvent
  | PaymentEvent
  | RefundEvent
  | ErrorEvent
  | HealthCheckEvent;

/**
 * Batch of events to send
 */
export interface EventBatch {
  events: ZauthEvent[];
  batchId: string;
  sentAt: string;
}

/**
 * Response from event submission
 */
export interface EventSubmitResponse {
  success: boolean;
  batchId: string;
  accepted: number;
  rejected: number;
  errors?: Array<{
    eventId: string;
    error: string;
  }>;
}

// ============================================
// Refund Types
// ============================================

/**
 * Pending refund from the server
 */
export interface PendingRefund {
  /** Unique refund request ID */
  id: string;
  /** Endpoint URL */
  url: string;
  /** HTTP method */
  method: string;
  /** Network for refund (base, solana, etc.) */
  network: X402Network;
  /** Amount to refund in cents */
  amountCents: number;
  /** Amount to refund in USD */
  amountUsd: number;
  /** Recipient wallet address */
  recipientAddress: string;
  /** Why the refund was approved */
  reason: RefundReason;
  /** HTTP status code of failed response */
  statusCode?: number;
  /** Meaningfulness score of failed response */
  meaningfulnessScore?: number;
  /** Original payment transaction hash */
  paymentTxHash?: string;
  /** SDK event IDs for tracing */
  sdkRequestEventId?: string;
  sdkResponseEventId?: string;
  sdkPaymentEventId?: string;
  /** When the refund was requested */
  requestedAt: string;
  /** When the refund expires if not processed */
  expiresAt?: string;
}

/**
 * Response from getPendingRefunds
 */
export interface PendingRefundsResponse {
  refunds: PendingRefund[];
  /** Total pending refunds (may be more than returned) */
  total: number;
  /** Provider's refund stats */
  stats: {
    todayRefundedCents: number;
    monthRefundedCents: number;
    dailyCapCents?: number;
    monthlyCapCents?: number;
    remainingDailyCents?: number;
    remainingMonthlyCents?: number;
  };
}

/**
 * Request to confirm a refund was executed
 */
export interface ConfirmRefundRequest {
  /** Refund request ID */
  refundId: string;
  /** Transaction hash of the refund */
  txHash: string;
  /** Network where refund was sent */
  network: X402Network;
  /** Actual amount refunded in token base units */
  amountRaw: string;
  /** Token address/identifier */
  token?: string;
  /** Gas cost in cents (for tracking) */
  gasCostCents?: number;
}

/**
 * Response from confirmRefund
 */
export interface ConfirmRefundResponse {
  success: boolean;
  refundId: string;
  status: 'CONFIRMED' | 'ALREADY_CONFIRMED' | 'NOT_FOUND' | 'ERROR';
  message?: string;
}

/**
 * Request to reject/skip a refund
 */
export interface RejectRefundRequest {
  refundId: string;
  reason: 'EXCEEDED_CAP' | 'INVALID_RECIPIENT' | 'MANUAL_REVIEW' | 'OTHER';
  note?: string;
}

/**
 * Response from rejectRefund
 */
export interface RejectRefundResponse {
  success: boolean;
  refundId: string;
  status: 'REJECTED' | 'NOT_FOUND' | 'ERROR';
}
