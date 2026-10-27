// Transport code is independent of React so byte ordering, retries and resume
// can be tested without a signalling service or a particular mobile carrier.
import { applyPauseState, flushControlMessages } from './controlMessages.js';

// Start with small SCTP messages to avoid monopolising slower associations
// (RFC 8831, section 6.6); retain bounded adaptation for fast paths.
export const CHUNK_SIZE = 16 * 1024;
export const MAX_CHUNK = 64 * 1024;
const SEND_BUFFER = 256 * 1024;
const READ_SIZE = 4 * 1024 * 1024;
export const MAX_IN_FLIGHT = 8 * 1024 * 1024;

// A pause cannot recall bytes already accepted by SCTP. Hold those frames,
// including file-end/all-done, until Resume so neither progress nor downloads
// complete behind the pause banner. Allow the previous client's 16 MB window.
export function createReceiveQueue({ isPaused, consume, maxBytes = 17 * 1024 * 1024 }) {
  let pending = [], bytes = 0;
  return {
    push(data) {
      if (!isPaused() && !pending.length) { consume(data); return; }
      const size = typeof data === 'string' ? data.length * 2 : data.byteLength;
      if (bytes + size > maxBytes) throw new DOMException('Paused receive queue is full', 'QuotaExceededError');
      pending.push(data);
      bytes += size;
    },
    drain() {
      while (pending.length && !isPaused()) {
        const batch = pending;
        pending = []; bytes = 0;
        for (const data of batch) this.push(data);
      }
    },
    clear() { pending = []; bytes = 0; },
  };
}

export function negotiatedChunkSize(maxMessageSize) {
  // Zero means unlimited; an absent SCTP limit requires a conservative default.
  if (maxMessageSize === 0) return MAX_CHUNK;
  if (!Number.isFinite(maxMessageSize) || maxMessageSize < 1) return CHUNK_SIZE;
  return Math.min(MAX_CHUNK, Math.floor(maxMessageSize));
}

export function resumePosition(files, message, transferId) {
  const index = message.resumeIndex;
  const offset = message.resumeOffset;
  if (message.transferId !== transferId || !Number.isInteger(index) ||
      !Number.isInteger(offset) || index < 0 || index > files.length ||
      offset < 0 || offset > (files[index]?.size ?? 0)) {
    return { index: 0, offset: 0, received: 0 };
  }
  return { index, offset, received: files.slice(0, index).reduce((n, f) => n + f.size, 0) + offset };
}

export class ReceiveSession {
  constructor() { this.reset(); }

  reset() {
    this.transferId = null;
    this.files = [];
    this.index = 0;
    this.offset = 0;
    this.received = 0;
    this.total = 0;
    this.currentFile = null;
    this.parts = [];
    this.chunks = [];
    this.chunkBytes = 0;
    this.complete = false;
  }

  begin(message) {
    const continuing = message.transferId && message.transferId === this.transferId &&
      message.resumeIndex === this.index && message.resumeOffset === this.offset;
    if (!continuing) this.reset();
    this.transferId = message.transferId;
    this.files = message.files || [];
    this.total = this.files.reduce((n, file) => n + file.size, 0);
    return continuing;
  }

  startFile(message) {
    const offset = message.offset || 0;
    if (message.index !== this.index || offset !== this.offset) {
      throw new Error('File resume position does not match the received data');
    }
    const file = this.files[this.index];
    if (!file || file.name !== message.name || file.size !== message.size) {
      throw new Error('File metadata does not match the transfer');
    }
    this.currentFile = file;
  }

  append(data) {
    if (!this.currentFile || this.offset + data.byteLength > this.currentFile.size) {
      throw new Error('Unexpected file data');
    }
    if (!data.byteLength) return;
    this.chunks.push(data);
    this.chunkBytes += data.byteLength;
    this.offset += data.byteLength;
    this.received += data.byteLength;
    // Avoid a 512 MB allocation/copy on memory-constrained phones. Blob parts
    // also preserve partially received files across connection replacements.
    if (this.chunkBytes >= READ_SIZE) this.flush();
  }

  flush() {
    if (this.chunks.length) this.parts.push(new Blob(this.chunks));
    this.chunks = [];
    this.chunkBytes = 0;
  }

