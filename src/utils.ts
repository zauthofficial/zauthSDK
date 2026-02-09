/**
 * Utility functions for zauthSDK
 */

import type { TelemetryConfig } from './types/config.js';

/**
 * USDC has 6 decimals, so 1 USDC = 1,000,000 base units
 */
export const USDC_DECIMALS = 1_000_000;

/**
 * Convert base units to USDC decimal string
 */
export function baseUnitsToUsdc(baseUnits: string | number): string {
  return (Number(baseUnits) / USDC_DECIMALS).toFixed(6);
}

/**
 * Extract base URL without query parameters
 */
export function getBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Parse query parameters from URL
 */
export function parseQueryParams(url: string): Record<string, string> {
  try {
    const parsed = new URL(url);
    const params: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return params;
  } catch {
    return {};
  }
}

/**
 * Redact sensitive headers
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  redactList: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  const redactSet = new Set(redactList.map(h => h.toLowerCase()));

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const headerValue = Array.isArray(value) ? value.join(', ') : value;

    if (redactSet.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = headerValue;
    }
  }

  return result;
}

/**
 * Redact sensitive fields from an object
 */
export function redactFields(
  obj: unknown,
  fields: string[]
): unknown {
  if (!obj || typeof obj !== 'object' || fields.length === 0) {
    return obj;
  }

  const fieldSet = new Set(fields);

  function redactRecursive(current: unknown, path: string): unknown {
    if (!current || typeof current !== 'object') {
      return current;
    }

    if (Array.isArray(current)) {
      return current.map((item, i) => redactRecursive(item, `${path}[${i}]`));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      const fullPath = path ? `${path}.${key}` : key;

      if (fieldSet.has(key) || fieldSet.has(fullPath)) {
        result[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        result[key] = redactRecursive(value, fullPath);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return redactRecursive(obj, '');
}

/**
 * Truncate body to max size
 */
export function truncateBody(body: unknown, maxSize: number): unknown {
  if (body === undefined || body === null) {
    return body;
  }

  const str = typeof body === 'string' ? body : JSON.stringify(body);

  if (str.length <= maxSize) {
    return body;
  }

  // For strings, truncate directly
  if (typeof body === 'string') {
    return str.slice(0, maxSize) + '...[TRUNCATED]';
  }

  // For objects, try to parse truncated JSON or return indicator
  return { _truncated: true, _originalSize: str.length, _preview: str.slice(0, 200) };
}

/**
 * Process body for telemetry (redact + truncate)
 */
export function processBody(
  body: unknown,
  config: TelemetryConfig
): unknown {
  if (body === undefined || body === null) {
    return body;
  }

  let processed: unknown = body;

  // Redact fields
  if (config.redactFields && config.redactFields.length > 0) {
    processed = redactFields(processed, config.redactFields);
  }

  // Truncate
  if (config.maxBodySize) {
    processed = truncateBody(processed, config.maxBodySize);
  }

  return processed;
}

/**
 * Calculate byte size of a value
 */
export function getByteSize(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }

  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.byteLength(str, 'utf8');
}

/**
 * Check if should sample this event
 */
export function shouldSample(sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return Math.random() < sampleRate;
}

/**
 * Safe JSON parse
 */
export function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Check if response body indicates an error
 */
export function hasErrorIndicators(
  body: unknown,
  errorFields: string[] = ['error', 'errors']
): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }

  const obj = body as Record<string, unknown>;

  for (const field of errorFields) {
    if (field in obj && obj[field] !== undefined && obj[field] !== null) {
      // Check if the field has actual content
      const value = obj[field];
      if (typeof value === 'string' && value.length > 0) return true;
      if (typeof value === 'object' && Object.keys(value as object).length > 0) return true;
      if (typeof value === 'boolean' && value === true) return true;
    }
  }

  // Check for ok: false or success: false
  if (obj.ok === false || obj.success === false) {
    return true;
  }

  return false;
}

/**
 * Check if body is empty or minimal
 */
export function isEmptyResponse(body: unknown, minSize: number = 2): boolean {
  if (body === undefined || body === null || body === '') {
    return true;
  }

  if (typeof body === 'string') {
    return body.trim().length < minSize;
  }

  if (typeof body === 'object') {
    // Empty object or array
    if (Array.isArray(body)) {
      return body.length === 0;
    }
    return Object.keys(body).length === 0;
  }

  return false;
}

/**
 * Payment info extracted from headers or request
 */
export interface ExtractedPaymentInfo {
  paymentHeader: string | null;
  paymentResponse: {
    transactionHash: string | null;
    amountPaid: string | null;
    amountPaidUsdc: string | null;
    network: string | null;
    payTo: string | null;
    asset: string | null;
    payer: string | null;
  } | null;
}

/**
 * Extract payment info from response headers
 */
export function extractPaymentFromHeaders(headers: Record<string, string | string[] | undefined>): ExtractedPaymentInfo {
  const getHeader = (name: string): string | null => {
    const value = headers[name] || headers[name.toLowerCase()];
    if (!value) return null;
    return Array.isArray(value) ? value[0] : value;
  };

  const paymentHeader = getHeader('X-PAYMENT') || getHeader('Payment-Signature');
  const paymentResponseHeader = getHeader('X-PAYMENT-RESPONSE') || getHeader('Payment-Response');

  // Try to parse X-PAYMENT-RESPONSE header as JSON
  let paymentResponse: ExtractedPaymentInfo['paymentResponse'] = null;
  if (paymentResponseHeader) {
    try {
      const parsed = JSON.parse(paymentResponseHeader);
      paymentResponse = {
        transactionHash: parsed.transactionHash || parsed.txHash || parsed.hash || null,
        amountPaid: parsed.amountPaid || parsed.amount || null,
        amountPaidUsdc: parsed.amountPaidUsdc || parsed.amountUsdc || null,
        network: parsed.network || parsed.chain || null,
        payTo: parsed.payTo || parsed.recipient || parsed.to || null,
        asset: parsed.asset || parsed.token || null,
        payer: parsed.payer || parsed.from || parsed.sender || null,
      };
    } catch {
      // Header is not JSON, might be a reference or signature
    }
  }

  return {
    paymentHeader,
    paymentResponse,
  };
}

/**
 * Extract payment info from Express request object (x402 middleware attaches this)
 */
export function extractPaymentFromRequest(req: Record<string, unknown>): ExtractedPaymentInfo['paymentResponse'] | null {
  // Check common locations where x402 middleware might attach payment info
  const paymentInfo = req.paymentInfo || req.x402Payment || req.payment;
  if (!paymentInfo || typeof paymentInfo !== 'object') {
    return null;
  }

  const info = paymentInfo as Record<string, unknown>;
  return {
    transactionHash: (info.transactionHash || info.txHash || info.hash || null) as string | null,
    amountPaid: (info.amountPaid || info.amount || null) as string | null,
    amountPaidUsdc: (info.amountPaidUsdc || info.amountUsdc || null) as string | null,
    network: (info.network || info.chain || null) as string | null,
    payTo: (info.payTo || info.recipient || info.to || null) as string | null,
    asset: (info.asset || info.token || null) as string | null,
    payer: (info.payer || info.from || info.sender || null) as string | null,
  };
}

/**
 * Decode X-PAYMENT header to extract payer info
 * The X-PAYMENT header contains a base64-encoded JSON with payment details
 *
 * x402 V2 EVM format: {"x402Version":2,"payload":{"authorization":{"from":"0x..."}}}
 * x402 V2 Solana format: {"x402Version":2,"payload":{"transaction":"base64..."}}
 * x402 V1 format: varies
 */
export function decodePaymentHeader(paymentHeader: string | null): { payer: string | null; amount: string | null; network: string | null } | null {
  if (!paymentHeader) return null;

  try {
    // Try to decode as base64 first
    let decoded: string;
    try {
      // Use Buffer for Node.js compatibility
      if (typeof Buffer !== 'undefined') {
        decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
      } else {
        decoded = atob(paymentHeader);
      }
    } catch {
      // Not base64, try as JSON directly
      decoded = paymentHeader;
    }

    const parsed = JSON.parse(decoded);

    // x402 V2 EVM format: payload.authorization.from
    // x402 V2 Solana format: payload.transaction (base64 Solana tx)
    // x402 V1 format: varies
    let payer =
      parsed.payload?.authorization?.from ||  // x402 V2 EVM
      parsed.payer ||
      parsed.from ||
      parsed.payload?.from ||
      parsed.x?.signature?.address ||
      null;

    // For Solana x402 V2, extract payer from the transaction
    if (!payer && parsed.payload?.transaction) {
      payer = extractSolanaFeePayer(parsed.payload.transaction);
    }

    const amount =
      parsed.payload?.authorization?.value ||  // x402 V2 EVM
      parsed.accepted?.amount ||               // x402 V2 (accepted payment requirements)
      parsed.amount ||
      parsed.payload?.amount ||
      null;

    // Detect network from payload or transaction format
    let network =
      parsed.payload?.authorization?.network ||  // x402 V2 EVM
      parsed.network ||
      parsed.payload?.network ||
      null;

    // If we extracted a Solana payer, set network to solana
    if (!network && parsed.payload?.transaction && payer) {
      network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; // Solana mainnet
    }

    return { payer, amount, network };
  } catch {
    // Could not decode payment header
    return null;
  }
}

/**
 * SPL Token program addresses for identifying token transfer instructions
 */
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Extract the token transfer authority (the actual payer) from a Solana x402 payment transaction.
 *
 * In x402 SVM, the transaction fee payer is often the facilitator or provider,
 * NOT the client who paid. The actual client address is the authority on the
 * SPL Token TransferChecked instruction (accountIndices[3]).
 *
 * Falls back to the fee payer (first account) if no token transfer is found.
 */
function extractSolanaFeePayer(base64Transaction: string): string | null {
  try {
    const txBytes = typeof Buffer !== 'undefined'
      ? Buffer.from(base64Transaction, 'base64')
      : Uint8Array.from(atob(base64Transaction), c => c.charCodeAt(0));

    let offset = 0;

    // Skip signatures
    const numSignatures = txBytes[offset];
    offset += 1 + numSignatures * 64;

    // Check for V0 message prefix
    if ((txBytes[offset] & 0x80) !== 0) {
      offset += 1;
    }

    // Message header: [numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts]
    offset += 3;

    // Account keys
    const numAccounts = txBytes[offset];
    offset += 1;

    const accountKeys: Uint8Array[] = [];
    for (let i = 0; i < numAccounts; i++) {
      accountKeys.push(txBytes.slice(offset, offset + 32));
      offset += 32;
    }

    if (accountKeys.length === 0) return null;

    // Skip recent blockhash (32 bytes)
    offset += 32;

    // Parse instructions to find the token transfer authority
    const numInstructions = txBytes[offset];
    offset += 1;

    for (let i = 0; i < numInstructions; i++) {
      const programIdIndex = txBytes[offset];
      offset += 1;

      // Read account indices (compact array)
      const numIxAccounts = txBytes[offset];
      offset += 1;
      const ixAccountIndices: number[] = [];
      for (let j = 0; j < numIxAccounts; j++) {
        ixAccountIndices.push(txBytes[offset]);
        offset += 1;
      }

      // Read instruction data (compact array)
      const dataLen = txBytes[offset];
      offset += 1 + dataLen;

      // Check if this instruction is for SPL Token / Token-2022
      const programAddr = base58Encode(accountKeys[programIdIndex]);
      if (programAddr === SPL_TOKEN_PROGRAM || programAddr === SPL_TOKEN_2022_PROGRAM) {
        // TransferChecked has 4 accounts: [source, mint, destination, authority]
        if (ixAccountIndices.length >= 4) {
          const authorityIndex = ixAccountIndices[3];
          return base58Encode(accountKeys[authorityIndex]);
        }
        // Transfer has 3 accounts: [source, destination, authority]
        if (ixAccountIndices.length >= 3) {
          const authorityIndex = ixAccountIndices[2];
          return base58Encode(accountKeys[authorityIndex]);
        }
      }
    }

    // Fallback: return fee payer (first account)
    return base58Encode(accountKeys[0]);
  } catch {
    return null;
  }
}

/**
 * Simple base58 encoder for Solana public keys
 */
function base58Encode(bytes: Uint8Array | Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58;

  // Convert bytes to a big integer
  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte);
  }

  // Convert to base58
  let result = '';
  while (num > 0) {
    const remainder = Number(num % BigInt(BASE));
    num = num / BigInt(BASE);
    result = ALPHABET[remainder] + result;
  }

  // Add leading '1's for leading zero bytes
  for (const byte of bytes) {
    if (byte === 0) {
      result = '1' + result;
    } else {
      break;
    }
  }

  return result || '1';
}

/**
 * Detect x402 version from response
 */
export function detectX402Version(body: unknown): 1 | 2 | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const obj = body as Record<string, unknown>;

  if (obj.x402Version === 2) return 2;
  if (obj.x402Version === 1) return 1;
  if (obj.paymentRequirements) return 2;
  if (obj.accepts || (obj.scheme && obj.network && obj.payTo)) return 1;

  return null;
}
