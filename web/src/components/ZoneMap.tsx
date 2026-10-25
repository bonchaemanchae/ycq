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
  // values can be negative (Activity Dashboard imbalance): positive zones are
  // drawn green, negative ones red, darker the further from zero
  diverging?: boolean;
};

// NYC taxi zone map shared by every page. Colour zones by passing values.
export default function ZoneMap({ values = {}, label = "value", onZoneClick, lines, diverging = false }: Props) {
  const [zones, setZones] = useState<FeatureCollection | null>(null);
  useEffect(() => {
    api<FeatureCollection>("/zones/geojson").then(setZones).catch(console.error);
  }, []);

  const max = Math.max(1, ...Object.values(values).map(Math.abs));
  const fill = (v: number) => {
    const strength = 0.15 + 0.85 * (Math.abs(v) / max);
    if (!diverging) return `rgba(230, 160, 0, ${strength})`;
    return v >= 0 ? `rgba(27, 138, 82, ${strength})` : `rgba(194, 56, 43, ${strength})`;
  };
  const style = (f?: Feature): PathOptions => {
    const v = values[f?.properties?.location_id];
    return {
      weight: 0.5,
      color: "#555",
      fillColor: v === undefined ? "#ccc" : fill(v),
      fillOpacity: 0.8,
    };
  };
  const onEach = (f: Feature, layer: Layer) => {
    const id = f.properties?.location_id;
    const v = values[id];
    layer.bindTooltip(`${f.properties?.zone_name} (${f.properties?.borough})` +
      (v === undefined ? "" : `<br>${label}: ${v}`));
    if (onZoneClick) layer.on("click", () => onZoneClick(id));
  };

  return (
    <MapContainer center={[40.73, -73.94]} zoom={11} className="map">
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {zones && (
        // key forces a redraw when the values change
        <GeoJSON key={`${diverging}:${JSON.stringify(values)}`} data={zones} style={style} onEachFeature={onEach} />
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
