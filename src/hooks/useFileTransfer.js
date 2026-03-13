import { useState, useRef, useCallback, useEffect } from 'react';
import Peer from 'peerjs';

// ===== CHUNK TIERS =====
const CHUNK_TIERS = {
  unstable: { size: 256 * 1024, label: 'Unstable', buffer: 2 * 1024 * 1024, bufLow: 512 * 1024, pipeline: 4 },
  balanced: { size: 512 * 1024, label: 'Balanced', buffer: 4 * 1024 * 1024, bufLow: 1 * 1024 * 1024, pipeline: 6 },
  fast:     { size: 1024 * 1024, label: 'Fast WiFi', buffer: 8 * 1024 * 1024, bufLow: 2 * 1024 * 1024, pipeline: 8 },
  lan:      { size: 2 * 1024 * 1024, label: 'LAN', buffer: 16 * 1024 * 1024, bufLow: 4 * 1024 * 1024, pipeline: 12 },
  ultra:    { size: 10 * 1024 * 1024, label: 'Ultra (10MB)', buffer: 40 * 1024 * 1024, bufLow: 10 * 1024 * 1024, pipeline: 4 },
};

const NETWORK_MODES = {
  lan: { label: 'LAN / Hotspot', icon: '🔌', color: '#22c55e', detail: 'Same network — max speed' },
  wifi: { label: 'Same WiFi', icon: '📶', color: '#3b82f6', detail: 'Same WiFi — fast transfer' },
  internet: { label: 'Internet', icon: '🌐', color: '#f59e0b', detail: 'P2P through internet' },
  relay: { label: 'Relay', icon: '☁️', color: '#ef4444', detail: 'Relay — limited speed' },
};

const SPEED_LIMITS = [
  { label: 'Unlimited', value: 0 },
  { label: '256 KB/s', value: 256 * 1024 },
  { label: '512 KB/s', value: 512 * 1024 },
  { label: '1 MB/s', value: 1024 * 1024 },
  { label: '2 MB/s', value: 2 * 1024 * 1024 },
  { label: '5 MB/s', value: 5 * 1024 * 1024 },
  { label: '10 MB/s', value: 10 * 1024 * 1024 },
];



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

function isBinary(d) {
  return d instanceof ArrayBuffer || d instanceof Uint8Array || ArrayBuffer.isView(d) || d instanceof Blob;
}
function toU8(d) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return null;
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
  { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

// ===== NETWORK DETECT =====
async function detectNetwork(conn) {
  const r = { mode: 'internet', localIP: '', remoteIP: '' };
  try {
    const pc = conn.peerConnection || conn._pc;
    if (!pc) return r;
    const stats = await pc.getStats();
    let lId = null, rId = null;
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.state === 'succeeded' || s.selected)) {
        lId = s.localCandidateId; rId = s.remoteCandidateId;
      }
    });
    let lt = '', rt = '', la = '', ra = '';
    stats.forEach((s) => {
      if (s.type === 'local-candidate' && s.id === lId) { lt = s.candidateType || ''; la = s.address || s.ip || ''; }
      if (s.type === 'remote-candidate' && s.id === rId) { rt = s.candidateType || ''; ra = s.address || s.ip || ''; }
    });
    r.localIP = la; r.remoteIP = ra;

    // Find if ANY host-to-host pair actually succeeded
    let hasWorkingHostPair = false;
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && s.state === 'succeeded') {
        const lc = stats.get(s.localCandidateId);
        const rc = stats.get(s.remoteCandidateId);
        if (lc && rc && lc.candidateType === 'host' && rc.candidateType === 'host') {
          hasWorkingHostPair = true;
        }
      }
    });

    if (lt === 'relay' || rt === 'relay') {
      r.mode = hasWorkingHostPair ? 'wifi' : 'relay';
    } else if (lt === 'host' && rt === 'host') {
      r.mode = 'lan';
    } else if (hasWorkingHostPair) {
      r.mode = 'lan'; // Local connection worked but ICE preferred srflx
    } else if (lt === 'srflx' || rt === 'srflx') {
      // Both behind same NAT? same public IP = same WiFi
      if (la && ra && la === ra) r.mode = 'wifi';
      else r.mode = 'internet';
    }

    const m = NETWORK_MODES[r.mode];
    console.log(`%c[DropBeam™] ${m.icon} ${m.label}`, 'color:' + m.color + ';font-weight:bold;font-size:14px');
    console.log(`  Selected pair: ${lt} ${la} | ${rt} ${ra}`);
    console.log(`  Working host pair found: ${hasWorkingHostPair}`);
  } catch (e) { console.log('[DropBeam™] Network detection error:', e); }
  return r;
}

