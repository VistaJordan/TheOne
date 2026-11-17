/* A box to sign in with a finger, a pen or a mouse (0156, the sign-off form).
 *
 * The strokes are kept as points in CSS pixels, so the canvas can be redrawn
 * sharp at any size (a phone turned sideways resizes it). `toPngBase64` hands
 * back the signature cropped to its ink, on a transparent background, at twice
 * its on-screen size — what the API embeds in the signed PDF.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

export interface SignaturePadHandle {
  clear: () => void;
  isEmpty: () => boolean;
  /** base64 PNG (no data: prefix), or null when nothing was drawn. */
  toPngBase64: () => string | null;
}

type Pt = { x: number; y: number };

/** The ink: the same dark navy the signed PDF prints it in. */
const INK = '#141a28';
const WIDTH = 2.6;

function drawStroke(ctx: CanvasRenderingContext2D, pts: Pt[], scale: number, dx = 0, dy = 0): void {
  if (pts.length === 0) return;
  ctx.beginPath();
  const p0 = pts[0];
  if (pts.length === 1) {
    ctx.arc((p0.x - dx) * scale, (p0.y - dy) * scale, (WIDTH / 2) * scale, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo((p0.x - dx) * scale, (p0.y - dy) * scale);
  // Through the midpoints: smooth curves instead of a polyline.
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    ctx.quadraticCurveTo((a.x - dx) * scale, (a.y - dy) * scale, ((a.x + b.x) / 2 - dx) * scale, ((a.y + b.y) / 2 - dy) * scale);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo((last.x - dx) * scale, (last.y - dy) * scale);
  ctx.stroke();
}

function prep(ctx: CanvasRenderingContext2D, scale: number): void {
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = WIDTH * scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

export const SignaturePad = forwardRef<SignaturePadHandle, { onChange?: (empty: boolean) => void; label: string; className?: string }>(
  function SignaturePad({ onChange, label, className }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const strokes = useRef<Pt[][]>([]);
    const drawing = useRef<Pt[] | null>(null);

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      prep(ctx, dpr);
      for (const s of strokes.current) drawStroke(ctx, s, dpr);
    }, []);

    useEffect(() => {
      redraw();
      const canvas = canvasRef.current;
      if (!canvas || typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => redraw());
      ro.observe(canvas);
      return () => ro.disconnect();
    }, [redraw]);

    const point = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
      const r = e.currentTarget.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const s = [point(e)];
      drawing.current = s;
      strokes.current.push(s);
      redraw();
      onChange?.(false);
    };
    const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawing.current) return;
      e.preventDefault();
      const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
      const r = e.currentTarget.getBoundingClientRect();
      if (events.length) for (const ev of events) drawing.current.push({ x: ev.clientX - r.left, y: ev.clientY - r.top });
      else drawing.current.push(point(e));
      redraw();
    };
    const onUp = () => { drawing.current = null; };

    useImperativeHandle(ref, () => ({
      clear: () => {
        strokes.current = [];
        drawing.current = null;
        redraw();
        onChange?.(true);
      },
      isEmpty: () => strokes.current.length === 0,
      toPngBase64: () => {
        const all = strokes.current.flat();
        if (all.length === 0) return null;
        const pad = WIDTH * 2;
        const minX = Math.min(...all.map((p) => p.x)) - pad;
        const minY = Math.min(...all.map((p) => p.y)) - pad;
        const maxX = Math.max(...all.map((p) => p.x)) + pad;
        const maxY = Math.max(...all.map((p) => p.y)) + pad;
        const w = Math.max(1, maxX - minX);
        const h = Math.max(1, maxY - minY);
        const scale = Math.min(2, 1400 / w);
        const out = document.createElement('canvas');
        out.width = Math.ceil(w * scale);
        out.height = Math.ceil(h * scale);
        const ctx = out.getContext('2d');
        if (!ctx) return null;
        prep(ctx, scale);
        for (const s of strokes.current) drawStroke(ctx, s, scale, minX, minY);
        return out.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
      },
    }), [onChange, redraw]);

    return (
      <canvas
        ref={canvasRef}
        className={className}
        role="img"
        aria-label={label}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onUp}
      />
    );
  },
);
