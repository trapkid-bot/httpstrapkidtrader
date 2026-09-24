/**
 * TrapKid Analyzer signal/live-feed bridge.
 * The Analyzer is the master source for market selection, live ticks and locked signals.
 */

declare global {
    interface Window {
        __TRAPKID_ANALYZER_WS_URL__?: string;
    }
}

const DEFAULT_URL = 'wss://shipping-cos-zum-horse.trycloudflare.com/ws/ticks';

const getUrl = () => {
    if (typeof window !== 'undefined' && window.__TRAPKID_ANALYZER_WS_URL__) {
        return window.__TRAPKID_ANALYZER_WS_URL__;
    }
    return DEFAULT_URL;
};

class AnalyzerSignalService {
    ws = null;
    reconnectTimer = null;
    latestSignal = null;
    activeSignal = null;
    latestFeed = null;
    feedHistory = [];
    selectedMarket = null;
    markets = [];
    analyzerStatus = null;
    listeners = new Set();
    manuallyStopped = false;
    connected = false;
    executionQueue = [];

    constructor() {
        if (typeof window !== 'undefined') this.connect();
    }

    setConnected(connected) {
        this.connected = Boolean(connected);
        this.emit({ type: 'STATUS', connected: this.connected, status: this.analyzerStatus });
    }