// ===== SPEED CALIBRATION =====
async function calibrate(conn) {
  const sz = 256 * 1024, rounds = 3;
  conn.send({ type: 'cal-start', rounds, size: sz });
  await new Promise(r => setTimeout(r, 50));
  const speeds = [];
  for (let i = 0; i < rounds; i++) {
    const buf = new ArrayBuffer(sz);
    const t = performance.now();
    conn.send(buf);
    const got = await new Promise((res) => {
      const h = (d) => { if (d?.type === 'cal-ack' && !isBinary(d)) { conn.off('data', h); res(true); } };
      conn.on('data', h);
      setTimeout(() => { conn.off('data', h); res(false); }, 5000);
    });
    const el = (performance.now() - t) / 1000;
    if (got && el > 0) speeds.push(sz / el);
  }
  conn.send({ type: 'cal-done' });
  if (!speeds.length) return 'balanced';
  const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  let tier;
  if (avg > 25 * 1024 * 1024) tier = 'ultra'; // > 25 MB/s
  else if (avg > 10 * 1024 * 1024) tier = 'lan';
  else if (avg > 2 * 1024 * 1024) tier = 'fast';
  else if (avg > 500 * 1024) tier = 'balanced';
  else tier = 'unstable';
  console.log(`%c[DropBeam™] Speed: ${formatBytes(avg)}/s → ${CHUNK_TIERS[tier].label} (${formatBytes(CHUNK_TIERS[tier].size)} chunks)`, 'color:#3b82f6;font-weight:bold');
  return tier;
}

