# Transfer reliability and mobile networks

DropBeam keeps direct WebRTC transfers as its first choice. Both devices now
gather STUN and TURN candidates, including TCP and TLS on port 443. A failed
connection retries with a relay-only attempt, then alternates with normal ICE.
The sender's share code and other receivers stay connected during recovery.

## Configure a reliable relay on Vercel

The public OpenRelay credentials are retained as a best-effort fallback. They
are shared infrastructure: their availability, capacity and performance are
outside this repository's control. Adding TCP/TLS URLs alone does not prove
that a particular Jio, Airtel or Vi connection will work.

For dependable operation on networks that need a relay:

1. Obtain a Metered/OpenRelay account and its TURN credential API details.
2. In the Vercel project's environment variables, set `METERED_DOMAIN` to the
   hostname provided by that account (for example `your-app.metered.live`, with
   no `https://` or path) and `METERED_API_KEY` to its credential API key.
3. Redeploy. `/api/ice-servers` must return HTTP 200 with an `iceServers` array.
   A 503 means the provider is not configured; the app will use the public fallback.
4. Open a fresh tab on both devices and test the combinations below.

Keep the API key in **server** environment variables, not `VITE_*`, source code,
or a committed `.env` file. The endpoint returns browser-required ICE credentials,
never the provider API key. Use the provider's appropriate credential lifetime,
usage limits and region for your deployment. No new provider account, paid plan,
or deployment settings are created by this code change.

Static hosts without the function can use the public fallback, or implement the
same `/api/ice-servers` JSON endpoint. Fetching credentials has a four-second
deadline so an unavailable endpoint cannot leave connection setup hanging.

## What changed in the transfer engine

- Respect the negotiated SCTP message-size limit before sending. If a browser
  rejects a message, retry the same byte offset using a smaller message.
- Retry full-buffer errors for both file bytes and control messages. Resume
  immediately on acknowledgements and low-buffer events; polling is only a
  safety net.
- Use bounded read batches and Blob parts instead of allocating a contiguous
  buffer as large as 512 MB on the receiving phone.
- Resume with a transfer ID, completed file index and **per-file** byte offset.
  Keep partial data and completed-file bookkeeping across reconnects.
- Use a stable receiver ID to distinguish multiple devices with the same name.
- Validate file sizes and require receiver completion before showing sender
  success. A closed connection or timeout cannot silently become a success.
- Keep pause, cancel, speed/ETA displays, completion sounds, code expiry,
  folders/ZIPs, file previews, QR/link sharing and multiple receivers.

## Validation

Run `npm ci`, `npm test` and `npm run build`. The Node tests exercise the real
transport functions with deterministic channel faults and verify output bytes.

For the browser lifecycle suite, run `npx playwright install chromium` and
`npm run test:ui`. It checks the actual React hooks, downloads and controls with
a test-only PeerJS substitute using ordered browser messages. This includes
two identical-device receivers, pauses, cancellation, folder ZIP contents and
reconnecting during a later file without duplicate downloads. It does not test
native ICE or TURN. An existing Chromium executable can be selected with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

The carrier check requires physical devices and a functioning TURN service;
local tests do not reproduce a carrier's routing, CGNAT, IPv6 or firewall.

| Sender | Receiver | Check |
| --- | --- | --- |
| Jio mobile data | Airtel or Vi mobile data | Small file and a large file; compare hashes |
| Airtel or Vi mobile data | Jio mobile data | Same files in the opposite direction |
| Jio mobile data | Jio mobile data | Relay fallback and completion on both devices |
| Same Wi-Fi / hotspot | Same Wi-Fi / hotspot | Direct connection and throughput |
| Any network | Two receivers | Pause one receiver; the other must continue |

Also disconnect a receiver in the second file of a batch, restore its network,
and confirm the share code stays unchanged, no completed file downloads twice,
and the resumed file's SHA-256 matches the original. Test folder ZIP contents,
empty files, cancel, send/receive more, native sharing and clipboard copying.
Browsers may ask for permission to download multiple files. Keep both tabs open;
mobile operating systems can suspend browsers when the phone is locked.

## References

- [PeerJS NAT and TURN FAQ](https://peerjs.com/client/faq)
- [OpenRelay setup and credential API](https://www.metered.ca/tools/openrelay/)
- [RTCDataChannel send errors](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/send)
