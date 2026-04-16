import { useState, useCallback, useEffect, useMemo } from 'react';
import { useDropzone } from 'react-dropzone';
import JSZip from 'jszip';
import { QRCodeSVG } from 'qrcode.react';
import { useFileSender, formatBytes, NETWORK_MODES } from '../hooks/useFileTransfer';
import { FilePreview, FileThumbnail, getFileIcon } from '../components/FilePreview';

function SendPage({ onTransferStateChange }) {
  const {
    status, code, files, setFiles, error, codeExpiry,
    paused, togglePause,
    receivers, initPeer, cleanup
  } = useFileSender();
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [expiryCountdown, setExpiryCountdown] = useState('');
  const [previewFile, setPreviewFile] = useState(null);
  const [isZipping, setIsZipping] = useState(false);

  const isActive = status === 'transferring' || status === 'waiting' || receivers.some(r => r.status === 'transferring');
  useEffect(() => { onTransferStateChange?.(isActive); }, [isActive, onTransferStateChange]);

  useEffect(() => {
    if (!codeExpiry) { setExpiryCountdown(''); return; }
    const tick = () => {
      const rem = Math.max(0, codeExpiry - Date.now());
      if (rem <= 0) { setExpiryCountdown('Expired'); return; }
      setExpiryCountdown(`${Math.floor(rem / 60000)}:${Math.floor((rem % 60000) / 1000).toString().padStart(2, '0')}`);
    };
    tick(); const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [codeExpiry]);

  const onDrop = useCallback(async (acceptedFiles) => {
    if (!acceptedFiles.length) return;

    // Filter out OS hidden files and MS Office temp lock files
    const validFiles = acceptedFiles.filter(f => {
      const n = f.name;
      return !n.startsWith('~$') && !n.startsWith('._') && n !== '.DS_Store';
    });
    if (!validFiles.length) return;

    // Check for folders
    const groups = { root: [] };
    let hasFolders = false;

    // For Android/iOS image selection and standard non-folder files
    for (const f of validFiles) {
      const pathStr = f.webkitRelativePath || ''; 
      const parts = pathStr.split('/').filter(Boolean);

      // A real folder drop creates paths like `folder/file.jpg` 
      // Individual files just have `file.jpg` or an empty path.
      if (parts.length > 1) {
        hasFolders = true;
        const topFolder = parts[0];
        if (!groups[topFolder]) groups[topFolder] = [];
        groups[topFolder].push({ file: f, path: parts.slice(1).join('/') });
      } else {
        groups.root.push(f);
      }
    }

    // Fast-path: no real folders detected, send as raw standard files
    if (!hasFolders) {
      setFiles([...acceptedFiles]);
      initPeer();
      return;
    }

    setIsZipping(true);
    const finalFiles = [...groups.root];
    
    try {
      const folders = Object.keys(groups).filter(k => k !== 'root');
      for (const folderName of folders) {
        const zip = new JSZip();
        groups[folderName].forEach(item => {
          zip.file(item.path, item.file);
        });
        
        // STORE compression is fast, good for general file transfers
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
        const zipFile = new File([blob], `${folderName}.zip`, { type: 'application/zip' });
        finalFiles.push(zipFile);
      }
      setFiles(finalFiles);
      initPeer();
    } catch (err) {
      console.error('Failed to zip folders', err);
      setFiles(acceptedFiles); // fallback
      initPeer();
    } finally {
      setIsZipping(false);
    }
  }, [setFiles, initPeer]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({ onDrop, multiple: true, noClick: status !== 'idle' });

  const shareLink = code ? `${window.location.origin}${window.location.pathname}?code=${code}` : '';
  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);

  const copyText = async (text, cb) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    }
    cb(true); setTimeout(() => cb(false), 2000);
  };

  const handleNativeShare = async () => {
    if (navigator.share) try { await navigator.share({ title: 'DropBeam™', text: `Code: ${code}`, url: shareLink }); } catch (e) {}
  };
  const handleRemoveFile = (i) => {
    const next = files.filter((_, idx) => idx !== i);
    if (!next.length) { cleanup(); setFiles([]); } else setFiles(next);
  };
  const handleReset = () => { cleanup(); setFiles([]); setPreviewFile(null); };
  const handleCancel = () => {
    if (window.confirm('⚠️ Cancel transfer?\n\nThis will disconnect all receivers and stop the transfer immediately.')) {
      handleReset();
    }
  };

  const radius = 54, circ = 2 * Math.PI * radius;

  return (
    <div className="fade-in">
      {status === 'idle' && (
        <div className="glass-card">
          <div {...getRootProps()} className={`dropzone ${isDragActive ? 'active' : ''} ${isZipping ? 'zipping' : ''}`}>
            <input {...getInputProps()} disabled={isZipping} />
            {isZipping ? (
              <>
                <span className="dropzone-icon" style={{ animation: 'spin 2s linear infinite' }}>📦</span>
                <p className="dropzone-title">Zipping folder...</p>
                <p className="dropzone-subtitle">Please wait, compressing files</p>
              </>
            ) : (
              <>
                <span className="dropzone-icon">↑</span>
                <p className="dropzone-title">{isDragActive ? 'Drop files/folders here' : 'Drop files or folders here'}</p>
                <p className="dropzone-subtitle">Multiple files · Any type · Any size</p>
                <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                  <button className="btn btn-secondary" onClick={(e) => { e.stopPropagation(); open(); }}>Select Files</button>
                  <button className="btn btn-secondary" onClick={(e) => {
                    e.stopPropagation();
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.webkitdirectory = true;
                    input.multiple = true;
                    input.onchange = (ev) => onDrop(Array.from(ev.target.files));
                    input.click();
                  }}>Select Folder</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {files.length > 0 && status !== 'idle' && (
        <div className="glass-card slide-up">
          {/* File list */}
          <div className="file-list">
            {files.map((f, i) => (
              <div className="file-info" key={i} onClick={() => setPreviewFile(previewFile === i ? null : i)} style={{ cursor: 'pointer' }}>
                <FileThumbnail file={f} />
                <div className="file-details">
                  <div className="file-name">{f.name}</div>
                  <div className="file-size">{formatBytes(f.size)}</div>
                </div>
                {status === 'waiting' && <button className="file-remove" onClick={(e) => { e.stopPropagation(); handleRemoveFile(i); }}>✕</button>}
              </div>
            ))}
            {files.length > 1 && <div className="file-total">{files.length} files · {formatBytes(totalSize)}</div>}
          </div>

          {/* File preview */}
          {previewFile !== null && files[previewFile] && (
            <div className="file-preview-section fade-in">
              <FilePreview file={files[previewFile]} maxHeight={180} />
            </div>
          )}

          {/* Share code */}
          {(status === 'waiting' || (status === 'transferring' && code)) && code && (
            <div className="code-display-container fade-in">
              <div className="code-label">Share Code</div>
              <div className="code-value" onClick={() => copyText(code, setCopied)}>{code}</div>
              <div className="code-hint">{copied ? <span className="code-copied">Copied!</span> : 'Click to copy'}</div>
              {status === 'waiting' && (
                <div className="qr-section fade-in">
                  <QRCodeSVG value={shareLink} size={110} bgColor="transparent" fgColor="#a1a1aa" level="M" className="qr-code" />
                  <p className="qr-hint">Scan to receive · Multi-device supported</p>
                  <div className="share-buttons">
                    <button className="btn-link" onClick={() => copyText(shareLink, setCopiedLink)}>{copiedLink ? '✓ Copied' : '🔗 Copy link'}</button>
                    {navigator.share && <button className="btn-link" onClick={handleNativeShare}>📤 Share</button>}
                  </div>
                </div>
              )}
            </div>
          )}

          {status === 'waiting' && (
            <div style={{ textAlign: 'center' }}>
              <div className="status-badge status-waiting"><span className="status-dot"></span>Waiting for receivers...</div>
            </div>
          )}

          {/* === CONTROLS: Pause + Cancel === */}
          {status === 'transferring' && (
            <div className="controls-bar fade-in">
              <button className={`ctrl-btn ${paused ? 'active' : ''}`} onClick={togglePause}>
                {paused ? '▶ Resume' : '⏸ Pause'}
              </button>
              <button className="ctrl-btn cancel" onClick={handleCancel}>
                ✕ Cancel
              </button>
            </div>
          )}

          {paused && status === 'transferring' && (
            <div className="pause-banner fade-in">⏸ Transfer paused</div>
          )}

          {/* === RECEIVERS LIST === */}
          {receivers.length > 0 && (
            <div className="receivers-section fade-in">
              {receivers.length > 1 && <div className="receivers-title">{receivers.length} Devices</div>}
              {receivers.map((r) => {
                const net = r.networkMode ? NETWORK_MODES[r.networkMode] : null;
                const offset = circ - (r.progress / 100) * circ;

                return (
                  <div className="receiver-card" key={r.id}>
                    <div className="receiver-header">
                      <span className="receiver-device">{r.device || 'Unknown device'}</span>
                      {net && <span className="network-chip-sm" style={{ '--net-color': net.color }}>{net.icon}</span>}
                      {r.status === 'done' && <span className="file-done-badge">✓</span>}
                    </div>

                    {r.status === 'connecting' && (
                      <div className="receiver-status"><span className="status-dot" style={{ background: '#3b82f6' }}></span> Connecting...</div>
                    )}

                    {r.status === 'transferring' && (
                      <div className="receiver-progress">
                        <div className="mini-ring-wrap">
                          <svg viewBox="0 0 120 120" className="mini-ring-svg">
                            <circle cx="60" cy="60" r={radius} className="ring-track" />
                            <circle cx="60" cy="60" r={radius} className="ring-fill" strokeDasharray={circ} strokeDashoffset={offset} transform="rotate(-90 60 60)" />
                          </svg>
                          <span className="mini-ring-pct">{r.progress}%</span>
                        </div>
                        <div className="receiver-info">
                          <div className="receiver-speed">{formatBytes(r.speed)}/s</div>
                          <div className="receiver-meta">
                            {r.activeChunkSize > 0 && <span>{formatBytes(r.activeChunkSize)} chunks</span>}
                            {r.eta && <span> · {r.eta}</span>}
                          </div>
                          <div className="receiver-chunks">{formatBytes(r.bytesSent)} / {formatBytes(r.bytesTotal)}</div>
                        </div>
                      </div>
                    )}

                    {r.status === 'done' && (
                      <div className="receiver-done">
                        <span>{formatBytes(r.totalBytes)} · {r.totalTime?.toFixed(1)}s · avg {formatBytes(r.avgSpeed)}/s</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {status === 'done' && (
            <div className="complete-section fade-in">
              <div className="complete-icon">✓</div>
              <div className="complete-title">All Transfers Complete</div>
              {expiryCountdown && <div className="expiry-badge">Code expires in {expiryCountdown}</div>}
              <button className="btn btn-secondary" onClick={handleReset} style={{ marginTop: '1rem' }}>Send more files</button>
            </div>
          )}

          {status === 'error' && (
            <div style={{ textAlign: 'center' }} className="fade-in">
              <div className="status-badge status-error">{error}</div>
              <button className="btn btn-secondary" onClick={() => window.location.reload()} style={{ marginTop: '1rem' }}>Try again</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SendPage;
