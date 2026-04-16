import { useState, useRef, useCallback, useEffect } from 'react';
import Peer from 'peerjs';

// ===== PERFORMANCE CONSTANTS =====
const CHUNK_SIZE = 256 * 1024;       // 256KB per dc.send() call
const BUF_HI     = 1 * 1024 * 1024;  // 1MB — conservative to avoid send-queue-full
const BUF_LO     = 256 * 1024;       // Resume sending when buffer drains to 256KB
const READ_AHEAD = 16;               // Read 16 chunks (4MB) from disk at a time
const ACK_INTERVAL = 200;            // Receiver ACK interval (ms)
const UI_INTERVAL  = 150;            // Sender UI throttle (ms)

const NETWORK_MODES = {
  lan:      { label: 'LAN / Hotspot', icon: '🔌', color: '#22c55e', detail: 'Same network' },
  wifi:     { label: 'Same WiFi',     icon: '📶', color: '#3b82f6', detail: 'Same WiFi' },
  internet: { label: 'Internet',      icon: '🌐', color: '#f59e0b', detail: 'Internet P2P' },
  relay:    { label: 'Relay',         icon: '☁️', color: '#ef4444', detail: 'Relay server' },
};

const CHUNK_TIERS = {
  fast: { size: CHUNK_SIZE, label: 'Fast', bufHi: BUF_HI, ahead: READ_AHEAD },
};

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
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
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
async function waitIfPaused(pausedRef, destroyedRef) {
  if (!pausedRef.current) return;
  await new Promise((resolve) => {
    const check = () => {
      if (!pausedRef.current || destroyedRef.current) resolve();
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

    // Safety poll every 50ms — some browsers don't fire the event reliably
    const pollId = setInterval(() => {
      if (!dc || dc.readyState !== 'open' || dc.bufferedAmount <= BUF_LO) done();
    }, 50);
  });
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

  // ---- TRANSFER ENGINE ----
  const transferToReceiver = useCallback(async (receiverId, conn, filesToSend) => {
    let pendingUpdate = null;
    let updateTimer = null;
    let lastUpdateTime = 0;

    const throttledUpdate = (upd) => {
      pendingUpdate = pendingUpdate ? { ...pendingUpdate, ...upd } : upd;
      const now = Date.now();
      if (now - lastUpdateTime >= UI_INTERVAL) {
        if (updateTimer) clearTimeout(updateTimer);
        lastUpdateTime = now;
        updateReceiver(receiverId, pendingUpdate);
        pendingUpdate = null;
      } else if (!updateTimer) {
        updateTimer = setTimeout(() => {
          updateTimer = null;
          if (pendingUpdate) {
            lastUpdateTime = Date.now();
            updateReceiver(receiverId, pendingUpdate);
            pendingUpdate = null;
          }
        }, UI_INTERVAL - (now - lastUpdateTime));
      }
    };

    const flushUpdate = () => {
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = null;
      if (pendingUpdate) {
        lastUpdateTime = Date.now();
        updateReceiver(receiverId, pendingUpdate);
        pendingUpdate = null;
      }
    };

    const dc = getDC(conn);
    if (!dc || dc.readyState !== 'open') {
      updateReceiver(receiverId, { status: 'error', error: 'Channel not open' });
      return;
    }
    dc.binaryType = 'arraybuffer';

    let receiverBytes = 0;

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ack') {
            if (msg.received != null) receiverBytes = Math.max(receiverBytes, msg.received);
            throttledUpdate({ progress: msg.progress ?? 0, speed: msg.speed || 0, eta: msg.eta || '' });
          }
          if (msg.type === 'cancel') {
            conn._cancelled = true;
            updateReceiver(receiverId, { status: 'disconnected', error: 'Cancelled by receiver' });
          }
          if (msg.type === 'device-info') {
            updateReceiver(receiverId, { device: msg.device || '' });
          }
        } catch (e) {}
      }
    };

    updateReceiver(receiverId, { status: 'transferring', progress: 0, speed: 0, eta: '', activeChunkSize: CHUNK_SIZE });

    dcSendJSON(dc, {
      type: 'file-list',
      files: filesToSend.map(f => ({ name: f.name, size: f.size, fileType: f.type })),
      device: getDeviceName(),
      chunkSize: CHUNK_SIZE
    });

    const grandTotal = filesToSend.reduce((s, f) => s + f.size, 0);
    const startTime = Date.now();
    let globalBytesSent = 0;

    for (let fi = 0; fi < filesToSend.length; fi++) {
      if (destroyedRef.current || conn._cancelled) break;
      const file = filesToSend[fi];
      throttledUpdate({ currentFile: fi });

      dcSendJSON(dc, { type: 'file-start', index: fi, name: file.name, size: file.size, fileType: file.type });

      let offset = 0;

      while (offset < file.size) {
        if (destroyedRef.current || conn._cancelled) break;
        await waitIfPaused(pausedRef, destroyedRef);
        if (destroyedRef.current || conn._cancelled) break;

        // Read a batch of chunks from disk
        const batchEnd = Math.min(offset + CHUNK_SIZE * READ_AHEAD, file.size);
        const readPromises = [];
        let cursor = offset;
        while (cursor < batchEnd) {
          const end = Math.min(cursor + CHUNK_SIZE, file.size);
          readPromises.push(file.slice(cursor, end).arrayBuffer());
          cursor = end;
        }
        const buffers = await Promise.all(readPromises);

        for (const buf of buffers) {
          if (destroyedRef.current || conn._cancelled) break;
          if (!buf || buf.byteLength === 0) continue;

          // ALWAYS wait for drain BEFORE sending — prevents send-queue-full
          await waitForDrain(dc);
          if (!dc || dc.readyState !== 'open') break;

          await waitIfPaused(pausedRef, destroyedRef);
          if (destroyedRef.current || conn._cancelled) break;

          try {
            dc.send(buf);
          } catch (err) {
            // If send still fails (extremely rare), wait and retry once
            console.warn('[DropBeam] send failed, waiting for drain...', err.message);
            await waitForDrain(dc);
            if (!dc || dc.readyState !== 'open') break;
            try {
              dc.send(buf);
            } catch (err2) {
              console.error('[DropBeam] send failed after retry', err2.message);
              updateReceiver(receiverId, { status: 'error', error: 'Send failed' });
              return;
            }
          }

          offset += buf.byteLength;
          globalBytesSent += buf.byteLength;
        }

        throttledUpdate({ bytesSent: globalBytesSent, bytesTotal: grandTotal });
      }

      dcSendJSON(dc, { type: 'file-end', index: fi });
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
              resolve();
            }
          } catch (e) {}
        }
      };
      dc.addEventListener('message', onMsg);
      const sid = setTimeout(() => { dc.removeEventListener('message', onMsg); resolve(); }, 15000);
    });

    flushUpdate();

    // Clean up dc.onmessage to release closure references
    if (dc) dc.onmessage = null;

    if (destroyedRef.current || conn._cancelled) {
      updateReceiver(receiverId, { status: 'disconnected' });
      return;
    }

    dcSendJSON(dc, { type: 'all-done' });

    const totalTime = (Date.now() - startTime) / 1000;
    updateReceiver(receiverId, {
      status: 'done', progress: 100,
      avgSpeed: grandTotal / totalTime,
      totalTime, totalBytes: grandTotal
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
      config: { iceServers: ICE, sdpSemantics: 'unified-plan' },
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
          progress: 0, speed: 0, eta: '', networkMode: null,
          currentFile: 0, avgSpeed: 0, totalTime: 0, totalBytes: 0,
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
                if (msg.type === 'cancel') { conn._cancelled = true; updateReceiver(receiverId, { status: 'disconnected', error: 'Cancelled' }); }
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
          if (r.id === receiverId && r.status !== 'done') return { ...r, status: 'disconnected' };
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

  const togglePause = useCallback(() => setPaused(p => !p), []);

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

  const allDone = receivers.length > 0 && receivers.every(r => r.status === 'done' || r.status === 'error' || r.status === 'disconnected');
  useEffect(() => {
    if (allDone && statusRef.current === 'transferring') {
      setStatus('done');
      setCodeExpiry(Date.now() + 10 * 60 * 1000);
      expiryRef.current = setTimeout(() => { cleanup(); setCode(''); setCodeExpiry(null); }, 10 * 60 * 1000);
    }
  }, [allDone, cleanup]);

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
  const pendingUIRef = useRef({ progress: null, speed: null, eta: null });

  const isTransferring = status === 'receiving' || status === 'connected';
  useBeforeUnload(isTransferring);
  useEffect(() => { statusRef.current = status; }, [status]);

  const flushUI = useCallback(() => {
    const p = pendingUIRef.current;
    if (p.progress !== null) setProgress(p.progress);
    if (p.speed !== null) setSpeed(p.speed);
    if (p.eta !== null) setEta(p.eta);
    pendingUIRef.current = { progress: null, speed: null, eta: null };
    rafRef.current = null;
  }, []);

  const scheduleUI = useCallback((pct, spd, etaStr) => {
    pendingUIRef.current.progress = pct;
    if (spd !== undefined) pendingUIRef.current.speed = spd;
    if (etaStr !== undefined) pendingUIRef.current.eta = etaStr;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushUI);
  }, [flushUI]);

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
    const etaStr = spd > 0 ? formatTime(rem / spd) : '--:--';
    lastEtaRef.current = etaStr;

    const pct = total > 0 ? (received >= total ? 100 : Math.min(99, Math.round((received / total) * 100))) : 0;
    scheduleUI(pct, spd, etaStr);

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
        setTransferStats({
          totalBytes: grandReceivedRef.current, totalTime: tt,
          avgSpeed: grandReceivedRef.current / tt,
          fileCount: fileListRef.current.length || 1
        });
        setProgress(100);
        setStatus('done');
        // Free all buffers on completion
        freeBuffers();
        playDone();
        break;
      }

      case 'cancel':
        stopAckTimer();
        freeBuffers();
        setError('Transfer cancelled by sender');
        setStatus('error');
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

    const peer = new Peer({
      config: { iceServers: ICE, sdpSemantics: 'unified-plan' },
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
          setError('Connection closed'); setStatus('error');
        }
      });
      conn.on('error', (e) => {
        if (!destroyedRef.current) {
          stopAckTimer();
          freeBuffers();
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
    setStatus('idle'); setError(''); setProgress(0); setSpeed(0); setEta('');
    setFileList([]); setCurrentFileIndex(0); setCurrentFileName('');
    setTransferStats(null); setPeerDevice(null); setNetworkMode(null); setActiveChunkSize(0);
  }, [stopAckTimer, freeBuffers]);

  useEffect(() => cleanup, [cleanup]);

  return {
    status, progress, speed: formatBytes(speed) + '/s', eta, error,
    fileList, currentFileIndex, currentFileName,
    transferStats, peerDevice, networkMode, activeChunkSize,
    connect, cleanup, formatBytes
  };
}

export { formatBytes, getDeviceName, NETWORK_MODES, CHUNK_TIERS };
