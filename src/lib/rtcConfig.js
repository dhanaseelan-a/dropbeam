const PUBLIC_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turns:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export function validIceServers(servers) {
  return Array.isArray(servers) && servers.length > 0 && servers.every(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.length > 0 && urls.every(url => typeof url === 'string' && /^(stun|stuns|turn|turns):/.test(url));
  });
}

// Resolve credentials before constructing either peer. The optional endpoint
// keeps the TURN provider's API key out of Vite's public JavaScript bundle.
export async function getRTCConfig({ relayOnly = false, fetcher = globalThis.fetch } = {}) {
  let iceServers = PUBLIC_ICE_SERVERS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetcher('/api/ice-servers', { signal: controller.signal, cache: 'no-store' });
    if (response.ok) {
      const result = await response.json();
      if (validIceServers(result.iceServers)) iceServers = result.iceServers;
    }
  } catch {
    // Static deployments and offline credential endpoints retain public fallback.
  } finally { clearTimeout(timeout); }
  return { iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all', iceCandidatePoolSize: 0 };
}

export async function detectNetwork(conn) {
  try {
    const pc = conn.peerConnection || conn._pc;
    if (!pc) return { mode: 'internet' };
    const stats = await pc.getStats();
    let pair;
    stats.forEach(stat => {
      if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = stats.get(stat.selectedCandidatePairId);
    });
    if (!pair) stats.forEach(stat => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) pair = stat;
    });
    const local = stats.get(pair?.localCandidateId)?.candidateType;
    const remote = stats.get(pair?.remoteCandidateId)?.candidateType;
    if (local === 'relay' || remote === 'relay') return { mode: 'relay' };
    if (local === 'host' && remote === 'host') return { mode: 'lan' };
    if (local === 'host' || remote === 'host') return { mode: 'wifi' };
  } catch { /* Network labels are best-effort and never block a transfer. */ }
  return { mode: 'internet' };
}
