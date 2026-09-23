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
        if (message.type === 'SIGNAL_LOCKED') {
            const signal = message.signal || message.data || message;
            if (!signal || signal.lockedDigit === undefined) return;
            this.latestSignal = this.normalizeSignal(signal);
            this.emit({ type: 'SIGNAL_LOCKED', signal: this.latestSignal });
            return;
        }

        if (message.type === 'STATUS') {
            const status = message.status || message.data || message;
            const lock = status?.lock || status?.signal || status?.data?.lock;
            if (lock && lock.lockedDigit !== undefined) {
                const normalized = this.normalizeSignal(lock);
                if (normalized.expiresAt && Date.now() < normalized.expiresAt) {
                    this.latestSignal = normalized;
                }
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
        if (!this.latestSignal) return null;
        if (!Number.isInteger(this.latestSignal.lockedDigit)) return null;
        if (this.latestSignal.lockedDigit < 0 || this.latestSignal.lockedDigit > 9) return null;

        if (!this.latestSignal.expiresAt || Date.now() >= this.latestSignal.expiresAt) {
            this.latestSignal = null;
            return null;
        }

        return { ...this.latestSignal };
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
        };
    }

    stop() {
        this.manuallyStopped = true;
        clearTimeout(this.reconnectTimer);
        this.ws?.close();
        this.ws = null;
        this.setConnected(false);
    }
}

export const analyzerSignalService = new AnalyzerSignalService();
export const getAnalyzerSignal = () => analyzerSignalService.getValidSignal();
export default analyzerSignalService;
