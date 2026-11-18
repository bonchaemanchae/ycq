import type { Feature, FeatureCollection } from "geojson";
import type { Layer, PathOptions } from "leaflet";
import { useEffect, useState } from "react";
import { GeoJSON, MapContainer, Pane, Polyline, TileLayer, Tooltip } from "react-leaflet";
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
  height?: number;
};

const RGB = { scale: "230, 160, 0", short: "194, 56, 43", surplus: "42, 100, 184" };

// NYC taxi zone map shared by every page. Colour zones by passing values.
export default function ZoneMap({ values = {}, label = "value", onZoneClick, lines, diverging = false,
                                  selectedId = null, markedIds = [], height }: Props) {
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
    <MapContainer center={[40.73, -73.94]} zoom={11} className="map" style={height ? { height } : undefined}>
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
