/* The map canvas shared by the technician map on a work order and the
   Vendors › Coverage map (0057). MapLibre GL over OpenFreeMap vector tiles
   (keyless): Positron in the day theme, Dark at night.

   Loaded lazily (React.lazy in the callers) — the map library is the single
   heaviest thing in the app and most sessions never open a map.

   Colours come from the --map-* tokens (theme/tokens.css), read off :root
   here because a canvas cannot resolve var(). The parent remounts the map
   (key = theme) when the theme flips, which re-reads them.

   A VR vendor is a filled dot; a technician is a ring; a blacklisted record
   is grey. A halo ring marks "preferred" or "hired". The work order's own
   place is the dark pin with the search-radius ring around it. */

import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { boundsOf, circleRing, spreadOverlaps } from '../../lib/mapPoints';

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  /** Palette slot 1–16 (the trade), 0 = other. */
  slot: number;
  kind: 'vendor' | 'tech';
  blacklisted?: boolean;
  /** Preferred for this work order, or hired on it. */
  marked?: boolean;
}

interface VendorMapProps {
  theme: 'day' | 'night';
  points: MapPoint[];
  /** The work order's place; absent on the coverage map. */
  center?: { lat: number; lng: number } | null;
  radiusMiles?: number;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Changes when the view should re-frame (a new search, a new filter set). */
  fitKey: string;
}

const STYLE = {
  day: 'https://tiles.openfreemap.org/styles/positron',
  night: 'https://tiles.openfreemap.org/styles/dark',
} as const;

const US_BOUNDS: [[number, number], [number, number]] = [[-125, 24.5], [-66.5, 49.5]];

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function palette(): { slots: string[]; other: string; center: string; ring: string; halo: string; blacklist: string } {
  return {
    slots: Array.from({ length: 16 }, (_, i) => token(`--map-${i + 1}`, '#2563eb')),
    other: token('--map-other', '#6b7280'),
    center: token('--map-center', '#111827'),
    ring: token('--map-ring', '#1a9fd4'),
    halo: token('--map-halo', '#ffffff'),
    blacklist: token('--map-blacklist', '#9ca3af'),
  };
}

type FC = FeatureCollection;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };

