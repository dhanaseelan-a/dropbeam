import { useState, useRef, useCallback, useEffect } from 'react';
import Peer from 'peerjs';

import { CHUNK_SIZE, createFilePump, createReceiveQueue, ReceiveSession, resumePosition } from '../lib/transferProtocol';
import { getRTCConfig } from '../lib/rtcConfig';
import { watchConnection } from '../lib/connectionDiagnostics';
import { applyPauseState, createControlChannel, waitForControlChannel, sendControlMessage as dcSendJSON } from '../lib/controlMessages';

const NETWORK_MODES = {
  unknown:  { label: 'Checking connection', icon: '⏳', color: '#71717a', detail: 'Route not reported yet' },
  lan:      { label: 'Direct connection', icon: '🔌', color: '#22c55e', detail: 'Direct host candidates' },
  wifi:     { label: 'Same WiFi',     icon: '📶', color: '#3b82f6', detail: 'Same WiFi' },
  internet: { label: 'Internet',      icon: '🌐', color: '#f59e0b', detail: 'Internet P2P' },
  relay:    { label: 'Relay',         icon: '☁️', color: '#ef4444', detail: 'Relay server' },
};

const CHUNK_TIERS = {
  slow:   { size: 128 * 1024,  label: 'Slow',   bufHi: 1 * 1024 * 1024,  ahead: 4 },
  normal: { size: 128 * 1024,  label: 'Normal', bufHi: 2 * 1024 * 1024,  ahead: 8 },
  fast:   { size: 256 * 1024,  label: 'Fast',   bufHi: 2 * 1024 * 1024,  ahead: 8 },
};

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
  } catch { /* Completion audio is optional. */ }
}

function getDC(conn) { return conn?.dataChannel || conn?._dc; }
function senderControl(receiver) { return receiver.control?.readyState === 'open' ? receiver.control : getDC(receiver.conn); }

