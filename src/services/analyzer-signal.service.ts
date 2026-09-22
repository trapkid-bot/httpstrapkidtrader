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
    'wss://shipping-cos-zum-horse.trycloudflare.com/ws/ticks';

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
    indicator = null;
    connected = false;

    constructor() {
        if (typeof window !== 'undefined') {
            const mount = () => {
                this.createIndicator();
                this.renderIndicator();
            };

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', mount, { once: true });
            } else {
                mount();
            }

            this.connect();
        }
    }

    createIndicator() {
        if (typeof document === 'undefined' || !document.body) return;

        const existing = document.getElementById('trapkid-analyzer-indicator');
        if (existing) {
            this.indicator = existing;
            return;
        }

        const indicator = document.createElement('div');
        indicator.id = 'trapkid-analyzer-indicator';
        indicator.setAttribute('role', 'status');
        indicator.style.cssText = [
            'position:fixed',
            'right:18px',
            'bottom:18px',
            'z-index:2147483647',
            'width:260px',
            'padding:12px 14px',
            'border:1px solid rgba(255,255,255,.14)',
            'border-radius:12px',
            'background:rgba(15,15,18,.96)',
            'box-shadow:0 8px 30px rgba(0,0,0,.35)',
            'color:#fff',
            'font:12px/1.45 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'backdrop-filter:blur(10px)',
        ].join(';');

        document.body.appendChild(indicator);
        this.indicator = indicator;
    }

    renderIndicator() {
        if (!this.indicator) {
            this.createIndicator();
            if (!this.indicator) return;
        }

        const signal = this.latestSignal;
        const remaining = signal?.expiresAt
            ? Math.max(0, Math.ceil((signal.expiresAt - Date.now()) / 1000))
            : 0;

        const connectionText = this.connected ? 'CONNECTED' : 'DISCONNECTED';
        const connectionMark = this.connected ? '●' : '○';
        const connectionColor = this.connected ? '#35d07f' : '#ff5f56';

        let signalHtml = '<div style="margin-top:8px;color:#aaa">Waiting for analyzer lock...</div>';

        if (signal) {
            signalHtml =
                '<div style="margin-top:8px">' +
                '<div style="color:#aaa">LOCKED DIGIT</div>' +
                '<div style="font-size:28px;font-weight:800;line-height:1.1;margin-top:2px">' +
                String(signal.lockedDigit) +
                '</div>' +
                '<div style="margin-top:4px;color:#aaa">Signal: ' +
                this.escapeHtml(signal.signalId || 'active') +
                '</div>' +
                '<div style="color:#aaa">Expires in: ' +
                remaining +
                's</div>' +
                '</div>';
        }

        this.indicator.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
            '<strong style="font-size:13px">TRAPKID ANALYZER</strong>' +
            '<span style="color:' + connectionColor + ';font-weight:700">' +
            connectionMark + ' ' + connectionText +
            '</span>' +
            '</div>' +
            signalHtml +
            '<div style="margin-top:9px;padding-top:8px;border-top:1px solid rgba(255,255,255,.09);color:#777">' +
            'Match signal bridge' +
            '</div>';
    }

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    setConnected(connected) {
        this.connected = Boolean(connected);
        this.renderIndicator();
        this.emit({ type: 'STATUS', connected: this.connected });
    }

    connect() {
        if (this.manuallyStopped || typeof window === 'undefined') return;
        if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;

        try {
            this.ws = new WebSocket(getUrl());

            this.ws.onopen = () => {
                this.setConnected(true);
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
            this.renderIndicator();
            this.emit({ type: 'SIGNAL_LOCKED', signal: this.latestSignal });
            return;
        }

        if (message.type === 'SIGNAL_UNLOCKED') {
            if (!message.signalId || message.signalId === this.latestSignal?.signalId) {
                this.latestSignal = null;
            }
            this.renderIndicator();
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
            this.renderIndicator();
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
        this.setConnected(false);
    }
}

export const analyzerSignalService = new AnalyzerSignalService();
export const getAnalyzerSignal = () => analyzerSignalService.getValidSignal();
export default analyzerSignalService;
