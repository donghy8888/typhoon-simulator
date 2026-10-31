#!/usr/bin/env python3
"""
Regenerate js/mountain-data.js from elevation tiles + Natural Earth Range/mtn.

Requires: pyshp, shapely, numpy, Pillow; NE land + geography_regions_polys under /tmp/ne/
  curl -L -o /tmp/ne/ne_10m_land.zip https://naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip
  curl -L -o /tmp/ne/ne_10m_geography_regions_polys.zip \\
    https://naciscdn.org/naturalearth/10m/physical/ne_10m_geography_regions_polys.zip
  unzip -d /tmp/ne /tmp/ne/ne_10m_land.zip
  unzip -d /tmp/ne /tmp/ne/ne_10m_geography_regions_polys.zip

Elevation: Mapzen/AWS terrarium PNG tiles (WGS84 geographic extent per tile),
thresholded and polygonized, then unioned with selected NE 10m Range/mtn and
clipped to NE land — same datum/CRS as OSM Leaflet tiles.

Replaces hand-drawn MOUNTAIN_POLYS that did not match the basemap.
"""
from __future__ import annotations

import json
import math
import sys
import urllib.request
from pathlib import Path

try:
    import numpy as np
    import shapefile
    from PIL import Image
    from shapely import make_valid
    from shapely.geometry import Point, box, shape
    from shapely.ops import unary_union
except ImportError as e:
    sys.exit(f"Need pyshp+shapely+numpy+Pillow: {e}")

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "js" / "mountain-data.js"
LAND_SHP = Path("/tmp/ne/ne_10m_land.shp")
RANGE_SHP = Path("/tmp/ne/ne_10m_geography_regions_polys.shp")
TILE_DIR = Path("/tmp/ne/terrarium")

Z = 6
THRESH = 550.0
LON0, LON1, LAT0, LAT1 = 108.0, 148.0, 10.0, 42.0
SIMPLIFY = 0.025
NE_KEEP = {
    "Wuyi Mts.",
    "Nan Ling Mts.",
    "Dalou Mts.",
    "Central Highlands",
    "CHAÎNE ANNAMITIQUE",
    "Dabie Mts.",
}
TILE_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[float, float]:
    n = 2**z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def tile_bounds(x: int, y: int, z: int) -> tuple[float, float, float, float]:
    n = 2**z
    lon0 = x / n * 360.0 - 180.0
    lon1 = (x + 1) / n * 360.0 - 180.0

    def ty_to_lat(ty: float) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))

    return lon0, ty_to_lat(y + 1), lon1, ty_to_lat(y)


def iter_polys(g):
    if g.is_empty:
        return
    if g.geom_type == "Polygon":
        yield g
    elif g.geom_type == "MultiPolygon":
        for p in g.geoms:
            yield p
    elif g.geom_type == "GeometryCollection":
        for p in g.geoms:
            yield from iter_polys(p)


def download_tiles(tx0: int, tx1: int, ty0: int, ty1: int) -> None:
    TILE_DIR.mkdir(parents=True, exist_ok=True)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            dest = TILE_DIR / f"{Z}_{tx}_{ty}.png"
            if dest.exists():
                continue
            url = f"{TILE_BASE}/{Z}/{tx}/{ty}.png"
            print(f"fetch {url}")
            urllib.request.urlretrieve(url, dest)


def elev_union(tx0: int, tx1: int, ty0: int, ty1: int):
    parts = []
    step = 3
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            dest = TILE_DIR / f"{Z}_{tx}_{ty}.png"
            if not dest.exists():
                continue
            img = np.asarray(Image.open(dest).convert("RGB"), dtype=np.float64)
            elev = img[:, :, 0] * 256.0 + img[:, :, 1] + img[:, :, 2] / 256.0 - 32768.0
            mask = elev >= THRESH
            if not mask.any():
                continue
            m = mask[::step, ::step]
            lon0, lat0, lon1, lat1 = tile_bounds(tx, ty, Z)
            ys, xs = np.where(m)
            cell_w = (lon1 - lon0) / m.shape[1]
            cell_h = (lat1 - lat0) / m.shape[0]
            boxes = [
                box(
                    lon0 + c * cell_w,
                    lat1 - (r + 1) * cell_h,
                    lon0 + (c + 1) * cell_w,
                    lat1 - r * cell_h,
                )
                for r, c in zip(ys, xs)
            ]
            if boxes:
                parts.append(unary_union(boxes))
    if not parts:
        return box(0, 0, 0, 0)  # empty
    return make_valid(unary_union(parts)).simplify(0.03, preserve_topology=True)


