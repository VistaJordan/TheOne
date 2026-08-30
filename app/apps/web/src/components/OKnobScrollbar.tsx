import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

/** The "O knob" scrollbar (design option 1c): the target element hides its
    native bar in CSS and this overlay draws the replacement — the logo's "O"
    ring riding a hairline node line. It is a pointer affordance only; wheel,
    trackpad and keyboard keep scrolling the element natively, which is why the
    rail stays aria-hidden. Render it as a sibling of the scroll element inside
    a `position: relative` wrapper. */
export function OKnobScrollbar({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const railRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  /** Pointer-to-knob-centre offset while dragging, so grabbing the knob off
      centre does not make it jump under the pointer. */
  const grab = useRef(0);

  useEffect(() => {
    const sc = scrollRef.current;
    const rail = railRef.current;
    const tr = trackRef.current;
    const th = thumbRef.current;
    if (!sc || !rail || !tr || !th) return;

    let raf = 0;
    const sync = () => {
      raf = 0;
      const max = sc.scrollHeight - sc.clientHeight;
      rail.hidden = max <= 1; // nothing to scroll — no rail at all
      if (rail.hidden) return;
      const range = tr.clientHeight - th.offsetHeight;
      th.style.top = `${(sc.scrollTop / max) * range}px`;
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(sync);
    };

    sync();
    sc.addEventListener('scroll', queue, { passive: true });
    // The element resizes with the window, but its scrollHeight moves when the
    // CONTENT does — observe both, re-collecting the children whenever a route
    // swap replaces them.
    const ro = new ResizeObserver(queue);
    const observeChildren = () => {
      ro.disconnect();
      ro.observe(sc);
      for (const el of Array.from(sc.children)) ro.observe(el);
    };
    observeChildren();
    const mo = new MutationObserver(() => {
      observeChildren();
      queue();
    });
    mo.observe(sc, { childList: true });

    return () => {
      sc.removeEventListener('scroll', queue);
      ro.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef]);

  const scrollToPointer = (clientY: number) => {
    const sc = scrollRef.current;
    const tr = trackRef.current;
    const th = thumbRef.current;
    if (!sc || !tr || !th) return;
    const range = tr.clientHeight - th.offsetHeight;
    if (range <= 0) return;
    const rect = tr.getBoundingClientRect();
    const p = Math.min(
      1,
      Math.max(0, (clientY - grab.current - rect.top - th.offsetHeight / 2) / range),
    );
    sc.scrollTop = p * (sc.scrollHeight - sc.clientHeight);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    const th = thumbRef.current;
    if (!rail || !th || e.button !== 0) return;
    e.preventDefault(); // keeps the drag from starting a text selection
    // A grab on the knob holds the pointer where it landed on it; a press on
    // the line jumps the knob's centre to the pointer instead.
    grab.current = th.contains(e.target as Node)
      ? e.clientY - th.getBoundingClientRect().top - th.offsetHeight / 2
      : 0;
    rail.setPointerCapture(e.pointerId);
    rail.classList.add('is-dragging');
    scrollToPointer(e.clientY);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (railRef.current?.hasPointerCapture(e.pointerId)) scrollToPointer(e.clientY);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail) return;
    if (rail.hasPointerCapture(e.pointerId)) rail.releasePointerCapture(e.pointerId);
    rail.classList.remove('is-dragging');
  };

  return (
    <div
      className="oknob is-y"
      ref={railRef}
      aria-hidden="true"
      hidden
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="oknob-track" ref={trackRef}>
        <span className="oknob-line" />
        <span className="oknob-node is-top" />
        <span className="oknob-node is-end" />
        <div className="oknob-thumb" ref={thumbRef} />
      </div>
    </div>
  );
}
