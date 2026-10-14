"""Load boroughs, taxi zones and zone shapes.

The shapefile is in New York State Plane feet (EPSG:2263); PostGIS converts it
to lat/long (EPSG:4326) on load. Zones 264 and 265 have no shape.
"""
import csv
import json

import shapefile  # pyshp

from common import DATA, pg_connect

LOOKUP_CSV = DATA / "zones" / "taxi_zone_lookup.csv"
SHAPEFILE = DATA / "zones" / "taxi_zones.shp"


def main() -> None:
    with LOOKUP_CSV.open(newline="", encoding="utf-8") as f:
        zones = [
            (int(r["LocationID"]), r["Borough"], r["Zone"], r["service_zone"] or None)
            for r in csv.DictReader(f)
        ]

    reader = shapefile.Reader(str(SHAPEFILE))
    shapes = [
        (int(sr.record["LocationID"]), json.dumps(sr.shape.__geo_interface__))
        for sr in reader.iterShapeRecords()
    ]

    with pg_connect() as conn, conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO borough (name) VALUES (%s) ON CONFLICT (name) DO NOTHING",
            [(b,) for b in sorted({z[1] for z in zones})],
        )
        cur.executemany(
            """
            INSERT INTO taxi_zone (location_id, borough_id, zone_name, service_zone)
            VALUES (%s, (SELECT borough_id FROM borough WHERE name = %s), %s, %s)
            ON CONFLICT (location_id) DO UPDATE
               SET borough_id = EXCLUDED.borough_id,
                   zone_name = EXCLUDED.zone_name,
                   service_zone = EXCLUDED.service_zone
            """,
            zones,
        )

        cur.execute("CREATE TEMP TABLE zone_shape_raw (location_id smallint, geojson text)")
        with cur.copy("COPY zone_shape_raw (location_id, geojson) FROM STDIN") as copy:
            for row in shapes:
                copy.write_row(row)
        # Union in case a zone is ever split over several records.
        cur.execute(
            """
            UPDATE taxi_zone z
               SET geom = s.geom
              FROM (
                  SELECT location_id,
                         ST_Multi(ST_Union(ST_MakeValid(ST_Transform(
                             ST_SetSRID(ST_GeomFromGeoJSON(geojson), 2263), 4326))))::geometry(MultiPolygon, 4326) AS geom
                  FROM zone_shape_raw
                  GROUP BY location_id
              ) s
             WHERE z.location_id = s.location_id
            """
        )
        cur.execute(
            "SELECT count(*), count(geom) FROM taxi_zone"
        )
        total, with_shape = cur.fetchone()
    print(f"zones: {total} loaded, {with_shape} with a map shape")


if __name__ == "__main__":
    main()
