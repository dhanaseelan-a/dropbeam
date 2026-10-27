import { useState } from 'react';
import { diagnosticReport } from '../lib/connectionDiagnostics';

const routes = { unknown: 'Not reported yet', lan: 'Direct (host to host)', internet: 'Direct (no relay)', relay: 'Relay server' };
const number = value => Number.isFinite(value) ? value : null;
const rate = value => number(value) === null ? 'Not reported' : `${(value * 8 / 1e6).toFixed(2)} Mbps`;

export default function ConnectionDetails({ info, flow, speed, side, remoteHidden, remoteWasHidden }) {
  const [copyStatus, setCopyStatus] = useState('');
  const [report, setReport] = useState('');
  const peer = side === 'sender' ? 'Receiving' : 'Sending';
  const background = info?.hidden || remoteHidden;
  const copy = async () => {
    const text = diagnosticReport({ info: info || {}, flow, speed, side, remoteHidden, remoteWasHidden });
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('Copied'); setReport('');
    } catch {
      setReport(text); setCopyStatus('Select and copy the report below');
    }
  };
  return <div className="connection-details-wrap">
    {background && <p className="background-hint" role="status">
      {remoteHidden ? `${peer} page is in the background.` : 'This page is in the background.'} Keep DropBeam visible on both devices for the speed test.
    </p>}
    <details className="connection-details">
      <summary>Connection details</summary>
      <dl>
        <div><dt>Route</dt><dd>{routes[info?.mode] || routes.unknown}</dd></div>
        <div><dt>Transport</dt><dd>{info?.protocol?.toUpperCase() || 'Not reported'}{info?.relayProtocol ? ` · Relay ${info.relayProtocol.toUpperCase()}` : ''}</dd></div>
        <div><dt>Round-trip time</dt><dd>{number(info?.roundTripMs) === null ? 'Not reported' : `${info.roundTripMs} ms`}</dd></div>
        <div><dt>File transfer</dt><dd>{rate(speed)}</dd></div>
        <div><dt>Network {side === 'sender' ? 'send' : 'receive'}</dt><dd>{rate(side === 'sender' ? info?.networkSendSpeed : info?.networkReceiveSpeed)}</dd></div>
        <div><dt>This page</dt><dd>{info?.hidden ? 'Background' : 'Visible'}</dd></div>
        <div><dt>Other page</dt><dd>{typeof remoteHidden !== 'boolean' ? 'Not reported' : remoteHidden ? 'Background' : 'Visible'}</dd></div>
      </dl>
      <p>KB/s and MB/s measure bytes. Mbps measures bits: 1 MB/s is about 8 Mbps. Network rate can include protocol traffic and queued data.</p>
      {info?.mode === 'relay' && <p>This transfer uses an internet relay. Sharing a hotspot does not guarantee a local route.</p>}
      <button className="btn-link" onClick={copy}>Copy diagnostics</button>
      {copyStatus && <span className="diagnostic-copy-status" role="status">{copyStatus}</span>}
      {report && <textarea aria-label="Connection diagnostic report" readOnly value={report} onFocus={e => e.target.select()} />}
    </details>
  </div>;
}