  finishFile(index) {
    if (!this.currentFile || index !== this.index || this.offset !== this.currentFile.size) {
      throw new Error('File is incomplete; reconnect to resume the transfer');
    }
    this.flush();
    const file = this.currentFile;
    const blob = new Blob(this.parts, { type: file.fileType || 'application/octet-stream' });
    this.index++;
    this.offset = 0;
    this.currentFile = null;
    this.parts = [];
    return { blob, name: file.name };
  }

  finish() {
    if (this.index !== this.files.length || this.received !== this.total) {
      throw new Error('Transfer is incomplete');
    }
    this.complete = true;
  }
}

export function createFilePump({
  channel, controlChannel = channel, files, transferId, device, resume = { index: 0, offset: 0, received: 0 },
  initialPaused = false, initialPauseVersion = -1,
  maxMessageSize, isPaused = () => false, onProgress = () => {},
  onControl = () => {}, onDone = () => {}, onError = () => {},
  onDisconnect = () => {}, stallTimeout = 60000,
}) {
  const total = files.reduce((n, file) => n + file.size, 0);
  let index = resume.index, offset = resume.offset;
  let sent = resume.received, received = resume.received;
  let chunkLimit = negotiatedChunkSize(maxMessageSize);
  let chunkSize = Math.min(CHUNK_SIZE, chunkLimit);
  let chunksSent = 0, speed = 0, eta = '', etc = '';
  const remotePause = { paused: initialPaused, version: initialPauseVersion };
  let batch = null, batchPosition = 0, fileStarted = false, manifestSent = false;
  let pumping = false, stopped = false, finishing = false, queued = false;
  let retryTimer = null, lastProgress = Date.now(), lastUI = 0;
  const startedAt = Date.now();
  channel.bufferedAmountLowThreshold = SEND_BUFFER / 4;

  function dispose() {
    stopped = true;
    clearTimeout(retryTimer);
    clearInterval(watchdog);
    channel.removeEventListener('bufferedamountlow', wake);
    channel.removeEventListener('message', handleMessage);
    channel.removeEventListener('close', handleClose);
    channel.removeEventListener('error', handleClose);
    if (controlChannel !== channel) {
      controlChannel.removeEventListener('message', handleMessage);
      controlChannel.removeEventListener('close', handleClose);
      controlChannel.removeEventListener('error', handleClose);
    }
    batch = null;
  }

  function disconnect(reason) {
    if (stopped) return;
    dispose();
    onDisconnect(reason);
  }

  function handleClose() { disconnect('Connection interrupted'); }

  function fail(error) {
    if (stopped) return;
    dispose();
    onError(error);
  }

  function report(force = false) {
    if (!force && Date.now() - lastUI < 200) return;
    lastUI = Date.now();
    onProgress({ received, total, chunkSize, chunksSent, index, speed, eta, etc,
      progress: total ? Math.min(99, Math.round(received / total * 100)) : 0 });
  }

  function retry() {
    if (!retryTimer && !stopped) retryTimer = setTimeout(() => {
      retryTimer = null;
      wake();
    }, 25);
  }

  // File metadata and boundaries use the same ordered channel as file bytes.
  // A full native send queue must retry the frame, not drop file-end/all-done.
  function send(data) {
    try { channel.send(data); return true; }
    catch (error) {
      if (error.name === 'OperationError') { retry(); return false; }
      throw error;
    }
  }

  function handleMessage(event) {
    if (stopped || typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ack') {
      if (Number.isFinite(message.received) && message.received >= received && message.received <= sent) {
        if (message.received > received) {
          lastProgress = Date.now();
        }
        received = message.received;
      }
      speed = Number.isFinite(message.speed) ? Math.max(0, message.speed) : speed;
      eta = message.eta || '';
      etc = message.etc || '';
      // SCTP handles congestion. UI speed (including zero after a pause) must
      // not cap the transport's delivery window or create an ACK round-trip
      // bottleneck. Keep the native queue small and total unacknowledged bytes
      // bounded independently; controls use their own stream.
      chunkSize = Math.min(chunkLimit, speed > 10 * 1024 * 1024 ? MAX_CHUNK : CHUNK_SIZE);
      applyPauseState(remotePause, message);
      report();
      // Resume immediately on acknowledgements, including in background tabs.
      wake();
    } else if (message.type === 'complete' && finishing && message.received === total) {
      report(true);
      dispose();
      onDone({ totalBytes: total, totalTime: Math.max(0.001, (Date.now() - startedAt) / 1000),
        transferredBytes: total - resume.received });
    } else if (message.type === 'pause') {
      applyPauseState(remotePause, message);
    } else if (message.type === 'resume') {
      applyPauseState(remotePause, message);
      lastProgress = Date.now();
      wake();
    } else if (message.type === 'cancel') {
      dispose();
    }
    onControl({ ...message, paused: remotePause.paused });
  }

  async function pump() {
    if (pumping || stopped || finishing) return;
    pumping = true;
    try {
      while (!stopped && channel.readyState === 'open') {
        if (!flushControlMessages(channel)) { retry(); return; }
        if (channel.bufferedAmount >= SEND_BUFFER || sent - received >= MAX_IN_FLIGHT) return;
        if (!manifestSent) {
          if (!send(JSON.stringify({ type: 'file-list', protocol: 2, transferId,
            files: files.map(f => ({ name: f.name, size: f.size, fileType: f.type })),
            device, chunkSize, resumeIndex: resume.index, resumeOffset: resume.offset }))) return;
          manifestSent = true;
        }
        if (isPaused() || remotePause.paused) return;
        if (index >= files.length) {
          if (!send(JSON.stringify({ type: 'all-done' }))) return;
          finishing = true;
          report(true);
          return;
        }
        const file = files[index];
        if (!fileStarted) {
          if (!send(JSON.stringify({ type: 'file-start', index, name: file.name,
            size: file.size, fileType: file.type, offset }))) return;
          fileStarted = true;
          report(true);
        }
        if (offset === file.size) {
          if (!send(JSON.stringify({ type: 'file-end', index }))) return;
          index++;
          offset = 0;
          batch = null;
          fileStarted = false;
          continue;
        }
        if (!batch) {
          batch = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + READ_SIZE)).arrayBuffer());
          batchPosition = 0;
          // Reading from disk is asynchronous: cancellation or pause may have
          // happened meanwhile, so re-check before sending any bytes.
          if (stopped) return;
          continue;
        }
        const length = Math.min(chunkSize, batch.byteLength - batchPosition, MAX_IN_FLIGHT - (sent - received));
        const data = batch.subarray(batchPosition, batchPosition + length);
        try {
          if (!send(data)) return;
        } catch (error) {
          if (error.name !== 'TypeError' || length <= 1) throw error;
          chunkLimit = Math.max(1, Math.floor(length / 2));
          chunkSize = chunkLimit;
          // Retry this exact offset immediately. Waiting for a low-buffer event
          // here deadlocks when the rejected message never entered the buffer.
          continue;
        }
        batchPosition += length;
        offset += length;
        sent += length;
        chunksSent++;
        if (batchPosition === batch.byteLength) batch = null;
      }
    } catch (error) { fail(error); }
    finally { pumping = false; }
  }

  function wake() {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => { queued = false; void pump(); });
  }

  const watchdog = setInterval(() => {
    if (channel.readyState !== 'open') { handleClose(); return; }
    if (isPaused() || remotePause.paused) lastProgress = Date.now();
    else if (Date.now() - lastProgress > stallTimeout) {
      disconnect('Transfer stalled; reconnecting');
      return;
    }
    report();
    // Safety net for a missed low-buffer event; it is not the throughput clock.
    wake();
  }, 1000);
  channel.addEventListener('bufferedamountlow', wake);
  channel.addEventListener('message', handleMessage);
  channel.addEventListener('close', handleClose);
  channel.addEventListener('error', handleClose);
  if (controlChannel !== channel) {
    controlChannel.addEventListener('message', handleMessage);
    controlChannel.addEventListener('close', handleClose);
    controlChannel.addEventListener('error', handleClose);
  }
  wake();
  return { wake, cancel: dispose, diagnostics: () => ({
    outstandingBytes: sent - received,
    waitingFor: stopped ? 'stopped' : isPaused() || remotePause.paused ? 'paused' :
      finishing ? 'completion' : channel.bufferedAmount >= SEND_BUFFER ? 'send-buffer' :
      sent - received >= MAX_IN_FLIGHT ? 'acknowledgement' : pumping ? 'file-read-or-send' : 'ready',
  }) };
}
