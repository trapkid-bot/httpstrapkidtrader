/**
 * TrapKid analyzer signal bridge.
 *
 * Receives a short-lived locked digit from the public analyzer WebSocket.
 * No Deriv credentials are ever sent through this channel.
 */

declare global {
    interface Window {
        __TRAPKID_ANALYZER_WS_URL__?: string;
    }
}

// Live TrapKid analyzer public WebSocket tunnel.
const DEFAULT_URL =
    'wss://incidence-aaa-chambers-reed.trycloudflare.com/ws/ticks';

const getUrl = () => DEFAULT_URL;

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
    indicator = null;
    connected = false;
    indicatorTimer = null;
    executionQueue = [];

    constructor() {
        if (typeof window !== 'undefined') {
            this.connect();
        }
    }

    setConnected(connected) {
        this.connected = Boolean(connected);
        this.emit({ type: 'STATUS', connected: this.connected });
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

                // Flush execution telemetry generated before the
                // Analyzer WebSocket finished connecting.
                if (this.executionQueue.length) {
                    const queue = [...this.executionQueue];
                    this.executionQueue = [];

                    queue.forEach(message => {
                        try {
                            this.ws?.send(JSON.stringify(message));
                        } catch {
                            // Telemetry must never interrupt trading.
                        }
                    });
                }
            };

            this.ws.onmessage = event => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch {
                    // Ignore malformed analyzer messages.
                }
            };

            this.ws.onerror = () => {
                this.setConnected(false);
            };

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
        // The Analyzer is the single source of truth for market selection,
        // analyzer state and live ticks. DBot must not source market/tick data
        // independently when this bridge is active.
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

        if (message.type === 'STATUS') {
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
            if (lock && lock.lockedDigit !== undefined) {
                const normalized = this.normalizeSignal(lock);
                this.latestSignal = normalized;
            } else if (status?.lock === null || status?.signal === null) {
                this.latestSignal = null;
            }
            this.emit({ type: 'STATUS', connected: this.connected, status });
            return;
        }

        if (message.type === 'SIGNAL_UNLOCKED') {
            if (!message.signalId || message.signalId === this.latestSignal?.signalId) {
                this.latestSignal = null;
            }
            this.emit({ type: 'SIGNAL_UNLOCKED', signalId: message.signalId });
        }
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
        if (!Number.isInteger(signal.lockedDigit)) return null;
        if (signal.lockedDigit < 0 || signal.lockedDigit > 9) return null;
        if (!signal.symbol || !Number.isFinite(Number(signal.lockedQuote ?? signal.entryQuote))) return null;
        return { ...signal, lockedQuote: Number(signal.lockedQuote ?? signal.entryQuote), entryQuote: Number(signal.entryQuote ?? signal.lockedQuote) };
    }

    releaseForRun() {
        const signal = this.latestSignal ? { ...this.latestSignal } : null;
        if (!signal) return null;
        this.activeSignal = signal;
        this.emit({ type: 'RUN_RELEASED', signal: this.activeSignal });
        return { ...this.activeSignal };
    }

    getActiveSignal() {
        return this.activeSignal ? { ...this.activeSignal } : null;
    }

    clearActiveSignal() {
        this.activeSignal = null;
    }

    /**
     * Publish DBot execution telemetry back through the same Analyzer bridge.
     * The Analyzer server can broadcast these events to its dashboard.
     */
    publishExecution(execution) {
        const message = {
            type: 'DBOT_EXECUTION',
            execution: {
                ...execution,
                timestamp: Date.now(),
            },
        };

        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(message));
            } catch {
                // Keep the event queued if the socket closes during send.
                this.executionQueue.push(message);
            }
        } else {
            // Do not lose execution events while the public Analyzer
            // WebSocket is still connecting.
            this.executionQueue.push(message);

            // The normal reconnect loop will flush the queue on open.
            if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
                this.connect();
            }
        }

        this.emit(message);
    }

    emit(event) {
        this.listeners.forEach(listener => {
            try {
                listener(event);
            } catch {
                // A UI listener must never break the trading bridge.
            }
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
