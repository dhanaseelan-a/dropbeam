import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { connectionSnapshot, connectionRates, diagnosticReport, watchConnection } from '../src/lib/connectionDiagnostics.js';
import { detectNetwork } from '../src/lib/rtcConfig.js';

const relayStats = () => new Map([
  ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
  ['selected', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.125, timestamp: 2000, bytesSent: 1000000, bytesReceived: 300000 }],
  ['local', { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls', address: '192.0.2.1', username: 'secret-user', credential: 'secret-pass' }],
  ['remote', { candidateType: 'host', protocol: 'udp', address: '192.168.1.2' }],
  ['unused', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'remote', remoteCandidateId: 'remote' }],
]);

test('missing or failed route stats stay unknown instead of claiming Internet', async () => {
  assert.equal(connectionSnapshot(new Map()).mode, 'unknown');
  assert.deepEqual(await detectNetwork({ peerConnection: { getStats: async () => { throw new Error('not ready'); } } }), { mode: 'unknown' });
  assert.equal(connectionSnapshot(new Map([['transport', { type: 'transport', selectedCandidatePairId: 'missing' }]])).mode, 'unknown');
});

test('selected route distinguishes TURN transport from relayed UDP and preserves RTT', () => {
  const snapshot = connectionSnapshot(relayStats(), { bufferedAmount: 12345 });
  assert.equal(snapshot.mode, 'relay');
  assert.equal(snapshot.protocol, 'udp');
  assert.equal(snapshot.relayProtocol, 'tls');
  assert.equal(snapshot.roundTripMs, 125);
  assert.equal(snapshot.sendBufferBytes, 12345);
  assert.ok(!JSON.stringify(snapshot).includes('192.168'));
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
});

test('network rate uses actual sample time and never spans a route or counter reset', () => {
  const prev = { id: 'one', time: 1000, sent: 100, received: 100 };
  assert.deepEqual(connectionRates({ id: 'one', time: 3000, sent: 400100, received: 1000100 }, prev), {
    networkSendSpeed: 200000, networkReceiveSpeed: 500000,
  });
  for (const current of [
    { id: 'two', time: 3000, sent: 400100, received: 1000100 },
    { id: 'one', time: 1000, sent: 400100, received: 1000100 },
    { id: 'one', time: 3000, sent: 0, received: 0 },
  ]) assert.deepEqual(connectionRates(current, prev), { networkSendSpeed: null, networkReceiveSpeed: null });
});

test('copyable diagnostics include rates and background state but exclude sensitive inputs', () => {
  const info = { ...connectionSnapshot(relayStats()), hidden: false, wasHidden: true, address: '192.168.1.2', apiKey: 'secret', filename: 'private-file' };
  const text = diagnosticReport({ info, speed: 200000, side: 'sender', remoteHidden: true, flow: { outstandingBytes: 8000, waitingFor: 'acknowledgement', filename: 'private-file' } });
  const report = JSON.parse(text);
  assert.equal(report.fileMbps, 1.6);
  assert.equal(report.remotePageHidden, true);
  assert.equal(report.localPageWasHidden, true);
  assert.equal(report.outstandingFileBytes, 8000);
  assert.ok(!/192\.|secret|private-file|selected/.test(text));
});

test('route monitor retries an initially missing pair, reports visibility changes and stops cleanly', { timeout: 2000 }, async t => {
  const page = new EventTarget(); page.visibilityState = 'visible';
  const channel = new EventTarget(); channel.bufferedAmount = 0;
  let calls = 0;
  const updates = [], visibility = [];
  const conn = { dataChannel: channel, peerConnection: { getStats: async () => ++calls === 1 ? new Map() : relayStats() } };
  const stop = watchConnection(conn, info => updates.push(info), { page, interval: 10, onVisibility: hidden => visibility.push(hidden) });
  t.after(stop);
  await delay(60);
  assert.equal(updates[0].mode, 'unknown');
  assert.equal(updates.at(-1).mode, 'relay');
  page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'));
  await delay(20);
  assert.equal(updates.at(-1).hidden, true);
  page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'));
  await delay(20);
  assert.equal(updates.at(-1).wasHidden, true);
  assert.deepEqual(visibility, [false, true, false]);
  channel.dispatchEvent(new Event('close'));
  const count = updates.length;
  await delay(30);
  assert.equal(updates.length, count);
});
