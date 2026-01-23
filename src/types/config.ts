/**
 * Configuration types for the zauthSDK
 */

import type { X402Network } from './x402.js';
import type { RefundReason, ValidationResult } from './events.js';

/**
 * Main SDK configuration
 */
export interface ZauthConfig {
  /**
   * Your zauthx402 API key
   * Get this from https://zauthx402.com/dashboard
   */
  apiKey: string;

  /**
   * API endpoint for zauthx402 service
   * @default 'https://back.zauthx402.com'
   */
  apiEndpoint?: string;

  /**
   * SDK mode: provider (hosting x402 endpoints)
   */
  mode: 'provider';

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Environment name for grouping events
   * @default process.env.NODE_ENV || 'development'
   */
  environment?: string;

  /**
   * Event batching configuration
   */
  batching?: BatchingConfig;

  /**
   * Response validation configuration (provider mode)
   */
  validation?: ValidationConfig;

  /**
   * Refund configuration (provider mode)
   */
  refund?: RefundConfig;

  /**
   * Telemetry configuration
   */
  telemetry?: TelemetryConfig;
}

/**
 * Event batching configuration
 */
export interface BatchingConfig {
  /**
   * Maximum events to batch before sending
   * @default 10
   */
  maxBatchSize?: number;

  /**
   * Maximum time to wait before sending batch (ms)
   * @default 5000
   */
  maxBatchWaitMs?: number;

  /**
   * Retry failed batches
   * @default true
   */
  retry?: boolean;

  /**
   * Max retry attempts
   * @default 3
   */
  maxRetries?: number;
}

/**
 * Response validation configuration
 */
export interface ValidationConfig {
  /**
   * JSON schema for valid responses
   * If provided, responses will be validated against this schema
   */
  responseSchema?: Record<string, unknown>;

  /**
   * Custom validator function
   * Return ValidationResult with valid=true if response is meaningful
   */
  customValidator?: (response: unknown, statusCode: number) => ValidationResult;

  /**
   * Minimum response size to consider meaningful (bytes)
   * @default 2 (i.e., not empty "{}" or "[]")
   */
  minResponseSize?: number;

  /**
   * Fields that must be present in response
   */
  requiredFields?: string[];

  /**
   * Fields that must NOT be present (error indicators)
   */
  errorFields?: string[];

  /**
   * Consider empty arrays/objects as invalid
   * @default true
   */
  rejectEmptyCollections?: boolean;
}

/**
 * Refund configuration (provider mode)
 * Supports global settings and per-endpoint overrides
 */
export interface RefundConfig {
  /**
   * Enable automatic refunds (master switch)
   * @default false
   */
  enabled?: boolean;

  /**
   * Signer for refund transactions (viem Account or private key string)
   * Should be a hot wallet with limited funds
   * Can also be set via ZAUTH_REFUND_PRIVATE_KEY env var
   */
  signer?: RefundSigner;

  /**
   * Private key for refund transactions (deprecated, use signer)
   * @deprecated Use signer instead
   */
  privateKey?: string;

  /**
   * Default network for refunds (can be overridden per-endpoint)
   * @default 'base'
   */
  network?: X402Network;

  /**
   * Global refund triggers
   */
  triggers?: RefundTriggers;

  /**
   * Maximum refund amount in USD per transaction (global default)
   * @default 1.00
   */
  maxRefundUsd?: number;

  /**
   * Daily refund cap in USD (optional safety limit)
   */
  dailyCapUsd?: number;

  /**
   * Monthly refund cap in USD (optional safety limit)
   */
  monthlyCapUsd?: number;

  /**
   * Per-endpoint refund configuration overrides
   * Key is URL pattern (supports * wildcard)
   */
  endpoints?: Record<string, EndpointRefundConfig>;

  /**
   * Polling configuration for checking pending refunds
   */
  polling?: RefundPollingConfig;

  /**
   * Callback when a refund is executed
   */
  onRefund?: (refund: ExecutedRefund) => void | Promise<void>;

  /**
   * Callback when a refund fails
   */
  onRefundError?: (error: RefundError) => void | Promise<void>;
}

