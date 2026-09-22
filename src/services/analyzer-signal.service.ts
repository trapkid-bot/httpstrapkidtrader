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

const DEFAULT_URL =
    'wss://coverage-max-surrounding-continues.trycloudflare.com/ws/ticks';

const getUrl = () => {
    if (typeof window !== 'undefined') {
        const configured = window.__TRAPKID_ANALYZER_WS_URL__;
        const stored = window.localStorage?.getItem('TRAPKID_ANALYZER_WS_URL');
        return configured || stored || DEFAULT_URL;
    }
    return DEFAULT_URL;
};

class AnalyzerSignalService {
    ws = null;
    reconnectTimer = null;
    latestSignal = null;
    listeners = new Set();
    manuallyStopped = false;

    constructor() {
        if (typeof window !== 'undefined') {
            this.connect();
        }
    }

    connect() {
        if (this.manuallyStopped || typeof window === 'undefined') return;
        if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;

        try {
            this.ws = new WebSocket(getUrl());

            this.ws.onopen = () => {
                this.emit({ type: 'STATUS', connected: true });
                this.ws?.send(JSON.stringify({ type: 'STATUS' }));
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
                this.emit({ type: 'STATUS', connected: false });
            };

            this.ws.onclose = () => {
                this.ws = null;
                this.emit({ type: 'STATUS', connected: false });
                if (!this.manuallyStopped) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
                }
            };
        } catch {
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

        if (message.type === 'SIGNAL_UNLOCKED') {
            if (!message.signalId || message.signalId === this.latestSignal?.signalId) {
                this.latestSignal = null;
            }
            this.emit({ type: 'SIGNAL_UNLOCKED', signalId: message.signalId });
        }
    }

    normalizeSignal(signal) {
        const lockedAt = this.toMs(signal.lockedAt);
        const expiresAt = this.toMs(signal.expiresAt);
        return {
            ...signal,
            lockedDigit: Number(signal.lockedDigit),
            lockedAt,
            expiresAt,
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

    stop() {
        this.manuallyStopped = true;
        clearTimeout(this.reconnectTimer);
        this.ws?.close();
        this.ws = null;
    }
}

export const analyzerSignalService = new AnalyzerSignalService();
export const getAnalyzerSignal = () => analyzerSignalService.getValidSignal();
export default analyzerSignalService;
