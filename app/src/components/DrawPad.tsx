// 指・ペンで描けるキャンバス(人体図のマーク・署名)。描いた内容は PNG の Blob で取り出せる
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Eraser } from 'lucide-react';

export interface DrawPadHandle {
  isEmpty: () => boolean;
  toBlob: () => Promise<Blob | null>;
  clear: () => void;
}

interface Props {
  background?: string;        // 背景画像(人体図)。書き出し時も一緒に描く
  aspect: number;             // 横 / 縦
  color?: string;
  lineWidth?: number;
  clearLabel: string;
  hint?: string;
  onChange?: (empty: boolean) => void;
}

export const DrawPad = forwardRef<DrawPadHandle, Props>(function DrawPad(
  { background, aspect, color = '#d1343e', lineWidth = 4, clearLabel, hint, onChange }, ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  const paintBackground = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (img.current?.complete) ctx.drawImage(img.current, 0, 0, c.width, c.height);
  }, []);

  // 表示サイズに合わせて内部解像度を決める(高解像度画面でもにじまない)
  const resize = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const w = c.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(w * dpr);
    c.height = Math.round((w / aspect) * dpr);
    paintBackground();
    setEmpty(true);
    onChange?.(true);
  }, [aspect, paintBackground, onChange]);

  useEffect(() => {
    if (background) {
      const i = new Image();
      i.onload = () => { img.current = i; paintBackground(); };
      i.src = background;
    }
    resize();
    // 向きの変更などでサイズが変わったら描き直し(描いた内容は消える)
    let w = canvas.current?.clientWidth;
    const onResize = () => {
      if (canvas.current && canvas.current.clientWidth !== w) { w = canvas.current.clientWidth; resize(); }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [background, resize, paintBackground]);

  const point = (e: React.PointerEvent) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };

  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    canvas.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current || !last.current) return;
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    const p = point(e);
    const scale = c.width / c.clientWidth;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (empty) { setEmpty(false); onChange?.(false); }
  };
  const up = () => { drawing.current = false; last.current = null; };

  const clear = useCallback(() => {
    paintBackground();
    setEmpty(true);
    onChange?.(true);
  }, [paintBackground, onChange]);

  useImperativeHandle(ref, () => ({
    isEmpty: () => empty,
    clear,
    toBlob: () => new Promise((resolve) => canvas.current ? canvas.current.toBlob(resolve, 'image/png') : resolve(null)),
  }), [empty, clear]);

  return (
    <div className="drawpad">
      <canvas
        ref={canvas}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        style={{ aspectRatio: String(aspect) }}
      />
      <div className="drawpad-foot">
        {hint && <span className="muted small">{hint}</span>}
        <button type="button" className="btn-sm" onClick={clear}><Eraser size={14} />{clearLabel}</button>
      </div>
    </div>
  );
});