/**
 * Signer type - can be a viem Account or private key string
 */
export type RefundSigner =
  | string  // Private key hex string
  | { address: string; signTransaction: (tx: unknown) => Promise<string> }; // viem-like Account

/**
 * What triggers an automatic refund
 */
export interface RefundTriggers {
  /** Refund on 5xx server errors */
  serverError?: boolean;
  /** Refund on request timeout */
  timeout?: boolean;
  /** Refund on empty/meaningless response */
  emptyResponse?: boolean;
  /** Refund when response doesn't match expected schema */
  schemaValidation?: boolean;
  /** Minimum meaningfulness score - refund if below this */
  minMeaningfulness?: number;
}

/**
 * Per-endpoint refund configuration
 */
export interface EndpointRefundConfig {
  /** Override enabled for this endpoint (null = use global) */
  enabled?: boolean;
  /** Override max refund for this endpoint */
  maxRefundUsd?: number;
  /** Override triggers for this endpoint */
  triggers?: Partial<RefundTriggers>;
  /** Custom matcher for this endpoint */
  shouldRefund?: (response: unknown, statusCode: number, validationResult: ValidationResult) => boolean;
  /** Plain text description of expected response shape for AI validation */
  expectedResponse?: string;
}

/**
 * Polling configuration for checking pending refunds
 */
export interface RefundPollingConfig {
  /** Enable polling (defaults to true if refunds enabled) */
  enabled?: boolean;
  /** Polling interval in milliseconds @default 30000 */
  intervalMs?: number;
  /** Max refunds to process per poll @default 10 */
  batchSize?: number;
}

/**
 * Successfully executed refund
 */
export interface ExecutedRefund {
  refundId: string;
  requestId: string;
  url: string;
  amountUsd: number;
  amountRaw: string;
  txHash: string;
  network: X402Network;
  recipient: string;
  reason: RefundReason;
  executedAt: string;
}

/**
 * Refund execution error
 */
export interface RefundError {
  refundId: string;
  url: string;
  amountUsd: number;
  error: string;
  retryable: boolean;
}

/**
 * Condition that triggers a refund (legacy - use RefundTriggers)
 * @deprecated Use RefundTriggers instead
 */
export interface RefundCondition {
  reason: RefundReason;
  enabled: boolean;
  /** Additional matcher for this condition */
  matcher?: (response: unknown, statusCode: number) => boolean;
}

/**
 * Telemetry configuration
 */
export interface TelemetryConfig {
  /**
   * Include request body in events
   * @default true
   */
  includeRequestBody?: boolean;

  /**
   * Include response body in events
   * @default true
   */
  includeResponseBody?: boolean;

  /**
   * Maximum body size to include (bytes)
   * Bodies larger than this will be truncated
   * @default 10000
   */
  maxBodySize?: number;

  /**
   * Headers to redact from events
   * @default ['authorization', 'cookie', 'x-api-key']
   */
  redactHeaders?: string[];

  /**
   * Fields to redact from request/response bodies
   * Supports dot notation (e.g., 'user.password')
   */
  redactFields?: string[];

  /**
   * Sample rate for events (0-1)
   * 1 = send all events, 0.1 = send 10% of events
   * @default 1
   */
  sampleRate?: number;
}

/**
 * Provider middleware configuration
 */
export interface ProviderMiddlewareConfig extends ZauthConfig {
  mode: 'provider';

  /**
   * URL patterns to monitor
   * If not specified, monitors all routes
   */
  includeRoutes?: string[];

  /**
   * URL patterns to exclude from monitoring
   */
  excludeRoutes?: string[];

  /**
   * Skip monitoring for health check endpoints
   * @default true
   */
  skipHealthChecks?: boolean;
}


/**
 * Resolved configuration with all defaults applied
 */
/** Resolved validation config - some fields remain optional */
export type ResolvedValidationConfig = {
  responseSchema?: Record<string, unknown>;
  customValidator?: (response: unknown, statusCode: number) => ValidationResult;
  minResponseSize: number;
  requiredFields: string[];
  errorFields: string[];
  rejectEmptyCollections: boolean;
};

