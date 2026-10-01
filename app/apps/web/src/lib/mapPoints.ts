/* Pure helpers for the vendor maps (0057) — no map library, no DOM, so they can
   be unit-tested (tests/vendors.test.ts). */

export interface SpreadPoint {
  id: string;
  lat: number;
  lng: number;
}

/**
 * Vendors are placed at the centre of their city, so everyone in one city
 * lands on the same point and only the top dot could ever be clicked. This
 * fans a stack out on a small spiral (the first stays put), a few hundred
 * metres per step — invisible at the zoom a 100-mile search opens at, and a
 * clickable cluster of dots once zoomed in. Deterministic: sorted by id, so a
 * dot does not jump between two loads.
 */
export function spreadOverlaps<T extends SpreadPoint>(points: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const p of points) {
    const k = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  const out: T[] = [];
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    const sorted = [...g].sort((a, b) => a.id.localeCompare(b.id));
    sorted.forEach((p, i) => {
      if (i === 0) {
        out.push(p);
        return;
      }
      // ~350 m per ring step; longitude degrees shrink with latitude.
      const r = 0.0032 * Math.sqrt(i);
      const a = i * GOLDEN;
      out.push({
        ...p,
        lat: p.lat + r * Math.sin(a),
        lng: p.lng + (r * Math.cos(a)) / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180)),
      });
    });
  }
  return out;
}

/** A closed ring of [lng, lat] `miles` around a point — the search radius. */
export function circleRing(center: { lat: number; lng: number }, miles: number, steps = 72): [number, number][] {
  const out: [number, number][] = [];
  const dLat = miles / 69.0;
  const dLng = miles / (69.0 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    out.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return out;
}

/** [[west, south], [east, north]] of a set of points, or null when empty. */
export function boundsOf(points: { lat: number; lng: number }[]): [[number, number], [number, number]] | null {
  if (points.length === 0) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of points) {
    if (p.lng < w) w = p.lng;
    if (p.lng > e) e = p.lng;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  return [[w, s], [e, n]];
}

/** The palette slot of a trade: its place in the trade list, 1-based; 0 = other. */
export function tradeSlot(trade: string | null | undefined, trades: string[]): number {
  if (!trade) return 0;
  const i = trades.findIndex((t) => t.toLowerCase() === trade.toLowerCase());
  return i >= 0 && i < 16 ? i + 1 : 0;
}
