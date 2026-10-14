-- Geography: boroughs and taxi zones (shapes in WGS84 lat/long).
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS borough (
    borough_id   smallserial PRIMARY KEY,
    name         text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS taxi_zone (
    location_id   smallint PRIMARY KEY,
    borough_id    smallint NOT NULL REFERENCES borough,
    zone_name     text NOT NULL,          -- not unique (56 and 57 are both "Corona")
    service_zone  text,
    geom          geometry(MultiPolygon, 4326)  -- NULL for 264 Unknown and 265 Outside NYC
);

CREATE INDEX IF NOT EXISTS taxi_zone_geom_gist ON taxi_zone USING gist (geom);
CREATE INDEX IF NOT EXISTS taxi_zone_borough_idx ON taxi_zone (borough_id);
