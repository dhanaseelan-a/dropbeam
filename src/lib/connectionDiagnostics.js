// Only retain route types, timing and counters. Candidate addresses, TURN
// credentials, peer IDs and filenames never enter a diagnostic report.
export function connectionSnapshot(stats, channel) {
  let pair, pairId;
  stats.forEach(stat => {
    if (stat.type === 'transport' && stats.has(stat.selectedCandidatePairId)) {
      pairId = stat.selectedCandidatePairId;
      pair = stats.get(pairId);
    }
  });
  if (!pair) stats.forEach((stat, id) => {
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) {
      pair = stat; pairId = id;
    }
  });
  const local = stats.get(pair?.localCandidateId);
  const remote = stats.get(pair?.remoteCandidateId);
  const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  const mode = relay ? 'relay' : !pair || !local?.candidateType || !remote?.candidateType ? 'unknown' :
    local?.candidateType === 'host' && remote?.candidateType === 'host' ? 'lan' : 'internet';
  return {
    mode,
    localCandidate: local?.candidateType ?? null,
    remoteCandidate: remote?.candidateType ?? null,
    protocol: local?.protocol ?? remote?.protocol ?? null,
    // relayProtocol is the browser-to-TURN transport, not the relayed
    // candidate's protocol (which can say UDP even when TURN uses TCP/TLS).
    relayProtocol: local?.candidateType === 'relay' ? local.relayProtocol ?? null : null,
    roundTripMs: Number.isFinite(pair?.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null,
    sendBufferBytes: channel?.bufferedAmount ?? null,
    counter: pair ? { id: pairId, time: pair.timestamp, sent: pair.bytesSent, received: pair.bytesReceived } : null,
  };
}

export function connectionRates(current, previous) {
  const elapsed = current?.time - previous?.time;
  const valid = current && previous && current.id === previous.id && elapsed > 0;
  const rate = key => valid && Number.isFinite(current[key]) && Number.isFinite(previous[key]) && current[key] >= previous[key]
    ? (current[key] - previous[key]) * 1000 / elapsed : null;
  return { networkSendSpeed: rate('sent'), networkReceiveSpeed: rate('received') };
}

export function watchConnection(conn, onUpdate, {
  onVisibility = () => {}, interval = 1000, page = globalThis.document,
} = {}) {
  const pc = conn.peerConnection || conn._pc;
  const channel = conn.dataChannel || conn._dc;
  let stopped = false, running = false, timer, previous = null;
  let wasHidden = page?.visibilityState === 'hidden';
  async function sample() {
    if (stopped || running) return;
    running = true;
    try {
      const stats = pc ? await pc.getStats() : new Map();
      if (stopped) return;
      const { counter, ...snapshot } = connectionSnapshot(stats, channel);
      const rates = connectionRates(counter, previous);
      previous = counter;
      onUpdate({ ...snapshot, ...rates, hidden: page?.visibilityState === 'hidden', wasHidden });
    } catch {
      // Diagnostics must not interrupt file transfer or invent a route.
      if (!stopped) onUpdate({ mode: 'unknown', hidden: page?.visibilityState === 'hidden', wasHidden });
    } finally { running = false; }
  }
  function visibilityChanged() {
    const hidden = page?.visibilityState === 'hidden';
    wasHidden ||= hidden;
    onVisibility(hidden);
    void sample();
  }
  function stop() {
    stopped = true;
    clearInterval(timer);
    page?.removeEventListener('visibilitychange', visibilityChanged);
    channel?.removeEventListener('close', stop);
  }
  page?.addEventListener('visibilitychange', visibilityChanged);
  channel?.addEventListener('close', stop);
  timer = setInterval(sample, interval);
  visibilityChanged();
  return stop;
}

const finite = value => Number.isFinite(value) ? Math.round(value) : null;
export function diagnosticReport({ info = {}, flow = {}, speed = 0, side, remoteHidden, remoteWasHidden }) {
  return JSON.stringify({
    reportVersion: 1,
    side,
    fileBytesPerSecond: finite(speed),
    fileMbps: Math.round(speed * 8 / 1e6 * 100) / 100,
    route: info.mode === 'lan' ? 'direct-host' : info.mode === 'internet' ? 'direct' : info.mode ?? 'unknown',
    localCandidate: info.localCandidate ?? null,
    remoteCandidate: info.remoteCandidate ?? null,
    protocol: info.protocol ?? null,
    localRelayProtocol: info.relayProtocol ?? null,
    roundTripMs: finite(info.roundTripMs),
    networkSendBytesPerSecond: finite(info.networkSendSpeed),
    networkReceiveBytesPerSecond: finite(info.networkReceiveSpeed),
    sendBufferBytes: finite(info.sendBufferBytes),
    outstandingFileBytes: finite(flow.outstandingBytes),
    waitingFor: flow.waitingFor ?? null,
    localPageHidden: info.hidden ?? null,
    localPageWasHidden: info.wasHidden ?? null,
    remotePageHidden: remoteHidden ?? null,
    remotePageWasHidden: remoteWasHidden ?? null,
  }, null, 2);
}
