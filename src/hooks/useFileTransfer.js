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
    const hostLocal = [], hostRemote = [];
    
    stats.forEach((s) => {
      if (s.type === 'local-candidate') {
        if (s.id === lId) { lt = s.candidateType || ''; la = s.address || s.ip || ''; }
        if (s.candidateType === 'host') hostLocal.push(s.address || s.ip || '');
      }
      if (s.type === 'remote-candidate') {
        if (s.id === rId) { rt = s.candidateType || ''; ra = s.address || s.ip || ''; }
        if (s.candidateType === 'host') hostRemote.push(s.address || s.ip || '');
      }
    });

    r.localIP = la; r.remoteIP = ra;

    const isPrivateIP = (ip) => {
      if (!ip) return false;
      if (ip.includes(':')) return ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:');
      return ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
    };

    // Default WebRTC classification logic
    if (lt === 'relay' || rt === 'relay') r.mode = 'relay';
    else if (lt === 'host' && rt === 'host') {
      // Two phones on Mobile Data get globally routable IPv6 'host' addresses. These are NOT LANs.
      if (isPrivateIP(la) && isPrivateIP(ra)) r.mode = 'lan';
      else r.mode = 'internet';
    }
    else if ((lt === 'srflx' || rt === 'srflx') && la && ra && la === ra) r.mode = 'wifi';
    else if (lt === 'host' || rt === 'host') r.mode = 'wifi';
    else {
      let hasWorkingHostPair = false;
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
          const lc = stats.get(s.localCandidateId);
          const rc = stats.get(s.remoteCandidateId);
          if (lc && rc && (lc.candidateType === 'host' || rc.candidateType === 'host')) hasWorkingHostPair = true;
        }
      });
      r.mode = hasWorkingHostPair ? 'wifi' : 'internet';
    }

    // OVERRIDE: Indian Telecom Carrier-Grade NAT (Jio / Vi / Airtel) Edge Case
    // Two phones on mobile data will often get 10.x.x.x IPs. WebRTC successfully connects them directly
    const isCGNAT = (ip) => ip.startsWith('10.') && !ip.startsWith('10.43.') && !ip.startsWith('10.0.');
    if (isCGNAT(la) && isCGNAT(ra) && r.mode !== 'relay') {
      r.mode = 'internet'; 
    }
    
    // OVERRIDE: Android Hotspot to Android Mobile Edge Case
    if (isPrivateIP(la) && isPrivateIP(ra) && r.mode === 'internet') {
      const lp = la.split('.'), rp = ra.split('.');
      if (lp[0] === rp[0] && lp[1] === rp[1]) r.mode = 'wifi';
    }

    // Sync network mode directly to the PeerJS conn object so the UI can force-sync easily
    conn._networkMode = r.mode;

    const m = NETWORK_MODES[r.mode];
    console.log(`%c[DropBeam™] ${m.icon} ${m.label}`, 'color:' + m.color + ';font-weight:bold;font-size:14px');
    console.log(`  Selected pair: ${lt} ${la} | ${rt} ${ra}`);
    console.log(`  Hosts: local[${hostLocal.join(',')}] remote[${hostRemote.join(',')}]`);
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



// ====== SENDER ======
export function useFileSender() {
  const [status, setStatus] = useState('idle');
  const [code, setCode] = useState('');
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [codeExpiry, setCodeExpiry] = useState(null);
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

  const updateReceiver = useCallback((id, updates) => {
    setReceivers(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  }, []);

  const transferToReceiver = useCallback(async (receiverId, conn, filesToSend, tier) => {
    // Dynamic config — auto-scales chunk size based on LIVE receiver speed
    const getConfig = () => {
      const spd = latestReceiverSpeed;
      // Aggressively scale chunks based on actual throughput.
      // Start with calibration tier, upgrade/downgrade dynamically.
      if (spd > 8 * 1024 * 1024)  return CHUNK_TIERS.ultra;      // > 8 MB/s  → 10MB chunks
      if (spd > 3 * 1024 * 1024)  return CHUNK_TIERS.lan;        // > 3 MB/s  → 2MB chunks
      if (spd > 1 * 1024 * 1024)  return CHUNK_TIERS.fast;       // > 1 MB/s  → 1MB chunks
      if (spd > 500 * 1024)       return CHUNK_TIERS.balanced;   // > 500 KB/s → 512KB chunks
      if (spd > 0)                return CHUNK_TIERS.unstable;   // < 500 KB/s → 256KB chunks
      return CHUNK_TIERS[tier] || CHUNK_TIERS.balanced;           // Fallback to calibration
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

        // Re-read config before pipelining to allow instant slider changes
        let c = getConfig();
        if (c.size !== lastSentChunkSize) {
          lastSentChunkSize = c.size;
          try { conn.send({ type: 'config-update', chunkSize: c.size }); } catch(e){}
          updateReceiver(receiverId, { activeChunkSize: c.size });
        }

        // Pipeline read
        const reads = [];
        let pre = offset;
        for (let i = 0; i < c.pipeline && pre < file.size; i++) {
          
          // CRITICAL: Sub-pipeline check. If the user clicks the speed slider WHILE we are
          // generating the pipeline, we must instantly abort the large buffered reads and switch
          // to the requested small chunk size so the speed drop is instantaneous.
          const freshC = getConfig();
          if (freshC.size !== c.size) {
            c = freshC;
            lastSentChunkSize = c.size;
            try { conn.send({ type: 'config-update', chunkSize: c.size }); } catch(e){}
            updateReceiver(receiverId, { activeChunkSize: c.size });
            break; // Abort this pipeline aggressively to apply new size on next tick
          }

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
              let resolved = false;
              const cleanup = () => { 
                if (resolved) return;
                resolved = true;
                dc.removeEventListener('bufferedamountlow', cleanup); 
                resolve(); 
              };
              dc.bufferedAmountLowThreshold = c.bufLow;
              dc.addEventListener('bufferedamountlow', cleanup);
              const check = () => { 
                if (resolved) return;
                if (!dc || dc.bufferedAmount < c.bufLow) cleanup(); 
                else setTimeout(check, 10); 
              };
              setTimeout(check, 10);
            });
          }

          // WebRTC MTU Optimization: Sending > 64KB in a single frame can cause severe SCTP packet loss/stalling on WiFi.
          // We slice the large memory buffer into zero-copy 64KB chunks for the actual DataChannel transfer.
          const u8 = new Uint8Array(buf);
          const MAX_PAYLOAD = 64 * 1024;
          for (let pByte = 0; pByte < u8.byteLength; pByte += MAX_PAYLOAD) {
            const chunkView = new Uint8Array(u8.buffer, u8.byteOffset + pByte, Math.min(MAX_PAYLOAD, u8.byteLength - pByte));
            conn.send(chunkView);
          }

          offset += buf.byteLength;
          updateReceiver(receiverId, { bytesSent: offset });
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

export { formatBytes, getDeviceName, NETWORK_MODES, CHUNK_TIERS };
