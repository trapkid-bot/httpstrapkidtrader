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
            {signal ? (
                <div style={{marginTop:9}}>
                    <div style={{color:'#aaa'}}>LOCKED DIGIT</div>
                    <div style={{fontSize:30,fontWeight:800,lineHeight:1.1}}>{signal.lockedDigit}</div>
                    <div style={{marginTop:4,color:'#aaa'}}>{signal.symbol || '—'} · DIGITMATCH</div>
                    <div style={{color:'#aaa'}}>Analyzer quote: {feed?.quote ?? '—'} · digit: {feed?.digit ?? '—'}</div>
                    <div style={{color:'#aaa'}}>Pending lock: held until Run</div>
                    {state.activeSignal ? <div style={{color:'#35d07f'}}>RUN LOCK: {state.activeSignal.lockedDigit}</div> : null}
                    <div style={{color:'#aaa'}}>Analyzer expiry: {remaining}s</div>
                </div>
            ) : (
                <div style={{marginTop:9,color:'#aaa'}}>
                    {state.connected ? 'Connected — waiting for analyzer lock...' : 'Connecting to local analyzer...'}
                </div>
            )}
            <div style={{marginTop:9,paddingTop:8,borderTop:'1px solid rgba(255,255,255,.09)',color:'#777'}}>
                Analyzer → DBot bridge
            </div>
        </div>
    );
};

export default AnalyzerBridgeIndicator;
