import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import WebRTCFileTransfer from './pages/WebRTCFileTransfer.jsx'
import SendLargeFiles from './pages/SendLargeFiles.jsx'
import AirdropAlternative from './pages/AirdropAlternative.jsx'
import HowToTransferFiles from './pages/HowToTransferFiles.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/webrtc-file-transfer" element={<WebRTCFileTransfer />} />
        <Route path="/send-large-files-online" element={<SendLargeFiles />} />
        <Route path="/airdrop-alternative" element={<AirdropAlternative />} />
        <Route path="/how-to-transfer-files" element={<HowToTransferFiles />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