// ===== WAIT FOR PAUSE =====
async function waitIfPaused(pausedRef, destroyedRef) {
  if (!pausedRef.current) return;
  await new Promise((resolve) => {
    const check = () => {
      if (!pausedRef.current || destroyedRef.current) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}

// ===== BANDWIDTH THROTTLE (Token Bucket) =====
async function throttle(speedLimitRef, windowStartRef, bytesSent, destroyedRef) {
  const limit = speedLimitRef.current;
  if (!limit || limit <= 0) return;

  const msPerByte = 1000 / limit;
  const costMs = bytesSent * msPerByte;
  const now = Date.now();

  // Initialize or reset if we fell too far behind (no arbitrary arbitrary buffering)
  if (!windowStartRef.current || now > windowStartRef.current) {
    windowStartRef.current = now;
  }

  windowStartRef.current += costMs;
  const delay = windowStartRef.current - Date.now();

  if (delay > 10) {
    let remaining = delay;
    while (remaining > 0 && !destroyedRef?.current) {
      const step = Math.min(remaining, 50);
      await new Promise(r => setTimeout(r, step));
      remaining -= step;
      // Break early if speed limit is changed mid-sleep
      if (speedLimitRef.current !== limit) {
        windowStartRef.current = Date.now(); // Reset bucket for new limit
        break;
      }
    }
  }
}

// ====== SENDER ======
export function useFileSender() {
  const [status, setStatus] = useState('idle');
  const [code, setCode] = useState('');
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [codeExpiry, setCodeExpiry] = useState(null);
  const [speedLimit, setSpeedLimit] = useState(0);
  const [paused, setPaused] = useState(false);
  // Multi-device: array of receiver states
  const [receivers, setReceivers] = useState([]);

  const peerRef = useRef(null);
  const destroyedRef = useRef(false);
  const statusRef = useRef('idle');
  const filesRef = useRef([]);
  const expiryRef = useRef(null);
  const pausedRef = useRef(false);
  const speedLimitRef = useRef(0);
  const receiversRef = useRef([]);

  const isTransferring = receivers.some(r => r.status === 'transferring' || r.status === 'calibrating');
  useBeforeUnload(isTransferring || status === 'waiting');
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  // Sync setters — update ref immediately + state for UI
  const setSpeedLimitSync = useCallback((v) => { speedLimitRef.current = v; setSpeedLimit(v); }, []);

  const updateReceiver = useCallback((id, updates) => {
    setReceivers(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  }, []);

  const transferToReceiver = useCallback(async (receiverId, conn, filesToSend, tier) => {
    // Dynamic config — re-read each file iteration
    const getConfig = () => {
      const limit = speedLimitRef.current;
      let config = CHUNK_TIERS[tier] || CHUNK_TIERS.balanced;

      // Enforce very tight backpressure to match throttle limits (prevent WebRTC buffering 50MB instantly)
      if (limit > 0) {
        // Force chunk size to cover max 0.25s of data, max 256KB
        const constrainedSize = Math.max(16 * 1024, Math.min(config.size, Math.floor(limit / 4), 256 * 1024));
        return { size: constrainedSize, buffer: constrainedSize * 2, bufLow: constrainedSize, pipeline: 1 };
      }
      
      // Auto-scaling logic if no hard limit is set
      const spd = latestReceiverSpeed;
      if (spd > 30 * 1024 * 1024) config = CHUNK_TIERS.ultra;
      else if (spd > 15 * 1024 * 1024) config = CHUNK_TIERS.lan;
      else if (spd > 5 * 1024 * 1024) config = CHUNK_TIERS.fast;
      else if (spd > 1 * 1024 * 1024) config = CHUNK_TIERS.balanced;
      else if (spd > 0) config = CHUNK_TIERS.unstable;

      return config;
    };

    updateReceiver(receiverId, { status: 'transferring', progress: 0, speed: 0, eta: '' });

    // Listen for acks
    let latestReceiverBytes = 0;
    let latestReceiverSpeed = 0;
    const ackHandler = (data) => {
      if (data?.type === 'ack' && !isBinary(data)) {
        if (data.received !== undefined) latestReceiverBytes = Math.max(latestReceiverBytes, data.received);
        if (data.speed !== undefined) latestReceiverSpeed = data.speed;
        updateReceiver(receiverId, { progress: data.progress ?? 0, speed: data.speed || 0, eta: data.eta || '' });
      }
    };
    conn.on('data', ackHandler);

    const initConfig = getConfig();
    updateReceiver(receiverId, { activeChunkSize: initConfig.size });
    conn.send({
      type: 'file-list',
      files: filesToSend.map(f => ({ name: f.name, size: f.size, fileType: f.type })),
      device: getDeviceName(),
      chunkSize: initConfig.size, tier
    });
    await new Promise(r => setTimeout(r, 100));

    const grandTotal = filesToSend.reduce((s, f) => s + f.size, 0);
    const startTime = Date.now();
    const windowStartRef = { current: Date.now() };

    for (let fi = 0; fi < filesToSend.length; fi++) {
      if (destroyedRef.current) break;
      const file = filesToSend[fi];
      updateReceiver(receiverId, { currentFile: fi });

      conn.send({ type: 'file-start', index: fi, name: file.name, size: file.size, fileType: file.type });
      await new Promise(r => setTimeout(r, 50));

      const cfg = getConfig(); // Re-read config each file
      let offset = 0;
      let lastSentChunkSize = cfg.size;
      updateReceiver(receiverId, { bytesSent: 0, bytesTotal: file.size, activeChunkSize: cfg.size });

      while (offset < file.size) {
        if (destroyedRef.current) break;

        // Pause check
        await waitIfPaused(pausedRef, destroyedRef);
        if (destroyedRef.current) break;

        // Re-read config each iteration for live changes
        const c = getConfig();
        if (c.size !== lastSentChunkSize) {
          lastSentChunkSize = c.size;
          try { conn.send({ type: 'config-update', chunkSize: c.size }); } catch(e){}
          updateReceiver(receiverId, { activeChunkSize: c.size });
        }

        // Pipeline read
        const reads = [];
        let pre = offset;
        for (let i = 0; i < c.pipeline && pre < file.size; i++) {
          const end = Math.min(pre + c.size, file.size);
          reads.push(file.slice(pre, end).arrayBuffer());
          pre = end;
        }
        const buffers = await Promise.all(reads);

        // Calculate maximum bytes we can send in this cluster to prevent over-sending file size
        for (let i = 0; i < buffers.length; i++) {
          const buf = buffers[i];
          if (!buf || destroyedRef.current) break;
          if (offset >= file.size) break;

          await waitIfPaused(pausedRef, destroyedRef);
          if (destroyedRef.current) break;

          // Backpressure (Allow 20% burst over buffer limit to maintain continuous LAN throughput)
          const dc = conn.dataChannel || conn._dc;
          if (dc && dc.bufferedAmount > c.buffer * 1.2) {
            await new Promise((resolve) => {
              const check = () => { if (!dc || dc.bufferedAmount < c.bufLow) resolve(); else setTimeout(check, 1); };
              dc.bufferedAmountLowThreshold = c.bufLow;
              const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); resolve(); };
              dc.addEventListener('bufferedamountlow', onLow);
              setTimeout(check, 10);
            });
          }

          conn.send(buf);
          offset += buf.byteLength;
          updateReceiver(receiverId, { bytesSent: offset });

          // Bandwidth throttle (only await if there is actually a limit)
          if (speedLimitRef.current > 0) {
            await throttle(speedLimitRef, windowStartRef, buf.byteLength, destroyedRef);
          }
        }
      }

      conn.send({ type: 'file-end', index: fi });
      await new Promise(r => setTimeout(r, 50));
    }

    // Wait for the receiver to completely drain the network buffer and confirm all bytes received
    // doing this BEFORE sending `all-done` prevents the JSON message overtaking async binary chunks
    await new Promise((resolve) => {
      if (latestReceiverBytes >= grandTotal) return resolve();
      
      let checkInterval;
      const waitBytes = (d) => {
        if (d?.type === 'ack' && d.received !== undefined && d.received >= grandTotal) {
          conn.off('data', waitBytes);
          clearInterval(checkInterval);
          resolve();
        }
      };
      conn.on('data', waitBytes);
      
      checkInterval = setInterval(() => {
        if (destroyedRef.current || latestReceiverBytes >= grandTotal) {
          conn.off('data', waitBytes);
          clearInterval(checkInterval);
          resolve();
        }
      }, 200);
    });

    conn.send({ type: 'all-done' });

    conn.off('data', ackHandler);

    const totalTime = (Date.now() - startTime) / 1000;
    updateReceiver(receiverId, {
      status: 'done', progress: 100,
      avgSpeed: grandTotal / totalTime,
      totalTime, totalBytes: grandTotal
    });
    playDone();
  }, [updateReceiver]);

  const initPeer = useCallback(() => {
    if (peerRef.current) peerRef.current.destroy();
    destroyedRef.current = false;
    setReceivers([]);
    setCodeExpiry(null);
    setPaused(false);
    if (expiryRef.current) clearTimeout(expiryRef.current);

    const myCode = generateCode();
    const peer = new Peer(myCode, { config: { iceServers: ICE } });

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

        // Add receiver to list
        const newReceiver = {
          id: receiverId, conn, device: '', status: 'calibrating',
          progress: 0, speed: 0, eta: '', networkMode: null, chunkTier: null,
          currentFile: 0, chunksSent: 0, chunksTotal: 0,
          avgSpeed: 0, totalTime: 0, totalBytes: 0,
        };
        setReceivers(prev => [...prev, newReceiver]);
        receiversRef.current.push(newReceiver);

        // Detect network
        const net = await detectNetwork(conn);
        updateReceiver(receiverId, { networkMode: net.mode });

        // Calibrate speed
        let tier;
        try { tier = await calibrate(conn); } catch {
          tier = net.mode === 'lan' ? 'lan' : net.mode === 'wifi' ? 'fast' : net.mode === 'relay' ? 'unstable' : 'balanced';
        }
        updateReceiver(receiverId, { chunkTier: tier, status: 'connected' });

        setStatus('transferring');

        // Auto-send
        const currentFiles = filesRef.current;
        if (currentFiles.length) {
          transferToReceiver(receiverId, conn, currentFiles, tier);
        }
      });

      conn.on('data', (data) => {
        if (data?.type === 'device-info' && !isBinary(data)) {
          updateReceiver(receiverId, { device: data.device || '' });
        }
      });

      conn.on('close', () => {
        if (destroyedRef.current) return;
        updateReceiver(receiverId, (prev) => {
          if (prev?.status !== 'done') return { status: 'disconnected' };
          return {};
        });
      });

      conn.on('error', (err) => {
        updateReceiver(receiverId, { status: 'error', error: err.message });
      });
    });

    peer.on('error', (err) => {
      if (destroyedRef.current) return;
      if (err.type === 'unavailable-id') { setTimeout(() => initPeer(), 100); return; }
      setError(err.message || 'Connection failed'); setStatus('error');
    });

    peerRef.current = peer;
  }, [transferToReceiver, updateReceiver]);

  const togglePause = useCallback(() => {
    setPaused(p => !p);
  }, []);

  const cleanup = useCallback(() => {
    destroyedRef.current = true;
    if (expiryRef.current) clearTimeout(expiryRef.current);
    receiversRef.current.forEach(r => { try { r.conn?.close(); } catch (e) {} });
    receiversRef.current = [];
    if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  // Check if all receivers are done
  const allDone = receivers.length > 0 && receivers.every(r => r.status === 'done' || r.status === 'error' || r.status === 'disconnected');
  useEffect(() => {
    if (allDone && statusRef.current === 'transferring') {
      setStatus('done');
      const expiryTime = Date.now() + 10 * 60 * 1000;
      setCodeExpiry(expiryTime);
      expiryRef.current = setTimeout(() => { cleanup(); setCode(''); setCodeExpiry(null); }, 10 * 60 * 1000);
    }
  }, [allDone, cleanup]);

  return {
    status, code, files, setFiles, error, codeExpiry,
    speedLimit, setSpeedLimit: setSpeedLimitSync,
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
  const [chunkInfo, setChunkInfo] = useState({ received: 0, total: 0 });
  const [networkMode, setNetworkMode] = useState(null);
  const [chunkTier, setChunkTier] = useState(null);
  const [activeChunkSize, setActiveChunkSize] = useState(0);
  const [calibrating, setCalibrating] = useState(false);

  const peerRef = useRef(null);
  const connRef = useRef(null);
  const chunksRef = useRef([]);
  const receivedSizeRef = useRef(0);
  const fileTypeRef = useRef('');
  const fileNameRef = useRef('');
  const grandTotalRef = useRef(0);
  const grandReceivedRef = useRef(0);
  const startTimeRef = useRef(null);
  const destroyedRef = useRef(false);
  const statusRef = useRef('idle');
  const lastAckRef = useRef(0);
  const speedWindowRef = useRef([]);

  const isTransferring = status === 'receiving' || status === 'connected';
  useBeforeUnload(isTransferring || calibrating);
  useEffect(() => { statusRef.current = status; }, [status]);

  const sendAck = useCallback((pct) => {
    const conn = connRef.current;
    if (!conn) return;
    const now = Date.now();

    speedWindowRef.current.push({ time: now, bytes: grandReceivedRef.current });
    while (speedWindowRef.current.length > 2 && now - speedWindowRef.current[0].time > 2000) {
      speedWindowRef.current.shift();
    }
    const oldest = speedWindowRef.current[0];
    let instSpd = 0;
    if (now - oldest.time > 0) instSpd = (grandReceivedRef.current - oldest.bytes) / ((now - oldest.time) / 1000);

    if (now - lastAckRef.current < 200 && pct < 100) return;

    const rem = grandTotalRef.current - grandReceivedRef.current;
    const etaStr = instSpd > 0 ? formatTime(rem / instSpd) : '--:--';
    setSpeed(instSpd);
    setEta(etaStr);
    try { conn.send({ type: 'ack', progress: pct, received: grandReceivedRef.current, speed: instSpd, eta: etaStr }); } catch (e) {}
    lastAckRef.current = now;
  }, []);

  const processChunk = useCallback((d) => {
    const arr = toU8(d);
    if (!arr) return;
    chunksRef.current.push(arr);
    receivedSizeRef.current += arr.byteLength;
    grandReceivedRef.current += arr.byteLength;
    const pct = Math.min(99, Math.round((grandReceivedRef.current / grandTotalRef.current) * 100));
    setProgress(pct);
    sendAck(pct);
  }, [sendAck]);

  const connect = useCallback((code) => {
    if (peerRef.current) peerRef.current.destroy();
    destroyedRef.current = false;
    setStatus('connecting');
    setError('');
    setNetworkMode(null);
    setChunkTier(null);

    const peer = new Peer({ config: { iceServers: ICE } });

    peer.on('open', () => {
      if (destroyedRef.current) return;
      const conn = peer.connect(code.toUpperCase(), { reliable: true });

      conn.on('open', async () => {
        if (destroyedRef.current) return;
        setStatus('connected');
        connRef.current = conn;
        conn.send({ type: 'device-info', device: getDeviceName() });
        setCalibrating(true);
        const net = await detectNetwork(conn);
        setNetworkMode(net.mode);
        setCalibrating(false);
      });

      conn.on('data', (data) => {
        if (destroyedRef.current) return;

        if (data && typeof data === 'object' && !isBinary(data)) {
          if (data.type === 'cal-start') return;
          if (data.type === 'cal-done') return;
          if (data.type === 'rejected') { setError(data.reason || 'Rejected'); setStatus('error'); return; }

          if (data.type === 'file-list') {
            setFileList(data.files || []);
            setPeerDevice(data.device || '');
            if (data.tier) setChunkTier(data.tier);
            const cs = data.chunkSize || 256 * 1024;
            setActiveChunkSize(cs);
            grandTotalRef.current = data.files.reduce((s, f) => s + f.size, 0);
            grandReceivedRef.current = 0;
            startTimeRef.current = Date.now();
            lastAckRef.current = Date.now();
            speedWindowRef.current = [{ time: Date.now(), bytes: 0 }];
            setStatus('receiving');
            return;
          }
          if (data.type === 'config-update') {
            setActiveChunkSize(data.chunkSize);
            return;
          }
          if (data.type === 'file-start') {
            setCurrentFileIndex(data.index);
            setCurrentFileName(data.name);
            fileTypeRef.current = data.fileType || 'application/octet-stream';
            fileNameRef.current = data.name;
            chunksRef.current = [];
            receivedSizeRef.current = 0;
            return;
          }
          if (data.type === 'file-end') {
            const blob = new Blob(chunksRef.current, { type: fileTypeRef.current });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fileNameRef.current;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            chunksRef.current = [];
            return;
          }
          if (data.type === 'all-done') {
            sendAck(100);
            const tt = (Date.now() - startTimeRef.current) / 1000;
            setTransferStats({
              totalBytes: grandReceivedRef.current, totalTime: tt,
              avgSpeed: grandReceivedRef.current / tt,
              fileCount: fileList.length || 1
            });
            setProgress(100);
            setStatus('done');
            playDone();
            return;
          }
        }

        if (isBinary(data)) {
          // Calibration ack
          if (statusRef.current === 'connected') {
            try { conn.send({ type: 'cal-ack' }); } catch (e) {}
            return;
          }
          if (data instanceof Blob) data.arrayBuffer().then(b => { if (!destroyedRef.current) processChunk(b); });
          else processChunk(data);
          return;
        }

        if (typeof data === 'string') {
          try { const m = JSON.parse(data); if (m.type) conn.emit('data', m); } catch (e) {}
        }
      });

      conn.on('close', () => { if (!destroyedRef.current && statusRef.current !== 'done') { setError('Connection closed'); setStatus('error'); } });
      conn.on('error', (e) => { if (!destroyedRef.current) { setError(e.message); setStatus('error'); } });
    });

    peer.on('error', (err) => {
      if (destroyedRef.current) return;
      setError(err.type === 'peer-unavailable' ? 'Invalid code or sender offline' : err.message || 'Failed');
      setStatus('error');
    });

    peerRef.current = peer;
  }, [processChunk, sendAck, fileList]);

  const cleanup = useCallback(() => {
    destroyedRef.current = true;
    chunksRef.current = [];
    if (connRef.current) { connRef.current.close(); connRef.current = null; }
    if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
    setStatus('idle');
    setError('');
    setProgress(0);
    setSpeed(0);
    setEta('');
    setFileList([]);
    setCurrentFileIndex(0);
    setCurrentFileName('');
    setTransferStats(null);
    setPeerDevice(null);
    setNetworkMode(null);
    setChunkTier(null);
    setActiveChunkSize(0);
    setCalibrating(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  return {
    status, progress, speed: formatBytes(speed) + '/s', eta, error,
    fileList, currentFileIndex, currentFileName,
    transferStats, peerDevice, networkMode, chunkTier, activeChunkSize, calibrating,
    connect, cleanup, formatBytes
  };
}

export { formatBytes, getDeviceName, NETWORK_MODES, CHUNK_TIERS, SPEED_LIMITS };
