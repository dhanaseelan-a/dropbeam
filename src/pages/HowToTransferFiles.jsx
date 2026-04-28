import { useNavigate } from 'react-router-dom';
import useSEO from '../hooks/useSEO';


export default function HowToTransferFiles() {
  const navigate = useNavigate();

  useSEO({
    title: 'How to Transfer Files Between Devices (Phone, PC, Mac) — DropBeam',
    description: 'Sending files between your phone, tablet, and computer should not be complicated. Learn how to transfer files in 3 simple steps with DropBeam.',
    url: 'https://dropbeam.tech/how-to-transfer-files',
  });


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
        <h2 className="seo-heading">How to Transfer Files Between Devices</h2>
        <p className="seo-intro">
          Sending files between your phone, tablet, and computer shouldn't be complicated. 
          With DropBeam, it takes <strong>3 simple steps</strong> — no apps, no accounts, no cables.
        </p>

        <section className="seo-section">
          <h3 className="seo-subheading">📋 Step-by-Step Guide</h3>
          <div className="seo-steps">
            <div className="seo-step glass-card">
              <span className="seo-step-num">1</span>
              <div>
                <strong>Open DropBeam on the Sender</strong>
                <p>Go to <strong>dropbeam.tech</strong> on the device that has the files. Tap "Send" and select your files.</p>
              </div>
            </div>
            <div className="seo-step glass-card">
              <span className="seo-step-num">2</span>
              <div>
                <strong>Share the Code or QR</strong>
                <p>You'll get a <strong>6-character code</strong> and a QR code. Share either with the receiving device.</p>
              </div>
            </div>
            <div className="seo-step glass-card">
              <span className="seo-step-num">3</span>
              <div>
                <strong>Receive & Download</strong>
                <p>Open DropBeam on the receiver, enter the code (or scan QR), and the file transfers directly at full speed.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h3 className="seo-subheading">💡 Pro Tips</h3>
          <div className="seo-grid">
            <div className="seo-card glass-card">
              <h4>📶 Same Network = Fastest</h4>
              <p>When both devices are on the same Wi-Fi, transfers happen at LAN speed — often 50-100+ MB/s.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>📱 Use the QR Code</h4>
              <p>On mobile? Just scan the QR code with your camera — it opens DropBeam with the code pre-filled.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>📁 Multiple Files</h4>
              <p>Select multiple files at once. They'll be sent sequentially and auto-downloaded on the other end.</p>
            </div>
            <div className="seo-card glass-card">
              <h4>🔒 One-Time Code</h4>
              <p>Each code expires after one use and has a short time-to-live. Your connection stays private.</p>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h3 className="seo-subheading">❓ Frequently Asked Questions</h3>
          <div className="seo-faq">
            <details className="faq-item glass-card">
              <summary><strong>Do I need to install an app?</strong></summary>
              <p>No. DropBeam works entirely in your web browser. Just open dropbeam.tech and start transferring.</p>
            </details>
            <details className="faq-item glass-card">
              <summary><strong>Is there a file size limit?</strong></summary>
              <p>No. Since files go directly between devices (not through our servers), there are no size restrictions.</p>
            </details>
            <details className="faq-item glass-card">
              <summary><strong>Can I send files to someone in another country?</strong></summary>
              <p>Yes! DropBeam works over the internet. As long as both devices have a connection, you can transfer files globally.</p>
            </details>
            <details className="faq-item glass-card">
              <summary><strong>Are my files private?</strong></summary>
              <p>Absolutely. Files are encrypted end-to-end via WebRTC DTLS. They never touch our servers — we physically cannot see them.</p>
            </details>
            <details className="faq-item glass-card">
              <summary><strong>What happens if the connection drops?</strong></summary>
              <p>DropBeam has built-in reconnection. If the connection briefly drops, it will automatically attempt to re-establish and resume.</p>
            </details>
          </div>
        </section>

        <div className="seo-cta">
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            🚀 Transfer Files Now — It's Free
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
