// Optional Vercel function. These are server environment variables, never VITE_*.
// Without them, the client continues to use its public STUN/TURN fallback.
export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }
  const { METERED_DOMAIN: domain, METERED_API_KEY: apiKey } = process.env;
  if (!domain || !apiKey) return response.status(503).json({ error: 'TURN provider is not configured' });
  if (!/^[a-z0-9-]+\.metered\.(live|ca)$/i.test(domain)) {
    return response.status(503).json({ error: 'Invalid TURN provider domain' });
  }
  try {
    const url = new URL(`https://${domain}/api/v1/turn/credentials`);
    url.searchParams.set('apiKey', apiKey);
    const upstream = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!upstream.ok) throw new Error('TURN provider unavailable');
    const iceServers = await upstream.json();
    if (!Array.isArray(iceServers) || !iceServers.length) throw new Error('Empty ICE configuration');
    return response.status(200).json({ iceServers });
  } catch {
    // Do not include the credential URL or API key in errors/logs.
    return response.status(502).json({ error: 'Unable to load relay credentials' });
  }
}
