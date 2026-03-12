import { useState, useCallback, useEffect } from 'react';
import SendPage from './pages/SendPage';
import ReceivePage from './pages/ReceivePage';
import './App.css';

function App() {
  const [mode, setMode] = useState('send');
  const [isTransferring, setIsTransferring] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('code')) setMode('receive');
  }, []);

  const handleModeSwitch = (newMode) => {
    if (isTransferring) return;
    setMode(newMode);
  };

  const onTransferStateChange = useCallback((active) => {
    setIsTransferring(active);
  }, []);

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="app-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12l7-7 7 7" />
          </svg>
        </div>
        <h1 className="app-title">DropBeam<sup className="tm">™</sup></h1>
        <p className="app-subtitle">Beam files directly between devices — no sign up, no limits</p>
      </header>

      <div className="mode-switcher">
        <button className={`mode-btn ${mode === 'send' ? 'active' : ''}`}
          onClick={() => handleModeSwitch('send')} disabled={isTransferring && mode !== 'send'}>Send</button>
        <button className={`mode-btn ${mode === 'receive' ? 'active' : ''}`}
          onClick={() => handleModeSwitch('receive')} disabled={isTransferring && mode !== 'receive'}>Receive</button>
      </div>

      {isTransferring && (
        <div className="transfer-warning fade-in">Transfer in progress — keep this tab open</div>
      )}

      {mode === 'send' ? (
        <SendPage onTransferStateChange={onTransferStateChange} />
      ) : (
        <ReceivePage onTransferStateChange={onTransferStateChange} />
      )}

      <footer className="app-footer">
        <div className="footer-text">
          <span>Encrypted P2P</span>
          <span className="footer-dot"></span>
          <span>Nothing stored on servers</span>
          <span className="footer-dot"></span>
          <span>WebRTC</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