// ====== SENDER ======
export function useFileSender() {
  const [status, setStatusState] = useState('idle');
  const [code, setCode] = useState('');
  const [files, setFilesState] = useState([]);
  const [error, setError] = useState('');
  const [networkWarning, setNetworkWarning] = useState('');
  const [codeExpiry, setCodeExpiry] = useState(null);
  const [paused, setPaused] = useState(false);
  const [receivers, setReceivers] = useState([]);
  const peerRef = useRef(null);
  const generationRef = useRef(0);
  const statusRef = useRef('idle');
  const filesRef = useRef([]);
  const expiryRef = useRef(null);
  const signalRetryRef = useRef(null);
  const pausedRef = useRef(false);
  const pauseVersionRef = useRef(0);
  const receiversRef = useRef([]);
  const pendingRef = useRef(new Set());
  const recoveryTimersRef = useRef(new Map());

  const setStatus = useCallback(value => { statusRef.current = value; setStatusState(value); }, []);
  const setFiles = useCallback(value => {
    filesRef.current = typeof value === 'function' ? value(filesRef.current) : value;
    setFilesState(filesRef.current);
  }, []);
  useBeforeUnload(status === 'waiting' || status === 'transferring');

  const stopConnections = useCallback(() => {
    generationRef.current++;
    clearTimeout(expiryRef.current);
    clearTimeout(signalRetryRef.current);
    expiryRef.current = null;
    for (const receiver of receiversRef.current) {
      receiver.pump?.cancel();
      dcSendJSON(senderControl(receiver), { type: 'cancel' });
    }
    // Invalidate callbacks before destroying the peer (which emits close).
    const peer = peerRef.current;
    peerRef.current = null;
    peer?.destroy();
    for (const cancel of pendingRef.current) cancel();
    pendingRef.current.clear();
    for (const timer of recoveryTimersRef.current.values()) clearTimeout(timer);
    recoveryTimersRef.current.clear();
    receiversRef.current = [];
  }, []);

  const cleanup = useCallback(() => {
    stopConnections();
    pausedRef.current = false;
    setStatus('idle'); setCode(''); setFiles([]); setError('');
    setReceivers([]); setPaused(false); setCodeExpiry(null); setNetworkWarning('');
  }, [stopConnections, setStatus, setFiles]);
  useEffect(() => cleanup, [cleanup]);

  const updateReceiver = useCallback((id, updates) => {
    receiversRef.current = receiversRef.current.map(r => r.id === id ? { ...r, ...updates } : r);
    const next = receiversRef.current;
    setReceivers([...next]);
    const terminal = next.length && next.every(r => ['done', 'error', 'cancelled'].includes(r.status));
    if (terminal && next.some(r => r.status === 'done')) {
      setStatus('done');
      if (!expiryRef.current) {
        setCodeExpiry(Date.now() + 10 * 60 * 1000);
        expiryRef.current = setTimeout(cleanup, 10 * 60 * 1000);
      }
    } else if (terminal) {
      setStatus('error');
      setError('Transfer stopped — no receiver completed the transfer');
    }
    // A disconnected receiver can reconnect using the same code; it is not a
    // completed transfer, and must not tear down other receivers or the peer.
  }, [cleanup, setStatus]);

  const togglePause = useCallback(() => {
    pausedRef.current = !pausedRef.current;
    pauseVersionRef.current++;
    setPaused(pausedRef.current);
    for (const receiver of receiversRef.current) {
      dcSendJSON(senderControl(receiver), { type: pausedRef.current ? 'pause' : 'resume', pauseVersion: pauseVersionRef.current });
      if (!pausedRef.current) receiver.pump?.wake();
    }
  }, []);

  const initPeer = useCallback(async function initialize(existingCode = null) {
    stopConnections();
    const generation = generationRef.current;
    const active = () => generation === generationRef.current;
    const transferId = crypto.randomUUID();
    pausedRef.current = false;
    pauseVersionRef.current = 0;
    setReceivers([]); setCodeExpiry(null); setPaused(false); setError('');
    setStatus('waiting');
    setCode('');
    const config = await getRTCConfig({ onWarning: message => { if (active()) setNetworkWarning(message); } });
    if (!active()) return;
    const peer = new Peer(existingCode || generateCode(), { config, debug: 0 });
    peerRef.current = peer;

    peer.on('open', id => {
      if (!active()) return;
      clearTimeout(signalRetryRef.current);
      setCode(id);
    });
    peer.on('disconnected', () => {
      if (!active()) return;
      clearTimeout(signalRetryRef.current);
      signalRetryRef.current = setTimeout(() => {
        if (active() && !peer.destroyed && peer.disconnected) peer.reconnect();
      }, 1000);
    });
    peer.on('connection', conn => {
      if (!active()) { conn.close(); return; }
      let receiverId = `r_${crypto.randomUUID()}`;
      let pump;
      let control;
      let stopMonitoring = () => {};
      let handshakeTimer;
      let disconnectedTimer;
      let removeHandshake = () => {};
      const dispose = () => {
        clearTimeout(handshakeTimer);
        clearTimeout(disconnectedTimer);
        removeHandshake();
        pump?.cancel();
        stopMonitoring();
        control?.close();
        control = null;
        pendingRef.current.delete(dispose);
      };
      pendingRef.current.add(dispose);
      handshakeTimer = setTimeout(() => { dispose(); conn.close(); }, 30000);

      conn.on('open', () => {
        if (!active()) { dispose(); conn.close(); return; }
        const dc = getDC(conn);
        if (!dc) { dispose(); conn.close(); return; }
        dc.binaryType = 'arraybuffer';
        const handshake = async event => {
          if (typeof event.data !== 'string') return;
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type !== 'device-info') return;
          removeHandshake();
          clearTimeout(handshakeTimer);
          if (!active()) return;
          if (message.protocol !== 2) {
            dcSendJSON(dc, { type: 'rejected', reason: 'Please refresh the receiving tab to update DropBeam, then reconnect with the same code.' });
            handshakeTimer = setTimeout(() => { dispose(); conn.close(); }, 1000);
            return;
          }
          // Device names are not unique. A stable receiver ID keeps two phones
          // with the same browser separate and reuses only the reconnecting row.
          const previous = receiversRef.current.find(r => message.receiverId && r.clientId === message.receiverId);
          if (previous) {
            receiverId = previous.id;
            previous.pump?.cancel();
            if (previous.conn !== conn) previous.conn.close();
            clearTimeout(recoveryTimersRef.current.get(receiverId));
            recoveryTimersRef.current.delete(receiverId);
          }
          const receiver = {
            id: receiverId, clientId: message.receiverId, conn, device: message.device || '',
            status: 'transferring', progress: 0, speed: 0, eta: '', etc: '', networkMode: null,
            currentFile: 0, avgSpeed: 0, totalTime: 0, totalBytes: 0,
            speedLabel: getSpeedLabel(0), remotePaused: !!message.paused,
            remoteHidden: message.hidden, remoteWasHidden: !!message.hidden,
            chunksSent: 0, totalChunks: 0, senderProgress: 0,
            senderSpeed: 0, senderEta: '', senderEtc: '', senderSpeedLabel: getSpeedLabel(0),
          };
          receiversRef.current = [...receiversRef.current.filter(r => r.id !== receiverId), receiver];
          setReceivers([...receiversRef.current]);
          clearTimeout(expiryRef.current); expiryRef.current = null;
          setCodeExpiry(null); setError(''); setStatus('transferring');
          const currentFiles = filesRef.current;
          const resume = resumePosition(currentFiles, message, transferId);
          const pc = conn.peerConnection || conn._pc;
          if (Number.isInteger(message.controlChannelId)) {
            const candidate = createControlChannel(conn, dc, message.controlChannelId);
            control = candidate;
            if (candidate && !await waitForControlChannel(candidate)) {
              candidate.close();
              if (control === candidate) control = null;
            }
            if (!active() || dc.readyState !== 'open') { dispose(); return; }
            if (control) dcSendJSON(dc, { type: 'control-ready', id: control.id });
          }
          // updateReceiver replaces render snapshots, so retain live handles in
          // the current row as well as this connection's callbacks.
          receiver.control = control;
          pump = createFilePump({
            channel: dc, controlChannel: control || dc, files: currentFiles, transferId, device: getDeviceName(), resume,
            initialPaused: !!message.paused, initialPauseVersion: message.pauseVersion ?? -1,
            maxMessageSize: pc?.sctp?.maxMessageSize,
            isPaused: () => pausedRef.current,
            onProgress: stats => {
              if (!active()) return;
              updateReceiver(receiverId, {
                progress: stats.progress, senderProgress: stats.progress,
                bytesSent: stats.received, bytesTotal: stats.total,
                activeChunkSize: stats.chunkSize, chunksSent: stats.chunksSent,
                totalChunks: currentFiles.reduce((n, f) => n + Math.ceil(f.size / stats.chunkSize), 0),
                currentFile: stats.index, speed: stats.speed, speedLabel: getSpeedLabel(stats.speed),
                eta: stats.eta, etc: stats.etc,
              });
            },
            onControl: msg => {
              if (!active()) return;
              if (typeof msg.hidden === 'boolean' && receiver.remoteHidden !== msg.hidden) {
                receiver.remoteHidden = msg.hidden;
                receiver.remoteWasHidden ||= msg.hidden;
                updateReceiver(receiverId, { remoteHidden: msg.hidden, remoteWasHidden: receiver.remoteWasHidden });
              }
              if (msg.type === 'pause' || msg.type === 'resume' || (msg.type === 'ack' && typeof msg.paused === 'boolean')) {
                const nextPaused = msg.paused;
                if (receiver.remotePaused !== nextPaused) {
                  receiver.remotePaused = nextPaused;
                  updateReceiver(receiverId, { remotePaused: nextPaused });
                  if (!nextPaused) pump?.wake();
                }
              }
              if (msg.type === 'cancel') {
                updateReceiver(receiverId, { status: 'cancelled' });
                dispose(); conn.close();
              }
            },
            onDone: stats => {
              if (!active()) return;
              const avgSpeed = stats.transferredBytes / stats.totalTime;
              updateReceiver(receiverId, { ...stats, status: 'done', progress: 100,
                senderProgress: 100, bytesSent: stats.totalBytes, avgSpeed,
                speedLabel: getSpeedLabel(avgSpeed),
                completionTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
              });
              dispose(); playDone();
            },
            onError: err => {
              if (!active()) return;
              updateReceiver(receiverId, { status: 'error', error: err.message });
              dcSendJSON(control || dc, { type: 'rejected', reason: err.message });
              dispose();
            },
            onDisconnect: () => {
              if (!active()) return;
              updateReceiver(receiverId, { status: 'disconnected' });
              dispose(); conn.close();
            },
          });
          receiver.pump = pump;
          updateReceiver(receiverId, { pump, control });
          dcSendJSON(control || dc, { type: pausedRef.current ? 'pause' : 'resume', pauseVersion: pauseVersionRef.current });
          stopMonitoring = watchConnection(conn, info => {
            if (active() && dc.readyState === 'open') updateReceiver(receiverId, {
              networkMode: info.mode, connectionInfo: info, flowInfo: pump?.diagnostics(),
            });
          }, {
            onVisibility: hidden => dcSendJSON(control || dc, { type: 'page-state', hidden }),
          });
        };
        dc.addEventListener('message', handshake);
        removeHandshake = () => dc.removeEventListener('message', handshake);
      });
      conn.on('iceStateChanged', state => {
        clearTimeout(disconnectedTimer);
        if (state === 'failed') { dispose(); conn.close(); }
        else if (state === 'disconnected') {
          // PeerJS does not renegotiate restartIce(). Replace only this data
          // connection after a grace period and let the receiver resume it.
          disconnectedTimer = setTimeout(() => { if (active()) { dispose(); conn.close(); } }, 10000);
        }
      });
      conn.on('close', () => {
        dispose();
        if (!active()) return;
        const current = receiversRef.current.find(r => r.id === receiverId);
        if (current?.conn === conn && !['done', 'cancelled', 'error'].includes(current.status)) {
          updateReceiver(receiverId, { status: 'disconnected' });
          clearTimeout(recoveryTimersRef.current.get(receiverId));
          recoveryTimersRef.current.set(receiverId, setTimeout(() => {
            recoveryTimersRef.current.delete(receiverId);
            const receiver = receiversRef.current.find(r => r.id === receiverId);
            if (active() && receiver?.conn === conn && receiver.status === 'disconnected') {
              updateReceiver(receiverId, { status: 'error', error: 'Receiver did not reconnect within five minutes' });
            }
          }, 5 * 60 * 1000));
        }
      });
      conn.on('error', () => { dispose(); conn.close(); });
    });
    peer.on('error', err => {
      if (!active()) return;
      if (err.type === 'unavailable-id') { void initialize(); return; }
      if (['network', 'disconnected', 'webrtc', 'peer-unavailable'].includes(err.type)) return;
      setError(err.message || 'Connection failed'); setStatus('error');
    });
  }, [stopConnections, setStatus, updateReceiver]);

  return { status, code, files, setFiles, error, networkWarning, codeExpiry, paused, togglePause,
    receivers, initPeer, cleanup, formatBytes };
}

