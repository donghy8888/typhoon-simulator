#!/usr/bin/env python3
"""
Regenerate js/mountain-data.js from Natural Earth Range/mtn + island elev.

Root-cause fix vs prior elev≥550m z6 full-basin ∪ few NE names:
  - Full-basin elev≥550 marked Loess/YunGui plateaus as "mountains" and
    clip∩topology created fake walls along lon=108 / lat=42 that looked
    like wrong-position blobs on OSM.
  - z6 + step=3 + simplify 0.025 was too coarse for Taiwan 中央山脉 etc.

New approach (same WGS84 CRS as OSM / NE land mask):
  1. ALL NE 10m Range/mtn intersecting the basin (mainland named ranges)
  2. Terrarium elev in island/peninsula windows only (TW/JP/PH/KR/Hainan…),
     z7, threshold 550m, contour-polygonized for detail
  3. Final ∩ NE land ∩ inset clip (kills domain-edge walls)
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
    from shapely.geometry import MultiPolygon, Polygon, box, shape
    from shapely.ops import unary_union
    from skimage import measure
except ImportError as e:
    sys.exit(f"Need pyshp+shapely+numpy+Pillow+skimage: {e}")

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "js" / "mountain-data.js"
LAND_SHP = Path("/tmp/ne/ne_10m_land.shp")
RANGE_SHP = Path("/tmp/ne/ne_10m_geography_regions_polys.shp")
TILE_DIR = Path("/tmp/ne/terrarium")

Z = 7
THRESH = 550.0
LON0, LON1, LAT0, LAT1 = 108.0, 148.0, 10.0, 42.0
# Inset so clip-boundary shortcuts cannot enclose plains as mountain interiors
INSET = 0.08
SIMPLIFY_NE = 0.018
SIMPLIFY_ELEV = 0.008
MIN_AREA = 0.012
MIN_AREA_ISLAND = 0.004

# Regions poorly covered by NE Range/mtn (no Taiwan / Japan Alps / Cordillera…)
# Each window: (lon0, lon1, lat0, lat1) — convert to shapely box(lon0,lat0,lon1,lat1)
ISLAND_WINDOWS = [
    (119.2, 122.3, 21.6, 25.6),   # Taiwan 中央山脉
    (128.0, 146.5, 30.0, 41.95),  # Japan main islands
    (123.5, 131.2, 24.0, 31.2),   # Ryukyu / Amami / south Kyushu fringe
    (118.0, 126.8, 10.0, 20.6),   # Philippines (north of domain S edge)
    (125.5, 130.0, 33.0, 38.9),   # S Korea / Jeju / Taebaek
    (108.55, 111.15, 18.05, 20.15),  # Hainan highlands
    (127.3, 129.5, 40.6, 41.95),  # Changbai / Baekdu massif
]

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


def download_tiles(tx0: int, tx1: int, ty0: int, ty1: int) -> None:
    TILE_DIR.mkdir(parents=True, exist_ok=True)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            dest = TILE_DIR / f"{Z}_{tx}_{ty}.png"
            if dest.exists():
                continue
            url = f"{TILE_BASE}/{Z}/{tx}/{ty}.png"
            print(f"fetch {url}", flush=True)
            urllib.request.urlretrieve(url, dest)


def contour_polys_for_tile(tx: int, ty: int, windows) -> list:
    """Polygonize elev≥THRESH inside any island window overlapping this tile."""
    dest = TILE_DIR / f"{Z}_{tx}_{ty}.png"
    if not dest.exists():
        return []
    lon0, lat_s, lon1, lat_n = tile_bounds(tx, ty, Z)
    tile_box = box(lon0, lat_s, lon1, lat_n)
    # Skip tiles that don't overlap any window
    if not any(tile_box.intersects(box(w[0], w[2], w[1], w[3])) for w in windows):
        return []

    img = np.asarray(Image.open(dest).convert("RGB"), dtype=np.float64)
    elev = img[:, :, 0] * 256.0 + img[:, :, 1] + img[:, :, 2] / 256.0 - 32768.0
    h, w = elev.shape
    mask = (elev >= THRESH).astype(np.float64)

    # Zero out pixels outside island windows (mercator-correct lat per row)
    n = 2**Z
    rows = np.arange(h)
    # pixel center in tile-y
    ty_pix = ty + (rows + 0.5) / h
    lats = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * ty_pix / n))))
    lons = lon0 + (np.arange(w) + 0.5) / w * (lon1 - lon0)
    inside = np.zeros_like(mask, dtype=bool)
    for wlon0, wlon1, wlat0, wlat1 in windows:
        lon_ok = (lons >= wlon0) & (lons <= wlon1)
        lat_ok = (lats >= wlat0) & (lats <= wlat1)
        inside |= lat_ok[:, None] & lon_ok[None, :]
    mask = np.where(inside, mask, 0.0)
    if not mask.any():
        return []

    # Pad so contours at tile edge close cleanly
    padded = np.pad(mask, 1, mode="constant")
    contours = measure.find_contours(padded, 0.5)
    polys = []
    for contour in contours:
        # contour coords are (row, col) in padded space
        if len(contour) < 4:
            continue
        coords = []
        for r_pad, c_pad in contour:
            r = r_pad - 1
            c = c_pad - 1
            # mercator-correct geographic mapping
            frac_r = r / h
            frac_c = c / w
            lon = lon0 + frac_c * (lon1 - lon0)
            ty_f = ty + frac_r
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
            if p.area >= 1e-6:
                polys.append(p)
    return polys


def elev_island_union(windows) -> object:
    # Tile ranges covering all windows
    txs, tys = [], []
    for wlon0, wlon1, wlat0, wlat1 in windows:
        x0, y1 = lonlat_to_tile(wlon0, wlat0, Z)
        x1, y0 = lonlat_to_tile(wlon1, wlat1, Z)
        txs += [x0, x1]
        tys += [y0, y1]
    tx0, tx1 = int(math.floor(min(txs))), int(math.floor(max(txs)))
    ty0, ty1 = int(math.floor(min(tys))), int(math.floor(max(tys)))
    download_tiles(tx0, tx1, ty0, ty1)

    parts = []
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            parts.extend(contour_polys_for_tile(tx, ty, windows))
    if not parts:
        return Polygon()
    u = make_valid(unary_union(parts))
    # Clip to windows union so tile-edge spill is removed
    win_u = unary_union([box(w[0], w[2], w[1], w[3]) for w in windows])
    u = make_valid(u.intersection(win_u))
    return make_valid(u.simplify(SIMPLIFY_ELEV, preserve_topology=True))


def ne_ranges(clip) -> object:
    fields = [f[0] for f in shapefile.Reader(str(RANGE_SHP)).fields[1:]]
    sf = shapefile.Reader(str(RANGE_SHP))
    parts = []
    kept = []
    for sr in sf.iterShapeRecords():
        rec = dict(zip(fields, sr.record))
        if rec.get("FEATURECLA") != "Range/mtn":
            continue
        inter = make_valid(shape(sr.shape.__geo_interface__)).intersection(clip)
        if not inter.is_empty:
            parts.append(inter)
            kept.append(rec.get("NAME"))
    print(f"NE Range/mtn kept ({len(kept)}): {kept}", flush=True)
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
    """Mass centroid of mountain polys inside Taiwan window."""
    tw = box(119.5, 21.8, 122.2, 25.5)
    parts = [p for p in iter_polys(elev_geom.intersection(tw)) if p.area >= 0.002]
    if not parts:
        return None
    u = unary_union(parts)
    c = u.centroid
    return round(c.x, 2), round(c.y, 2)


def main() -> None:
    if not LAND_SHP.exists() or not RANGE_SHP.exists():
        sys.exit(f"Missing {LAND_SHP} or {RANGE_SHP}")

    clip = box(LON0, LAT0, LON1, LAT1)
    inset = box(LON0 + INSET, LAT0 + INSET, LON1 - INSET, LAT1 - INSET)

    print("building NE ranges…", flush=True)
    ne = ne_ranges(clip)
    print("building island elev (z7 contours)…", flush=True)
    elev = elev_island_union(ISLAND_WINDOWS)
    print("loading land…", flush=True)
    land = load_land(clip)

    combined = make_valid(unary_union([g for g in (ne, elev) if not g.is_empty]))
    combined = make_valid(combined.intersection(land).intersection(inset))

    tw_c = taiwan_centroid(elev)
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
        # Drop rings that still hug the outer clip (should be rare with inset)
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
        f"NE 10m Range/mtn ∪ terrarium elev>={THRESH:.0f}m z{Z} "
        f"(island windows) / WGS84 inset={INSET}"
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
        print(f"NOTE: update TW_MTN_LON/LAT in physics.js if changed meaningfully → {tw_c}", flush=True)


if __name__ == "__main__":
    main()