/** Resolved refund config */
export interface ResolvedRefundConfig {
  enabled: boolean;
  signer?: RefundSigner;
  privateKey?: string;
  network: X402Network;
  triggers: Required<RefundTriggers>;
  maxRefundUsd: number;
  dailyCapUsd?: number;
  monthlyCapUsd?: number;
  endpoints: Record<string, EndpointRefundConfig>;
  polling: Required<RefundPollingConfig>;
  onRefund?: (refund: ExecutedRefund) => void | Promise<void>;
  onRefundError?: (error: RefundError) => void | Promise<void>;
}

export interface ResolvedConfig {
  apiKey: string;
  apiEndpoint: string;
  mode: 'provider';
  debug: boolean;
  environment: string;
  batching: Required<BatchingConfig>;
  validation: ResolvedValidationConfig;
  refund: ResolvedRefundConfig;
  telemetry: Required<TelemetryConfig>;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Omit<ResolvedConfig, 'apiKey' | 'mode'> = {
  apiEndpoint: process.env.ZAUTH_API_ENDPOINT || 'https://back.zauthx402.com',
  debug: false,
  environment: process.env.NODE_ENV || 'development',
  batching: {
    maxBatchSize: 10,
    maxBatchWaitMs: 5000,
    retry: true,
    maxRetries: 3,
  },
  validation: {
    minResponseSize: 2,
    requiredFields: [],
    errorFields: ['error', 'errors'],
    rejectEmptyCollections: true,
  },
  refund: {
    enabled: false,
    privateKey: process.env.ZAUTH_REFUND_PRIVATE_KEY,
    network: 'base',
    triggers: {
      serverError: true,
      timeout: true,
      emptyResponse: true,
      schemaValidation: false,
      minMeaningfulness: 0.3,
    },
    maxRefundUsd: 1.00,
    endpoints: {},
    polling: {
      enabled: true,
      intervalMs: 30000,
      batchSize: 10,
    },
  },
  telemetry: {
    includeRequestBody: true,
    includeResponseBody: true,
    maxBodySize: 10000,
    redactHeaders: ['authorization', 'cookie', 'x-api-key', 'x-payment'],
    redactFields: [],
    sampleRate: 1,
  },
};

/**
 * Resolve configuration by merging with defaults
 */
export function resolveConfig(config: ZauthConfig): ResolvedConfig {
  // Deep merge refund config
  const refundConfig: ResolvedRefundConfig = {
    enabled: config.refund?.enabled ?? DEFAULT_CONFIG.refund.enabled,
    signer: config.refund?.signer,
    privateKey: config.refund?.privateKey ?? DEFAULT_CONFIG.refund.privateKey,
    network: config.refund?.network ?? DEFAULT_CONFIG.refund.network,
    triggers: {
      ...DEFAULT_CONFIG.refund.triggers,
      ...config.refund?.triggers,
    },
    maxRefundUsd: config.refund?.maxRefundUsd ?? DEFAULT_CONFIG.refund.maxRefundUsd,
    dailyCapUsd: config.refund?.dailyCapUsd,
    monthlyCapUsd: config.refund?.monthlyCapUsd,
    endpoints: config.refund?.endpoints ?? DEFAULT_CONFIG.refund.endpoints,
    polling: {
      ...DEFAULT_CONFIG.refund.polling,
      ...config.refund?.polling,
    },
    onRefund: config.refund?.onRefund,
    onRefundError: config.refund?.onRefundError,
  };

  return {
    apiKey: config.apiKey,
    apiEndpoint: config.apiEndpoint || DEFAULT_CONFIG.apiEndpoint,
    mode: config.mode,
    debug: config.debug ?? DEFAULT_CONFIG.debug,
    environment: config.environment || DEFAULT_CONFIG.environment,
    batching: {
      ...DEFAULT_CONFIG.batching,
      ...config.batching,
    },
    validation: {
      ...DEFAULT_CONFIG.validation,
      ...config.validation,
    },
    refund: refundConfig,
    telemetry: {
      ...DEFAULT_CONFIG.telemetry,
      ...config.telemetry,
    },
  };
}
