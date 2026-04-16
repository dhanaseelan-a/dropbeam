import { useState, useEffect } from 'react';
import { useFileReceiver, formatBytes, formatTime, NETWORK_MODES, getSpeedLabel } from '../hooks/useFileTransfer';
import { getFileIcon } from '../components/FilePreview';

function ReceivePage({ onTransferStateChange }) {
  const {
    status, progress, speed, speedRaw, eta, etc, error,
    fileList, currentFileIndex, currentFileName,
    transferStats, peerDevice, activeChunkSize,
    networkMode, speedLabel, remotePaused, paused, togglePause,
    bytesReceived, bytesTotal, chunksReceived,
    connect, cleanup
  } = useFileReceiver();
  const [inputCode, setInputCode] = useState('');
  const [autoConnecting, setAutoConnecting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get('code');
    if (urlCode && urlCode.length >= 4 && status === 'idle' && !autoConnecting) {
      setAutoConnecting(true); setInputCode(urlCode.toUpperCase());
      setTimeout(() => connect(urlCode), 500);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [status, connect, autoConnecting]);

  useEffect(() => {
    const active = status === 'receiving' || status === 'connected' || status === 'connecting';
    onTransferStateChange?.(active);
  }, [status, onTransferStateChange]);

  const handleConnect = () => { const c = inputCode.trim().toUpperCase(); if (c.length >= 4) connect(c); };
  const handleReset = () => { cleanup(); setInputCode(''); setAutoConnecting(false); };
  const handleCancel = () => {
    if (window.confirm('⚠️ Cancel receiving?\n\nThis will disconnect from the sender and discard any partially received files.')) {
      handleReset();
    }
  };

  const radius = 54, circ = 2 * Math.PI * radius;
  const offset = circ - (progress / 100) * circ;
  const net = networkMode ? NETWORK_MODES[networkMode] : null;
  const displaySpeedLabel = speedLabel || getSpeedLabel(0);
  const displayChunkSize = activeChunkSize ? formatBytes(activeChunkSize) : '128 KB';
  const totalChunks = activeChunkSize > 0 && bytesTotal > 0 ? Math.ceil(bytesTotal / activeChunkSize) : 0;

  return (
    <div className="fade-in">
      {(status === 'idle' || status === 'connecting') && (
        <div className="glass-card">
          <div className="code-input-container">
            <div className="code-label" style={{ marginBottom: '1.25rem' }}>Enter Share Code</div>
            <input type="text" className="code-input" value={inputCode}
              onChange={(e) => { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (v.length <= 6) setInputCode(v); }}
              onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              placeholder="ABC123" autoFocus disabled={status === 'connecting'} />
            <button className="btn btn-primary" onClick={handleConnect}
              disabled={inputCode.length < 4 || status === 'connecting'} style={{ marginTop: '1.25rem' }}>
              {status === 'connecting' ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>
      )}

      {(status === 'connected' || status === 'receiving') && (
        <div className="glass-card slide-up">
          {peerDevice && <div className="device-badge" style={{ marginBottom: '0.75rem' }}>📱 Sender: {peerDevice}</div>}

          {net && status === 'connected' && fileList.length === 0 && (
            <div style={{ textAlign: 'center' }}>
              <div className="network-badge" style={{ '--net-color': net.color }}>{net.icon} {net.label}</div>
              <div className="status-badge status-connected"><span className="status-dot"></span>Connected — waiting for file...</div>
            </div>
          )}

          {fileList.length > 0 && (
            <div className="file-list">
              {fileList.map((f, i) => (
                <div className="file-info" key={i}>
                  <span className="file-icon">{getFileIcon(f.name)}</span>
                  <div className="file-details">
                    <div className="file-name">{f.name}</div>
                    <div className="file-size">{formatBytes(f.size)}</div>
                  </div>
                  {status === 'receiving' && i === currentFileIndex && <span className="file-active-badge">Receiving</span>}
                  {status === 'receiving' && i < currentFileIndex && <span className="file-done-badge">✓</span>}
                </div>
              ))}
              {fileList.length > 1 && <div className="file-total">{fileList.length} files · {formatBytes(fileList.reduce((s, f) => s + f.size, 0))}</div>}
            </div>
          )}

          {status === 'receiving' && (
            <div className="progress-section-v2 fade-in">
              {(networkMode || activeChunkSize > 0) && (
                <div className="net-tier-row">
                  {networkMode && <div className="network-chip" style={{ '--net-color': NETWORK_MODES[networkMode].color }}>{NETWORK_MODES[networkMode].icon} {NETWORK_MODES[networkMode].label}</div>}
                </div>
              )}

              {/* Pause banners */}
              {remotePaused && (
                <div className="remote-pause-banner fade-in">⏸ Sender paused transfer</div>
              )}
              {paused && (
                <div className="pause-banner fade-in">⏸ Transfer paused by you</div>
              )}

              <div className="ring-container">
                <svg className="ring-svg" viewBox="0 0 120 120">
                  <circle cx="60" cy="60" r={radius} className="ring-track" />
                  <circle cx="60" cy="60" r={radius} className="ring-fill" strokeDasharray={circ} strokeDashoffset={offset} transform="rotate(-90 60 60)" />
                </svg>
                <div className="ring-content">
                  <div className="ring-percent">{progress}%</div>
                  <div className="ring-speed">{speed}</div>
                </div>
              </div>

              {/* Linear progress bar */}
              <div className="linear-progress-wrap">
                <div className="linear-progress-bar">
                  <div className="linear-progress-fill" style={{ width: `${progress}%` }}></div>
                </div>
                <span className="linear-progress-pct">{progress}%</span>
              </div>

              {/* Speed label indicator */}
              {displaySpeedLabel && displaySpeedLabel.tier !== 'waiting' && (
                <div className="speed-chip-center" style={{ '--speed-color': displaySpeedLabel.color }}>
                  {displaySpeedLabel.label}
                  {displaySpeedLabel.detail && <span className="speed-chip-detail"> · {displaySpeedLabel.detail}</span>}
                </div>
              )}

              {/* Transfer detail grid */}
              <div className="transfer-detail-grid">
                <div className="detail-row">
                  <span className="detail-label">Transferred</span>
                  <span className="detail-value">{formatBytes(bytesReceived)} / {formatBytes(bytesTotal)}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Chunk</span>
                  <span className="detail-value">{displayChunkSize} × {chunksReceived}{totalChunks ? ` / ${totalChunks}` : ''}</span>
                </div>
                {fileList.length > 1 && (
                  <div className="detail-row">
                    <span className="detail-label">File</span>
                    <span className="detail-value">{currentFileIndex + 1} of {fileList.length}</span>
                  </div>
                )}
                <div className="detail-row">
                  <span className="detail-label">Remaining</span>
                  <span className="detail-value">{eta || '--:--'}</span>
                </div>
                {etc && (
                  <div className="detail-row">
                    <span className="detail-label">Est. Done</span>
                    <span className="detail-value">{etc}</span>
                  </div>
                )}
              </div>

              {/* Controls: Pause + Cancel */}
              <div className="controls-bar">
                <button className={`ctrl-btn ${paused ? 'active' : ''}`} onClick={togglePause}>
                  {paused ? '▶ Resume' : '⏸ Pause'}
                </button>
                <button className="ctrl-btn cancel" onClick={handleCancel}>
                  ✕ Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {status === 'done' && (
        <div className="glass-card slide-up">
          <div className="complete-section">
            <div className="complete-icon">✓</div>
            <div className="complete-title">Received</div>
            {transferStats && (
              <>
                <div className="transfer-stats">
                  <span>{transferStats.fileCount > 1 ? `${transferStats.fileCount} files · ` : ''}{formatBytes(transferStats.totalBytes)}</span>
                  <span className="stats-dot">·</span>
                  <span>{transferStats.totalTime.toFixed(1)}s</span>
                  <span className="stats-dot">·</span>
                  <span>avg {formatBytes(transferStats.avgSpeed)}/s</span>
                </div>
                {transferStats.speedLabel && transferStats.speedLabel.tier !== 'waiting' && (
                  <div className="speed-chip-center done" style={{ '--speed-color': transferStats.speedLabel.color }}>
                    {transferStats.speedLabel.label}
                  </div>
                )}
                {transferStats.completionTime && (
                  <div className="complete-time">Completed at {transferStats.completionTime}</div>
                )}
              </>
            )}
            {net && <div className="network-chip done" style={{ '--net-color': net.color }}>{net.icon} {net.label}</div>}
            <div className="complete-subtitle" style={{ marginTop: '0.25rem' }}>{fileList.length > 1 ? `${fileList.length} files` : currentFileName} saved</div>
            <button className="btn btn-secondary" onClick={handleReset} style={{ marginTop: '1rem' }}>Receive more files</button>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="glass-card slide-up">
          <div style={{ textAlign: 'center' }}>
            <div className="status-badge status-error">{error || 'Connection failed'}</div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.3rem' }}>Make sure sender's tab is open</p>
            <button className="btn btn-secondary" onClick={() => window.location.reload()} style={{ marginTop: '1rem' }}>Try again</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ReceivePage;
