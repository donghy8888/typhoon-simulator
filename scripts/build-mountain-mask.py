#!/usr/bin/env python3
"""
Regenerate js/mountain-data.js aligned to OSM (WGS84).

Problem history:
  - Full-basin low-threshold elev painted Loess/plateaus + clip walls.
  - NE 10m Nan Ling / Wuyi polys are coarse blobs that sit on plains.
  - Taiwan ≥800m ridge-only left isolated summit islands (peaks, not belts).
  - South China ≥550m without closing also fragmented into peak fields.

Approach:
  1. Terrarium elev mosaicked per window (not per-tile contours) so ridges
     can connect across tile seams, then dual-threshold + morphological
     closing before polygonize:
       • Taiwan z8: corridor ≥580m closed (r=4) ∪ core ≥750m
       • South China z8: corridor ≥400m closed (r=6) ∪ core ≥550m
       • Japan Alps z8 + Honshu/PH Luzon/KR/Indochina dual-thresh belts
      • Ryukyu high-cut only (no flat-island walls); Hainan/Changbai z7
  2. NE 10m Range/mtn only NORTH of ~30.5N (Taihang/Qinling/Dabie/…)
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
    from skimage.morphology import closing, disk
except ImportError as e:
    sys.exit(f"Need pyshp+shapely+numpy+Pillow+skimage: {e}")

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "js" / "mountain-data.js"
LAND_SHP = Path("/tmp/ne/ne_10m_land.shp")
RANGE_SHP = Path("/tmp/ne/ne_10m_geography_regions_polys.shp")
TILE_DIR = Path("/tmp/ne/terrarium")

LON0, LON1, LAT0, LAT1 = 108.0, 148.0, 10.0, 42.0
INSET = 0.08
SIMPLIFY_ELEV = 0.005
SIMPLIFY_NE = 0.015
MIN_AREA = 0.010
MIN_AREA_ISLAND = 0.0025

# (lon0, lon1, lat0, lat1, z, core_m, corridor_m, close_r, label)
# corridor ≤ core; closing merges nearby corridor pixels into ridge belts;
# final mask = close(elev≥corridor) ∪ (elev≥core). Plains stay below corridor.
# TW/SC thresholds proven; other NW-Pacific ranges use the same dual-thresh
# idea with region-appropriate cuts (not one ultra-low global threshold).
ELEV_WINDOWS = [
    # Taiwan 中央山脉 — reconnect ridge without western plain
    (119.2, 122.3, 21.6, 25.6, 8, 750.0, 580.0, 4, "taiwan"),
    # 华南 / 武夷 / 南岭 / 戴云 / 闽西 — connected belts, not peak field
    (108.0, 120.2, 21.5, 30.2, 8, 550.0, 400.0, 6, "southchina"),
    # Japan Alps / Chubu backbone (z8 belts, not summit islands)
    (136.2, 139.8, 34.8, 37.5, 8, 700.0, 450.0, 5, "japan_alps"),
    # Honshu / Kyushu / Shikoku ranges (Ou, Chugoku, Kyushu mtns)
    (129.2, 142.8, 30.2, 41.95, 7, 600.0, 400.0, 4, "japan"),
    # Hokkaido southern tip inside domain (<42N) — real high terrain only
    (139.5, 146.2, 41.0, 41.95, 7, 500.0, 350.0, 3, "hokkaido_tip"),
    # Ryukyu: keep HIGH cuts — only Yakushima-class peaks, no flat-island walls
    (123.5, 131.2, 24.0, 31.2, 7, 650.0, 550.0, 1, "ryukyu"),
    # Luzon Cordillera / Sierra Madre / Zambales
    (119.5, 124.6, 13.2, 19.2, 8, 650.0, 420.0, 5, "luzon"),
    # Visayas + N Mindanao fringe (domain south edge ≈10N)
    (120.5, 126.8, 10.05, 13.8, 7, 550.0, 400.0, 3, "visayas"),
    # S Korea Taebaek / Sobaek / Jeju Hallasan
    (126.0, 129.9, 33.1, 38.8, 7, 500.0, 350.0, 4, "korea"),
    # Hainan Wuzhi
    (108.55, 111.15, 18.05, 20.15, 7, 550.0, 480.0, 2, "hainan"),
    # Changbai / Baekdu massif
    (126.8, 131.0, 40.2, 41.95, 7, 650.0, 500.0, 3, "changbai"),
    # E Indochina / Annamite fringe inside domain (≥108E)
    (108.05, 110.2, 11.0, 23.0, 7, 500.0, 350.0, 3, "indochina_e"),
]

NE_KEEP = {
    "Taihang Mts.",
    "Lüliang Mts.",
    "Qinling Mountains",
    "Dabie Mts.",
    "Hamgyong Mts.",
    "Yin Mts.",
}
NE_MIN_LAT = 30.5

TILE_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
TILE_PX = 256


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


def load_elev_tile(z: int, tx: int, ty: int) -> np.ndarray | None:
    dest = TILE_DIR / f"{z}_{tx}_{ty}.png"
    if not dest.exists():
        return None
    img = np.asarray(Image.open(dest).convert("RGB"), dtype=np.float64)
    return img[:, :, 0] * 256.0 + img[:, :, 1] + img[:, :, 2] / 256.0 - 32768.0


def mosaic_elev(z: int, tx0: int, tx1: int, ty0: int, ty1: int) -> np.ndarray:
    """Stitch terrarium tiles into one elev grid (row=ty, col=tx). Missing → -32768."""
    nrows = (ty1 - ty0 + 1) * TILE_PX
    ncols = (tx1 - tx0 + 1) * TILE_PX
    elev = np.full((nrows, ncols), -32768.0, dtype=np.float64)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            tile = load_elev_tile(z, tx, ty)
            if tile is None:
                continue
            r0 = (ty - ty0) * TILE_PX
            c0 = (tx - tx0) * TILE_PX
            elev[r0 : r0 + TILE_PX, c0 : c0 + TILE_PX] = tile
    return elev


def contour_mask(
    mask: np.ndarray,
    z: int,
    tx0: int,
    ty0: int,
    ntiles_x: int,
    ntiles_y: int,
) -> list:
    """Polygonize boolean mask; pixel → lon/lat via mosaic tile origin."""
    if not mask.any():
        return []
    h, w = mask.shape
    # Mosaic spans [tx0 .. tx0+ntiles_x) × [ty0 .. ty0+ntiles_y)
    n = 2**z
    lon_w0 = tx0 / n * 360.0 - 180.0
    lon_w1 = (tx0 + ntiles_x) / n * 360.0 - 180.0

    def ty_to_lat(ty_f: float) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty_f / n))))

    padded = np.pad(mask.astype(np.float64), 1, mode="constant")
    contours = measure.find_contours(padded, 0.5)
    polys = []
    for contour in contours:
        if len(contour) < 5:
            continue
        coords = []
        for r_pad, c_pad in contour:
            r = r_pad - 1
            c = c_pad - 1
            lon = lon_w0 + (c / w) * (lon_w1 - lon_w0)
            ty_f = ty0 + (r / h) * ntiles_y
            lat = ty_to_lat(ty_f)
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
    lon0, lon1, lat0, lat1, z, core_m, corr_m, close_r, label = w
    clip = win_box(w)
    x0, y1 = lonlat_to_tile(lon0, lat0, z)
    x1, y0 = lonlat_to_tile(lon1, lat1, z)
    tx0, tx1 = int(math.floor(min(x0, x1))), int(math.floor(max(x0, x1)))
    ty0, ty1 = int(math.floor(min(y0, y1))), int(math.floor(max(y0, y1)))
    ntiles_x = tx1 - tx0 + 1
    ntiles_y = ty1 - ty0 + 1
    print(
        f"  window {label}: z{z} core>={core_m:.0f}m corridor>={corr_m:.0f}m "
        f"close_r={close_r} tiles x[{tx0}..{tx1}] y[{ty0}..{ty1}]",
        flush=True,
    )
    download_tiles(z, tx0, tx1, ty0, ty1)
    elev = mosaic_elev(z, tx0, tx1, ty0, ty1)
    h, ww = elev.shape
    n = 2**z

    # Zero outside window bbox (mercator-correct lat)
    rows = np.arange(h)
    cols = np.arange(ww)
    ty_pix = ty0 + (rows + 0.5) / h * ntiles_y
    lats = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * ty_pix / n))))
    lon_w0 = tx0 / n * 360.0 - 180.0
    lon_w1 = (tx0 + ntiles_x) / n * 360.0 - 180.0
    lons = lon_w0 + (cols + 0.5) / ww * (lon_w1 - lon_w0)
    minx, miny, maxx, maxy = clip.bounds
    inside = (
        (lons[None, :] >= minx)
        & (lons[None, :] <= maxx)
        & (lats[:, None] >= miny)
        & (lats[:, None] <= maxy)
    )

    core = (elev >= core_m) & inside
    corridor = (elev >= corr_m) & inside
    if close_r > 0:
        closed = closing(corridor, disk(close_r))
    else:
        closed = corridor
    # Bridge nearby corridor peaks into ridge belts; always keep true cores
    mask = closed | core
    if not mask.any():
        print(f"  window {label}: EMPTY", flush=True)
        return Polygon()

    parts = contour_mask(mask, z, tx0, ty0, ntiles_x, ntiles_y)
    if not parts:
        print(f"  window {label}: EMPTY contours", flush=True)
        return Polygon()
    u = make_valid(unary_union(parts))
    u = make_valid(u.intersection(clip))
    u = make_valid(u.simplify(SIMPLIFY_ELEV, preserve_topology=True))
    npoly = sum(1 for _ in iter_polys(u))
    print(
        f"  window {label}: area={u.area:.3f} polys≈{npoly} "
        f"mask_px={int(mask.sum())} closed_px={int(closed.sum())} core_px={int(core.sum())}",
        flush=True,
    )
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


def sample_checks(combined) -> None:
    """Sanity samples before writing (lon, lat, expect_mtn, label)."""
    pts = [
        (120.65, 24.15, False, "Taichung plain"),
        (120.20, 22.99, False, "Tainan plain"),
        (121.00, 23.50, True, "Central ridge"),
        (120.95, 23.47, True, "Yushan area"),
        (121.39, 24.39, True, "Xueshan area"),
        (118.08, 24.48, False, "Xiamen"),
        (118.60, 24.90, False, "Quanzhou"),
        (113.26, 23.13, False, "Pearl / Guangzhou"),
        (119.30, 26.08, False, "Fuzhou plain"),
        (117.95, 27.75, True, "Wuyi"),
        (118.60, 25.65, True, "Daiyun"),
        (113.00, 25.00, True, "Nanling"),
        (121.55, 25.03, False, "Taipei basin-ish"),
        (138.50, 36.00, True, "Japanese Alps"),
        (137.50, 35.60, True, "Chubu ridge"),
        (136.90, 35.15, False, "Nagoya plain"),
        (140.90, 39.60, True, "Ou / Tohoku"),
        (121.00, 17.50, True, "Luzon Cordillera"),
        (121.20, 15.50, True, "Sierra Madre"),
        (120.98, 14.60, False, "Manila plain"),
        (128.50, 37.50, True, "Taebaek"),
        (127.00, 37.50, False, "Seoul basin-ish"),
        (127.70, 26.20, False, "Okinawa flat"),
        (130.53, 30.34, True, "Yakushima"),
        (108.66, 12.06, True, "C Highlands VN"),
        (109.20, 12.25, False, "S Vietnam coast"),
    ]
    print("sample checks:", flush=True)
    for lon, lat, expect, label in pts:
        hit = combined.contains(shape({"type": "Point", "coordinates": [lon, lat]}))
        # shapely Point
        from shapely.geometry import Point

        hit = combined.contains(Point(lon, lat))
        ok = "OK" if hit == expect else "FAIL"
        print(
            f"  [{ok}] {label}: ({lon},{lat}) mountain={hit} expect={expect}",
            flush=True,
        )


def main() -> None:
    if not LAND_SHP.exists() or not RANGE_SHP.exists():
        sys.exit(f"Missing {LAND_SHP} or {RANGE_SHP}")

    clip = box(LON0, LAT0, LON1, LAT1)
    inset = box(LON0 + INSET, LAT0 + INSET, LON1 - INSET, LAT1 - INSET)

    print("building elev windows (mosaic + dual-thresh + closing)…", flush=True)
    elev_parts = []
    tw_geom = Polygon()
    for w in ELEV_WINDOWS:
        g = elev_for_window(w)
        if not g.is_empty:
            elev_parts.append(g)
            if w[8] == "taiwan":
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

    sample_checks(combined)

    # Connectivity: Taiwan should be few large polys, not dozens of peaks
    tw_box = box(119.5, 21.8, 122.2, 25.5)
    tw_parts = list(iter_polys(combined.intersection(tw_box)))
    tw_parts = [p for p in tw_parts if p.area >= 0.001]
    sc_box = box(108.0, 21.5, 120.2, 30.2)
    sc_parts = list(iter_polys(combined.intersection(sc_box)))
    sc_parts = [p for p in sc_parts if p.area >= 0.001]
    print(
        f"connectivity: Taiwan polys≥0.001={len(tw_parts)} "
        f"largest={max((p.area for p in tw_parts), default=0):.3f}; "
        f"SouthChina polys≥0.001={len(sc_parts)} "
        f"largest={max((p.area for p in sc_parts), default=0):.3f}",
        flush=True,
    )

    final = []
    for p in iter_polys(combined):
        c = p.centroid
        islandish = (
            (119 < c.x < 132 and c.y < 34)
            or (108.5 < c.x < 111.5 and c.y < 20.5)
            or (119 < c.x < 122.5 and 21 < c.y < 26)
            or (125 < c.x < 131 and 33 < c.y < 39)
            or (108 < c.x < 120.5 and 21.5 < c.y < 30.5)
            or (129 < c.x < 146.5 and 30 < c.y < 42)  # Japan arcs
            or (118 < c.x < 127 and 10 < c.y < 20.5)  # Philippines
            or (108 < c.x < 110.5 and 11 < c.y < 23)  # E Indochina fringe
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
        "terrarium elev mosaic dual-thresh+closing "
        "TW core≥750/corr≥580r4 SC core≥550/corr≥400r6 "
        "JP Alps z8 + Honshu/PH/KR/Indochina region cuts "
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
