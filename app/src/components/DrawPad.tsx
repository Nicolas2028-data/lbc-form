// 指・ペンで描けるキャンバス(人体図のマーク・署名)
//  - 内部の解像度は固定(画面の回転・サイズ変更で描いた線が消えない)。表示は CSS で拡大縮小
//  - 背景画像と描いた線は別の層。画像の読込が遅くても線は消えない
//  - 最初に触れた 1 本の指・ペンだけを使う(2 本指や手のひらで線が飛ばない)
//  - 書き出しは背景 + 線を合成した画像(人体図は JPEG で軽く、署名は PNG)
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { Eraser } from 'lucide-react';

export interface DrawPadHandle {
  isEmpty: () => boolean;
  /** 描いた内容が変わるたびに増える番号(前回アップロードした内容と同じか判定する) */
  version: () => number;
  toBlob: () => Promise<Blob | null>;
  clear: () => void;
}

interface Props {
  background?: string;        // 背景画像(人体図)
  width: number;              // 内部の解像度
  height: number;
  color?: string;
  lineWidth?: number;
  format?: 'image/png' | 'image/jpeg';
  clearLabel: string;
  hint?: string;
  onChange?: (empty: boolean) => void;
}

export const DrawPad = forwardRef<DrawPadHandle, Props>(function DrawPad(
  { background, width, height, color = '#d1343e', lineWidth = 5, format = 'image/png', clearLabel, hint, onChange }, ref,
) {
  const ink = useRef<HTMLCanvasElement>(null);
  const activePointer = useRef<number | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const versionRef = useRef(0);
  const [empty, setEmpty] = useState(true);

  const markDrawn = () => {
    versionRef.current++;
    if (empty) { setEmpty(false); onChange?.(false); }
  };

  const point = (e: { clientX: number; clientY: number }) => {
    const c = ink.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const ctx = () => {
    const g = ink.current!.getContext('2d')!;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = lineWidth;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    return g;
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== null || !e.isPrimary) return;
    e.preventDefault();
    activePointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    last.current = p;
    // タップだけでも点を打つ
    const g = ctx();
    g.beginPath();
    g.arc(p.x, p.y, lineWidth / 2, 0, Math.PI * 2);
    g.fill();
    markDrawn();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== activePointer.current || !last.current) return;
    const g = ctx();
    // Apple Pencil などの細かい点も拾ってなめらかに
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
    g.beginPath();
    g.moveTo(last.current.x, last.current.y);
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = point(ev);
      g.lineTo(p.x, p.y);
      last.current = p;
    }
    g.stroke();
    versionRef.current++;
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== activePointer.current) return;
    activePointer.current = null;
    last.current = null;
  };

  const clear = useCallback(() => {
    const c = ink.current;
    if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    versionRef.current++;
    setEmpty(true);
    onChange?.(true);
  }, [onChange]);

  useImperativeHandle(ref, () => ({
    isEmpty: () => empty,
    version: () => versionRef.current,
    clear,
    toBlob: async () => {
      const out = document.createElement('canvas');
      out.width = width;
      out.height = height;
      const g = out.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, width, height);
      if (background) {
        const img = new Image();
        img.src = background;
        await img.decode().catch(() => undefined);
        if (img.complete && img.naturalWidth) g.drawImage(img, 0, 0, width, height);
      }
      if (ink.current) g.drawImage(ink.current, 0, 0);
      return new Promise<Blob | null>((resolve) => out.toBlob(resolve, format, 0.85));
    },
  }), [empty, clear, background, width, height, format]);

  return (
    <div className="drawpad">
      <div className="drawpad-stage" style={{ aspectRatio: `${width} / ${height}`, backgroundImage: background ? `url(${background})` : undefined }}>
        <canvas
          ref={ink}
          width={width}
          height={height}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      </div>
      <div className="drawpad-foot">
        {hint && <span className="muted small">{hint}</span>}
        <button type="button" className="btn-sm" onClick={clear}><Eraser size={14} />{clearLabel}</button>
      </div>
    </div>
  );
});
