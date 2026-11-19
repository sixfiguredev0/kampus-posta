'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export default function PdfPreview({ url }) {
  const box = useRef(null);
  const canvas = useRef(null);
  const [pdf, setPdf] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);
  const [width, setWidth] = useState(480);

  useEffect(() => {
    let active = true;
    let loadingTask;
    async function load() {
      const library = await import('pdfjs-dist');
      if (!active) return;
      library.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      loadingTask = library.getDocument({
        url, enableXfa: false, isEvalSupported: false, maxImageSize: 16_000_000,
      });
      const document = await loadingTask.promise;
      if (active) setPdf(document);
    }
    load().catch(() => { if (active) setError(true); });
    return () => {
      active = false;
      loadingTask?.destroy().catch(() => {});
    };
  }, [url]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, Math.floor(entry.contentRect.width) - 24)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let rendering;
    async function draw() {
      const current = await pdf.getPage(page);
      if (cancelled) return;
      const natural = current.getViewport({ scale: 1 });
      const scale = Math.min(width / natural.width, 1000 / natural.height, 1.5);
      const viewport = current.getViewport({ scale });
      const pixels = Math.min(window.devicePixelRatio || 1, 2);
      const target = canvas.current;
      target.width = Math.ceil(viewport.width * pixels);
      target.height = Math.ceil(viewport.height * pixels);
      target.style.width = Math.ceil(viewport.width) + 'px';
      target.style.height = Math.ceil(viewport.height) + 'px';
      rendering = current.render({ canvas: target, viewport, transform: [pixels, 0, 0, pixels, 0, 0], annotationMode: 0 });
      await rendering.promise;
    }
    draw().catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      rendering?.cancel();
    };
  }, [pdf, page, width]);

  return <>
    <div className="pdf-preview" ref={box}>
      {error ? <p>PDF прегледът е недостъпен. Можете да изтеглите файла.</p>
        : !pdf ? <p>Зареждане на PDF…</p>
        : <canvas ref={canvas} role="img" aria-label={'PDF, страница ' + page} />}
    </div>
    {pdf?.numPages > 1 && !error && <nav className="pdf-nav" aria-label="Страници в PDF">
      <button className="icon-button" type="button" aria-label="Предишна страница" onClick={() => setPage(page - 1)} disabled={page <= 1}><ChevronLeft size={19} /></button>
      <span>{page} / {pdf.numPages}</span>
      <button className="icon-button" type="button" aria-label="Следваща страница" onClick={() => setPage(page + 1)} disabled={page >= pdf.numPages}><ChevronRight size={19} /></button>
    </nav>}
  </>;
}
