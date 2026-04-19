import { useNavigate } from 'react-router-dom';

export default function WebRTCFileTransfer() {
  const navigate = useNavigate();

  return (
    <div className="app-container seo-page">
      <header className="app-header">
        <div className="app-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12l7-7 7 7" />
          </svg>
        </div>
        <h1 className="app-title" style={{ cursor: 'pointer' }} onClick={() => navigate('/')}>DropBeam<sup className="tm">™</sup></h1>
      </header>

      <article className="seo-article fade-in">
        <h2 className="seo-heading">WebRTC File Transfer — Fast, Private & Serverless</h2>
        <p className="seo-intro">
          DropBeam uses <strong>WebRTC</strong> (Web Real-Time Communication) to create a direct peer-to-peer 
          connection between your devices. Your files travel directly from sender to receiver — 
          never touching any cloud server.
        </p>

        <section className="seo-section">
          <h3 className="seo-subheading">⚡ How WebRTC File Transfer Works</h3>
          <div className="seo-steps">
            <div className="seo-step glass-card">
              <span className="seo-step-num">1</span>
              <div>
                <strong>Signal Exchange</strong>
                <p>Both devices exchange a lightweight handshake via our signaling server to establish the connection.</p>
              </div>
            </div>
            <div className="seo-step glass-card">
              <span className="seo-step-num">2</span>
              <div>
                <strong>Direct P2P Tunnel</strong>
                <p>A secure, encrypted <strong>DTLS</strong> tunnel is created. Data flows directly between browsers — no middleman.</p>
              </div>
            </div>
            <div className="seo-step glass-card">
              <span className="seo-step-num">3</span>
              <div>
                <strong>High-Speed Transfer</strong>
                <p>Files are split into optimized chunks and streamed through the DataChannel at maximum bandwidth.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h3 className="seo-subheading">🔒 Why WebRTC Is More Private</h3>
          <div className="seo-grid">
            <div className="seo-card glass-card">
              <h4>End-to-End Encrypted</h4>
              <p>WebRTC mandates DTLS encryption. Every byte is encrypted in transit — even we can't see your files.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>Zero Server Storage</h4>
              <p>Files are never uploaded to any server. The transfer happens entirely between your devices.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>No Account Required</h4>
              <p>No sign up, no email, no tracking. Just open the page, share the code, and beam your files.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>No File Size Limits</h4>
              <p>Since nothing is stored on servers, there are no artificial size limits. Transfer gigabytes for free.</p>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h3 className="seo-subheading">📊 WebRTC vs Traditional Upload</h3>
          <div className="seo-table-wrap glass-card">
            <table className="seo-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>DropBeam (WebRTC)</th>
                  <th>Cloud Upload</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Privacy</td><td className="highlight">P2P, end-to-end encrypted</td><td>Uploaded to servers</td></tr>
                <tr><td>Speed</td><td className="highlight">Direct — LAN speed possible</td><td>Limited by upload bandwidth</td></tr>
                <tr><td>File Size</td><td className="highlight">Unlimited</td><td>Usually 2-10 GB cap</td></tr>
                <tr><td>Cost</td><td className="highlight">Free forever</td><td>Free tier + paid plans</td></tr>
                <tr><td>Account</td><td className="highlight">Not needed</td><td>Required</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <div className="seo-cta">
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            🚀 Start a WebRTC Transfer Now
          </button>
        </div>
      </article>

      <footer className="app-footer">
        <div className="footer-text">
          <span>Encrypted P2P</span>
          <span className="footer-dot"></span>
          <span>Nothing stored on servers</span>
          <span className="footer-dot"></span>
          <span>WebRTC</span>
        </div>
      </footer>
    </div>
  );
}
