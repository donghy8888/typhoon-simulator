#!/usr/bin/env python3
"""
Regenerate js/mountain-data.js aligned to OSM (WGS84).

Fixes vs elev≥550 z6 full-basin and vs NE southern Range blobs:
  - Full-basin low-threshold elev painted Loess/plateaus + clip walls.
  - NE 10m Nan Ling / Wuyi polys are coarse blobs that sit on plains.
  - Taiwan needs ridge-only (中央山脉), not the whole island.

Approach:
  1. Terrarium elev, contour-polygonized (skimage), mercator-correct:
       • Taiwan z8 ≥800m  (ridge / east-central only)
       • South China z8 ≥550m (武夷/南岭/闽西 actual terrain)
       • Japan / PH / KR / Hainan / Changbai z7 ≥550m
  2. NE 10m Range/mtn only NORTH of ~31.5N (Taihang/Qinling/Dabie/…)
     — never Nan Ling / Wuyi (too blocky for OSM).
  3. ∩ NE land ∩ inset basin clip (no domain-edge walls).
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
    from shapely.geometry import Polygon, box, shape
    from shapely.ops import unary_union
    from skimage import measure
except ImportError as e:
    sys.exit(f"Need pyshp+shapely+numpy+Pillow+skimage: {e}")

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "js" / "mountain-data.js"
LAND_SHP = Path("/tmp/ne/ne_10m_land.shp")
RANGE_SHP = Path("/tmp/ne/ne_10m_geography_regions_polys.shp")
TILE_DIR = Path("/tmp/ne/terrarium")

LON0, LON1, LAT0, LAT1 = 108.0, 148.0, 10.0, 42.0
INSET = 0.08
SIMPLIFY_ELEV = 0.006
SIMPLIFY_NE = 0.015
MIN_AREA = 0.010
MIN_AREA_ISLAND = 0.003

# (lon0, lon1, lat0, lat1, z, thresh_m, label)
# shapely box = box(lon0, lat0, lon1, lat1)
ELEV_WINDOWS = [
    # Taiwan 中央山脉 — high thresh so western plain stays clear
    (119.2, 122.3, 21.6, 25.6, 8, 800.0, "taiwan"),
    # 华南 / 武夷 / 南岭 / 闽西 — z8 follows OSM terrain, not NE blobs
    (108.0, 120.2, 21.5, 30.2, 8, 550.0, "southchina"),
    # Japan main
    (128.0, 146.5, 30.0, 41.95, 7, 550.0, "japan"),
    # Ryukyu fringe
    (123.5, 131.2, 24.0, 31.2, 7, 550.0, "ryukyu"),
    # Philippines
    (118.0, 126.8, 10.0, 20.6, 7, 550.0, "philippines"),
    # S Korea / Jeju / Taebaek
    (125.5, 130.0, 33.0, 38.9, 7, 550.0, "korea"),
    # Hainan
    (108.55, 111.15, 18.05, 20.15, 7, 550.0, "hainan"),
    # Changbai / Baekdu
    (127.3, 129.5, 40.6, 41.95, 7, 700.0, "changbai"),
]

# NE Range/mtn names allowed (northern / inland). Exclude southern blocky ones.
NE_KEEP = {
    "Taihang Mts.",
    "Lüliang Mts.",
    "Qinling Mountains",
    "Dabie Mts.",
    "Hamgyong Mts.",
    "Yin Mts.",
}
NE_MIN_LAT = 30.5  # drop any NE fragment south of this even if named

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
    if g is None or g.is_empty:
        return
    if g.geom_type == "Polygon":
        yield g
    elif g.geom_type == "MultiPolygon":
        for p in g.geoms:
            yield p
    elif g.geom_type == "GeometryCollection":
        for p in g.geoms:
            yield from iter_polys(p)


def win_box(w) -> object:
    lon0, lon1, lat0, lat1 = w[0], w[1], w[2], w[3]
    return box(lon0, lat0, lon1, lat1)


def download_tiles(z: int, tx0: int, tx1: int, ty0: int, ty1: int) -> None:
    TILE_DIR.mkdir(parents=True, exist_ok=True)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            dest = TILE_DIR / f"{z}_{tx}_{ty}.png"
            if dest.exists():
                continue
            url = f"{TILE_BASE}/{z}/{tx}/{ty}.png"
            print(f"fetch {url}", flush=True)
            try:
                urllib.request.urlretrieve(url, dest)
            except Exception as e:
                print(f"  WARN fetch failed: {e}", flush=True)


def contour_polys_for_tile(z: int, tx: int, ty: int, thresh: float, clip_geom) -> list:
    dest = TILE_DIR / f"{z}_{tx}_{ty}.png"
    if not dest.exists():
        return []
    lon0, lat_s, lon1, lat_n = tile_bounds(tx, ty, z)
    tile_box = box(lon0, lat_s, lon1, lat_n)
    if not tile_box.intersects(clip_geom):
        return []

    img = np.asarray(Image.open(dest).convert("RGB"), dtype=np.float64)
    elev = img[:, :, 0] * 256.0 + img[:, :, 1] + img[:, :, 2] / 256.0 - 32768.0
    h, w = elev.shape
    mask = (elev >= thresh).astype(np.float64)

    # Zero pixels outside clip window (mercator-correct lat)
    n = 2**z
    rows = np.arange(h)
    ty_pix = ty + (rows + 0.5) / h
    lats = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * ty_pix / n))))
    lons = lon0 + (np.arange(w) + 0.5) / w * (lon1 - lon0)
    # coarse bbox reject then shapely for edge tiles is expensive; use window bbox
    minx, miny, maxx, maxy = clip_geom.bounds
    inside = (
        (lons[None, :] >= minx)
        & (lons[None, :] <= maxx)
        & (lats[:, None] >= miny)
        & (lats[:, None] <= maxy)
    )
    mask = np.where(inside, mask, 0.0)
    if not mask.any():
        return []

    padded = np.pad(mask, 1, mode="constant")
    contours = measure.find_contours(padded, 0.5)
    polys = []
    for contour in contours:
        if len(contour) < 5:
            continue
        coords = []
        for r_pad, c_pad in contour:
            r = r_pad - 1
            c = c_pad - 1
            lon = lon0 + (c / w) * (lon1 - lon0)
            ty_f = ty + (r / h)
            lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty_f / n))))
            coords.append((lon, lat))
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        try:
            poly = Polygon(coords)
        except Exception:
            continue
        if not poly.is_valid:
            poly = make_valid(poly)
        for p in iter_polys(poly):
            if p.area >= 1e-7:
                polys.append(p)
    return polys


def elev_for_window(w) -> object:
    lon0, lon1, lat0, lat1, z, thresh, label = w
    clip = win_box(w)
    x0, y1 = lonlat_to_tile(lon0, lat0, z)
    x1, y0 = lonlat_to_tile(lon1, lat1, z)
    tx0, tx1 = int(math.floor(min(x0, x1))), int(math.floor(max(x0, x1)))
    ty0, ty1 = int(math.floor(min(y0, y1))), int(math.floor(max(y0, y1)))
    print(
        f"  window {label}: z{z} thr>={thresh:.0f}m tiles "
        f"x[{tx0}..{tx1}] y[{ty0}..{ty1}]",
        flush=True,
    )
    download_tiles(z, tx0, tx1, ty0, ty1)
    parts = []
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            parts.extend(contour_polys_for_tile(z, tx, ty, thresh, clip))
    if not parts:
        print(f"  window {label}: EMPTY", flush=True)
        return Polygon()
    u = make_valid(unary_union(parts))
    u = make_valid(u.intersection(clip))
    u = make_valid(u.simplify(SIMPLIFY_ELEV, preserve_topology=True))
    npoly = sum(1 for _ in iter_polys(u))
    print(f"  window {label}: area={u.area:.3f} polys≈{npoly}", flush=True)
    return u


def ne_northern_ranges(clip) -> object:
    fields = [f[0] for f in shapefile.Reader(str(RANGE_SHP)).fields[1:]]
    sf = shapefile.Reader(str(RANGE_SHP))
    parts, kept = [], []
    for sr in sf.iterShapeRecords():
        rec = dict(zip(fields, sr.record))
        if rec.get("FEATURECLA") != "Range/mtn":
            continue
        name = rec.get("NAME")
        if name not in NE_KEEP:
            continue
        inter = make_valid(shape(sr.shape.__geo_interface__)).intersection(clip)
        # Keep only the part north of NE_MIN_LAT
        inter = make_valid(inter.intersection(box(LON0, NE_MIN_LAT, LON1, LAT1)))
        if not inter.is_empty:
            parts.append(inter)
            kept.append(name)
    print(f"NE northern Range/mtn kept ({len(kept)}): {kept}", flush=True)
    if not parts:
        return Polygon()
    return make_valid(
        unary_union(parts).simplify(SIMPLIFY_NE, preserve_topology=True)
    )


def load_land(clip) -> object:
    land_parts = []
    sf = shapefile.Reader(str(LAND_SHP))
    for sr in sf.iterShapeRecords():
        inter = make_valid(shape(sr.shape.__geo_interface__)).intersection(clip)
        if not inter.is_empty:
            land_parts.append(inter)
    return make_valid(
        unary_union(land_parts).simplify(0.02, preserve_topology=True)
    )


def taiwan_centroid(elev_geom) -> tuple[float, float] | None:
    tw = box(119.5, 21.8, 122.2, 25.5)
    parts = [p for p in iter_polys(elev_geom.intersection(tw)) if p.area >= 0.002]
    if not parts:
        return None
    c = unary_union(parts).centroid
    return round(c.x, 2), round(c.y, 2)


def main() -> None:
    if not LAND_SHP.exists() or not RANGE_SHP.exists():
        sys.exit(f"Missing {LAND_SHP} or {RANGE_SHP}")

    clip = box(LON0, LAT0, LON1, LAT1)
    inset = box(LON0 + INSET, LAT0 + INSET, LON1 - INSET, LAT1 - INSET)

    print("building elev windows…", flush=True)
    elev_parts = []
    tw_geom = Polygon()
    for w in ELEV_WINDOWS:
        g = elev_for_window(w)
        if not g.is_empty:
            elev_parts.append(g)
            if w[6] == "taiwan":
                tw_geom = g

    print("building NE northern ranges…", flush=True)
    ne = ne_northern_ranges(clip)
    print("loading land…", flush=True)
    land = load_land(clip)

    pieces = [g for g in elev_parts + [ne] if not g.is_empty]
    combined = make_valid(unary_union(pieces))
    combined = make_valid(combined.intersection(land).intersection(inset))

    tw_c = taiwan_centroid(tw_geom if not tw_geom.is_empty else combined)
    if tw_c:
        print(f"Taiwan mountain centroid ≈ {tw_c[0]}E, {tw_c[1]}N", flush=True)

    final = []
    for p in iter_polys(combined):
        c = p.centroid
        islandish = (
            (119 < c.x < 132 and c.y < 34)
            or (108.5 < c.x < 111.5 and c.y < 20.5)
            or (119 < c.x < 122.5 and 21 < c.y < 26)
            or (125 < c.x < 131 and 33 < c.y < 39)
            or (108 < c.x < 120.5 and 21.5 < c.y < 30.5)  # south china detail
        )
        amin = MIN_AREA_ISLAND if islandish else MIN_AREA
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
        on_edge = sum(
            1
            for lat, lon in ll
            if abs(lon - LON0) < 1e-4
            or abs(lon - LON1) < 1e-4
            or abs(lat - LAT0) < 1e-4
            or abs(lat - LAT1) < 1e-4
        )
        if on_edge >= 2 and on_edge / len(ll) > 0.08:
            print(f"skip edge-hugging ring n={len(ll)} edge_pts={on_edge}", flush=True)
            continue
        lats = [x[0] for x in ll]
        lons = [x[1] for x in ll]
        latlon.append(ll)
        bboxes.append([min(lons), min(lats), max(lons), max(lats)])

    src = (
        "terrarium elev z8 TW≥800m+SC≥550m / z7 islands≥550m "
        "∪ NE northern Range/mtn / WGS84 inset=0.08"
    )
    js = (
        "/** Auto-generated mountain polygons (WGS84), same CRS as OSM basemap.\n"
        f" * {src}\n"
        f" * clipped to NE land & inset basin {LON0}+{INSET}–{LON1}-{INSET}E / "
        f"{LAT0}+{INSET}–{LAT1}-{INSET}N.\n"
        " * Regenerated by scripts/build-mountain-mask.py */\n"
        "(function (global) {\n"
        "  'use strict';\n"
        f"  const MOUNTAIN_POLYS = {json.dumps(latlon, separators=(',', ':'))};\n"
        f"  const MOUNTAIN_BBOXES = {json.dumps(bboxes, separators=(',', ':'))};\n"
        "  global.TY_MOUNTAIN_MASK = { MOUNTAIN_POLYS: MOUNTAIN_POLYS, MOUNTAIN_BBOXES: MOUNTAIN_BBOXES,\n"
        f'    source: "{src}" }};\n'
        "})(typeof window !== \"undefined\" ? window : globalThis);\n"
    )
    OUT.write_text(js)
    print(
        f"wrote {OUT} rings={len(latlon)} verts={sum(len(r) for r in latlon)} "
        f"bytes={OUT.stat().st_size}",
        flush=True,
    )
    if tw_c:
        print(f"NOTE: TW_MTN_LON/LAT → {tw_c}", flush=True)


if __name__ == "__main__":
    main()