const emptyMetrics = () => ({ progress: 0, speed: 0, eta: '', etc: '',
  bytesReceived: 0, bytesTotal: 0, chunksReceived: 0, speedLabel: getSpeedLabel(0) });

// ====== RECEIVER ======
export function useFileReceiver() {
  const [status, setStatusState] = useState('idle');
  const [metrics, setMetrics] = useState(emptyMetrics);
  const [error, setError] = useState('');
  const [networkWarning, setNetworkWarning] = useState('');
  const [fileList, setFileList] = useState([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [currentFileName, setCurrentFileName] = useState('');
  const [transferStats, setTransferStats] = useState(null);
  const [peerDevice, setPeerDevice] = useState('');
  const [networkMode, setNetworkMode] = useState(null);
  const [connectionInfo, setConnectionInfo] = useState(null);
  const [remoteHidden, setRemoteHidden] = useState(null);
  const [remoteWasHidden, setRemoteWasHidden] = useState(false);
  const [activeChunkSize, setActiveChunkSize] = useState(0);
  const [remotePaused, setRemotePaused] = useState(false);
  const [paused, setPaused] = useState(false);
  const peerRef = useRef(null);
  const connRef = useRef(null);
  const dcRef = useRef(null);
  const controlRef = useRef(null);
  const generationRef = useRef(0);
  const statusRef = useRef('idle');
  const pausedRef = useRef(false);
  const pauseVersionRef = useRef(0);
  const senderPauseRef = useRef({ paused: false, version: -1 });
  const pauseChangedRef = useRef(() => {});
  const sessionRef = useRef(new ReceiveSession());
  const disposeRef = useRef(() => {});

  const setStatus = useCallback(value => { statusRef.current = value; setStatusState(value); }, []);
  useBeforeUnload(['receiving', 'connected', 'connecting', 'reconnecting'].includes(status));

  const stopConnection = useCallback(() => {
    generationRef.current++;
    disposeRef.current();
    disposeRef.current = () => {};
    const peer = peerRef.current;
    peerRef.current = null; connRef.current = null; dcRef.current = null; controlRef.current = null;
    pauseChangedRef.current = () => {};
    peer?.destroy();
  }, []);

  const cleanup = useCallback(() => {
    dcSendJSON(controlRef.current || dcRef.current, { type: 'cancel' });
    stopConnection();
    sessionRef.current.reset();
    pausedRef.current = false;
    setStatus('idle'); setError(''); setMetrics(emptyMetrics());
    setFileList([]); setCurrentFileIndex(0); setCurrentFileName('');
    setTransferStats(null); setPeerDevice(''); setNetworkMode(null); setActiveChunkSize(0);
    setConnectionInfo(null); setRemoteHidden(null); setRemoteWasHidden(false);
    setRemotePaused(false); setPaused(false); setNetworkWarning('');
  }, [stopConnection, setStatus]);
  useEffect(() => cleanup, [cleanup]);

  const togglePause = useCallback(() => {
    pausedRef.current = !pausedRef.current;
    pauseVersionRef.current++;
    setPaused(pausedRef.current);
    dcSendJSON(controlRef.current || dcRef.current, { type: pausedRef.current ? 'pause' : 'resume', pauseVersion: pauseVersionRef.current });
    pauseChangedRef.current();
  }, []);

  const connect = useCallback(code => {
    stopConnection();
    const generation = generationRef.current;
    const active = () => generation === generationRef.current;
    const receiverId = crypto.randomUUID();
    const session = sessionRef.current;
    session.reset();
    pausedRef.current = false;
    pauseVersionRef.current = 0;
    senderPauseRef.current = { paused: false, version: -1 };
    setStatus('connecting'); setError(''); setNetworkMode(null);
    setConnectionInfo(null); setRemoteHidden(null); setRemoteWasHidden(false);
    setPaused(false); setRemotePaused(false); setMetrics(emptyMetrics());
    setTransferStats(null); setFileList([]); setCurrentFileIndex(0); setCurrentFileName('');
    let retryTimer, connectionTimer, disconnectTimer, ackTimer, ackDelayTimer;
    let attempts = 0, reconnectSince = 0, startedAt = 0, chunks = 0, observedChunkSize = 0;
    let samples = [], lastAck = 0, lastUI = 0;
    let lastSpeed = 0, lastEta = '', lastEtc = '';
    let removeMessage = () => {};
    let stopMonitoring = () => {};
    let receiveQueue;
    let relayOnly = false;
    let attemptGeneration = 0;

    const disposeAttempt = () => {
      attemptGeneration++;
      clearTimeout(connectionTimer); clearTimeout(disconnectTimer); clearInterval(ackTimer);
      clearTimeout(ackDelayTimer); ackDelayTimer = null;
      removeMessage(); removeMessage = () => {};
      stopMonitoring(); stopMonitoring = () => {};
      receiveQueue?.clear(); receiveQueue = null;
      pauseChangedRef.current = () => {};
      const peer = peerRef.current;
      peerRef.current = null; connRef.current = null; dcRef.current = null; controlRef.current = null;
      peer?.destroy();
    };
    disposeRef.current = () => { clearTimeout(retryTimer); disposeAttempt(); };

    const fail = message => {
      if (!active()) return;
      dcSendJSON(controlRef.current || dcRef.current, { type: 'cancel' });
      stopConnection();
      session.reset();
      setRemotePaused(false); setPaused(false); pausedRef.current = false;
      setError(message); setStatus('error');
    };

    const sendAck = (force = false, refreshUI = force) => {
      const dc = controlRef.current || dcRef.current;
      if (!dc || dc.readyState !== 'open') return;
      const now = Date.now();
      if (!force && now - lastAck < 20) {
        // A byte threshold alone can leave the final partial window waiting
        // for the 200 ms heartbeat. Schedule its ACK instead of dropping it.
        if (!ackDelayTimer) ackDelayTimer = setTimeout(() => {
          ackDelayTimer = null;
          sendAck(true, false);
        }, 20 - (now - lastAck));
        return;
      }
      clearTimeout(ackDelayTimer); ackDelayTimer = null;
      lastAck = now;
      samples.push({ time: now, bytes: session.received });
      while (samples.length > 2 && now - samples[0].time > 3000) samples.shift();
      const first = samples[0];
      const isPaused = pausedRef.current || senderPauseRef.current.paused;
      // A millisecond-sized first sample exaggerates burst speed. Speed is
      // display telemetry, independent of transport flow control.
      lastSpeed = !isPaused && now - first.time >= 250 ? Math.max(0, (session.received - first.bytes) * 1000 / (now - first.time)) : 0;
      const remaining = lastSpeed > 0 ? (session.total - session.received) / lastSpeed : 0;
      const updateUI = refreshUI || now - lastUI >= 200;
      if (updateUI) {
        lastEta = lastSpeed > 0 ? formatTime(remaining) : '--:--';
        lastEtc = lastSpeed > 0 ? new Date(now + remaining * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '';
      }
      const progress = session.complete ? 100 : session.total ? Math.min(99, Math.round(session.received / session.total * 100)) : 0;
      dcSendJSON(dc, { type: 'ack', received: session.received, progress, speed: lastSpeed, eta: lastEta, etc: lastEtc,
        paused: pausedRef.current, pauseVersion: pauseVersionRef.current,
        hidden: document.visibilityState === 'hidden' });
      if (updateUI) {
        lastUI = now;
        setMetrics({ progress, speed: lastSpeed, eta: lastEta, etc: lastEtc,
          bytesReceived: session.received, bytesTotal: session.total, chunksReceived: chunks,
          speedLabel: getSpeedLabel(lastSpeed) });
      }
    };

    const scheduleReconnect = () => {
      if (!active() || session.complete || retryTimer) return;
      disposeAttempt();
      if (!reconnectSince) reconnectSince = Date.now();
      if (Date.now() - reconnectSince > 5 * 60 * 1000 || attempts >= 8) {
        fail('Unable to connect. Check both devices are online and that a working TURN relay is configured for mobile networks.');
        return;
      }
      setStatus('reconnecting');
      // The first attempt already gathers UDP, TCP and TLS candidates. Retry
      // via relay only when direct negotiation failed; never force successful
      // Wi-Fi/LAN sessions through a slower shared relay.
      relayOnly = attempts % 2 === 1;
      retryTimer = setTimeout(() => { retryTimer = null; void attempt(); }, Math.min(1000 * 2 ** Math.max(0, attempts - 1), 10000));
    };

    const handleControl = message => {
      switch (message.type) {
        case 'file-list': {
          clearTimeout(connectionTimer);
          const continuing = session.begin(message);
          if (!continuing) { startedAt = Date.now(); chunks = 0; }
          samples = [{ time: Date.now(), bytes: session.received }];
          setFileList(session.files); setPeerDevice(message.device || '');
          setActiveChunkSize(message.chunkSize || CHUNK_SIZE);
          setStatus('receiving');
          clearInterval(ackTimer);
          ackTimer = setInterval(() => sendAck(), 200);
          sendAck(true);
          break;
        }
        case 'file-start':
          session.startFile(message);
          setCurrentFileIndex(message.index); setCurrentFileName(message.name);
          break;
        case 'file-end': {
          const { blob, name } = session.finishFile(message.index);
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url; anchor.download = name;
          document.body.appendChild(anchor); anchor.click(); anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          sendAck(true);
          break;
        }
        case 'all-done': {
          session.finish();
          sendAck(true);
          // Completion means every file-end was processed and every byte was
          // verified, not just that the sender's native buffer became empty.
          dcSendJSON(controlRef.current || dcRef.current, { type: 'complete', received: session.received });
          clearInterval(ackTimer); clearTimeout(connectionTimer); clearTimeout(disconnectTimer);
          clearTimeout(ackDelayTimer); ackDelayTimer = null;
          stopMonitoring();
          const totalTime = Math.max(0.001, (Date.now() - startedAt) / 1000);
          const avgSpeed = session.received / totalTime;
          setTransferStats({ totalBytes: session.received, totalTime, avgSpeed,
            fileCount: session.files.length, speedLabel: getSpeedLabel(avgSpeed),
            completionTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) });
          setStatus('done'); setRemotePaused(false); setPaused(false); pausedRef.current = false;
          playDone();
          break;
        }
        case 'tier-update': case 'config-update': case 'chunk-update':
          if (message.chunkSize) setActiveChunkSize(message.chunkSize);
          break;
        case 'pause': case 'resume':
          applyPauseState(senderPauseRef.current, message);
          setRemotePaused(senderPauseRef.current.paused);
          pauseChangedRef.current();
          break;
        case 'page-state':
          if (typeof message.hidden === 'boolean') {
            setRemoteHidden(message.hidden);
            if (message.hidden) setRemoteWasHidden(true);
          }
          break;
        case 'cancel': fail('Transfer cancelled by sender'); break;
        case 'rejected': fail(message.reason || 'Transfer rejected'); break;
        default: break;
      }
    };

    async function attempt() {
      if (!active() || session.complete) return;
      attempts++;
      const attemptId = ++attemptGeneration;
      const isCurrent = () => active() && attemptId === attemptGeneration;
      const config = await getRTCConfig({ relayOnly, onWarning: message => { if (isCurrent()) setNetworkWarning(message); } });
      if (!isCurrent()) return;
      const peer = new Peer({ config, debug: 0 });
      peerRef.current = peer;
      // This covers signalling, ICE and the file handshake, not just open data channels.
      connectionTimer = setTimeout(() => { if (isCurrent()) scheduleReconnect(); }, 25000);
      peer.on('open', () => {
        if (!isCurrent()) return;
        const conn = peer.connect(code.trim().toUpperCase(), { serialization: 'raw', reliable: true });
        connRef.current = conn;
        conn.on('open', () => {
          if (!isCurrent()) return;
          const dc = getDC(conn);
          if (!dc) { scheduleReconnect(); return; }
          dcRef.current = dc; dc.binaryType = 'arraybuffer';
          setStatus('connected');
          const consume = data => {
            if (!isCurrent() || session.complete) return;
            if (typeof data === 'string') handleControl(JSON.parse(data));
            else if (data instanceof ArrayBuffer) {
              session.append(data);
              chunks++;
              attempts = 0; reconnectSince = 0;
              if (data.byteLength !== observedChunkSize && session.offset < session.currentFile.size) {
                observedChunkSize = data.byteLength;
                setActiveChunkSize(observedChunkSize);
              }
              sendAck(chunks === 1);
            }
          };
          receiveQueue = createReceiveQueue({
            isPaused: () => pausedRef.current || senderPauseRef.current.paused,
            consume,
          });
          pauseChangedRef.current = () => {
            samples = [{ time: Date.now(), bytes: session.received }];
            try {
              receiveQueue?.drain();
              sendAck(true);
            } catch (err) { fail(err.message || 'Invalid transfer data'); }
          };
          const control = createControlChannel(conn, dc, dc.id === 2 ? 4 : 2);
          let controlAccepted = false;
          const selectControl = () => {
            if (isCurrent() && controlAccepted && control?.readyState === 'open') controlRef.current = control;
          };
          const onMessage = event => {
            if (!isCurrent() || session.complete) return;
            try {
              if (typeof event.data === 'string') {
                const message = JSON.parse(event.data);
                if (message.type === 'control-ready') {
                  controlAccepted = control?.id === message.id;
                  selectControl();
                  return;
                }
                if (['file-list', 'pause', 'resume', 'cancel', 'rejected', 'page-state'].includes(message.type)) {
                  handleControl(message); return;
                }
              }
              receiveQueue.push(event.data);
            } catch (err) {
              if (err.name === 'QuotaExceededError') scheduleReconnect();
              else fail(err.message || 'Invalid transfer data');
            }
          };
          dc.addEventListener('message', onMessage);
          control?.addEventListener('message', onMessage);
          control?.addEventListener('open', selectControl);
          const controlClosed = () => { if (isCurrent() && controlRef.current === control) scheduleReconnect(); };
          control?.addEventListener('close', controlClosed);
          control?.addEventListener('error', controlClosed);
          removeMessage = () => {
            dc.removeEventListener('message', onMessage);
            control?.removeEventListener('message', onMessage);
            control?.removeEventListener('open', selectControl);
            control?.removeEventListener('close', controlClosed);
            control?.removeEventListener('error', controlClosed);
            control?.close();
          };
          // Install the receive listener before the sender may respond.
          dcSendJSON(dc, { type: 'device-info', protocol: 2, receiverId, device: getDeviceName(),
            transferId: session.transferId, resumeIndex: session.index, resumeOffset: session.offset,
            paused: pausedRef.current, pauseVersion: pauseVersionRef.current,
            hidden: document.visibilityState === 'hidden',
            controlChannelId: control?.id });
          stopMonitoring = watchConnection(conn, info => {
            if (isCurrent()) { setNetworkMode(info.mode); setConnectionInfo(info); }
          }, {
            onVisibility: hidden => dcSendJSON(controlRef.current || dc, { type: 'page-state', hidden }),
          });
        });
        conn.on('iceStateChanged', state => {
          if (!isCurrent() || session.complete) return;
          clearTimeout(disconnectTimer);
          if (state === 'failed' || state === 'closed') scheduleReconnect();
          else if (state === 'disconnected') {
            disconnectTimer = setTimeout(() => { if (isCurrent()) scheduleReconnect(); }, 10000);
          }
        });
        conn.on('close', () => { if (isCurrent()) scheduleReconnect(); });
        conn.on('error', () => { if (isCurrent()) scheduleReconnect(); });
      });
      peer.on('error', err => {
        if (!isCurrent()) return;
        if (err.type === 'peer-unavailable' && !session.transferId) fail('Invalid code or sender offline');
        else if (['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable'].includes(err.type)) fail(err.message);
        else scheduleReconnect();
      });
      peer.on('disconnected', () => {
        // An established WebRTC transfer does not need the signalling socket.
        if (isCurrent() && dcRef.current?.readyState !== 'open') scheduleReconnect();
      });
    }
    void attempt();
  }, [stopConnection, setStatus]);

  return { status, ...metrics, speed: formatBytes(metrics.speed) + '/s', speedRaw: metrics.speed,
    error, networkWarning, fileList, currentFileIndex, currentFileName, transferStats, peerDevice,
    networkMode, connectionInfo, remoteHidden, remoteWasHidden,
    activeChunkSize, remotePaused, paused, togglePause, connect, cleanup, formatBytes };
}

export { formatBytes, formatTime, getDeviceName, NETWORK_MODES, CHUNK_TIERS, getSpeedLabel, CHUNK_SIZE };
