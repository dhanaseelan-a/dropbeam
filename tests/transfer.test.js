import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createFilePump, ReceiveSession, resumePosition, negotiatedChunkSize } from '../src/lib/transferProtocol.js';
import { getRTCConfig, detectNetwork } from '../src/lib/rtcConfig.js';

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  maxSize = Infinity;
  failures = 0;
  messages = [];
  onSend = () => {};
  send(data) {
    if (this.readyState !== 'open') throw new DOMException('Closed', 'InvalidStateError');
    if (typeof data !== 'string' && data.byteLength > this.maxSize) throw new TypeError('Message too large');
    if (this.failures-- > 0) throw new DOMException('Buffer full', 'OperationError');
    const copy = typeof data === 'string' ? data : data.slice().buffer;
    const length = typeof copy === 'string' ? copy.length : copy.byteLength;
    this.messages.push(copy);
    this.bufferedAmount += length;
    setTimeout(() => {
      if (this.readyState !== 'open') return;
      const before = this.bufferedAmount;
      this.bufferedAmount -= length;
      this.onSend(copy);
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.dispatchEvent(new Event('bufferedamountlow'));
      }
    }, 0);
  }
  reply(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}

const makeFile = (name, size) => new File([Uint8Array.from({ length: size }, (_, i) => i % 251)], name);

async function transfer(files, options = {}) {
  const channel = options.channel || new Channel();
  const session = options.session || new ReceiveSession();
  const saved = [];
  let completed = false;
  const done = new Promise((resolve, reject) => {
    channel.onSend = data => {
      try {
        if (typeof data === 'string') {
          const message = JSON.parse(data);
          if (message.type === 'file-list') session.begin(message);
          if (message.type === 'file-start') session.startFile(message);
          if (message.type === 'file-end') saved.push(session.finishFile(message.index));
          if (message.type === 'all-done') {
            session.finish();
            channel.reply({ type: 'complete', received: session.received });
          }
        } else session.append(data);
        channel.reply({ type: 'ack', received: session.received, speed: 20 * 1024 * 1024 });
      } catch (error) { reject(error); }
    };
    const pump = createFilePump({ channel, files, transferId: 'transfer-1',
      maxMessageSize: 256 * 1024, ...options,
      onDone: () => { completed = true; resolve(); }, onError: reject,
      onDisconnect: reason => reject(new Error(reason)),
    });
    options.onPump?.(pump);
  });
  await done;
  assert.equal(completed, true);
  assert.equal(session.received, files.reduce((n, f) => n + f.size, 0));
  return { saved, channel, session };
}

test('multi-file transfer preserves bytes and empty files', { timeout: 5000 }, async () => {
  const files = [makeFile('one.bin', 5 * 1024 * 1024 + 13), makeFile('empty.txt', 0), makeFile('two.bin', 200003)];
  const { saved } = await transfer(files);
  assert.deepEqual(saved.map(f => f.name), files.map(f => f.name));
  for (let i = 0; i < files.length; i++) assert.deepEqual(await saved[i].blob.arrayBuffer(), await files[i].arrayBuffer());
});

test('oversized message retries at the same offset without waiting for a drain event', { timeout: 5000 }, async () => {
  const channel = new Channel(); channel.maxSize = 16384;
  const file = makeFile('limited.bin', 150001);
  const { saved } = await transfer([file], { channel });
  assert.deepEqual(await saved[0].blob.arrayBuffer(), await file.arrayBuffer());
  assert.ok(channel.messages.filter(m => typeof m !== 'string').every(m => m.byteLength <= 16384));
});

test('a full send queue retries both metadata and data instead of stalling', { timeout: 5000 }, async () => {
  const channel = new Channel(); channel.failures = 2;
  const original = channel.send.bind(channel);
  let rejectedBinary = false, rejectedEnd = false;
  channel.send = data => {
    if (!rejectedBinary && typeof data !== 'string') { rejectedBinary = true; throw new DOMException('Full', 'OperationError'); }
    if (!rejectedEnd && typeof data === 'string' && JSON.parse(data).type === 'file-end') { rejectedEnd = true; throw new DOMException('Full', 'OperationError'); }
    original(data);
  };
  const file = makeFile('retry.bin', 150001);
  const { saved } = await transfer([file], { channel });
  assert.deepEqual(await saved[0].blob.arrayBuffer(), await file.arrayBuffer());
});

test('resume uses a file-relative offset and preserves accumulated blob parts', { timeout: 5000 }, async () => {
  const files = [makeFile('finished.bin', 100), makeFile('partial.bin', 6 * 1024 * 1024 + 3)];
  const session = new ReceiveSession();
  session.begin({ transferId: 'transfer-1', files });
  session.startFile({ index: 0, name: files[0].name, size: files[0].size });
  session.append(await files[0].arrayBuffer()); session.finishFile(0);
  session.startFile({ index: 1, name: files[1].name, size: files[1].size });
  const offset = 5 * 1024 * 1024 + 7;
  session.append(await files[1].slice(0, offset).arrayBuffer());
  assert.ok(session.parts.length > 0);
  const resume = resumePosition(files, { transferId: 'transfer-1', resumeIndex: 1, resumeOffset: offset }, 'transfer-1');
  assert.equal(resume.received, 100 + offset);
  const { saved } = await transfer(files, { session, resume });
  assert.equal(saved.length, 1);
  assert.deepEqual(await saved[0].blob.arrayBuffer(), await files[1].arrayBuffer());
});

