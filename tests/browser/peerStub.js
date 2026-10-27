// Test-only PeerJS substitute using ordered BroadcastChannel messages.
class Events {
  events = new Map();
  on(name, fn) {
    this.events.set(name, [...(this.events.get(name) || []), fn]);
    return this;
  }
  emit(name, ...args) {
    for (const fn of this.events.get(name) || []) fn(...args);
  }
}
class DataChannel extends EventTarget {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  constructor(conn) {
    super();
    this.conn = conn;
  }
  send(data) {
    if (this.readyState !== "open")
      throw new DOMException("Closed", "InvalidStateError");
    if (typeof data !== "string") {
      if (window.__chunkLimit && data.byteLength > window.__chunkLimit)
        throw new TypeError("Limited message");
      if (window.__failBinaryOnce) {
        window.__failBinaryOnce = false;
        throw new DOMException("Full", "OperationError");
      }
      if (window.__slow && Date.now() < (window.__nextSend || 0))
        throw new DOMException("Paced send buffer", "OperationError");
      window.__nextSend = Date.now() + 5;
    }
    const copy =
      typeof data === "string"
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const size = typeof copy === "string" ? copy.length : copy.byteLength;
    this.bufferedAmount += size;
    if (typeof copy === "string") {
      try {
        window.__controls.push(JSON.parse(copy));
      } catch {
        /* Non-JSON controls are irrelevant to test instrumentation. */
      }
    } else window.__sentBytes += size;
    this.conn.send({ kind: "data", data: copy, size });
  }
  delivered(size) {
    const before = this.bufferedAmount;
    this.bufferedAmount -= size;
    if (
      before > this.bufferedAmountLowThreshold &&
      this.bufferedAmount <= this.bufferedAmountLowThreshold
    )
      this.dispatchEvent(new Event("bufferedamountlow"));
  }
}
class Conn extends Events {
  constructor(peer, other, id) {
    super();
    this.provider = peer;
    this.peer = other;
    this.id = id;
    this.dataChannel = new DataChannel(this);
    this.peerConnection = {
      sctp: { maxMessageSize: 262144 },
      close: () => this.close(),
      getStats: async () => new Map(),
    };
    window.__pcs.push(this.peerConnection);
  }
  send(message) {
    if (this.provider.destroyed) return;
    this.provider.bus.postMessage({
      ...message,
      src: this.provider.id,
      dst: this.peer,
      id: this.id,
    });
  }
  open() {
    this.dataChannel.readyState = "open";
    this.emit("open");
  }
  close(notify = true) {
    if (this.dataChannel.readyState === "closed") return;
    if (notify) this.send({ kind: "close" });
    this.dataChannel.readyState = "closed";
    this.dataChannel.dispatchEvent(new Event("close"));
    this.emit("close");
  }
}
export default class Peer extends Events {
  constructor(id, options) {
    super();
    if (typeof id === "object") {
      options = id;
      id = null;
    }
    this.id = id || crypto.randomUUID();
    this.options = options;
    this.connections = new Map();
    this.bus = new BroadcastChannel("dropbeam-hook-test");
    this.bus.onmessage = (event) => {
      const m = event.data;
      if (m.dst !== this.id) return;
      let c = this.connections.get(m.id);
      if (m.kind === "connect") {
        c = new Conn(this, m.src, m.id);
        this.connections.set(m.id, c);
        this.emit("connection", c);
        c.open();
        c.send({ kind: "accept" });
      } else if (m.kind === "accept") c?.open();
      else if (m.kind === "data" && c?.dataChannel.readyState === "open") {
        if (m.data instanceof ArrayBuffer)
          window.__rxBytes += m.data.byteLength;
        c.dataChannel.dispatchEvent(
          new MessageEvent("message", { data: m.data }),
        );
        c.send({ kind: "delivery", size: m.size });
      } else if (m.kind === "delivery") c?.dataChannel.delivered(m.size);
      else if (m.kind === "close") c?.close(false);
    };
    queueMicrotask(() => this.emit("open", this.id));
  }
  connect(id) {
    const c = new Conn(this, id, crypto.randomUUID());
    this.connections.set(c.id, c);
    c.send({ kind: "connect" });
    return c;
  }
  destroy() {
    this.destroyed = true;
    for (const c of this.connections.values()) c.close();
    this.bus.close();
  }
  reconnect() {
    this.disconnected = false;
    this.emit("open", this.id);
  }
}