export default function VendorMap({ theme, points, center, radiusMiles, selectedId, onSelect, fitKey }: VendorMapProps) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const readyRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const colors = useMemo(() => palette(), [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  const spread = useMemo(() => spreadOverlaps(points), [points]);

  const pointData = useMemo<FC>(
    () => ({
      type: 'FeatureCollection',
      features: spread.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          id: p.id,
          color: p.blacklisted ? colors.blacklist : p.slot > 0 ? colors.slots[p.slot - 1] : colors.other,
          tech: p.kind === 'tech' ? 1 : 0,
          marked: p.marked ? 1 : 0,
        },
      })),
    }),
    [spread, colors],
  );

  const selectedData = useMemo<FC>(() => {
    const p = spread.find((x) => x.id === selectedId);
    return p
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: {} }] }
      : EMPTY;
  }, [spread, selectedId]);

  const centerData = useMemo<{ pin: FC; ring: FC }>(() => {
    if (!center) return { pin: EMPTY, ring: EMPTY };
    return {
      pin: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [center.lng, center.lat] }, properties: {} }] },
      ring: radiusMiles
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleRing(center, radiusMiles)] }, properties: {} }] }
        : EMPTY,
    };
  }, [center, radiusMiles]);

  // Latest data, for the load handler (which runs once, later).
  const latest = useRef({ pointData, selectedData, centerData });
  latest.current = { pointData, selectedData, centerData };

  const frame = (animate: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const opts = { padding: 48, maxZoom: 12, duration: animate ? 500 : 0 };
    if (center && radiusMiles) {
      const b = boundsOf(circleRing(center, radiusMiles, 16).map(([lng, lat]) => ({ lat, lng })));
      if (b) map.fitBounds(b, opts);
      return;
    }
    const b = boundsOf(spread);
    if (b) map.fitBounds(b, opts);
    else map.fitBounds(US_BOUNDS, { ...opts, padding: 16 });
  };
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // ── Create the map once ────────────────────────────────────────────────────
  useEffect(() => {
    if (!holder.current) return;
    const map = new maplibregl.Map({
      container: holder.current,
      style: STYLE[theme],
      bounds: US_BOUNDS,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('load', () => {
      const d = latest.current;
      map.addSource('ring', { type: 'geojson', data: d.centerData.ring });
      map.addSource('center', { type: 'geojson', data: d.centerData.pin });
      map.addSource('points', { type: 'geojson', data: d.pointData, cluster: true, clusterRadius: 42, clusterMaxZoom: 9 });
      map.addSource('selected', { type: 'geojson', data: d.selectedData });

      map.addLayer({ id: 'ring-fill', type: 'fill', source: 'ring', paint: { 'fill-color': colors.ring, 'fill-opacity': 0.06 } });
      map.addLayer({ id: 'ring-line', type: 'line', source: 'ring', paint: { 'line-color': colors.ring, 'line-width': 1.5, 'line-dasharray': [3, 2] } });

      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'points',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': colors.ring,
          'circle-opacity': 0.9,
          'circle-radius': ['step', ['get', 'point_count'], 15, 20, 19, 100, 24],
          'circle-stroke-color': colors.halo,
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'points',
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 12 },
        paint: { 'text-color': colors.halo },
      });
      // Preferred / hired: a ring outside the mark.
      map.addLayer({
        id: 'marked',
        type: 'circle',
        source: 'points',
        filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'marked'], 1]],
        paint: { 'circle-radius': 12, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': colors.center, 'circle-stroke-width': 1.5 },
      });
      // VR vendors: filled dots.
      map.addLayer({
        id: 'vendors',
        type: 'circle',
        source: 'points',
        filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'tech'], 0]],
        paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': colors.halo, 'circle-stroke-width': 2 },
      });
      // Technicians: rings.
      map.addLayer({
        id: 'techs',
        type: 'circle',
        source: 'points',
        filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'tech'], 1]],
        paint: { 'circle-radius': 5.5, 'circle-color': colors.halo, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3.5 },
      });
      map.addLayer({
        id: 'selected',
        type: 'circle',
        source: 'selected',
        paint: { 'circle-radius': 15, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': colors.center, 'circle-stroke-width': 3 },
      });
      map.addLayer({
        id: 'center',
        type: 'circle',
        source: 'center',
        paint: { 'circle-radius': 7, 'circle-color': colors.center, 'circle-stroke-color': colors.halo, 'circle-stroke-width': 3 },
      });

      for (const layer of ['vendors', 'techs', 'marked']) {
        map.on('click', layer, (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (typeof id === 'string') onSelectRef.current?.(id);
        });
      }
      map.on('click', 'clusters', async (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const src = map.getSource('points') as GeoJSONSource;
        const zoom = await src.getClusterExpansionZoom(f.properties?.cluster_id);
        map.easeTo({ center: (f.geometry as Point).coordinates as [number, number], zoom: zoom + 0.5 });
      });
      for (const layer of ['vendors', 'techs', 'clusters', 'marked']) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }
      readyRef.current = true;
      frameRef.current(false);
    });

    // The sheet the map sits in animates open; keep the canvas the right size.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(holder.current);
    return () => {
      ro.disconnect();
      readyRef.current = false;
      mapRef.current = null;
      map.remove();
    };
    // The parent remounts on a theme change; nothing else recreates the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Keep the sources current ───────────────────────────────────────────────
  useEffect(() => {
    if (!readyRef.current) return;
    (mapRef.current?.getSource('points') as GeoJSONSource | undefined)?.setData(pointData);
  }, [pointData]);

  useEffect(() => {
    if (!readyRef.current) return;
    (mapRef.current?.getSource('center') as GeoJSONSource | undefined)?.setData(centerData.pin);
    (mapRef.current?.getSource('ring') as GeoJSONSource | undefined)?.setData(centerData.ring);
  }, [centerData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!readyRef.current || !map) return;
    (map.getSource('selected') as GeoJSONSource | undefined)?.setData(selectedData);
    const f = selectedData.features[0];
    if (f) {
      const [lng, lat] = (f.geometry as Point).coordinates;
      // Bring a selection made from the list into view; leave the zoom alone
      // unless it is still clustered.
      if (!map.getBounds().contains([lng, lat]) || map.getZoom() < 9.5) {
        map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 10.5), duration: 450 });
      }
    }
  }, [selectedData]);

  useEffect(() => {
    if (readyRef.current) frameRef.current(true);
  }, [fitKey]);

  // The library puts position: relative on its own container, so the box that
  // fills the parent is a wrapper and the map sits inside it at 100%.
  return (
    <div className="vmap-canvas">
      <div ref={holder} className="vmap-gl" role="application" aria-label="Map" />
    </div>
  );
}
