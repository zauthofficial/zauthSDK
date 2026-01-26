/**
 * Refund handler for automatic refunds on bad responses
 *
 * This is an OPTIONAL feature that requires:
 * 1. viem package installed
 * 2. Provider's hot wallet private key configured
 *
 * The refund flow:
 * 1. SDK detects bad response (via validator)
 * 2. SDK reports to zauthx402 service
 * 3. If service approves, SDK triggers refund using provider's hot wallet
 */

import type { RefundConfig } from './types/config.js';
import type { RefundEvent, RefundReason, ValidationResult } from './types/events.js';
import type { X402Network } from './types/x402.js';
import { ZauthClient } from './client.js';

/**
 * Refund request parameters
 */
export interface RefundRequest {
  /** Original payment transaction hash */
  paymentTxHash: string;
  /** Amount to refund (in base units) */
  amount: string;
  /** Recipient address (original payer) */
  refundTo: string;
  /** Asset address (e.g., USDC contract) */
  asset: string;
  /** Network */
  network: X402Network;
  /** Reason for refund */
  reason: RefundReason;
  /** Additional details */
  details?: string;
  /** Request event ID for tracking */
  requestEventId: string;
  /** Payment event ID for tracking */
  paymentEventId: string;
  /** Endpoint URL */
  url: string;
}

/**
 * Refund result
 */
export interface RefundResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
}

/**
 * RefundHandler manages automatic refunds for providers
 */
export class RefundHandler {
  private config: RefundConfig;
  private client: ZauthClient;
  private viemAvailable = false;

  constructor(config: RefundConfig, client: ZauthClient) {
    this.config = config;
    this.client = client;

    // Check if viem is available
    this.checkViemAvailability();
  }

  private async checkViemAvailability(): Promise<void> {
    try {
      await import('viem');
      this.viemAvailable = true;
    } catch {
      this.viemAvailable = false;
      if (this.config.enabled) {
        console.warn(
          '[zauthSDK] Refunds are enabled but viem is not installed. ' +
          'Install viem to enable automatic refunds: npm install viem'
        );
      }
    }
  }

  /**
   * Check if refunds are available
   */
  isAvailable(): boolean {
    return this.config.enabled === true && this.viemAvailable && !!this.getPrivateKey();
  }

  /**
   * Get private key from config or env
   */
  private getPrivateKey(): string | undefined {
    return this.config.privateKey || process.env.ZAUTH_REFUND_PRIVATE_KEY;
  }

  /**
   * Check if a response should trigger a refund
   */
  shouldRefund(validationResult: ValidationResult, statusCode: number): RefundReason | null {
    if (!this.config.enabled) {
      return null;
    }

    const triggers = this.config.triggers;
    if (!triggers) {
      return null;
    }

    // Check server error
    if (triggers.serverError && statusCode >= 500) {
      return 'server_error';
    }

    // Check empty response
    if (triggers.emptyResponse) {
      const isEmpty = validationResult.checks.some(c => c.name === 'not_empty' && !c.passed);
      if (isEmpty) {
        return 'empty_response';
      }
    }

    // Check schema validation
    if (triggers.schemaValidation && !validationResult.valid) {
      return 'schema_validation_failed';
    }

    // Check meaningfulness threshold
    if (triggers.minMeaningfulness !== undefined) {
      if (validationResult.meaningfulnessScore < triggers.minMeaningfulness) {
        return 'invalid_response';
      }
    }

    return null;
  }