def main() -> None:
    if not LAND_SHP.exists() or not RANGE_SHP.exists():
        sys.exit(f"Missing {LAND_SHP} or {RANGE_SHP}")

    x0, y1 = lonlat_to_tile(LON0, LAT0, Z)
    x1, y0 = lonlat_to_tile(LON1, LAT1, Z)
    tx0, tx1 = int(math.floor(x0)), int(math.floor(x1))
    ty0, ty1 = int(math.floor(y0)), int(math.floor(y1))
    download_tiles(tx0, tx1, ty0, ty1)

    clip = box(LON0, LAT0, LON1, LAT1)
    elev = make_valid(elev_union(tx0, tx1, ty0, ty1).intersection(clip))

    land_parts = []
    sf = shapefile.Reader(str(LAND_SHP))
    for sr in sf.iterShapeRecords():
        inter = make_valid(shape(sr.shape.__geo_interface__)).intersection(clip)
        if not inter.is_empty:
            land_parts.append(inter)
    land = make_valid(
        unary_union(land_parts).simplify(0.02, preserve_topology=True)
    )

    fields = [f[0] for f in shapefile.Reader(str(RANGE_SHP)).fields[1:]]
    sf2 = shapefile.Reader(str(RANGE_SHP))
    ne_parts = []
    for sr in sf2.iterShapeRecords():
        rec = dict(zip(fields, sr.record))
        if rec.get("FEATURECLA") != "Range/mtn":
            continue
        if rec.get("NAME") not in NE_KEEP:
            continue
        inter = make_valid(shape(sr.shape.__geo_interface__)).intersection(clip)
        if not inter.is_empty:
            ne_parts.append(inter)

    combined = make_valid(unary_union([elev] + ne_parts)).simplify(
        SIMPLIFY, preserve_topology=True
    )
    combined = make_valid(combined.intersection(land))

    final = []
    for p in iter_polys(combined):
        c = p.centroid
        islandish = (
            (119 < c.x < 132 and c.y < 34)
            or (108.5 < c.x < 111.5 and c.y < 20.5)
            or (119 < c.x < 122.5 and 21 < c.y < 26)
        )
        amin = 0.008 if islandish else 0.02
        if p.area >= amin:
            final.append(p)

    latlon, bboxes = [], []
    for p in sorted(final, key=lambda p: -p.area):
        ll = []
        for lon, lat in p.exterior.coords:
            pt = [round(lat, 4), round(lon, 4)]
            if not ll or pt != ll[-1]:
                ll.append(pt)
        if len(ll) < 4:
            continue
        lats = [x[0] for x in ll]
        lons = [x[1] for x in ll]
        latlon.append(ll)
        bboxes.append([min(lons), min(lats), max(lons), max(lats)])

    js = (
        "/** Auto-generated mountain polygons (WGS84), same CRS as OSM basemap.\n"
        f" * terrarium elev>={THRESH:.0f}m (z{Z}) ∪ NE 10m Range/mtn (Wuyi/Nan Ling/…),\n"
        f" * clipped to NE land & basin {LON0}–{LON1}E / {LAT0}–{LAT1}N.\n"
        " * Regenerated by scripts/build-mountain-mask.py */\n"
        "(function (global) {\n"
        "  'use strict';\n"
        f"  const MOUNTAIN_POLYS = {json.dumps(latlon, separators=(',', ':'))};\n"
        f"  const MOUNTAIN_BBOXES = {json.dumps(bboxes, separators=(',', ':'))};\n"
        "  global.TY_MOUNTAIN_MASK = { MOUNTAIN_POLYS: MOUNTAIN_POLYS, MOUNTAIN_BBOXES: MOUNTAIN_BBOXES,\n"
        f'    source: "terrarium elev>={THRESH:.0f}m + NE 10m Range/mtn / WGS84" }};\n'
        "})(typeof window !== \"undefined\" ? window : globalThis);\n"
    )
    OUT.write_text(js)
    print(
        f"wrote {OUT} rings={len(latlon)} verts={sum(len(r) for r in latlon)} "
        f"bytes={OUT.stat().st_size}"
    )


if __name__ == "__main__":
    main()
