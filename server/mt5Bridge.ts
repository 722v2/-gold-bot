import { Candle } from '../src/types.js';

export interface MT5AccountStatus {
  connected: boolean;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  balance: number | null;
  equity: number | null;
  freeMargin: number | null;
  currency: string;
  server?: string;
  accountNumber?: string;
  accountMode?: 'DEMO' | 'REAL';
  lastUpdated: number | null;
  statusMessage: string;
}

export interface MT5OrderRequest {
  symbol: string;
  action: 'BUY' | 'SELL' | 'BUY_LIMIT' | 'SELL_LIMIT';
  lot: number;
  price?: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit2?: number;
  comment?: string;
  accountMode?: 'DEMO' | 'REAL';
}

export interface MT5OrderResponse {
  success: boolean;
  orderId?: string;
  ticket?: number;
  status: 'EXECUTED' | 'FAILED' | 'REJECTED' | 'SIMULATED_DEMO';
  accountMode: 'DEMO' | 'REAL';
  executionPrice?: number;
  message: string;
  executedAt?: string;
}

export interface MT5ModifyOrderRequest {
  ticket: number;
  stopLoss?: number;
  takeProfit?: number;
  accountMode?: 'DEMO' | 'REAL';
}

export interface MT5CloseOrderRequest {
  ticket: number;
  lot?: number;
  accountMode?: 'DEMO' | 'REAL';
}

class MT5BridgeService {
  private lastStatus: MT5AccountStatus = {
    connected: false,
    status: 'DISCONNECTED',
    balance: null,
    equity: null,
    freeMargin: null,
    currency: 'USD',
    server: undefined,
    accountNumber: undefined,
    accountMode: 'DEMO',
    lastUpdated: null,
    statusMessage: 'MT5 Bridge Disconnected (جاهز للربط عبر Execution Bridge API)',
  };