  /**
   * Process a refund
   */
  async processRefund(request: RefundRequest): Promise<RefundResult> {
    if (!this.isAvailable()) {
      return { success: false, error: 'Refunds not available' };
    }

    const privateKey = this.getPrivateKey();
    if (!privateKey) {
      return { success: false, error: 'No private key configured' };
    }

    // Check max refund amount
    const maxRefundUsd = this.config.maxRefundUsd ?? 1.00;
    const maxRefundBaseUnits = BigInt(Math.floor(maxRefundUsd * 1_000_000));
    const requestAmount = BigInt(request.amount);
    if (requestAmount > maxRefundBaseUnits) {
      return {
        success: false,
        error: `Refund amount ${request.amount} exceeds max ${maxRefundBaseUnits}`,
      };
    }

    // Check with service first (now using polling-based system)
    const approval = await this.client.requestRefund({
      url: request.url,
      requestEventId: request.requestEventId,
      paymentEventId: request.paymentEventId,
      reason: request.reason,
      details: request.details,
    });

    if (!approval.approved) {
      return { success: false, error: approval.message || 'Service denied refund' };
    }

    // Execute the refund based on network
    try {
      const result = await this.executeRefund(request, privateKey);

      // Report refund event
      if (result.success && result.transactionHash) {
        const refundEvent: RefundEvent = {
          ...this.client.createEventBase('refund'),
          type: 'refund',
          requestEventId: request.requestEventId,
          paymentEventId: request.paymentEventId,
          url: request.url,
          refundTransactionHash: result.transactionHash,
          amountRefunded: request.amount,
          amountRefundedUsdc: (Number(request.amount) / 1_000_000).toFixed(6),
          refundTo: request.refundTo,
          reason: request.reason,
          details: request.details,
        };
        this.client.queueEvent(refundEvent);
      }

      return result;
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Execute the actual refund transaction
   */
  private async executeRefund(request: RefundRequest, privateKey: string): Promise<RefundResult> {
    // Dynamically import viem
    const viem = await import('viem');
    const { createWalletClient, http, parseAbi } = viem;
    const { privateKeyToAccount } = await import('viem/accounts');
    const { base, baseSepolia } = await import('viem/chains');

    // Determine chain
    const chain = request.network === 'base-sepolia' ? baseSepolia : base;

    // Create account from private key
    const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const account = privateKeyToAccount(normalizedKey as `0x${string}`);

    // Create wallet client
    const client = createWalletClient({
      account,
      chain,
      transport: http(),
    });

    // ERC20 transfer ABI
    const erc20Abi = parseAbi([
      'function transfer(address to, uint256 amount) returns (bool)',
    ]);

    // Execute transfer
    const hash = await client.writeContract({
      address: request.asset as `0x${string}`,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [request.refundTo as `0x${string}`, BigInt(request.amount)],
    });

    return { success: true, transactionHash: hash };
  }
}

/**
 * Create a refund handler
 */
export function createRefundHandler(config: RefundConfig, client: ZauthClient): RefundHandler {
  return new RefundHandler(config, client);
}

// ============================================
// Refund Executor - WebSocket-based refund execution
// ============================================

import type {
  ResolvedRefundConfig,
  EndpointRefundConfig,
  ExecutedRefund,
  RefundError,
} from './types/config.js';
import type { PendingRefund } from './types/events.js';

// WebSocket implementation - resolved at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let WebSocketImpl: any = typeof WebSocket !== 'undefined' ? WebSocket : null;

async function getWebSocket(): Promise<typeof WebSocket | null> {
  if (WebSocketImpl) return WebSocketImpl;

  // Node.js environment - dynamically import ws
  try {
    const ws = await import('ws');
    WebSocketImpl = ws.default || ws;
    return WebSocketImpl;
  } catch {
    return null;
  }
}

/**
 * RefundExecutor handles real-time refund notifications via WebSocket
 * This is the bulletproof refund system where:
 * 1. SDK sends events to backend
 * 2. Backend analyzes, creates refund requests, stores in Redis
 * 3. Backend pushes refunds to SDK via WebSocket in real-time
 * 4. SDK executes refunds and confirms via WebSocket
 * 5. If SDK disconnects, pending refunds are resent on reconnect
 */
export class RefundExecutor {
  private client: ZauthClient;
  private config: ResolvedRefundConfig;
  private debug: boolean;
  private ws: InstanceType<typeof WebSocket> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private baseReconnectDelay = 1000;
  private persistentRetryDelay = 60000; // 60s in persistent phase
  private fastPhaseAttempts = 5; // Switch to persistent after 5 attempts
  private isShuttingDown = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  // Track daily/monthly totals locally for quick cap checks
  private todayRefundedCents = 0;
  private monthRefundedCents = 0;
  private lastCapResetDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  private lastCapResetMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

  // Track processed refundIds to prevent double execution within same session
  private processedRefundIds = new Set<string>();

  constructor(client: ZauthClient, config: ResolvedRefundConfig, debug = false) {
    this.client = client;
    this.config = config;
    this.debug = debug;
  }

  /**
   * Start the WebSocket connection for refund notifications
   */
  start(): void {
    if (!this.config.enabled) {
      this.log('Refund executor not enabled');
      return;
    }

    if (!this.config.signer && !this.config.privateKey) {
      this.log('Refund executor requires signer or privateKey');
      return;
    }

    this.log('Starting refund executor (WebSocket mode)', {
      maxRefundUsd: this.config.maxRefundUsd,
    });

    this.connect();
  }

  /**
   * Connect to the WebSocket server
   */
  private async connect(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    const WS = await getWebSocket();
    if (!WS) {
      this.log('WebSocket not available - install "ws" package for Node.js');
      return;
    }

    const clientConfig = this.client.getConfig();
    const wsEndpoint = clientConfig.apiEndpoint
      .replace('https://', 'wss://')
      .replace('http://', 'ws://');

    const wsUrl = `${wsEndpoint}/ws/refunds?apiKey=${encodeURIComponent(clientConfig.apiKey)}`;

    // Only log on first connection attempt
    if (this.reconnectAttempts === 0) {
      this.log('Connecting to refund WebSocket', { endpoint: wsEndpoint });
    }

    try {
      this.ws = new WS(wsUrl);

      this.ws.onopen = () => {
        if (this.reconnectAttempts > 0) {
          this.log('WebSocket reconnected');
        } else {
          this.log('WebSocket connected');
        }
        this.reconnectAttempts = 0;

        // Start ping interval to keep connection alive
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === 1 /* WebSocket.OPEN */) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30000);
      };

      this.ws.onmessage = (event) => {
        // Handle both string and Buffer (Node.js ws returns Buffer)
        const data = typeof event.data === 'string'
          ? event.data
          : event.data.toString();
        this.handleMessage(data);
      };

      this.ws.onclose = (event) => {
        // Only log on first disconnect, not on every retry failure
        if (this.reconnectAttempts === 0) {
          this.log('WebSocket disconnected', { code: event.code, reason: event.reason });
        }
        this.cleanup();
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // Silence error logs during retries — onclose handles reconnection
      };

    } catch (error) {
      this.scheduleReconnect();
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleMessage(data: string): Promise<void> {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'connected':
          this.log('Registered with server', { providerId: msg.providerId });
          break;

        case 'refund_required':
          this.log('Refund required', { refundId: msg.refund.id, amount: msg.refund.amountUsd });
          await this.processSingleRefund(msg.refund);
          break;

        case 'confirmation_ack':
          this.log('Refund confirmation acknowledged', { refundId: msg.refundId, status: msg.status });
          break;

        case 'rejection_ack':
          this.log('Refund rejection acknowledged', { refundId: msg.refundId });
          break;

        case 'executing_ack':
          // Server acknowledged we're executing this refund
          if (this.debug) {
            this.log('Refund executing acknowledged', { refundId: msg.refundId, status: msg.status });
          }
          break;

        case 'pong':
          // Server responded to ping
          break;

        default:
          this.log('Unknown message type', { type: msg.type });
      }
    } catch (error) {
      this.log('Error parsing WebSocket message', { error: (error as Error).message });
    }
  }

