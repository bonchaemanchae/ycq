"""Zones and boroughs, plus zone shapes as GeoJSON for the map."""
from fastapi import APIRouter, Depends
from psycopg.rows import dict_row

from ..db import get_pg

router = APIRouter(tags=["zones"])


@router.get("/boroughs")
def boroughs(conn=Depends(get_pg)):
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(
            """SELECT b.borough_id, b.name FROM borough b
               WHERE EXISTS (SELECT 1 FROM taxi_zone z
                             WHERE z.borough_id = b.borough_id AND z.geom IS NOT NULL)
               ORDER BY b.name""").fetchall()


@router.get("/zones")
def zones(conn=Depends(get_pg)):
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(
            """SELECT z.location_id, z.zone_name, z.service_zone, b.name AS borough
               FROM taxi_zone z JOIN borough b USING (borough_id)
               WHERE z.geom IS NOT NULL
               ORDER BY z.location_id""").fetchall()


@router.get("/zones/geojson")
def zones_geojson(conn=Depends(get_pg)):
    """All zone shapes, simplified (~50 m) so the whole city is a small download."""
    return conn.execute(
        """SELECT json_build_object(
               'type', 'FeatureCollection',
               'features', json_agg(json_build_object(
                   'type', 'Feature',
                   'id', z.location_id,
                   'properties', json_build_object(
                       'location_id', z.location_id, 'zone_name', z.zone_name,
                       'borough', b.name),
                   'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(z.geom, 0.0005), 5)::json)
                   ORDER BY z.location_id))
           FROM taxi_zone z JOIN borough b USING (borough_id)
           WHERE z.geom IS NOT NULL""").fetchone()[0]
