import type { Feature, FeatureCollection } from "geojson";
import { geoJSON, type Layer, type PathOptions } from "leaflet";
import { useEffect, useState } from "react";
import { GeoJSON, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";

// When the map's box changes size (a wider table beside it, the window
// resizing), Leaflet has to be told, or the map drifts off-centre.
function FitToBox() {
  const map = useMap();
  useEffect(() => {
    const box = map.getContainer();
    const watch = new ResizeObserver(() => map.invalidateSize());
    watch.observe(box);
    return () => watch.disconnect();
  }, [map]);
  return null;
}

// Zooms to one zone each time `n` changes (e.g. its name was clicked in a
// table), without animating when the user prefers less motion.
function ZoomToZone({ zones, target }: { zones: FeatureCollection | null; target: { id: number; n: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (!zones || !target) return;
    const f = zones.features.find((x) => x.properties?.location_id === target.id);
    if (!f) return;
    const bounds = geoJSON(f).getBounds();
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    map.flyToBounds(bounds, { maxZoom: 14, padding: [48, 48], duration: still ? 0 : 0.6, animate: !still });
  }, [map, zones, target?.n]);   // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// The view every map opens on: all five boroughs.
const HOME: [number, number] = [40.73, -73.94];
const HOME_ZOOM = 11;

// Flies back to that view each time `n` changes (e.g. after undoing changes).
function ResetView({ n }: { n: number }) {
  const map = useMap();
  useEffect(() => {
    if (!n) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    map.flyTo(HOME, HOME_ZOOM, { duration: still ? 0 : 0.6, animate: !still });
  }, [map, n]);
  return null;
}

import { api } from "../api";

// A straight line between two [lat, lon] points, e.g. from /zones/centroids.
export type MapLine = {
  from: [number, number];
  to: [number, number];
  weight: number;           // stroke width in pixels
  color?: string;
  tooltip?: string;
};

type Props = {
  // value per location_id; zones without a value are drawn grey
  values?: Record<number, number>;
  label?: string;
  onZoneClick?: (locationId: number) => void;
  // optional lines drawn above the zones (Flow Explorer); omit for none
  lines?: MapLine[];
  // values can be negative (imbalance): positive zones (more pickups than
  // drop-offs, so short of taxis) are drawn red, negative ones (taxis piling
  // up) blue, darker the further from zero
  diverging?: boolean;
  // a zone drawn with a thick outline, e.g. the origin of the flows shown
  selectedId?: number | null;
  // zones drawn with a dashed outline, e.g. the ones being compared
  markedIds?: number[];
  // a zone to zoom to; a new `n` zooms again (e.g. its name clicked twice)
  zoomTo?: { id: number; n: number } | null;
  // back to the whole-city view; a new number flies back again
  resetView?: number;
  height?: number;
};

const RGB = { scale: "230, 160, 0", short: "194, 56, 43", surplus: "42, 100, 184" };

// NYC taxi zone map shared by every page. Colour zones by passing values.
export default function ZoneMap({ values = {}, label = "value", onZoneClick, lines, diverging = false,
                                  selectedId = null, markedIds = [], zoomTo = null, resetView = 0, height }: Props) {
  const [zones, setZones] = useState<FeatureCollection | null>(null);
  useEffect(() => {
    api<FeatureCollection>("/zones/geojson").then(setZones).catch(console.error);
  }, []);

  const max = Math.max(1, ...Object.values(values).map(Math.abs));
  // Square root, so one very large zone (JFK) doesn't wash out all the others.
  const fill = (v: number) => {
    const strength = 0.12 + 0.88 * Math.sqrt(Math.abs(v) / max);
    if (!diverging) return `rgba(${RGB.scale}, ${strength})`;
    return `rgba(${v >= 0 ? RGB.short : RGB.surplus}, ${strength})`;
  };
  const style = (f?: Feature): PathOptions => {
    const id = f?.properties?.location_id;
    const v = values[id];
    const selected = id === selectedId;
    const marked = markedIds.includes(id);
    return {
      weight: selected ? 3 : marked ? 2.5 : 0.5,
      color: selected || marked ? "#1c1c1a" : "#555",
      dashArray: marked && !selected ? "5 4" : undefined,
      fillColor: v === undefined ? "#d9d7d0" : fill(v),
      fillOpacity: 0.8,
    };
  };
  const onEach = (f: Feature, layer: Layer) => {
    const id = f.properties?.location_id;
    const v = values[id];
    layer.bindTooltip(`${f.properties?.zone_name} (${f.properties?.borough})` +
      (v === undefined ? "" : `<br>${label}: ${v.toLocaleString()}`));
    if (onZoneClick) layer.on("click", () => onZoneClick(id));
  };

  return (
    // No wheel zoom: scrolling the page over the map would zoom it out instead
    // (the + and - buttons, double-click and pinch still zoom).
    <MapContainer center={HOME} zoom={HOME_ZOOM} className="map" style={height ? { height } : undefined}
                  scrollWheelZoom={false}>
      <FitToBox />
      <ZoomToZone zones={zones} target={zoomTo} />
      <ResetView n={resetView} />
      {/* greyed out in styles.css (.map .leaflet-tile-pane), so the zone colours stand out */}
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {zones && (
        // key forces a redraw when the values or the selected zone change
        <GeoJSON key={`${diverging}:${selectedId}:${markedIds.join(",")}:${JSON.stringify(values)}`} data={zones} style={style}
                 onEachFeature={onEach} />
      )}
      {lines && (
        // Own pane above the zones (overlayPane is 400), so the lines stay on
        // top when the GeoJSON layer is redrawn. Only created when lines is passed.
        <Pane name="flow-lines" style={{ zIndex: 450 }}>
          {lines.map((l, i) => (
            <Polyline key={`${i}:${l.to.join(",")}`} positions={[l.from, l.to]}
                      pathOptions={{ color: l.color ?? "#1f4fbf", weight: l.weight, opacity: 0.8, lineCap: "round" }}>
              {l.tooltip && <Tooltip sticky>{l.tooltip}</Tooltip>}
            </Polyline>
          ))}
        </Pane>
      )}
    </MapContainer>
  );
}