  /**
   * Process a single pending refund
   */
  private async processSingleRefund(refund: PendingRefund): Promise<void> {
    try {
      // Prevent double execution within same session
      if (this.processedRefundIds.has(refund.id)) {
        this.log('Refund already processed in this session', { refundId: refund.id });
        return;
      }

      // Check endpoint-specific config
      const endpointConfig = this.getEndpointConfig(refund.url);

      // Check if refunds are enabled for this endpoint
      if (endpointConfig?.enabled === false) {
        this.log('Refunds disabled for endpoint', { url: refund.url });
        this.sendMessage({
          type: 'refund_rejected',
          refundId: refund.id,
          reason: 'OTHER',
          note: 'Refunds disabled for this endpoint',
        });
        return;
      }

      // Check max refund amount
      const maxUsd = endpointConfig?.maxRefundUsd ?? this.config.maxRefundUsd;
      if (refund.amountUsd > maxUsd) {
        this.log('Refund exceeds max', { refundId: refund.id, amountUsd: refund.amountUsd, maxUsd });
        this.sendMessage({
          type: 'refund_rejected',
          refundId: refund.id,
          reason: 'EXCEEDED_CAP',
          note: `Amount ${refund.amountUsd} exceeds max ${maxUsd}`,
        });
        return;
      }

      // Reset caps if date/month has changed
      const today = new Date().toISOString().split('T')[0];
      const thisMonth = new Date().toISOString().slice(0, 7);
      if (today !== this.lastCapResetDate) {
        this.todayRefundedCents = 0;
        this.lastCapResetDate = today;
      }
      if (thisMonth !== this.lastCapResetMonth) {
        this.monthRefundedCents = 0;
        this.lastCapResetMonth = thisMonth;
      }

      // Check daily cap
      if (this.config.dailyCapUsd) {
        const dailyCapCents = Math.floor(this.config.dailyCapUsd * 100);
        if (this.todayRefundedCents + refund.amountCents > dailyCapCents) {
          this.log('Daily cap exceeded', { refundId: refund.id });
          this.sendMessage({
            type: 'refund_rejected',
            refundId: refund.id,
            reason: 'EXCEEDED_CAP',
            note: 'Daily refund cap exceeded',
          });
          return;
        }
      }

      // Check monthly cap
      if (this.config.monthlyCapUsd) {
        const monthlyCapCents = Math.floor(this.config.monthlyCapUsd * 100);
        if (this.monthRefundedCents + refund.amountCents > monthlyCapCents) {
          this.log('Monthly cap exceeded', { refundId: refund.id });
          this.sendMessage({
            type: 'refund_rejected',
            refundId: refund.id,
            reason: 'EXCEEDED_CAP',
            note: 'Monthly refund cap exceeded',
          });
          return;
        }
      }

      // Notify server we're about to execute (prevents re-send on reconnect)
      this.sendMessage({
        type: 'refund_executing',
        refundId: refund.id,
      });

      // Execute the refund
      const result = await this.executeRefundTx(refund);

      if (result.success) {
        // Mark as processed to prevent double execution in same session
        this.processedRefundIds.add(refund.id);

        // Confirm via WebSocket
        this.sendMessage({
          type: 'refund_confirmed',
          refundId: refund.id,
          txHash: result.txHash,
          network: refund.network,
          amountRaw: result.amountRaw,
          token: 'USDC',
          gasCostCents: result.gasCostCents,
        });

        // Update local stats
        this.todayRefundedCents += refund.amountCents;
        this.monthRefundedCents += refund.amountCents;

        // Callback
        if (this.config.onRefund) {
          const executedRefund: ExecutedRefund = {
            refundId: refund.id,
            requestId: refund.sdkRequestEventId || '',
            url: refund.url,
            amountUsd: refund.amountUsd,
            amountRaw: result.amountRaw!,
            txHash: result.txHash!,
            network: refund.network,
            recipient: refund.recipientAddress,
            reason: refund.reason,
            executedAt: new Date().toISOString(),
          };
          await this.config.onRefund(executedRefund);
        }

      } else {
        this.log('Refund execution failed', { refundId: refund.id, error: result.error });

        // Don't reject on retryable errors - server will resend on reconnect
        if (!result.retryable) {
          this.sendMessage({
            type: 'refund_rejected',
            refundId: refund.id,
            reason: 'OTHER',
            note: result.error || 'Execution failed',
          });
        }

        // Callback
        if (this.config.onRefundError) {
          const refundError: RefundError = {
            refundId: refund.id,
            url: refund.url,
            amountUsd: refund.amountUsd,
            error: result.error || 'Unknown error',
            retryable: result.retryable ?? true,
          };
          await this.config.onRefundError(refundError);
        }
      }

    } catch (error) {
      this.log('Error processing refund', { refundId: refund.id, error: (error as Error).message });

      if (this.config.onRefundError) {
        await this.config.onRefundError({
          refundId: refund.id,
          url: refund.url,
          amountUsd: refund.amountUsd,
          error: (error as Error).message,
          retryable: true,
        });
      }
    }
  }

