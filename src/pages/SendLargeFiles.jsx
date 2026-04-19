import { useNavigate } from 'react-router-dom';

export default function SendLargeFiles() {
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
        <h2 className="seo-heading">Send Large Files Online — No Limits, No Upload</h2>
        <p className="seo-intro">
          Tired of file size limits? DropBeam lets you <strong>send files of any size</strong> directly 
          to another device. No upload wait, no cloud storage, no compression. 
          Your files go straight from point A to point B.
        </p>

        <section className="seo-section">
          <h3 className="seo-subheading">🎯 Perfect For Large Files</h3>
          <div className="seo-grid">
            <div className="seo-card glass-card">
              <h4>🎬 Videos & RAW Footage</h4>
              <p>Send 4K videos, drone footage, or raw camera files without compression or quality loss.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>🎨 Design Assets</h4>
              <p>Transfer PSD files, Figma exports, high-resolution graphics, and entire asset bundles instantly.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>💾 Backups & Archives</h4>
              <p>Move ZIP archives, database dumps, or full project folders between machines without limits.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>🎵 Music & Audio</h4>
              <p>Share lossless FLAC, WAV stems, or entire album projects without any quality degradation.</p>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h3 className="seo-subheading">🚫 Why Cloud Uploads Fall Short</h3>
          <div className="seo-problems">
            <div className="seo-problem glass-card">
              <span className="problem-icon">⏱️</span>
              <div>
                <strong>Slow Upload + Download</strong>
                <p>Cloud services make you upload first, wait, then the receiver downloads. That's <em>double</em> the time.</p>
              </div>
            </div>
            <div className="seo-problem glass-card">
              <span className="problem-icon">📏</span>
              <div>
                <strong>File Size Caps</strong>
                <p>Most free services cap at 2–5 GB. Need to send 20 GB? You'll hit a paywall.</p>
              </div>
            </div>
            <div className="seo-problem glass-card">
              <span className="problem-icon">🔓</span>
              <div>
                <strong>Privacy Concerns</strong>
                <p>Your files sit on someone else's server. They can scan, index, or share them.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h3 className="seo-subheading">✅ DropBeam's Approach</h3>
          <ul className="seo-checklist">
            <li><span className="check">✓</span> Direct peer-to-peer — no upload wait</li>
            <li><span className="check">✓</span> No file size restrictions whatsoever</li>
            <li><span className="check">✓</span> Encrypted end-to-end via WebRTC DTLS</li>
            <li><span className="check">✓</span> LAN-speed transfers when on the same network</li>
            <li><span className="check">✓</span> Works on any device with a modern browser</li>
            <li><span className="check">✓</span> 100% free — no accounts, no upsells</li>
          </ul>
        </section>

        <div className="seo-cta">
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            📦 Send a Large File Now
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
