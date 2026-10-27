// File bytes and control messages share an ordered, reliable RTCDataChannel.
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