    connect() {
        if (this.manuallyStopped || typeof window === 'undefined') return;
        if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;

        try {
            const url = getUrl();
            console.info('[TrapKid Analyzer] Connecting to:', url);
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                this.setConnected(true);
                this.ws?.send(JSON.stringify({ type: 'STATUS' }));
                if (this.executionQueue.length) {
                    const queue = [...this.executionQueue];
                    this.executionQueue = [];
                    queue.forEach(message => {
                        try { this.ws?.send(JSON.stringify(message)); } catch { this.executionQueue.push(message); }
                    });
                }
            };

            this.ws.onmessage = event => {
                try { this.handleMessage(JSON.parse(event.data)); } catch { /* ignore malformed messages */ }
            };

            this.ws.onerror = () => this.setConnected(false);
            this.ws.onclose = () => {
                this.ws = null;
                this.setConnected(false);
                if (!this.manuallyStopped) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
                }
            };
        } catch {
            this.setConnected(false);
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    }

    handleMessage(message) {
        if (message.type === 'MARKET_SELECTED' || message.type === 'MARKET_CHANGED' || message.type === 'SELECTED_MARKET') {
            const selected = message.market || message.symbol || message.selectedMarket || message.data?.market || message.data?.symbol;
            if (selected) this.selectedMarket = typeof selected === 'string' ? selected : (selected.symbol || selected.code || null);
            this.emit({ type: 'MARKET_SELECTED', market: this.selectedMarket, data: message });
            return;
        }

        if (message.type === 'MARKETS') {
            this.markets = Array.isArray(message.markets) ? message.markets : (Array.isArray(message.data) ? message.data : []);
            this.emit({ type: 'MARKETS', markets: this.markets });
            return;
        }

        if (message.type === 'SIGNAL_LOCKED' || message.type === 'LOCKED_ENTRY') {
            const signal = message.signal || message.data || message;
            if (!signal || signal.lockedDigit === undefined) return;
            this.latestSignal = this.normalizeSignal(signal);
            this.emit({ type: message.type, signal: this.latestSignal });
            return;
        }

        if (message.type === 'TICK') {
            this.latestFeed = {
                symbol: message.symbol || this.selectedMarket,
                quote: Number(message.quote),
                epoch: Number(message.epoch),
                digit: Number(message.digit),
                receivedAt: message.receivedAt || Date.now(),
                pipSize: message.pipSize,
            };
            this.selectedMarket = this.latestFeed.symbol || this.selectedMarket;
            this.feedHistory = [...this.feedHistory.slice(-999), this.latestFeed];
            this.emit({ type: 'TICK', tick: this.latestFeed });
            return;
        }

        if (message.type === 'STATUS' || message.type === 'ANALYZER_STATUS') {
            const status = message.status || message.data || message;
            this.analyzerStatus = status;
            const selected = status?.selectedMarket || status?.market || status?.symbol || status?.data?.selectedMarket;
            if (selected) this.selectedMarket = typeof selected === 'string' ? selected : (selected.symbol || selected.code || null);
            if (Array.isArray(status?.markets)) this.markets = status.markets;
            const statusTick = status?.lastTick || status?.tick || status?.liveTick;
            if (statusTick && statusTick.quote !== undefined) {
                this.latestFeed = {
                    symbol: statusTick.symbol || this.selectedMarket,
                    quote: Number(statusTick.quote),
                    epoch: Number(statusTick.epoch),
                    digit: Number(statusTick.digit),
                    receivedAt: statusTick.receivedAt || Date.now(),
                    pipSize: statusTick.pipSize,
                };
            }
            const lock = status?.lock || status?.signal || status?.data?.lock;
            if (lock && lock.lockedDigit !== undefined) this.latestSignal = this.normalizeSignal(lock);
            this.emit({ type: 'STATUS', connected: this.connected, status });
            return;
        }

        if (message.type === 'SIGNAL_UNLOCKED') {
            if (!message.signalId || message.signalId === this.latestSignal?.signalId) this.latestSignal = null;
            this.emit({ type: 'SIGNAL_UNLOCKED', signalId: message.signalId });
        }

        if (message.type === 'FEED_STATUS') this.emit({ type: 'FEED_STATUS', feedStatus: message });
    }

    normalizeSignal(signal) {
        return {
            ...signal,
            lockedDigit: Number(signal.lockedDigit),
            lockedQuote: Number(signal.lockedQuote ?? signal.entryQuote ?? 0) || null,
            entryQuote: Number(signal.entryQuote ?? signal.lockedQuote ?? 0) || null,
            symbol: signal.symbol || signal.market || this.selectedMarket || null,
            score: Number(signal.score ?? 0) || null,
            lockedAt: this.toMs(signal.lockedAt),
            expiresAt: this.toMs(signal.expiresAt),
        };
    }

    toMs(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 0;
        return number < 1e12 ? number * 1000 : number;
    }

    getValidSignal() {
        const signal = this.activeSignal || this.latestSignal;
        if (!signal) return null;
        if (!Number.isInteger(signal.lockedDigit) || signal.lockedDigit < 0 || signal.lockedDigit > 9) return null;
        if (!signal.signalId || !signal.symbol || !Number.isFinite(Number(signal.lockedQuote ?? signal.entryQuote))) return null;
        return { ...signal, lockedQuote: Number(signal.lockedQuote ?? signal.entryQuote), entryQuote: Number(signal.entryQuote ?? signal.lockedQuote) };
    }

    releaseForRun() {
        const signal = this.getValidSignal();
        if (!signal) return null;
        this.activeSignal = { ...signal };
        this.emit({ type: 'RUN_RELEASED', signal: this.activeSignal });
        return { ...this.activeSignal };
    }

    getActiveSignal() { return this.activeSignal ? { ...this.activeSignal } : null; }
    clearActiveSignal() { this.activeSignal = null; }

    publishExecution(execution) {
        const message = { type: 'DBOT_EXECUTION', execution: { ...execution, timestamp: Date.now() } };
        if (this.ws?.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify(message)); }
            catch { this.executionQueue.push(message); }
        } else {
            this.executionQueue.push(message);
            if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect();
        }
        this.emit(message);
    }

    emit(event) {
        this.listeners.forEach(listener => {
            try { listener(event); } catch { /* UI listeners must not break trading */ }
        });
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    getSnapshot() {
        return {
            connected: this.connected,
            signal: this.getValidSignal(),
            pendingSignal: this.latestSignal ? { ...this.latestSignal } : null,
            activeSignal: this.activeSignal ? { ...this.activeSignal } : null,
            feed: this.latestFeed ? { ...this.latestFeed } : null,
            feedHistory: [...this.feedHistory],
            selectedMarket: this.selectedMarket,
            markets: [...this.markets],
            analyzerStatus: this.analyzerStatus,
        };
    }

    stop() {
        this.manuallyStopped = true;
        clearTimeout(this.reconnectTimer);
        this.ws?.close();
        this.ws = null;
        this.activeSignal = null;
        this.setConnected(false);
    }
}

export const analyzerSignalService = new AnalyzerSignalService();
export const getAnalyzerSignal = () => analyzerSignalService.getValidSignal();
export const releaseAnalyzerSignalForRun = () => analyzerSignalService.releaseForRun();
export const getActiveAnalyzerSignal = () => analyzerSignalService.getActiveSignal();
export default analyzerSignalService;
