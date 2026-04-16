import { useState, useRef, useCallback, useEffect } from 'react';
import Peer from 'peerjs';

// ===== PERFORMANCE CONSTANTS =====
const CHUNK_SIZE = 128 * 1024;        // 128KB — Large initial chunk for maximum SCTP pipeline efficiency
const MAX_CHUNK  = 256 * 1024;        // 256KB — Safe max for all browsers/SCTP implementations
const BUF_HI     = 2 * 1024 * 1024;   // 2MB — High watermark: keeps SCTP congestion window well-fed
const BUF_LO     = 256 * 1024;        // 256KB — Low watermark: resume quickly without buffer starvation
const READ_AHEAD = 8;                 // Read 8 chunks at a time (128KB × 8 = 1MB batch)
const ACK_INTERVAL = 200;             // Receiver ACK interval (ms)
const UI_INTERVAL  = 200;             // Sender UI throttle (ms)

const NETWORK_MODES = {
  lan:      { label: 'LAN / Hotspot', icon: '🔌', color: '#22c55e', detail: 'Same network' },
  wifi:     { label: 'Same WiFi',     icon: '📶', color: '#3b82f6', detail: 'Same WiFi' },
  internet: { label: 'Internet',      icon: '🌐', color: '#f59e0b', detail: 'Internet P2P' },
  relay:    { label: 'Relay',         icon: '☁️', color: '#ef4444', detail: 'Relay server' },
};

const CHUNK_TIERS = {
  slow:   { size: 128 * 1024,  label: 'Slow',   bufHi: 1 * 1024 * 1024,  ahead: 4 },
  normal: { size: 128 * 1024,  label: 'Normal', bufHi: 2 * 1024 * 1024,  ahead: 8 },
  fast:   { size: 256 * 1024,  label: 'Fast',   bufHi: 2 * 1024 * 1024,  ahead: 8 },
};

// ===== ADAPTIVE CHUNK SIZING =====
// Dynamically scales chunk size based on true network speed.
// CRITICAL: Only scales UP from CHUNK_SIZE. Never downgrades — smaller chunks
// cause more per-message SCTP overhead which creates a speed death spiral.
function getAdaptiveChunk(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return CHUNK_SIZE;
  const kbps = bytesPerSec / 1024;
  if (kbps < 2000) return CHUNK_SIZE;      // Keep 128KB — never downgrade below initial
  return MAX_CHUNK;                        // >=2 MB/s → 256KB
}

// ===== SPEED LABEL =====
function getSpeedLabel(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return { label: '⏳ Waiting', color: '#71717a', tier: 'waiting' };
  const kbps = bytesPerSec / 1024;
  const mbps = kbps / 1024;
  if (kbps < 100)    return { label: `🐌 Very Slow`, color: '#ef4444', tier: 'very-slow', detail: `${kbps.toFixed(0)} KB/s` };
  if (kbps < 500)    return { label: `🐢 Slow`,      color: '#f59e0b', tier: 'slow',      detail: `${kbps.toFixed(0)} KB/s` };
  if (mbps < 2)      return { label: `⚡ Normal`,     color: '#3b82f6', tier: 'normal',    detail: `${mbps.toFixed(1)} MB/s` };
  if (mbps < 10)     return { label: `🚀 Fast`,       color: '#22c55e', tier: 'fast',      detail: `${mbps.toFixed(1)} MB/s` };
  return               { label: `⚡⚡ Very Fast`,     color: '#a855f7', tier: 'very-fast', detail: `${mbps.toFixed(1)} MB/s` };
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(s) {
  if (!s || s === Infinity || isNaN(s)) return '--:--';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function getDeviceName() {
  const ua = navigator.userAgent;
  let b = 'Browser';
  if (ua.includes('Edg/')) b = 'Edge';
  else if (ua.includes('Chrome')) b = 'Chrome';
  else if (ua.includes('Firefox')) b = 'Firefox';
  else if (ua.includes('Safari')) b = 'Safari';
  let o = '';
  if (ua.includes('Windows')) o = 'Windows';
  else if (ua.includes('Mac')) o = 'macOS';
  else if (ua.includes('iPhone')) o = 'iPhone';
  else if (ua.includes('iPad')) o = 'iPad';
  else if (ua.includes('Android')) o = 'Android';
  else if (ua.includes('Linux')) o = 'Linux';
  return `${b} on ${o}`;
}

function useBeforeUnload(active) {
  useEffect(() => {
    if (!active) return;
    const h = (e) => { e.preventDefault(); e.returnValue = 'Transfer in progress!'; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [active]);
}

function playDone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.setValueAtTime(587, ctx.currentTime);
    o.frequency.setValueAtTime(784, ctx.currentTime + 0.1);
    o.frequency.setValueAtTime(1047, ctx.currentTime + 0.2);
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.4);
  } catch (e) {}
}

const ICE = [
  // STUN — discover public IP for NAT traversal
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // TURN — CRITICAL for internet transfers when both peers are behind symmetric NATs.
  // Without TURN, PeerJS falls back to its slow relay (~56KB/s cap).
  { urls: 'turn:openrelay.metered.ca:80',                username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',               username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

function getDC(conn) {
  return conn.dataChannel || conn._dc;
}

function dcSendJSON(dc, obj) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(obj));
  }
}

