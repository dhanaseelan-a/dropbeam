import { useNavigate } from 'react-router-dom';

export default function AirdropAlternative() {
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
        <h2 className="seo-heading">AirDrop Alternative — Cross-Platform File Sharing</h2>
        <p className="seo-intro">
          Love AirDrop but need it to work between <strong>iPhone and Windows</strong>? Or <strong>Android and Mac</strong>? 
          DropBeam is the cross-platform AirDrop alternative that works everywhere — 
          right from your browser.
        </p>

        <section className="seo-section">
          <h3 className="seo-subheading">🔄 Works Across Every Platform</h3>
          <div className="seo-platforms">
            <div className="platform-card glass-card">
              <span className="platform-icon">🍎</span>
              <span>iPhone / iPad</span>
            </div>
            <div className="platform-card glass-card">
              <span className="platform-icon">🤖</span>
              <span>Android</span>
            </div>
            <div className="platform-card glass-card">
              <span className="platform-icon">🪟</span>
              <span>Windows</span>
            </div>
            <div className="platform-card glass-card">
              <span className="platform-icon">🍏</span>
              <span>macOS</span>
            </div>
            <div className="platform-card glass-card">
              <span className="platform-icon">🐧</span>
              <span>Linux</span>
            </div>
            <div className="platform-card glass-card">
              <span className="platform-icon">💻</span>
              <span>ChromeOS</span>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h3 className="seo-subheading">📊 DropBeam vs AirDrop vs Others</h3>
          <div className="seo-table-wrap glass-card">
            <table className="seo-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>DropBeam</th>
                  <th>AirDrop</th>
                  <th>Nearby Share</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>Cross-Platform</td><td className="highlight">✅ All devices</td><td>❌ Apple only</td><td>❌ Android/Chrome</td></tr>
                <tr><td>No App Install</td><td className="highlight">✅ Browser-based</td><td>✅ Built-in</td><td>⚠️ Some devices</td></tr>
                <tr><td>Works over Internet</td><td className="highlight">✅ Anywhere</td><td>❌ Same Wi-Fi</td><td>❌ Nearby only</td></tr>
                <tr><td>File Size Limit</td><td className="highlight">✅ Unlimited</td><td>✅ Unlimited</td><td>⚠️ Varies</td></tr>
                <tr><td>Encryption</td><td className="highlight">✅ DTLS</td><td>✅ TLS</td><td>✅ Yes</td></tr>
                <tr><td>No Account</td><td className="highlight">✅</td><td>⚠️ Apple ID</td><td>⚠️ Google Acct</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="seo-section">
          <h3 className="seo-subheading">💡 Common Use Cases</h3>
          <div className="seo-grid">
            <div className="seo-card glass-card">
              <h4>📱 → 💻 Phone to PC</h4>
              <p>Transfer photos and videos from your iPhone or Android to your Windows PC without cables or apps.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>🏢 Office Sharing</h4>
              <p>Share files with colleagues instantly — even if they're on different operating systems.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>🌍 Remote Transfers</h4>
              <p>Unlike AirDrop, DropBeam works over the internet. Send files to anyone, anywhere in the world.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>🎓 Campus & Public Wi-Fi</h4>
              <p>AirDrop is often blocked on public networks. DropBeam navigates firewalls using ICE/TURN.</p>
            </div>
          </div>
        </section>

        <div className="seo-cta">
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            🔄 Try the Cross-Platform AirDrop
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
