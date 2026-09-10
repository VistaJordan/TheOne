/** The "O knob" scrollbar, app-wide (design option 1c). Every native bar is
    hidden in CSS (app.css); this manager watches the DOM for any element whose
    computed overflow can scroll — filter popovers, menus, modal bodies, the
    global-search panel, the sidebar — and mounts the replacement rail inside
    it: the logo's "O" ring riding a hairline node line, one rail per axis.

    The rail is ABSOLUTELY positioned inside the scroller (so it stacks with
    its own surface — a popover's rail rides above the canvas, the canvas rail
    stays under popovers) and is re-pinned to the visible corner on every
    scroll/resize. It is inserted as the FIRST child: nothing in the app keys
    styles off :first-child, while several row lists key off :last-child.

    The canvas keeps its own sibling rail (components/OKnobScrollbar.tsx) —
    a rail outside the scroller never lags a composited scroll — and opts out
    of the manager with data-oknob-own. Textareas can't host child rails and
    keep a thin native bar instead (see app.css). */

const KNOB = 18; // knob diameter; also the rail's cross size
const KNOB_SM = 14; // compact knob for short containers (menus, strips)
const SM_AT = 240; // containers shorter than this use the compact knob
const EDGE = 2; // gap between the rail and the container edge
const INSET = 4; // gap between the rail's ends and the container corners

type Axis = 'x' | 'y';

interface Rail {
  root: HTMLDivElement;
  track: HTMLElement;
  thumb: HTMLElement;
}

interface Binding {
  el: HTMLElement;
  y?: Rail;
  x?: Rail;
  off: () => void;
}

const bound = new Map<HTMLElement, Binding>();
let raf = 0;

function makeRail(axis: Axis): Rail {
  const root = document.createElement('div');
  root.className = `oknob is-${axis} oknob-in`;
  root.setAttribute('aria-hidden', 'true'); // pointer affordance only — wheel
  root.hidden = true; //   and keyboard still scroll the element natively
  root.innerHTML =
    '<div class="oknob-track">' +
    '<span class="oknob-line"></span>' +
    '<span class="oknob-node is-top"></span>' +
    '<span class="oknob-node is-end"></span>' +
    '<div class="oknob-thumb"></div>' +
    '</div>';
  const track = root.firstElementChild as HTMLElement;
  const thumb = track.lastElementChild as HTMLElement;
  return { root, track, thumb };
}

function syncAxis(el: HTMLElement, rail: Rail, axis: Axis, both: boolean) {
  const y = axis === 'y';
  const max = y ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  rail.root.hidden = max <= 1; // nothing to scroll — no rail at all
  if (rail.root.hidden) return;

  const sm = el.clientHeight < SM_AT;
  rail.root.classList.toggle('is-sm', sm);
  const k = sm ? KNOB_SM : KNOB;

  // Re-pin the rail to the visible corner: absolute children of a scroller
  // live in its content coordinates, so the current scroll offsets are baked
  // into the geometry on every sync.
  const s = rail.root.style;
  if (y) {
    s.left = `${el.scrollLeft + el.clientWidth - k - EDGE}px`;
    s.top = `${el.scrollTop + INSET}px`;
    s.width = `${k}px`;
    s.height = `${el.clientHeight - 2 * INSET - (both ? k : 0)}px`;
  } else {
    s.top = `${el.scrollTop + el.clientHeight - k - EDGE}px`;
    s.left = `${el.scrollLeft + INSET}px`;
    s.height = `${k}px`;
    s.width = `${el.clientWidth - 2 * INSET - (both ? k : 0)}px`;
  }

  const th = rail.thumb;
  const range = (y ? rail.track.clientHeight : rail.track.clientWidth) -
    (y ? th.offsetHeight : th.offsetWidth);
  const p = (y ? el.scrollTop : el.scrollLeft) / max;
  th.style[y ? 'top' : 'left'] = `${p * range}px`;
}

function sync(b: Binding) {
  if (b.y) syncAxis(b.el, b.y, 'y', !!b.x && !b.x.root.hidden);
  if (b.x) syncAxis(b.el, b.x, 'x', !!b.y && !b.y.root.hidden);
}