// ===== NETWORK DETECT =====
async function detectNetwork(conn) {
  const r = { mode: 'internet' };
  try {
    const pc = conn.peerConnection || conn._pc;
    if (!pc) return r;
    const stats = await pc.getStats();
    let lt = '', rt = '';
    let lId = null, rId = null;
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.state === 'succeeded' || s.selected)) {
        lId = s.localCandidateId; rId = s.remoteCandidateId;
      }
    });
    stats.forEach((s) => {
      if (s.type === 'local-candidate' && s.id === lId) lt = s.candidateType || '';
      if (s.type === 'remote-candidate' && s.id === rId) rt = s.candidateType || '';
    });
    if (lt === 'relay' || rt === 'relay') r.mode = 'relay';
    else if (lt === 'host' && rt === 'host') r.mode = 'lan';
    else if (lt === 'host' || rt === 'host') r.mode = 'wifi';
    else r.mode = 'internet';
  } catch (e) {}
  return r;
}

// ===== PAUSE =====
// Waits while local OR remote pause is active
async function waitIfPaused(pausedRef, destroyedRef, remotePausedFn) {
  const isPaused = () => pausedRef.current || (remotePausedFn && remotePausedFn());
  if (!isPaused()) return;
  await new Promise((resolve) => {
    const check = () => {
      if (!isPaused() || destroyedRef.current) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

// ===== BACKPRESSURE =====
// Waits until dc.bufferedAmount drops to BUF_LO.
// Uses the bufferedamountlow EVENT as primary, with a polling safety net.
function waitForDrain(dc) {
  if (!dc || dc.readyState !== 'open') return Promise.resolve();
  if (dc.bufferedAmount <= BUF_LO) return Promise.resolve();

  return new Promise((resolve) => {
    dc.bufferedAmountLowThreshold = BUF_LO;

    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      dc.removeEventListener('bufferedamountlow', onLow);
      clearInterval(pollId);
      resolve();
    };

    const onLow = () => done();
    dc.addEventListener('bufferedamountlow', onLow);

    // Safety poll every 16ms — align with frame timing
    const pollId = setInterval(() => {
      if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= BUF_LO) done();
    }, 16);
  });
}

// Returns true if buffer has room (below high watermark)
function bufferHasRoom(dc) {
  return dc && dc.readyState === 'open' && dc.bufferedAmount <= BUF_HI;
}


// ====== SENDER ======
export function useFileSender() {
  const [status, setStatus] = useState('idle');
  const [code, setCode] = useState('');
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [codeExpiry, setCodeExpiry] = useState(null);
  const [paused, setPaused] = useState(false);
  const [receivers, setReceivers] = useState([]);

  const peerRef = useRef(null);
  const destroyedRef = useRef(false);
  const statusRef = useRef('idle');
  const filesRef = useRef([]);
  const expiryRef = useRef(null);
  const pausedRef = useRef(false);
  const receiversRef = useRef([]);

  const isTransferring = receivers.some(r => r.status === 'transferring');
  useBeforeUnload(isTransferring || status === 'waiting');
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const updateReceiver = useCallback((id, updates) => {
    setReceivers(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  }, []);

  // ---- TOGGLE PAUSE WITH SYNC ----
  const togglePause = useCallback(() => {
    setPaused(p => {
      const newPaused = !p;
      // Send pause/resume to all active receivers
      receiversRef.current.forEach(r => {
        try {
          const dc = getDC(r.conn);
          if (dc && dc.readyState === 'open') {
            dcSendJSON(dc, { type: newPaused ? 'pause' : 'resume' });
          }
        } catch (e) {}
      });
      return newPaused;
    });
  }, []);

  // ---- TRANSFER ENGINE (rewritten for speed) ----
  const transferToReceiver = useCallback(async (receiverId, conn, filesToSend) => {
    const dc = getDC(conn);
    if (!dc || dc.readyState !== 'open') {
      updateReceiver(receiverId, { status: 'error', error: 'Channel not open' });
      return;
    }
    dc.binaryType = 'arraybuffer';

    const grandTotal = filesToSend.reduce((s, f) => s + f.size, 0);
    const startTime = Date.now();
    let globalBytesSent = 0;
    let chunksSent = 0;
    let currentChunkSize = CHUNK_SIZE;
    let lastSentChunkSize = currentChunkSize;
    let receiverBytes = 0;
    let currentSpeed = 0;
    let transferDone = false; // flag to stop the progress timer

    // Remote pause flag
    conn._remotePaused = false;
    conn._cancelled = false;

    // ===== INCOMING MESSAGES FROM RECEIVER =====
    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ack') {
            if (msg.received != null) receiverBytes = Math.max(receiverBytes, msg.received);
            // Forward receiver's progress/speed to UI
            const updObj = { progress: msg.progress ?? 0, eta: msg.eta || '' };
            if (msg.speed > 0) {
              updObj.speed = msg.speed;
              updObj.speedLabel = getSpeedLabel(msg.speed);
              currentSpeed = msg.speed; // Store speed perfectly for sender adaptive loop
            }
            updateReceiver(receiverId, updObj);
          }
          if (msg.type === 'cancel') {
            conn._cancelled = true;
            updateReceiver(receiverId, { status: 'cancelled', error: 'Cancelled by receiver' });
          }
          if (msg.type === 'pause') {
            conn._remotePaused = true;
            updateReceiver(receiverId, { remotePaused: true });
          }
          if (msg.type === 'resume') {
            conn._remotePaused = false;
            updateReceiver(receiverId, { remotePaused: false });
          }
          if (msg.type === 'device-info') {
            updateReceiver(receiverId, { device: msg.device || '' });
          }
        } catch (e) {}
      }
    };

    // ===== PROGRESS TIMER — runs every 200ms =====
    // We strictly use receiver ACKs for speed, avoiding local dc.bufferedAmount glitches 
    // that falsely reported 0 B/s on fast connections.
    const progressTimer = setInterval(() => {
      if (transferDone) return;
      const now = Date.now();

      // We only compute immediate display progress (bytes sent locally).
      // Speed and ETA are exclusively calculated by the Receiver's ACKs to avoid 0B glitches.
      const displayBytes = globalBytesSent;
      const pct = grandTotal > 0 ? Math.min(99, Math.round((displayBytes / grandTotal) * 100)) : 0;
      const totalChunks = Math.ceil(grandTotal / CHUNK_SIZE);

      // Adaptive Check -> use the 'currentSpeed' harvested from receiver ACKs!
      if (currentSpeed > 0) {
        const nextChunkSize = getAdaptiveChunk(currentSpeed);
        if (nextChunkSize !== lastSentChunkSize) {
          lastSentChunkSize = nextChunkSize;
          currentChunkSize = nextChunkSize;
          dcSendJSON(dc, { type: 'chunk-update', chunkSize: currentChunkSize });
        }
      }

      updateReceiver(receiverId, {
        bytesSent: displayBytes,
        bytesTotal: grandTotal,
        senderProgress: pct,
        activeChunkSize: currentChunkSize,
        chunksSent,
        totalChunks,
      });
    }, 200);

    // ===== INITIAL STATE =====
    updateReceiver(receiverId, {
      status: 'transferring', progress: 0, speed: 0, eta: '', etc: '',
      activeChunkSize: currentChunkSize, speedLabel: getSpeedLabel(0),
      chunksSent: 0, totalChunks: Math.ceil(grandTotal / CHUNK_SIZE),
    });

    dcSendJSON(dc, {
      type: 'file-list',
      files: filesToSend.map(f => ({ name: f.name, size: f.size, fileType: f.type })),
      device: getDeviceName(),
      chunkSize: currentChunkSize
    });

    // ===== FILE SEND LOOP =====
    const isRemotePaused = () => !!conn._remotePaused;

    for (let fi = 0; fi < filesToSend.length; fi++) {
      if (destroyedRef.current || conn._cancelled) break;
      const file = filesToSend[fi];
      updateReceiver(receiverId, { currentFile: fi });

      dcSendJSON(dc, { type: 'file-start', index: fi, name: file.name, size: file.size, fileType: file.type });

      let offset = 0;

      while (offset < file.size) {
        if (destroyedRef.current || conn._cancelled) break;
        if (!dc || dc.readyState !== 'open') break;

        await waitIfPaused(pausedRef, destroyedRef, isRemotePaused);
        if (destroyedRef.current || conn._cancelled) break;

        // Read a large batch from disk
        const batchBytes = currentChunkSize * READ_AHEAD;
        const batchEnd = Math.min(offset + batchBytes, file.size);
        const bigBuf = await file.slice(offset, batchEnd).arrayBuffer();
        const bigView = new Uint8Array(bigBuf);

        // ===== HOT INNER LOOP — minimal overhead =====
        // Only: send, increment counters, backpressure check
        // NO speed tracking, NO formatting, NO object creation
        let pos = 0;
        while (pos < bigView.length) {
          if (destroyedRef.current || conn._cancelled) break;
          if (!dc || dc.readyState !== 'open') break;

          let end = Math.min(pos + currentChunkSize, bigView.length);
          // subarray = zero-copy view (no allocation)
          let chunk = bigView.subarray(pos, end);

          try {
            dc.send(chunk);
          } catch (err) {
            // Buffer overflow OR WebRTC Message Too Large Exception
            if (err.name === 'TypeError' || String(err).includes('too large')) {
               // Browser rejected message size — step down chunk permanently
               currentChunkSize = Math.max(16 * 1024, Math.floor(currentChunkSize / 2));
               lastSentChunkSize = currentChunkSize;
               dcSendJSON(dc, { type: 'chunk-update', chunkSize: currentChunkSize });
               end = Math.min(pos + currentChunkSize, bigView.length);
               chunk = bigView.subarray(pos, end);
            }

            await waitForDrain(dc);
            if (!dc || dc.readyState !== 'open') break;
            try {
              dc.send(chunk);
            } catch (err2) {
              clearInterval(progressTimer);
              transferDone = true;
              updateReceiver(receiverId, { status: 'error', error: 'Send failed' });
              if (dc) dc.onmessage = null;
              return;
            }
          }

          pos += chunk.byteLength;
          globalBytesSent += chunk.byteLength;
          chunksSent++;
          
          // Backpressure — only wait when buffer exceeds HIGH watermark
          if (dc.bufferedAmount > BUF_HI) {
            await waitForDrain(dc);
          }
        }

        offset += bigView.length;

        // Check pause between batches (not per-chunk)
        if (pausedRef.current || conn._remotePaused) {
          await waitIfPaused(pausedRef, destroyedRef, isRemotePaused);
        }
      }

      if (destroyedRef.current || conn._cancelled) break;
      if (!dc || dc.readyState !== 'open') break;

      dcSendJSON(dc, { type: 'file-end', index: fi });
    }

    // ===== CLEANUP PROGRESS TIMER =====
    clearInterval(progressTimer);
    transferDone = true;

    // Check cancel BEFORE marking done
    if (destroyedRef.current || conn._cancelled) {
      if (dc) dc.onmessage = null;
      setReceivers(prev => prev.map(r => {
        if (r.id === receiverId && r.status !== 'cancelled') {
          return { ...r, status: 'disconnected' };
        }
        return r;
      }));
      return;
    }

    // Wait for receiver confirmation
    await new Promise((resolve) => {
      if (receiverBytes >= grandTotal) return resolve();
      const onMsg = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'ack' && msg.received >= grandTotal) {
              dc.removeEventListener('message', onMsg);
              clearTimeout(sid);
              clearInterval(cancelCheck);
              resolve();
            }
            if (msg.type === 'cancel') {
              conn._cancelled = true;
              dc.removeEventListener('message', onMsg);
              clearTimeout(sid);
              clearInterval(cancelCheck);
              resolve();
            }
          } catch (e) {}
        }
      };
      dc.addEventListener('message', onMsg);
      const cancelCheck = setInterval(() => {
        if (conn._cancelled || destroyedRef.current) {
          dc.removeEventListener('message', onMsg);
          clearTimeout(sid);
          clearInterval(cancelCheck);
          resolve();
        }
      }, 100);
      const remainingBytes = Math.max(0, grandTotal - receiverBytes);
      const dynTimeout = Math.max(60000, Math.ceil((remainingBytes / (30 * 1024)) * 3000));
      const sid = setTimeout(() => { dc.removeEventListener('message', onMsg); clearInterval(cancelCheck); resolve(); }, dynTimeout);
    });

    // Clean up
    if (dc) dc.onmessage = null;

    if (destroyedRef.current || conn._cancelled) {
      setReceivers(prev => prev.map(r => {
        if (r.id === receiverId && r.status !== 'cancelled') {
          return { ...r, status: 'disconnected' };
        }
        return r;
      }));
      return;
    }

    dcSendJSON(dc, { type: 'all-done' });

    const totalTime = (Date.now() - startTime) / 1000;
    const completionTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    updateReceiver(receiverId, {
      status: 'done', progress: 100,
      avgSpeed: grandTotal / totalTime,
      totalTime, totalBytes: grandTotal,
      speedLabel: getSpeedLabel(grandTotal / totalTime),
      completionTime,
    });
    playDone();
  }, [updateReceiver]);

  // ---- PEER SETUP ----
  const initPeer = useCallback(() => {
    if (peerRef.current) peerRef.current.destroy();
    destroyedRef.current = false;
    setReceivers([]);
    setCodeExpiry(null);
    setPaused(false);
    if (expiryRef.current) clearTimeout(expiryRef.current);

    const myCode = generateCode();
    const peer = new Peer(myCode, {
      config: { iceServers: ICE, sdpSemantics: 'unified-plan', iceCandidatePoolSize: 10 },
      debug: 0
    });

    peer.on('open', (id) => {
      if (destroyedRef.current) return;
      setCode(id);
      setStatus('waiting');
    });

    peer.on('connection', (conn) => {
      if (destroyedRef.current) return;
      const receiverId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      conn.on('open', async () => {
        if (destroyedRef.current) return;

        const newReceiver = {
          id: receiverId, conn, device: '', status: 'connecting',
          progress: 0, speed: 0, eta: '', etc: '', networkMode: null,
          currentFile: 0, avgSpeed: 0, totalTime: 0, totalBytes: 0,
          speedLabel: getSpeedLabel(0), remotePaused: false,
          chunksSent: 0, totalChunks: 0,
          senderProgress: 0, senderSpeed: 0, senderEta: '', senderEtc: '',
          senderSpeedLabel: getSpeedLabel(0),
        };
        setReceivers(prev => [...prev, newReceiver]);
        receiversRef.current.push(newReceiver);

        const dc = getDC(conn);
        if (dc) {
          dc.binaryType = 'arraybuffer';
          dc.onmessage = (event) => {
            if (typeof event.data === 'string') {
              try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'device-info') updateReceiver(receiverId, { device: msg.device || '' });
                if (msg.type === 'cancel') { conn._cancelled = true; updateReceiver(receiverId, { status: 'cancelled', error: 'Cancelled by receiver' }); }
                if (msg.type === 'pause') { updateReceiver(receiverId, { remotePaused: true }); }
                if (msg.type === 'resume') { updateReceiver(receiverId, { remotePaused: false }); }
              } catch (e) {}
            }
          };
        }

        detectNetwork(conn).then(net => {
          if (!destroyedRef.current) updateReceiver(receiverId, { networkMode: net.mode });
        });

        updateReceiver(receiverId, { status: 'connected' });
        setStatus('transferring');

        const currentFiles = filesRef.current;
        if (currentFiles.length) {
          transferToReceiver(receiverId, conn, currentFiles);
        }
      });

      conn.on('close', () => {
        if (destroyedRef.current) return;
        setReceivers(prev => prev.map(r => {
          if (r.id === receiverId && r.status !== 'done' && r.status !== 'cancelled') return { ...r, status: 'disconnected' };
          return r;
        }));
      });
      conn.on('error', (err) => updateReceiver(receiverId, { status: 'error', error: err.message }));
    });

    peer.on('error', (err) => {
      if (destroyedRef.current) return;
      if (err.type === 'unavailable-id') { setTimeout(() => initPeer(), 100); return; }
      setError(err.message || 'Connection failed'); setStatus('error');
    });

    peerRef.current = peer;
  }, [transferToReceiver, updateReceiver]);

  const cleanup = useCallback(() => {
    destroyedRef.current = true;
    if (expiryRef.current) clearTimeout(expiryRef.current);
    receiversRef.current.forEach(r => {
      try {
        const dc = getDC(r.conn);
        if (dc) {
          dc.onmessage = null; // release closure refs
          if (dc.readyState === 'open') dc.send(JSON.stringify({ type: 'cancel' }));
        }
        r.conn?.close();
      } catch (e) {}
    });
    receiversRef.current = [];
    if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
    setStatus('idle'); setCode(''); setFiles([]); setError(''); setReceivers([]); setPaused(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const allTerminal = receivers.length > 0 && receivers.every(r => r.status === 'done' || r.status === 'error' || r.status === 'disconnected' || r.status === 'cancelled');
  const anySuccess = receivers.some(r => r.status === 'done');
  useEffect(() => {
    if (allTerminal && statusRef.current === 'transferring') {
      if (anySuccess) {
        setStatus('done');
        setCodeExpiry(Date.now() + 10 * 60 * 1000);
        expiryRef.current = setTimeout(() => { cleanup(); setCode(''); setCodeExpiry(null); }, 10 * 60 * 1000);
      } else {
        // All receivers failed or disconnected — don't show "done", show error
        setStatus('error');
        setError('Transfer failed — all receivers disconnected');
      }
    }
  }, [allTerminal, anySuccess, cleanup]);

  return {
    status, code, files, setFiles, error, codeExpiry,
    paused, togglePause,
    receivers, initPeer, cleanup, formatBytes
  };
}


// ====== RECEIVER ======
export function useFileReceiver() {
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState('');
  const [error, setError] = useState('');
  const [fileList, setFileList] = useState([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [currentFileName, setCurrentFileName] = useState('');
  const [transferStats, setTransferStats] = useState(null);
  const [peerDevice, setPeerDevice] = useState('');
  const [networkMode, setNetworkMode] = useState(null);
  const [activeChunkSize, setActiveChunkSize] = useState(0);
  const [speedLabel, setSpeedLabel] = useState(getSpeedLabel(0));
  const [remotePaused, setRemotePaused] = useState(false);
  const [paused, setPaused] = useState(false);
  const [bytesReceived, setBytesReceived] = useState(0);
  const [bytesTotal, setBytesTotal] = useState(0);
  const [chunksReceived, setChunksReceived] = useState(0);
  const chunksReceivedRef = useRef(0);

  const peerRef = useRef(null);
  const connRef = useRef(null);
  const dcRef = useRef(null);

  const fileBufferRef = useRef(null);
  const fileOffsetRef = useRef(0);
  const chunksRef = useRef([]);
  const fileTypeRef = useRef('');
  const fileNameRef = useRef('');
  const grandTotalRef = useRef(0);
  const grandReceivedRef = useRef(0);
  const startTimeRef = useRef(null);
  const destroyedRef = useRef(false);
  const statusRef = useRef('idle');
  const fileListRef = useRef([]);
  const pausedRef = useRef(false);

  // ACK timer
  const ackTimerRef = useRef(null);
  // Speed tracking
  const speedSamplesRef = useRef([]);
  const lastSpeedRef = useRef(0);
  const lastEtaRef = useRef('--:--');
  // Track if we've sent the first ACK (send immediately on first data)
  const firstDataRef = useRef(true);

  // UI batching
  const rafRef = useRef(null);
  const [etc, setEtc] = useState('');
  const pendingUIRef = useRef({ progress: null, speed: null, eta: null, speedLabel: null, bytesReceived: null, bytesTotal: null, etc: null, chunksReceived: null });

  const isTransferring = status === 'receiving' || status === 'connected';
  useBeforeUnload(isTransferring);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const flushUI = useCallback(() => {
    const p = pendingUIRef.current;
    if (p.progress !== null) setProgress(p.progress);
    if (p.speed !== null) setSpeed(p.speed);
    if (p.eta !== null) setEta(p.eta);
    if (p.speedLabel !== null) setSpeedLabel(p.speedLabel);
    if (p.bytesReceived !== null) setBytesReceived(p.bytesReceived);
    if (p.bytesTotal !== null) setBytesTotal(p.bytesTotal);
    if (p.etc !== null) setEtc(p.etc);
    if (p.chunksReceived !== null) setChunksReceived(p.chunksReceived);
    pendingUIRef.current = { progress: null, speed: null, eta: null, speedLabel: null, bytesReceived: null, bytesTotal: null, etc: null, chunksReceived: null };
    rafRef.current = null;
  }, []);

  const scheduleUI = useCallback((pct, spd, etaStr, spdLabel, received, total, etcStr, chunks) => {
    pendingUIRef.current.progress = pct;
    if (spd !== undefined) pendingUIRef.current.speed = spd;
    if (etaStr !== undefined) pendingUIRef.current.eta = etaStr;
    if (spdLabel !== undefined) pendingUIRef.current.speedLabel = spdLabel;
    if (received !== undefined) pendingUIRef.current.bytesReceived = received;
    if (total !== undefined) pendingUIRef.current.bytesTotal = total;
    if (etcStr !== undefined) pendingUIRef.current.etc = etcStr;
    if (chunks !== undefined) pendingUIRef.current.chunksReceived = chunks;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushUI);
  }, [flushUI]);

  // ---- Toggle pause with sync ----
  const togglePause = useCallback(() => {
    setPaused(p => {
      const newPaused = !p;
      const dc = dcRef.current;
      if (dc && dc.readyState === 'open') {
        dcSendJSON(dc, { type: newPaused ? 'pause' : 'resume' });
      }
      return newPaused;
    });
  }, []);

  // ---- COMPUTE SPEED + SEND ACK ----
  const sendAckNow = useCallback(() => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;

    const now = Date.now();
    const received = grandReceivedRef.current;
    const total = grandTotalRef.current;

    // Add speed sample
    speedSamplesRef.current.push({ time: now, bytes: received });
    while (speedSamplesRef.current.length > 2 && now - speedSamplesRef.current[0].time > 3000) {
      speedSamplesRef.current.shift();
    }

    const oldest = speedSamplesRef.current[0];
    let spd = 0;
    if (oldest && now - oldest.time > 0) {
      spd = (received - oldest.bytes) / ((now - oldest.time) / 1000);
    }
    lastSpeedRef.current = spd;

    const rem = total - received;
    const remainingSec = spd > 0 ? rem / spd : 0;
    const etaStr = spd > 0 ? formatTime(remainingSec) : '--:--';
    lastEtaRef.current = etaStr;

    // Estimated completion time
    const etcStr = spd > 0
      ? new Date(Date.now() + remainingSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
      : '';

    const pct = total > 0 ? (received >= total ? 100 : Math.min(99, Math.round((received / total) * 100))) : 0;
    const spdLabel = getSpeedLabel(spd);
    scheduleUI(pct, spd, etaStr, spdLabel, received, total, etcStr, chunksReceivedRef.current);

    try {
      dc.send(JSON.stringify({
        type: 'ack', progress: pct,
        received: received, speed: spd, eta: etaStr
      }));
    } catch (e) {}
  }, [scheduleUI]);

  const startAckTimer = useCallback(() => {
    if (ackTimerRef.current) clearInterval(ackTimerRef.current);
    ackTimerRef.current = setInterval(sendAckNow, ACK_INTERVAL);
  }, [sendAckNow]);

  const stopAckTimer = useCallback(() => {
    if (ackTimerRef.current) { clearInterval(ackTimerRef.current); ackTimerRef.current = null; }
  }, []);

  // ---- Free all receive buffers ----
  const freeBuffers = useCallback(() => {
    fileBufferRef.current = null;
    fileOffsetRef.current = 0;
    chunksRef.current = [];
    grandReceivedRef.current = 0;
    grandTotalRef.current = 0;
    speedSamplesRef.current = [];
    chunksReceivedRef.current = 0;
  }, []);

  // ---- PROCESS FILE CHUNK (hot path) ----
  const processChunk = useCallback((data) => {
    if (!data || data.byteLength === 0) return;

    const buf = fileBufferRef.current;
    if (buf) {
      const view = (data instanceof Uint8Array) ? data : new Uint8Array(data);
      const off = fileOffsetRef.current;
      const len = Math.min(view.byteLength, buf.byteLength - off);
      if (len > 0) {
        buf.set(view.subarray(0, len), off);
        fileOffsetRef.current += len;
      }
    } else {
      chunksRef.current.push(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }

    grandReceivedRef.current += data.byteLength;
    chunksReceivedRef.current += 1;

    // On FIRST data chunk, send an immediate ACK so sender UI doesn't show 0 B
    if (firstDataRef.current) {
      firstDataRef.current = false;
      sendAckNow();
    }
  }, [sendAckNow]);

  const processChunkRef = useRef(processChunk);
  useEffect(() => { processChunkRef.current = processChunk; }, [processChunk]);

  // ---- HANDLE CONTROL MESSAGE ----
  const handleControl = useCallback((msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'file-list':
        setFileList(msg.files || []);
        fileListRef.current = msg.files || [];
        setPeerDevice(msg.device || '');
        setActiveChunkSize(msg.chunkSize || CHUNK_SIZE);
        grandTotalRef.current = (msg.files || []).reduce((s, f) => s + f.size, 0);
        grandReceivedRef.current = 0;
        startTimeRef.current = Date.now();
        speedSamplesRef.current = [{ time: Date.now(), bytes: 0 }];
        firstDataRef.current = true;
        setStatus('receiving');
        startAckTimer();
        break;

      case 'tier-update':
      case 'config-update':
      case 'chunk-update':
        if (msg.chunkSize) setActiveChunkSize(msg.chunkSize);
        break;

      case 'file-start': {
        setCurrentFileIndex(msg.index);
        setCurrentFileName(msg.name);
        fileTypeRef.current = msg.fileType || 'application/octet-stream';
        fileNameRef.current = msg.name;
        fileBufferRef.current = null;
        fileOffsetRef.current = 0;
        chunksRef.current = [];
        const MAX_PREALLOC = 512 * 1024 * 1024;
        const sz = msg.size || 0;
        if (sz > 0 && sz <= MAX_PREALLOC) {
          try { fileBufferRef.current = new Uint8Array(sz); } catch (e) { fileBufferRef.current = null; }
        }
        break;
      }

      case 'file-end': {
        let blob;
        if (fileBufferRef.current) {
          blob = new Blob([fileBufferRef.current.subarray(0, fileOffsetRef.current)], { type: fileTypeRef.current });
        } else if (chunksRef.current.length > 0) {
          blob = new Blob(chunksRef.current, { type: fileTypeRef.current });
        } else {
          blob = new Blob([], { type: fileTypeRef.current });
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileNameRef.current;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        // Free file buffers immediately after saving
        fileBufferRef.current = null;
        fileOffsetRef.current = 0;
        chunksRef.current = [];
        break;
      }

      case 'all-done': {
        sendAckNow();
        stopAckTimer();
        const tt = (Date.now() - startTimeRef.current) / 1000;
        const avgSpd = grandReceivedRef.current / tt;
        const completionTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        setTransferStats({
          totalBytes: grandReceivedRef.current, totalTime: tt,
          avgSpeed: avgSpd,
          fileCount: fileListRef.current.length || 1,
          speedLabel: getSpeedLabel(avgSpd),
          completionTime,
        });
        setProgress(100);
        setStatus('done');
        setRemotePaused(false);
        setPaused(false);
        // Free all buffers on completion
        freeBuffers();
        playDone();
        break;
      }

      case 'cancel':
        stopAckTimer();
        freeBuffers();
        setRemotePaused(false);
        setPaused(false);
        setError('Transfer cancelled by sender');
        setStatus('error');
        break;

      case 'pause':
        setRemotePaused(true);
        break;

      case 'resume':
        setRemotePaused(false);
        break;

      case 'rejected':
        stopAckTimer();
        freeBuffers();
        setError(msg.reason || 'Rejected');
        setStatus('error');
        break;

      default: break;
    }
  }, [sendAckNow, startAckTimer, stopAckTimer, freeBuffers]);

  const handleControlRef = useRef(handleControl);
  useEffect(() => { handleControlRef.current = handleControl; }, [handleControl]);

  // ---- CONNECT ----
  const connect = useCallback((code) => {
    if (peerRef.current) peerRef.current.destroy();
    destroyedRef.current = false;
    setStatus('connecting');
    setError('');
    setNetworkMode(null);
    setRemotePaused(false);
    setPaused(false);

    const peer = new Peer({
      config: { iceServers: ICE, sdpSemantics: 'unified-plan', iceCandidatePoolSize: 10 },
      debug: 0
    });

    peer.on('open', () => {
      if (destroyedRef.current) return;

      const conn = peer.connect(code.toUpperCase(), { serialization: 'raw', reliable: true });

      conn.on('open', async () => {
        if (destroyedRef.current) return;
        setStatus('connected');
        connRef.current = conn;

        const dc = getDC(conn);
        if (!dc) { setError('No data channel'); setStatus('error'); return; }

        dc.binaryType = 'arraybuffer';
        dcRef.current = dc;

        dc.send(JSON.stringify({ type: 'device-info', device: getDeviceName() }));

        dc.onmessage = (event) => {
          if (destroyedRef.current) return;

          if (typeof event.data === 'string') {
            try { handleControlRef.current(JSON.parse(event.data)); }
            catch (e) { console.warn('[DropBeam] Bad JSON'); }
            return;
          }

          if (event.data instanceof ArrayBuffer) {
            if (statusRef.current === 'receiving') {
              processChunkRef.current(event.data);
            }
          }
        };

        detectNetwork(conn).then(net => {
          if (!destroyedRef.current) setNetworkMode(net.mode);
        });
      });

      conn.on('close', () => {
        if (!destroyedRef.current && statusRef.current !== 'done') {
          stopAckTimer();
          freeBuffers();
          setRemotePaused(false);
          setPaused(false);
          setError('Connection closed'); setStatus('error');
        }
      });
      conn.on('error', (e) => {
        if (!destroyedRef.current) {
          stopAckTimer();
          freeBuffers();
          setRemotePaused(false);
          setPaused(false);
          setError(e.message); setStatus('error');
        }
      });
    });

    peer.on('error', (err) => {
      if (destroyedRef.current) return;
      setError(err.type === 'peer-unavailable' ? 'Invalid code or sender offline' : err.message || 'Failed');
      setStatus('error');
    });

    peerRef.current = peer;
  }, [stopAckTimer, freeBuffers]);

  const cleanup = useCallback(() => {
    destroyedRef.current = true;
    stopAckTimer();
    freeBuffers();
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      try { dc.send(JSON.stringify({ type: 'cancel' })); } catch (e) {}
    }
    dcRef.current = null;
    if (connRef.current) { connRef.current.close(); connRef.current = null; }
    if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
    setStatus('idle'); setError(''); setProgress(0); setSpeed(0); setEta(''); setEtc('');
    setFileList([]); setCurrentFileIndex(0); setCurrentFileName('');
    setTransferStats(null); setPeerDevice(null); setNetworkMode(null); setActiveChunkSize(0);
    setSpeedLabel(getSpeedLabel(0)); setRemotePaused(false); setPaused(false);
    setBytesReceived(0); setBytesTotal(0); setChunksReceived(0);
  }, [stopAckTimer, freeBuffers]);

  useEffect(() => cleanup, [cleanup]);

  return {
    status, progress, speed: formatBytes(speed) + '/s', speedRaw: speed, eta, etc, error,
    fileList, currentFileIndex, currentFileName,
    transferStats, peerDevice, networkMode, activeChunkSize,
    speedLabel, remotePaused, paused, togglePause,
    bytesReceived, bytesTotal, chunksReceived,
    connect, cleanup, formatBytes
  };
}

export { formatBytes, formatTime, getDeviceName, NETWORK_MODES, CHUNK_TIERS, getSpeedLabel, CHUNK_SIZE };
