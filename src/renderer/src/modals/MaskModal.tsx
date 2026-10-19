// Painting where an attached image may change. The painted area becomes the
// transparent part of a mask the size of the image, which is how OpenAI's
// image tool is told to leave everything else alone.
import { useEffect, useRef, useState } from "react";
import { imageUrl } from "../../../shared/api.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { Modal } from "./Modal.tsx";

const BRUSH = { min: 4, max: 160, initial: 40 } as const;
const UNDO_DEPTH = 20;

export function MaskModal({ absolute, onClose, onDone }: { absolute: string; onClose: () => void; onDone: (maskPath: string) => void }) {
  const { t } = useI18n();
  const paint = useRef<HTMLCanvasElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const [brush, setBrush] = useState<number>(BRUSH.initial);
  const [painted, setPainted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ width: number; height: number } | null>(null);
  const undo = useRef<ImageData[]>([]);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const image = new Image();
    image.onload = () => setNatural({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => setBroken(true);
    image.src = imageUrl(absolute);
  }, [absolute]);

  // The image fitted inside the stage both ways, kept fitted as the window resizes.
  useEffect(() => {
    const el = stage.current;
    if (!el || !natural) return;
    const measure = () => {
      const k = Math.min(el.clientWidth / natural.width, el.clientHeight / natural.height, 1);
      setFit({ width: Math.floor(natural.width * k), height: Math.floor(natural.height * k) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [natural]);

  const context = () => paint.current?.getContext("2d") ?? null;

  // The brush is sized on screen; the canvas holds the image's own pixels.
  const scale = () => (paint.current ? paint.current.width / paint.current.getBoundingClientRect().width : 1);

  const at = (event: React.PointerEvent) => {
    const rect = paint.current!.getBoundingClientRect();
    const s = scale();
    return { x: (event.clientX - rect.left) * s, y: (event.clientY - rect.top) * s };
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = context();
    if (!ctx) return;
    ctx.strokeStyle = "rgba(232, 96, 60, 1)";
    ctx.fillStyle = "rgba(232, 96, 60, 1)";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brush * scale();
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const onDown = (event: React.PointerEvent) => {
    const ctx = context();
    if (!ctx || !paint.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    undo.current = [...undo.current, ctx.getImageData(0, 0, paint.current.width, paint.current.height)].slice(-UNDO_DEPTH);
    const point = at(event);
    last.current = point;
    stroke(point, point);
    setPainted(true);
  };

  const onMove = (event: React.PointerEvent) => {
    if (!last.current) return;
    const point = at(event);
    stroke(last.current, point);
    last.current = point;
  };

  const onUp = () => {
    last.current = null;
  };

  const clear = () => {
    const ctx = context();
    if (!ctx || !paint.current) return;
    undo.current = [...undo.current, ctx.getImageData(0, 0, paint.current.width, paint.current.height)].slice(-UNDO_DEPTH);
    ctx.clearRect(0, 0, paint.current.width, paint.current.height);
    setPainted(false);
  };

  const back = () => {
    const ctx = context();
    const previous = undo.current.pop();
    if (!ctx || !previous) return;
    ctx.putImageData(previous, 0, 0);
    setPainted(previous.data.some((value, i) => i % 4 === 3 && value > 0));
  };

  const done = async () => {
    if (!paint.current || !natural) return;
    setSaving(true);
    setFailed(false);
    // Opaque white everywhere, then the painted area cut out: transparent where the image may change (OpenAI's documented mask).
    const mask = document.createElement("canvas");
    mask.width = natural.width;
    mask.height = natural.height;
    const ctx = mask.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, mask.width, mask.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(paint.current, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => mask.toBlob(resolve, "image/png"));
    const saved = blob ? await api.saveMask(new Uint8Array(await blob.arrayBuffer())) : null;
    setSaving(false);
    if (saved) onDone(saved);
    else setFailed(true);
  };

  return (
    <Modal
      title={t("mask.title")}
      width={0}
      large
      onClose={onClose}
      intro={t("mask.intro")}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="button primary" disabled={!painted || saving} onClick={() => void done()}>
            {t("mask.done")}
          </button>
        </>
      }
    >
      <div className="mask-tools">
        <label className="mask-brush">
          <span>{t("mask.brush")}</span>
          <input type="range" min={BRUSH.min} max={BRUSH.max} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
        </label>
        <button type="button" className="button" onClick={back} disabled={undo.current.length === 0 && !painted}>
          {t("mask.undo")}
        </button>
        <button type="button" className="button" onClick={clear} disabled={!painted}>
          {t("mask.clear")}
        </button>
      </div>
      {failed && (
        <p className="field-error" role="alert">
          {t("mask.failed")}
        </p>
      )}
      <div className="mask-stage" ref={stage}>
        {broken && <p className="mask-problem">{t("print.missing")}</p>}
        {natural && (
          <div className="mask-frame" style={fit ? { width: fit.width, height: fit.height } : { visibility: "hidden" }}>
            <img src={imageUrl(absolute)} alt="" draggable={false} />
            <canvas
              ref={paint}
              width={natural.width}
              height={natural.height}
              aria-label={t("mask.canvas")}
              role="img"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
