import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "./ui";
import { originalUrl } from "./api";
GlobalWorkerOptions.workerSrc = workerUrl;
export default function PdfPane({
  id,
  initialPage = 1,
  onClose,
}: {
  id: string;
  initialPage?: number;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(initialPage);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    setPage(initialPage);
  }, [id, initialPage]);
  useEffect(() => {
    let cancelled = false;
    let rendering: any;
    setError("");
    const task = getDocument({
      url: originalUrl(id),
      cMapUrl: "/_app/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/_app/standard_fonts/",
      wasmUrl: "/_app/wasm/",
    });
    task.promise
      .then(async (pdf) => {
        if (cancelled) return;
        setTotal(pdf.numPages);
        if (page < 1 || page > pdf.numPages)
          throw new Error("物理页超出范围。");
        const source = await pdf.getPage(page);
        if (cancelled || !canvas.current) return;
        const viewport = source.getViewport({ scale: 1.1 });
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        rendering = source.render({ canvas: canvas.current, viewport });
        await rendering.promise;
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      rendering?.cancel();
      void task.destroy();
    };
  }, [id, page]);
  return (
    <section className="pdf-pane" aria-label="PDF物理页预览">
      <div className="toolbar">
        <strong>原 PDF</strong>
        <span>
          物理页 {page} / {total || "…"}
        </span>
        <Button variant="ghost" onClick={onClose}>
          关闭预览
        </Button>
      </div>
      <div className="toolbar">
        <Button
          variant="outline"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          上一页
        </Button>
        <label>
          物理页{" "}
          <input
            className="page-input"
            type="number"
            min={1}
            max={total || 1}
            value={page}
            onChange={(e) =>
              setPage(Math.max(1, Math.min(total || 1, Number(e.target.value))))
            }
          />
        </label>
        <Button
          variant="outline"
          disabled={page >= total}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </Button>
        <a href={originalUrl(id)} target="_blank" rel="noreferrer">
          打开原件
        </a>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="pdf-canvas">
        <canvas ref={canvas} />
      </div>
    </section>
  );
}