test('completed files are not downloaded again after reconnecting at a file boundary', { timeout: 5000 }, async () => {
  const file = makeFile('finished.bin', 45);
  const session = new ReceiveSession();
  session.begin({ transferId: 'transfer-1', files: [file] });
  session.startFile({ index: 0, name: file.name, size: file.size });
  session.append(await file.arrayBuffer()); session.finishFile(0);
  const { saved } = await transfer([file], { session, resume: { index: 1, offset: 0, received: 45 } });
  assert.equal(saved.length, 0);
});

test('invalid or foreign resume checkpoints safely restart at zero', () => {
  const files = [makeFile('a', 20)];
  for (const message of [
    { transferId: 'old', resumeIndex: 0, resumeOffset: 10 },
    { transferId: 'new', resumeIndex: 0, resumeOffset: 21 },
    { transferId: 'new', resumeIndex: -1, resumeOffset: 0 },
    { transferId: 'new', resumeIndex: 0, resumeOffset: NaN },
  ]) assert.deepEqual(resumePosition(files, message, 'new'), { index: 0, offset: 0, received: 0 });
});

test('truncated or overlong data is never treated as a complete file', () => {
  const session = new ReceiveSession();
  session.begin({ files: [{ name: 'a', size: 10 }] });
  session.startFile({ index: 0, name: 'a', size: 10 });
  session.append(new Uint8Array(5));
  assert.throws(() => session.finishFile(0), /incomplete/);
  assert.throws(() => session.append(new Uint8Array(6)), /Unexpected/);
  assert.throws(() => session.finish(), /incomplete/);
});

test('local and remote pause resume the same transfer', { timeout: 5000 }, async () => {
  const channel = new Channel();
  let paused = true;
  const result = transfer([makeFile('paused', 1000)], {
    channel, isPaused: () => paused,
    onPump: pump => {
      setTimeout(() => { assert.equal(channel.messages.filter(m => typeof m !== 'string').length, 0); channel.reply({ type: 'pause' }); paused = false; pump.wake(); }, 20);
      setTimeout(() => { assert.equal(channel.messages.filter(m => typeof m !== 'string').length, 0); channel.reply({ type: 'resume' }); }, 40);
    },
  });
  await result;
});

test('cancellation during an asynchronous file read sends no file bytes', async () => {
  const channel = new Channel();
  let releaseRead;
  const read = new Promise(resolve => { releaseRead = resolve; });
  const file = { name: 'slow-disk', size: 10, slice: () => ({ arrayBuffer: () => read }) };
  const pump = createFilePump({ channel, files: [file], transferId: 'x' });
  await delay(10);
  pump.cancel(); releaseRead(new ArrayBuffer(10));
  await delay(10);
  assert.equal(channel.messages.filter(m => typeof m !== 'string').length, 0);
});

test('an interrupted completion wait cannot report success', async () => {
  const channel = new Channel();
  let done = false, disconnected = false;
  createFilePump({ channel, files: [], transferId: 'x',
    onDone: () => { done = true; }, onDisconnect: () => { disconnected = true; } });
  await delay(10); channel.close(); await delay(10);
  assert.equal(done, false); assert.equal(disconnected, true);
});

test('ACK of all bytes alone does not bypass receiver completion', async () => {
  const channel = new Channel();
  let done = false;
  const pump = createFilePump({ channel, files: [], transferId: 'x', onDone: () => { done = true; } });
  await delay(10); channel.reply({ type: 'ack', received: 0 });
  assert.equal(done, false); pump.cancel();
});

test('negotiated limits include absent and unlimited SCTP sizes', () => {
  assert.equal(negotiatedChunkSize(undefined), 65536);
  assert.equal(negotiatedChunkSize(0), 262144);
  assert.equal(negotiatedChunkSize(16384), 16384);
});

test('static deployment retains UDP, TCP and TLS relay candidates', async () => {
  const config = await getRTCConfig({ fetcher: async () => ({ ok: false }) });
  const urls = config.iceServers.flatMap(s => s.urls);
  assert.ok(urls.includes('turn:openrelay.metered.ca:80'));
  assert.ok(urls.includes('turn:openrelay.metered.ca:443?transport=tcp'));
  assert.ok(urls.includes('turns:openrelay.metered.ca:443?transport=tcp'));
  assert.equal(config.iceTransportPolicy, 'all');
});

test('both peers can use configured credentials and relay-only recovery', async () => {
  const iceServers = [{ urls: 'turns:example.org:443?transport=tcp', username: 'u', credential: 'p' }];
  const config = await getRTCConfig({ relayOnly: true, fetcher: async () => ({ ok: true, json: async () => ({ iceServers }) }) });
  assert.deepEqual(config.iceServers, iceServers); assert.equal(config.iceTransportPolicy, 'relay');
});

test('network label uses the selected pair, not an unused successful candidate', async () => {
  const stats = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'relay', remoteCandidateId: 'host' }],
    ['relay', { candidateType: 'relay' }], ['host', { candidateType: 'host' }],
    ['unused', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'host', remoteCandidateId: 'host' }],
  ]);
  assert.deepEqual(await detectNetwork({ peerConnection: { getStats: async () => stats } }), { mode: 'relay' });
});