  /**
   * Send message via WebSocket
   */
  private sendMessage(msg: unknown): void {
    if (this.ws?.readyState === 1 /* WebSocket.OPEN */) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.log('Cannot send message - WebSocket not connected');
    }
  }

  /**
   * Schedule reconnection with two-phase strategy:
   * - Fast phase: exponential backoff (1s, 2s, 4s, 8s, 16s) for quick recovery
   * - Persistent phase: fixed 60s interval, retries indefinitely until reconnected
   */
  private scheduleReconnect(): void {
    if (this.isShuttingDown) {
      return;
    }

    let delay: number;
    if (this.reconnectAttempts < this.fastPhaseAttempts) {
      // Fast phase: exponential backoff
      delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts);
    } else {
      // Persistent phase: fixed interval
      if (this.reconnectAttempts === this.fastPhaseAttempts) {
        this.log('Server unreachable, retrying every 60s');
      }
      delay = this.persistentRetryDelay;
    }

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Stop the WebSocket connection
   */
  stop(): void {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.cleanup();

    if (this.ws) {
      this.ws.close(1000, 'Shutdown');
      this.ws = null;
    }

    this.log('Refund executor stopped');
  }

  /**
   * Execute a refund transaction on-chain
   */
  private async executeRefundTx(refund: PendingRefund): Promise<{
    success: boolean;
    txHash?: string;
    amountRaw?: string;
    gasCostCents?: number;
    error?: string;
    retryable?: boolean;
  }> {
    const network = refund.network;

    // Convert USD to token amount (USDC has 6 decimals)
    const amountRaw = String(Math.floor(refund.amountUsd * 1_000_000));

    try {
      if (network.startsWith('eip155:') || network === 'base' || network === 'ethereum') {
        return await this.executeEvmRefund(refund, amountRaw);
      } else if (network === 'solana' || network.startsWith('solana:')) {
        return await this.executeSolanaRefund(refund, amountRaw);
      } else {
        return {
          success: false,
          error: `Unsupported network: ${network}`,
          retryable: false,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        retryable: true,
      };
    }
  }

  /**
   * Execute EVM refund (Base, Ethereum, etc.)
   */
  private async executeEvmRefund(refund: PendingRefund, amountRaw: string): Promise<{
    success: boolean;
    txHash?: string;
    amountRaw?: string;
    gasCostCents?: number;
    error?: string;
    retryable?: boolean;
  }> {
    const signer = this.config.signer || this.config.privateKey;
    if (!signer) {
      return { success: false, error: 'No signer configured', retryable: false };
    }

    try {
      // Dynamic import viem
      const { createWalletClient, http } = await import('viem');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { base } = await import('viem/chains');

      // USDC contract address on Base
      const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

      // Get account from signer
      const account = typeof signer === 'string'
        ? privateKeyToAccount(signer as `0x${string}`)
        : signer as ReturnType<typeof privateKeyToAccount>;

      // Create wallet client
      const client = createWalletClient({
        account,
        chain: base,
        transport: http(),
      });

      // ERC20 transfer ABI
      const erc20Abi = [
        {
          name: 'transfer',
          type: 'function',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ] as const;

      // Send transaction
      const hash = await client.writeContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [refund.recipientAddress as `0x${string}`, BigInt(amountRaw)],
      });

      this.log('EVM refund sent', { txHash: hash, to: refund.recipientAddress, amount: amountRaw });

      return {
        success: true,
        txHash: hash,
        amountRaw,
        gasCostCents: 1, // TODO: Calculate actual gas cost
      };

    } catch (error) {
      this.log('EVM refund failed', { error: (error as Error).message });
      return {
        success: false,
        error: (error as Error).message,
        retryable: true,
      };
    }
  }

  /**
   * Execute Solana refund using @solana/kit v2 libraries
   */
  private async executeSolanaRefund(refund: PendingRefund, amountRaw: string): Promise<{
    success: boolean;
    txHash?: string;
    amountRaw?: string;
    gasCostCents?: number;
    error?: string;
    retryable?: boolean;
  }> {
    try {
      // Get Solana private key
      const solanaPrivateKey = this.config.solanaPrivateKey;
      if (!solanaPrivateKey) {
        return {
          success: false,
          error: 'No Solana private key configured (set ZAUTH_SOLANA_PRIVATE_KEY)',
          retryable: false,
        };
      }

      // Dynamically import Solana v2 packages
      const { createKeyPairSignerFromPrivateKeyBytes } = await import('@solana/signers');
      const {
        createSolanaRpc,
        address,
        pipe,
        createTransactionMessage,
        setTransactionMessageFeePayer,
        setTransactionMessageLifetimeUsingBlockhash,
        appendTransactionMessageInstructions,
        signTransactionMessageWithSigners,
        getBase64EncodedWireTransaction,
      } = await import('@solana/kit');
      const {
        findAssociatedTokenPda,
        getTransferInstruction,
        TOKEN_PROGRAM_ADDRESS,
      } = await import('@solana-program/token');
      const bs58 = await import('bs58');

      // USDC mint on Solana mainnet
      const USDC_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

      // Create RPC client
      const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      const rpc = createSolanaRpc(rpcUrl);

      // Create signer from private key (base58 encoded -> 64 bytes -> first 32 bytes for private key)
      let signer: Awaited<ReturnType<typeof createKeyPairSignerFromPrivateKeyBytes>>;
      try {
        const secretKey = bs58.default.decode(solanaPrivateKey);
        // The secret key is 64 bytes: first 32 are private key, last 32 are public key
        const privateKeyBytes = secretKey.slice(0, 32);
        signer = await createKeyPairSignerFromPrivateKeyBytes(privateKeyBytes);
      } catch {
        return {
          success: false,
          error: 'Invalid Solana private key format (expected base58)',
          retryable: false,
        };
      }

      // Parse recipient address
      const recipientAddress = address(refund.recipientAddress);

      // Find ATAs for sender and recipient
      const [senderAta] = await findAssociatedTokenPda({
        mint: USDC_MINT,
        owner: signer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const [recipientAta] = await findAssociatedTokenPda({
        mint: USDC_MINT,
        owner: recipientAddress,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      // Create transfer instruction
      const transferIx = getTransferInstruction({
        source: senderAta,
        destination: recipientAta,
        authority: signer,
        amount: BigInt(amountRaw),
      });

      // Get latest blockhash
      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

      // Build transaction
      const tx = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayer(signer.address, tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
        (tx) => appendTransactionMessageInstructions([transferIx], tx),
      );

      // Sign transaction
      const signedTx = await signTransactionMessageWithSigners(tx);

      // Send transaction
      const base64Tx = getBase64EncodedWireTransaction(signedTx);
      const txSignature = await rpc.sendTransaction(base64Tx, { encoding: 'base64' }).send();

      this.log('Solana refund sent', {
        txHash: txSignature,
        to: refund.recipientAddress,
        amount: amountRaw,
      });

      return {
        success: true,
        txHash: txSignature,
        amountRaw,
        gasCostCents: 0, // Solana fees are negligible
      };

    } catch (error) {
      this.log('Solana refund failed', { error: (error as Error).message });
      return {
        success: false,
        error: (error as Error).message,
        retryable: true,
      };
    }
  }

  /**
   * Get endpoint-specific config by matching URL patterns
   */
  private getEndpointConfig(url: string): EndpointRefundConfig | undefined {
    for (const [pattern, config] of Object.entries(this.config.endpoints)) {
      // Support * wildcard in patterns
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(url)) {
        return config;
      }
    }
    return undefined;
  }

  /**
   * Debug logger
   */
  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[zauthSDK:refund]', ...args);
    }
  }
}

/**
 * Create a refund executor for WebSocket-based refunds
 */
export function createRefundExecutor(
  client: ZauthClient,
  config: ResolvedRefundConfig,
  debug = false
): RefundExecutor {
  return new RefundExecutor(client, config, debug);
}