function wireDrag(el: HTMLElement, rail: Rail, axis: Axis) {
  const y = axis === 'y';
  const { root, track, thumb } = rail;
  /** Pointer-to-knob-centre offset while dragging, so grabbing the knob off
      centre does not make it jump under the pointer. */
  let grab = 0;

  const toPointer = (c: number) => {
    const size = y ? thumb.offsetHeight : thumb.offsetWidth;
    const range = (y ? track.clientHeight : track.clientWidth) - size;
    if (range <= 0) return;
    const r = track.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (c - grab - (y ? r.top : r.left) - size / 2) / range));
    if (y) el.scrollTop = p * (el.scrollHeight - el.clientHeight);
    else el.scrollLeft = p * (el.scrollWidth - el.clientWidth);
  };

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // keeps the drag from starting a text selection
    e.stopPropagation(); // and from reaching the surface underneath
    // A grab on the knob holds the pointer where it landed on it; a press on
    // the line jumps the knob's centre to the pointer instead.
    const tr = thumb.getBoundingClientRect();
    grab = thumb.contains(e.target as Node)
      ? (y ? e.clientY - tr.top : e.clientX - tr.left) -
        (y ? thumb.offsetHeight : thumb.offsetWidth) / 2
      : 0;
    root.setPointerCapture(e.pointerId);
    root.classList.add('is-dragging');
    toPointer(y ? e.clientY : e.clientX);
  });
  root.addEventListener('pointermove', (e) => {
    if (root.hasPointerCapture(e.pointerId)) toPointer(y ? e.clientY : e.clientX);
  });
  const up = (e: PointerEvent) => {
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    root.classList.remove('is-dragging');
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  // The capture retargets the release click onto the rail — keep it from
  // bubbling into row/backdrop click handlers.
  root.addEventListener('click', (e) => e.stopPropagation());
}

function maybeBind(el: Element) {
  if (!(el instanceof HTMLElement)) return;
  if (bound.has(el) || el.closest('.oknob') || el.hasAttribute('data-oknob-own')) return;
  // Elements that cannot host child rails (see app.css for their fallback).
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;

  const cs = getComputedStyle(el);
  const wantY = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
  const wantX = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
  if (!wantY && !wantX) return;

  // The rail positions against the scroller's own box.
  if (cs.position === 'static') el.style.position = 'relative';

  const b: Binding = { el, off: () => {} };
  if (wantY) {
    b.y = makeRail('y');
    wireDrag(el, b.y, 'y');
  }
  if (wantX) {
    b.x = makeRail('x');
    wireDrag(el, b.x, 'x');
  }
  // First child — see the header comment on :last-child row styling.
  for (const rail of [b.x, b.y]) if (rail) el.insertBefore(rail.root, el.firstChild);

  const onScroll = () => sync(b); // synchronous: the rail re-pins in the same
  el.addEventListener('scroll', onScroll, { passive: true }); //   frame
  const ro = new ResizeObserver(schedule);
  ro.observe(el);
  b.off = () => {
    el.removeEventListener('scroll', onScroll);
    ro.disconnect();
  };
  bound.set(el, b);
  sync(b);
}

function flush() {
  raf = 0;
  for (const b of bound.values()) {
    if (!b.el.isConnected) {
      b.off();
      bound.delete(b.el);
    } else {
      sync(b);
    }
  }
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(flush);
}

/** Call once at boot. Watches the whole document: anything scrollable that
    ever mounts — route swaps, popovers, modals — gets its rails. */
export function initOKnob() {
  const scan = (root: Element) => {
    maybeBind(root);
    for (const el of root.querySelectorAll('*')) maybeBind(el);
  };
  scan(document.body);
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (n.nodeType === 1) scan(n as Element);
    }
    // Content changes move scrollHeights — re-sync everything (cheap: the
    // bound set is a handful of elements).
    schedule();
  });
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  // Late image/font loads change scrollHeights without a DOM mutation.
  document.addEventListener('load', schedule, true);
}
