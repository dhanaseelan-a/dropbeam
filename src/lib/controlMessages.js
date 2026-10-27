// Control messages use an ordered, reliable RTCDataChannel (a separate stream
// from file bytes when both peers support it).
// A native send-buffer error means the message was NOT accepted: keep it until
// send succeeds. In particular, dropping Resume leaves the other peer paused.
const queues = new WeakMap();

function queueFor(channel) {
  let queue = queues.get(channel);
  if (queue) return queue;
  const pending = [];
  let timer;
  const dispose = () => {
    clearTimeout(timer);
    pending.length = 0;
    channel.removeEventListener('bufferedamountlow', flush);
    channel.removeEventListener('close', dispose);
    channel.removeEventListener('error', dispose);
    queues.delete(channel);
  };
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (channel.readyState !== 'open') { dispose(); return false; }
    while (pending.length) {
      try { channel.send(pending[0].data); pending.shift(); }
      catch (error) {
        if (error.name === 'OperationError') {
          timer = setTimeout(flush, 10);
          return false;
        }
        // A failed control channel must recover, not leave a peer paused forever.
        dispose();
        channel.close();
        return false;
      }
    }
    return true;
  }
  queue = { flush, send(message) {
    const key = ['pause', 'resume'].includes(message.type) ? 'pause-state' : message.type;
    const coalesce = key === 'pause-state' || key === 'ack';
    const existing = coalesce ? pending.findIndex(item => item.key === key) : -1;
    const item = { key, data: JSON.stringify(message) };
    if (existing >= 0) pending[existing] = item;
    else pending.push(item);
    return flush();
  } };
  queues.set(channel, queue);
  channel.addEventListener('bufferedamountlow', flush);
  channel.addEventListener('close', dispose);
  channel.addEventListener('error', dispose);
  return queue;
}

export function sendControlMessage(channel, message) {
  if (channel?.readyState !== 'open') return false;
  return queueFor(channel).send(message);
}

// Do not add more file bytes ahead of a control message waiting for capacity.
export function flushControlMessages(channel) {
  return queues.get(channel)?.flush() ?? true;
}

// Negotiate a separate SCTP stream explicitly. An in-band datachannel event
// would make PeerJS replace its file channel. Both peers create this stream
// before acknowledging it over the existing, ordered file channel.
export function createControlChannel(connection, fileChannel, id = 2) {
  const pc = connection?.peerConnection || connection?._pc;
  if (!pc?.createDataChannel || !Number.isInteger(id) || id < 0 || id > 65534 || id === fileChannel?.id) return null;
  try {
    return pc.createDataChannel('dropbeam-controls', { negotiated: true, id, ordered: true });
  } catch { return null; }
}

export function waitForControlChannel(channel, timeout = 2000) {
  if (channel.readyState === 'open') return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      channel.removeEventListener('open', finish);
      channel.removeEventListener('close', finish);
      channel.removeEventListener('error', finish);
      resolve(channel.readyState === 'open');
    };
    channel.addEventListener('open', finish);
    channel.addEventListener('close', finish);
    channel.addEventListener('error', finish);
    timer = setTimeout(finish, timeout);
  });
}

// Controls can cross the file stream. A late initial state/ACK must not undo a
// newer Pause or Resume. Legacy peers without versions remain compatible.
export function applyPauseState(state, message) {
  const paused = message.type === 'ack' ? message.paused : message.type === 'pause';
  if (typeof paused !== 'boolean') return;
  const version = message.pauseVersion;
  if (Number.isSafeInteger(version) && version >= 0) {
    if (version < state.version) return;
    state.version = version;
  } else if (state.version >= 0) return;
  state.paused = paused;
}
