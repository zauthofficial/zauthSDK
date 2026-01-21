/**
 * ZauthClient - API client for zauthx402 service
 * Handles event batching and submission
 */

import type {
  ZauthConfig,
  ResolvedConfig,
  ZauthEvent,
  EventBatch,
  EventSubmitResponse,
  PendingRefundsResponse,
  ConfirmRefundRequest,
  ConfirmRefundResponse,
  RejectRefundRequest,
  RejectRefundResponse,
} from './types/index.js';
import { resolveConfig } from './types/config.js';

const SDK_VERSION = '0.1.0';

/**
 * Generate a unique event ID
 */
function generateEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Generate a unique batch ID
 */
function generateBatchId(): string {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * ZauthClient handles communication with the zauthx402 API
 */
export class ZauthClient {
  private config: ResolvedConfig;
  private eventQueue: ZauthEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing = false;

  constructor(config: ZauthConfig) {
    if (!config.apiKey) {
      throw new Error('zauthSDK: apiKey is required');
    }
    this.config = resolveConfig(config);
    this.log('Client initialized', { mode: this.config.mode, environment: this.config.environment });
  }

  /**
   * Debug logger
   */
  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[zauthSDK]', ...args);
    }
  }

  /**
   * Create base event with common fields
   */
  createEventBase<T extends ZauthEvent['type']>(type: T): { eventId: string; timestamp: string; type: T; apiKey: string; sdkVersion: string } {
    return {
      eventId: generateEventId(),
      timestamp: new Date().toISOString(),
      type,
      apiKey: this.config.apiKey,
      sdkVersion: SDK_VERSION,
    };
  }

  /**
   * Queue an event for batched submission
   */
  queueEvent(event: ZauthEvent): void {
    this.eventQueue.push(event);
    this.log('Event queued', { type: event.type, eventId: event.eventId, queueSize: this.eventQueue.length });

    // Flush if batch size reached
    if (this.eventQueue.length >= this.config.batching.maxBatchSize) {
      this.flush();
      return;
    }

    // Start flush timer if not already running
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush();
      }, this.config.batching.maxBatchWaitMs);
    }
  }

  /**
   * Send an event immediately (bypasses batching)
   */
  async sendEvent(event: ZauthEvent): Promise<EventSubmitResponse> {
    return this.submitBatch([event]);
  }

  /**
   * Flush queued events
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.eventQueue.length === 0 || this.isFlushing) {
      return;
    }

    this.isFlushing = true;
    const events = [...this.eventQueue];
    this.eventQueue = [];

    try {
      await this.submitBatch(events);
    } catch (error) {
      // Re-queue failed events if retry is enabled
      if (this.config.batching.retry) {
        this.log('Batch failed, re-queuing events', { count: events.length });
        this.eventQueue.unshift(...events);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Submit a batch of events to the API
   */
  private async submitBatch(events: ZauthEvent[], retryCount = 0): Promise<EventSubmitResponse> {
    const batch: EventBatch = {
      events,
      batchId: generateBatchId(),
      sentAt: new Date().toISOString(),
    };

    this.log('Submitting batch', { batchId: batch.batchId, eventCount: events.length });

    try {
      const response = await fetch(`${this.config.apiEndpoint}/api/sdk/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
          'X-SDK-Version': SDK_VERSION,
          'X-Environment': this.config.environment,
        },
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      const result = await response.json() as EventSubmitResponse;
      this.log('Batch submitted', { batchId: batch.batchId, accepted: result.accepted });
      return result;

    } catch (error) {
      this.log('Batch submission failed', { batchId: batch.batchId, error: (error as Error).message });

      // Retry logic
      if (this.config.batching.retry && retryCount < this.config.batching.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
        this.log('Retrying batch', { batchId: batch.batchId, retryCount: retryCount + 1, delay });
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.submitBatch(events, retryCount + 1);
      }

      throw error;
    }
  }

  /**
   * Check endpoint status from zauthx402 registry
   */
  async checkEndpoint(url: string): Promise<{
    verified: boolean;
    working: boolean;
    meaningful: boolean;
    lastChecked?: string;
    uptime?: number;
  }> {
    try {
      const response = await fetch(`${this.config.apiEndpoint}/api/verification/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
        },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        return { verified: false, working: false, meaningful: false };
      }

      const data = await response.json() as Record<string, unknown>;
      return {
        verified: data.verified as boolean ?? false,
        working: data.working as boolean ?? false,
        meaningful: data.meaningful as boolean ?? false,
        lastChecked: data.checkedAt as string | undefined,
        uptime: data.uptime as number | undefined,
      };
    } catch {
      return { verified: false, working: false, meaningful: false };
    }
  }

  /**
   * Request a refund for a bad response
   */
  async requestRefund(params: {
    url: string;
    requestEventId: string;
    paymentEventId: string;
    reason: string;
    details?: string;
  }): Promise<{ approved: boolean; refundId?: string; message?: string }> {
    try {
      const response = await fetch(`${this.config.apiEndpoint}/api/sdk/refund/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
        },
        body: JSON.stringify(params),
      });

      const data = await response.json() as Record<string, unknown>;
      return {
        approved: data.approved as boolean ?? false,
        refundId: data.refundId as string | undefined,
        message: data.message as string | undefined,
      };
    } catch {
      return { approved: false, message: 'Failed to request refund' };
    }
  }

  /**
   * Get resolved configuration
   */
  getConfig(): ResolvedConfig {
    return this.config;
  }

  // ============================================
  // Refund Methods
  // ============================================

  /**
   * Get pending refunds that need to be executed
   * These are refunds that the server has approved based on bad response detection
   */
  async getPendingRefunds(limit = 10): Promise<PendingRefundsResponse> {
    try {
      const response = await fetch(`${this.config.apiEndpoint}/api/sdk/refunds/pending`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
          'X-SDK-Version': SDK_VERSION,
        },
        body: JSON.stringify({ limit }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        this.log('Failed to get pending refunds', { status: response.status, error: errorText });
        return { refunds: [], total: 0, stats: { todayRefundedCents: 0, monthRefundedCents: 0 } };
      }

      const data = await response.json() as PendingRefundsResponse;
      this.log('Got pending refunds', { count: data.refunds.length, total: data.total });
      return data;

    } catch (error) {
      this.log('Error getting pending refunds', { error: (error as Error).message });
      return { refunds: [], total: 0, stats: { todayRefundedCents: 0, monthRefundedCents: 0 } };
    }
  }

  /**
   * Confirm that a refund was successfully executed
   */
  async confirmRefund(request: ConfirmRefundRequest): Promise<ConfirmRefundResponse> {
    try {
      const response = await fetch(`${this.config.apiEndpoint}/api/sdk/refunds/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
          'X-SDK-Version': SDK_VERSION,
        },
        body: JSON.stringify(request),
      });

      const data = await response.json() as ConfirmRefundResponse;

      if (data.success) {
        this.log('Refund confirmed', { refundId: request.refundId, txHash: request.txHash });
      } else {
        this.log('Refund confirmation failed', { refundId: request.refundId, status: data.status });
      }

      return data;

    } catch (error) {
      this.log('Error confirming refund', { refundId: request.refundId, error: (error as Error).message });
      return {
        success: false,
        refundId: request.refundId,
        status: 'ERROR',
        message: (error as Error).message,
      };
    }
  }

  /**
   * Reject/skip a pending refund
   */
  async rejectRefund(request: RejectRefundRequest): Promise<RejectRefundResponse> {
    try {
      const response = await fetch(`${this.config.apiEndpoint}/api/sdk/refunds/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
          'X-SDK-Version': SDK_VERSION,
        },
        body: JSON.stringify(request),
      });

      const data = await response.json() as RejectRefundResponse;
      this.log('Refund rejected', { refundId: request.refundId, reason: request.reason });
      return data;

    } catch (error) {
      this.log('Error rejecting refund', { refundId: request.refundId, error: (error as Error).message });
      return {
        success: false,
        refundId: request.refundId,
        status: 'ERROR',
      };
    }
  }

  /**
   * Update provider's refund configuration on the server
   */
  async updateRefundConfig(config: {
    enabled?: boolean;
    maxRefundUsdCents?: number;
    dailyCapCents?: number;
    monthlyCapCents?: number;
    triggers?: {
      serverError?: boolean;
      timeout?: boolean;
      emptyResponse?: boolean;
      schemaValidation?: boolean;
      minMeaningfulness?: number;
    };
  }): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await fetch(`${this.config.apiEndpoint}/api/sdk/refunds/config`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
          'X-SDK-Version': SDK_VERSION,
        },
        body: JSON.stringify(config),
      });

      const data = await response.json() as { success: boolean; message?: string };
      this.log('Refund config updated', { success: data.success });
      return data;

    } catch (error) {
      this.log('Error updating refund config', { error: (error as Error).message });
      return { success: false, message: (error as Error).message };
    }
  }

  /**
   * Get refund history/stats
   */
  async getRefundStats(days = 30): Promise<{
    totalRefunds: number;
    totalAmountCents: number;
    byReason: Record<string, number>;
    byEndpoint: Record<string, { count: number; amountCents: number }>;
    dailyTotals: Array<{ date: string; count: number; amountCents: number }>;
  }> {
    try {
      const response = await fetch(`${this.config.apiEndpoint}/api/sdk/refunds/stats?days=${days}`, {
        headers: {
          'X-API-Key': this.config.apiKey,
          'X-SDK-Version': SDK_VERSION,
        },
      });

      if (!response.ok) {
        return {
          totalRefunds: 0,
          totalAmountCents: 0,
          byReason: {},
          byEndpoint: {},
          dailyTotals: [],
        };
      }

      return await response.json() as {
        totalRefunds: number;
        totalAmountCents: number;
        byReason: Record<string, number>;
        byEndpoint: Record<string, { count: number; amountCents: number }>;
        dailyTotals: Array<{ date: string; count: number; amountCents: number }>;
      };

    } catch (error) {
      this.log('Error getting refund stats', { error: (error as Error).message });
      return {
        totalRefunds: 0,
        totalAmountCents: 0,
        byReason: {},
        byEndpoint: {},
        dailyTotals: [],
      };
    }
  }

  /**
   * Shutdown client gracefully
   */
  async shutdown(): Promise<void> {
    this.log('Shutting down client');
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

/**
 * Create a new ZauthClient instance
 */
export function createClient(config: ZauthConfig): ZauthClient {
  return new ZauthClient(config);
}
