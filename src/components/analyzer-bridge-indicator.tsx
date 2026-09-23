import React from 'react';
import { analyzerSignalService } from '@/services/analyzer-signal.service';

const AnalyzerBridgeIndicator = () => {
    const [state, setState] = React.useState(() => analyzerSignalService.getSnapshot());

    React.useEffect(() => {
        const update = () => setState(analyzerSignalService.getSnapshot());
        const unsubscribe = analyzerSignalService.subscribe(update);
        update();
        const timer = window.setInterval(update, 1000);
        return () => {
            unsubscribe();
            window.clearInterval(timer);
        };
    }, []);

    const signal = state.signal;
    const feed = state.feed;
    const remaining = signal?.expiresAt
        ? Math.max(0, Math.ceil((signal.expiresAt - Date.now()) / 1000))
        : 0;

    return (
        <div role='status' aria-live='polite' style={{
            position: 'fixed', right: 18, bottom: 18, zIndex: 2147483647,
            width: 270, padding: '12px 14px',
            border: '1px solid rgba(255,255,255,.14)', borderRadius: 12,
            background: 'rgba(15,15,18,.97)', boxShadow: '0 8px 30px rgba(0,0,0,.35)',
            color: '#fff', font: '12px/1.45 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
        }}>
            <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
                <strong style={{fontSize:13}}>TRAPKID ANALYZER</strong>
                <span style={{color:state.connected?'#35d07f':'#ff5f56',fontWeight:700}}>
                    {state.connected ? '● CONNECTED' : '○ DISCONNECTED'}
                </span>
            </div>
            <div style={{marginTop:9}}>
                <div style={{color:'#aaa'}}>ANALYZER MARKET</div>
                <div style={{fontSize:18,fontWeight:800}}>{state.selectedMarket || signal?.symbol || feed?.symbol || '—'}</div>
                <div style={{marginTop:5,color:'#aaa'}}>Live quote: {feed?.quote ?? '—'} · digit: {feed?.digit ?? '—'}</div>
                <div style={{color:'#aaa'}}>Epoch: {feed?.epoch ?? '—'}</div>
            </div>

            {signal ? (
                <div style={{marginTop:9,paddingTop:8,borderTop:'1px solid rgba(255,255,255,.09)'}}>
                    <div style={{color:'#aaa'}}>LOCKED ENTRY</div>
                    <div style={{fontSize:28,fontWeight:800,lineHeight:1.1}}>{signal.lockedDigit}</div>
                    <div style={{color:'#aaa'}}>Entry quote: {signal.lockedQuote ?? signal.entryQuote ?? '—'}</div>
                    <div style={{color:'#aaa'}}>Signal: {signal.signalId || '—'}</div>
                    <div style={{color:'#aaa'}}>Score: {signal.score ?? '—'}</div>
                    <div style={{color:'#aaa'}}>Expiry: {remaining}s</div>
                    {state.activeSignal ? <div style={{color:'#35d07f'}}>RUN LOCK: {state.activeSignal.lockedDigit}</div> : null}
                </div>
            ) : (
                <div style={{marginTop:9,color:'#aaa'}}>
                    {state.connected ? 'Connected — waiting for Analyzer lock...' : 'Connecting to Analyzer...'}
                </div>
            )}

            <div style={{marginTop:9,paddingTop:8,borderTop:'1px solid rgba(255,255,255,.09)'}}>
                <div style={{color:'#aaa'}}>ANALYZER SOURCE</div>
                <div style={{color:'#35d07f',fontWeight:700}}>LIVE TICKS FROM ANALYZER</div>
                <div style={{color:'#aaa'}}>DBot does not subscribe to a separate tick feed.</div>
            </div>
            <div style={{marginTop:9,paddingTop:8,borderTop:'1px solid rgba(255,255,255,.09)',color:'#777'}}>
                Analyzer → DBot bridge
            </div>
        </div>
    );
};

export default AnalyzerBridgeIndicator;
