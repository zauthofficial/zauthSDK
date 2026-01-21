/**
 * Implementation-agnostic x402 types
 * These types are designed to work with any x402 implementation
 * (coinbase/@x402, custom implementations, etc.)
 */

/**
 * Supported blockchain networks
 */
export type X402Network =
  | 'base'
  | 'base-sepolia'
  | 'solana'
  | 'solana-devnet'
  | 'solana-testnet'
  | string; // Allow custom networks

/**
 * Payment scheme type
 */
export type X402Scheme = 'exact' | string;

/**
 * x402 Version
 */
export type X402Version = 1 | 2;

/**
 * Payment requirement from a 402 response
 */
export interface X402PaymentRequirement {
  scheme: X402Scheme;
  network: X402Network;
  payTo: string;
  asset: string;
  amount?: string;
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
  extra?: Record<string, unknown>;
}

/**
 * 402 response body structure (V1)
 */
export interface X402ResponseV1 {
  x402Version: 1;
  accepts: X402PaymentRequirement[];
  resource?: string;
}

/**
 * 402 response body structure (V2)
 */
export interface X402ResponseV2 {
  x402Version: 2;
  paymentRequirements: X402PaymentRequirement[];
}

/**
 * Union of all 402 response formats
 */
export type X402Response = X402ResponseV1 | X402ResponseV2;

/**
 * Payment payload sent in X-PAYMENT header
 */
export interface X402PaymentPayload {
  x402Version: X402Version;
  scheme: X402Scheme;
  network: X402Network;
  payload: unknown;
}

/**
 * Payment response header structure
 */
export interface X402PaymentResponse {
  success: boolean;
  transaction?: string;
  txSignature?: string;
  signature?: string;
  amount?: string;
  paidAmount?: string;
  network?: X402Network;
  payer?: string;
  from?: string;
  error?: string;
}

/**
 * Normalized payment info extracted from various x402 implementations
 */
export interface X402PaymentInfo {
  transactionHash: string | null;
  amountPaid: string | null;
  amountPaidUsdc: string | null;
  network: X402Network | null;
  payTo: string | null;
  asset: string | null;
}

/**
 * Helper to parse 402 response (works with V1 and V2)
 */
export function parseX402Response(body: unknown): X402Response | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const data = body as Record<string, unknown>;

  // V2 format
  if (data.x402Version === 2 && Array.isArray(data.paymentRequirements)) {
    return data as unknown as X402ResponseV2;
  }

  // V1 format with explicit version
  if (data.x402Version === 1 && Array.isArray(data.accepts)) {
    return data as unknown as X402ResponseV1;
  }

  // V1 format without version field (common in older implementations)
  if (Array.isArray(data.accepts)) {
    return {
      x402Version: 1,
      accepts: data.accepts as X402PaymentRequirement[],
      resource: data.resource as string | undefined,
    };
  }

  // Direct V1 format (single payment requirement, no accepts array)
  if (
    typeof data.scheme === 'string' &&
    typeof data.network === 'string' &&
    typeof data.payTo === 'string'
  ) {
    return {
      x402Version: 1,
      accepts: [data as unknown as X402PaymentRequirement],
    };
  }

  return null;
}

/**
 * Extract payment requirements from any x402 response format
 */
export function getPaymentRequirements(
  response: X402Response
): X402PaymentRequirement[] {
  if (response.x402Version === 2) {
    return (response as X402ResponseV2).paymentRequirements;
  }
  return (response as X402ResponseV1).accepts;
}

/**
 * Extract price in USDC (6 decimals) from payment requirement
 */
export function getPriceUsdc(requirement: X402PaymentRequirement): string | null {
  const amount = requirement.amount || requirement.maxAmountRequired;
  if (!amount) return null;

  try {
    const value = BigInt(amount);
    return (Number(value) / 1_000_000).toFixed(6);
  } catch {
    return null;
  }
}

/**
 * Decode X-PAYMENT-RESPONSE header
 */
export function decodePaymentResponse(
  header: string
): X402PaymentResponse | null {
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    return JSON.parse(decoded) as X402PaymentResponse;
  } catch {
    return null;
  }
}

/**
 * Encode payment payload for X-PAYMENT header
 */
export function encodePaymentPayload(payload: X402PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}