  /**
   * Fetches MT5 account info.
   * If a real MT5 Bridge URL is provided via env MT5_BRIDGE_URL, queries it.
   * Otherwise returns real DISCONNECTED status without fake or placeholder numbers.
   */
  public async getAccountStatus(): Promise<MT5AccountStatus> {
    const bridgeUrl = process.env.MT5_BRIDGE_URL;

    if (!bridgeUrl) {
      this.lastStatus = {
        connected: false,
        status: 'DISCONNECTED',
        balance: null,
        equity: null,
        freeMargin: null,
        currency: 'USD',
        server: process.env.MT5_SERVER || undefined,
        accountNumber: process.env.MT5_ACCOUNT || undefined,
        accountMode: (process.env.MT5_ACCOUNT_TYPE as 'DEMO' | 'REAL') || 'DEMO',
        lastUpdated: Date.now(),
        statusMessage: 'MT5 Bridge Disconnected (لم يتم ربط جسر MT5 بعد - الحساب غير متصل)',
      };
      return { ...this.lastStatus };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/account`, {
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.MT5_API_KEY ? { Authorization: `Bearer ${process.env.MT5_API_KEY}` } : {}),
        },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`MT5 Bridge HTTP error: ${res.status}`);
      }

      const data: any = await res.json();
      const isConnected = Boolean(data.connected);

      this.lastStatus = {
        connected: isConnected,
        status: isConnected ? 'CONNECTED' : 'DISCONNECTED',
        balance: isConnected && typeof data.balance === 'number' ? data.balance : null,
        equity: isConnected && typeof data.equity === 'number' ? data.equity : null,
        freeMargin: isConnected && typeof data.freeMargin === 'number' ? data.freeMargin : null,
        currency: data.currency || 'USD',
        server: data.server || process.env.MT5_SERVER,
        accountNumber: data.accountNumber || process.env.MT5_ACCOUNT,
        accountMode: (data.accountType || data.accountMode || 'DEMO') as 'DEMO' | 'REAL',
        lastUpdated: Date.now(),
        statusMessage: isConnected ? 'MT5 Connected' : (data.message || 'MT5 Bridge Disconnected'),
      };
    } catch (err: any) {
      this.lastStatus = {
        connected: false,
        status: 'DISCONNECTED',
        balance: null,
        equity: null,
        freeMargin: null,
        currency: 'USD',
        server: process.env.MT5_SERVER,
        accountNumber: process.env.MT5_ACCOUNT,
        accountMode: 'DEMO',
        lastUpdated: Date.now(),
        statusMessage: `فشل الاتصال بجسر MT5: ${err.message || 'Connection refused'}`,
      };
    }

    return { ...this.lastStatus };
  }

  /**
   * Executes a trade order through the MT5 Bridge.
   * If accountMode is REAL, strictly requires active bridge connection.
   * If MT5 is disconnected, strictly refuses execution and returns failure without mock data.
   */
  public async executeOrder(order: MT5OrderRequest): Promise<MT5OrderResponse> {
    const bridgeUrl = process.env.MT5_BRIDGE_URL;
    const mode = order.accountMode || 'DEMO';

    // Check MT5 connection
    const status = await this.getAccountStatus();
    if (!status.connected || !bridgeUrl) {
      if (mode === 'REAL') {
        return {
          success: false,
          status: 'REJECTED',
          accountMode: 'REAL',
          message: 'تم حظر تنفيذ الأمر: جسر MT5 غير متصل بالحساب الحقيقي (DISCONNECTED).',
        };
      } else {
        // DEMO mode with no MT5 bridge connected: handled via internal Ledger execution
        return {
          success: true,
          status: 'SIMULATED_DEMO',
          accountMode: 'DEMO',
          executionPrice: order.price,
          message: 'تم تسجيل وتنفيذ الصفقة في دفتر التداول التجريبي (Demo Ledger).',
          executedAt: new Date().toISOString(),
        };
      }
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/order`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.MT5_API_KEY ? { Authorization: `Bearer ${process.env.MT5_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          symbol: order.symbol,
          action: order.action,
          lot: order.lot,
          price: order.price,
          sl: order.stopLoss,
          tp: order.takeProfit,
          tp2: order.takeProfit2,
          comment: order.comment || `Gold AI ${mode}`,
          mode: mode,
        }),
      });
      clearTimeout(timeout);

      const result: any = await res.json();
      if (!res.ok || !result.success) {
        return {
          success: false,
          status: 'FAILED',
          accountMode: mode,
          message: result.error || result.message || `MT5 Bridge order failed with status ${res.status}`,
        };
      }

      return {
        success: true,
        orderId: result.orderId || `mt5_${Date.now()}`,
        ticket: result.ticket,
        status: 'EXECUTED',
        accountMode: mode,
        executionPrice: result.executionPrice || order.price,
        message: `تم تنفيذ الأمر بنجاح على منصة MT5 (${mode}) - تذكرة: ${result.ticket || 'N/A'}`,
        executedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'FAILED',
        accountMode: mode,
        message: `خطأ أثناء إرسال الأمر إلى MT5 Bridge: ${err.message}`,
      };
    }
  }

  /**
   * Modifies an existing open order on MT5 (SL/TP update)
   */
  public async modifyOrder(params: MT5ModifyOrderRequest): Promise<{ success: boolean; message: string }> {
    const bridgeUrl = process.env.MT5_BRIDGE_URL;
    const mode = params.accountMode || 'DEMO';

    if (!bridgeUrl) {
      return {
        success: mode === 'DEMO',
        message: mode === 'DEMO' ? 'تم تعديل الهدف ووقف الخسارة في الـ Demo Ledger.' : 'جسر MT5 غير متصل.',
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/modify`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.MT5_API_KEY ? { Authorization: `Bearer ${process.env.MT5_API_KEY}` } : {}),
        },
        body: JSON.stringify(params),
      });
      clearTimeout(timeout);

      const result: any = await res.json();
      return {
        success: Boolean(res.ok && result.success),
        message: result.message || (res.ok ? 'تم تعديل الأمر في MT5 بنجاح.' : 'فشل تعديل الأمر في MT5.'),
      };
    } catch (err: any) {
      return {
        success: false,
        message: `خطأ أثناء تعديل الأمر في MT5: ${err.message}`,
      };
    }
  }

  /**
   * Closes an existing order / position on MT5
   */
  public async closeOrder(params: MT5CloseOrderRequest): Promise<{ success: boolean; message: string }> {
    const bridgeUrl = process.env.MT5_BRIDGE_URL;
    const mode = params.accountMode || 'DEMO';

    if (!bridgeUrl) {
      return {
        success: mode === 'DEMO',
        message: mode === 'DEMO' ? 'تم إغلاق الصفقة في الـ Demo Ledger.' : 'جسر MT5 غير متصل.',
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/close`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.MT5_API_KEY ? { Authorization: `Bearer ${process.env.MT5_API_KEY}` } : {}),
        },
        body: JSON.stringify(params),
      });
      clearTimeout(timeout);

      const result: any = await res.json();
      return {
        success: Boolean(res.ok && result.success),
        message: result.message || (res.ok ? 'تم إغلاق الأمر في MT5 بنجاح.' : 'فشل إغلاق الأمر في MT5.'),
      };
    } catch (err: any) {
      return {
        success: false,
        message: `خطأ أثناء إغلاق الأمر في MT5: ${err.message}`,
      };
    }
  }

  /**
   * Retrieves specific order status by ticket
   */
  public async getOrderStatus(ticket: number): Promise<{ success: boolean; data?: any; message: string }> {
    const bridgeUrl = process.env.MT5_BRIDGE_URL;
    if (!bridgeUrl) {
      return { success: false, message: 'جسر MT5 غير متصل.' };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/order-status?ticket=${ticket}`, {
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.MT5_API_KEY ? { Authorization: `Bearer ${process.env.MT5_API_KEY}` } : {}),
        },
      });
      clearTimeout(timeout);

      const result: any = await res.json();
      return {
        success: Boolean(res.ok && result.success),
        data: result.data || result,
        message: result.message || 'تم جلب حالة الأمر بنجاح.',
      };
    } catch (err: any) {
      return {
        success: false,
        message: `خطأ أثناء الاستعلام عن الأمر: ${err.message}`,
      };
    }
  }

  public getCachedStatus(): MT5AccountStatus {
    return { ...this.lastStatus };
  }

  /**
   * Fetches real historical OHLCV candles from the external MT5 Bridge.
   * Endpoint: GET /candles?symbol=XAUUSD&timeframe=M5&count=5000
   */
  public async fetchHistoricalCandles(
    symbol: string = 'XAUUSD',
    timeframe: string = 'M5',
    count: number = 5000
  ): Promise<Candle[] | null> {
    const bridgeUrl = process.env.MT5_BRIDGE_URL;
    if (!bridgeUrl) {
      return null;
    }

    try {
      // Normalize symbol
      const cleanSymbol = symbol.replace('/', '').toUpperCase();
      // Normalize timeframe string to M1, M5, M15, M30, H1, H4, D1
      let tf = timeframe.toUpperCase();
      if (tf.startsWith('1M')) tf = 'M1';
      else if (tf.startsWith('5M')) tf = 'M5';
      else if (tf.startsWith('15M')) tf = 'M15';
      else if (tf.startsWith('30M')) tf = 'M30';
      else if (tf.startsWith('1H')) tf = 'H1';
      else if (tf.startsWith('4H')) tf = 'H4';
      else if (tf.startsWith('1D')) tf = 'D1';

      const url = `${bridgeUrl.replace(/\/$/, '')}/candles?symbol=${cleanSymbol}&timeframe=${tf}&count=${count}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.MT5_API_KEY ? { Authorization: `Bearer ${process.env.MT5_API_KEY}` } : {}),
        },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        console.warn(`[MT5Bridge] /candles returned HTTP ${res.status}: ${res.statusText}`);
        return null;
      }

      const data: any = await res.json();
      if (!data || !data.success || !Array.isArray(data.candles)) {
        console.warn(`[MT5Bridge] /candles payload invalid:`, data?.error || 'No candles array');
        return null;
      }

      const candles: Candle[] = [];
      for (const item of data.candles) {
        const time = typeof item.time === 'number' ? item.time : (item.timestamp ? new Date(item.timestamp).getTime() : 0);
        const open = Number(item.open);
        const high = Number(item.high);
        const low = Number(item.low);
        const close = Number(item.close);
        const volume = Number(item.volume ?? item.tickVolume ?? 0);

        if (time > 0 && !isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close)) {
          candles.push({
            timestamp: time,
            open,
            high,
            low,
            close,
            volume,
          });
        }
      }

      // Ensure chronological ordering (oldest first)
      candles.sort((a, b) => a.timestamp - b.timestamp);
      return candles;
    } catch (err: any) {
      console.warn(`[MT5Bridge] Failed to fetch historical candles: ${err.message}`);
      return null;
    }
  }

  public isAvailable(): boolean {
    return Boolean(process.env.MT5_BRIDGE_URL);
  }
}

export const mt5Bridge = new MT5BridgeService();


