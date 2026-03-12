import { useState, useEffect, useMemo } from 'react';

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i;
const VIDEO_EXTS = /\.(mp4|webm|mov|avi|mkv)$/i;
const AUDIO_EXTS = /\.(mp3|wav|flac|aac|ogg|m4a)$/i;
const TEXT_EXTS = /\.(txt|md|csv|json|xml|html|css|js|jsx|ts|tsx|py|java|c|cpp|h|sh|yml|yaml|log|cfg|ini|env)$/i;

export function getFileType(name) {
  if (IMAGE_EXTS.test(name)) return 'image';
  if (VIDEO_EXTS.test(name)) return 'video';
  if (AUDIO_EXTS.test(name)) return 'audio';
  if (TEXT_EXTS.test(name)) return 'text';
  if (/\.pdf$/i.test(name)) return 'pdf';
  return 'other';
}

export function getFileIcon(name) {
  const type = getFileType(name);
  const map = { image: '🖼️', video: '🎬', audio: '🎵', text: '📄', pdf: '📄', other: '📁' };
  return map[type] || '📁';
}

export function FilePreview({ file, maxHeight = 200 }) {
  const [textContent, setTextContent] = useState('');
  const type = getFileType(file.name);
  const url = useMemo(() => {
    if (type === 'image' || type === 'video' || type === 'audio') {
      return URL.createObjectURL(file);
    }
    return null;
  }, [file, type]);

  useEffect(() => {
    if (type === 'text') {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        setTextContent(text.slice(0, 800));
      };
      reader.readAsText(file.slice(0, 1024));
    }
  }, [file, type]);

  useEffect(() => {
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [url]);

  if (type === 'image' && url) {
    return (
      <div className="preview-container">
        <img src={url} alt={file.name} className="preview-image" style={{ maxHeight }} />
      </div>
    );
  }

  if (type === 'video' && url) {
    return (
      <div className="preview-container">
        <video src={url} className="preview-video" style={{ maxHeight }} controls muted preload="metadata" />
      </div>
    );
  }

  if (type === 'audio' && url) {
    return (
      <div className="preview-container preview-audio-wrap">
        <div className="preview-audio-icon">🎵</div>
        <audio src={url} className="preview-audio" controls preload="metadata" />
      </div>
    );
  }

  if (type === 'text' && textContent) {
    return (
      <div className="preview-container">
        <pre className="preview-text">{textContent}{textContent.length >= 800 ? '\n...' : ''}</pre>
      </div>
    );
  }

  return null;
}

export function FileThumbnail({ file }) {
  const type = getFileType(file.name);
  const url = useMemo(() => {
    if (type === 'image') return URL.createObjectURL(file);
    return null;
  }, [file, type]);

  useEffect(() => {
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [url]);

  if (url) {
    return <img src={url} alt="" className="file-preview-thumb" />;
  }

  return <span className="file-icon">{getFileIcon(file.name)}</span>;
}
