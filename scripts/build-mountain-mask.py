#!/usr/bin/env python3
"""
Regenerate js/mountain-data.js aligned to OSM (WGS84).

Domain-wide mountain mask: land with elev ≥ 700 m across the whole map
basin. Replaces the earlier region-specific dual-threshold / Japan /
Philippines / Korea / Indochina window logic.

Approach:
  1. Terrarium elev mosaicked once over the full basin (z7).
  2. Simple mask: elev ≥ 700 m, morphological closing to reconnect thin
     ridge gaps (does not paint plains far from any ≥700 m pixel).
  3. ∩ NE land ∩ inset basin clip (no ocean, no domain-edge walls).
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
    from shapely.geometry import Point, Polygon, box, shape
    from shapely.ops import unary_union
    from skimage import measure
    from skimage.morphology import closing, disk
except ImportError as e:
    sys.exit(f"Need pyshp+shapely+numpy+Pillow+skimage: {e}")

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "js" / "mountain-data.js"
LAND_SHP = Path("/tmp/ne/ne_10m_land.shp")
TILE_DIR = Path("/tmp/ne/terrarium")

LON0, LON1, LAT0, LAT1 = 100.0, 150.0, 5.0, 50.0  # full WNP land: Hengduan/Tibet edge, Indochina, JP, PH, Korea, Hokkaido
INSET = 0.08
SIMPLIFY_ELEV = 0.005
MIN_AREA = 0.010
MIN_AREA_ISLAND = 0.0025

# Global single cut: elev ≥ 700 m domain-wide (user t321u).
ELEV_M = 700.0
MOSAIC_Z = 7
CLOSE_R = 4  # px at z7 (~few km); bridges thin ridge gaps only

TILE_BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
TILE_PX = 256


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[float, float]:
    n = 2**z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


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


def elev_domain_mask(clip) -> object:
    """Single global elev≥ELEV_M mosaic over the basin, with morphological close."""
    z = MOSAIC_Z
    lon0, lon1, lat0, lat1 = LON0, LON1, LAT0, LAT1
    x0, y1 = lonlat_to_tile(lon0, lat0, z)
    x1, y0 = lonlat_to_tile(lon1, lat1, z)
    tx0, tx1 = int(math.floor(min(x0, x1))), int(math.floor(max(x0, x1)))
    ty0, ty1 = int(math.floor(min(y0, y1))), int(math.floor(max(y0, y1)))
    ntiles_x = tx1 - tx0 + 1
    ntiles_y = ty1 - ty0 + 1
    print(
        f"  domain mosaic: z{z} elev>={ELEV_M:.0f}m close_r={CLOSE_R} "
        f"tiles x[{tx0}..{tx1}] y[{ty0}..{ty1}] ({ntiles_x}×{ntiles_y})",
        flush=True,
    )
    download_tiles(z, tx0, tx1, ty0, ty1)
    elev = mosaic_elev(z, tx0, tx1, ty0, ty1)
    h, ww = elev.shape
    n = 2**z

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

    raw = (elev >= ELEV_M) & inside
    if CLOSE_R > 0:
        closed = closing(raw, disk(CLOSE_R))
    else:
        closed = raw
    # Closing can dilate slightly into ocean pixels near coast — land ∩ later.
    mask = closed
    if not mask.any():
        print("  domain elev mask: EMPTY", flush=True)
        return Polygon()

    parts = contour_mask(mask, z, tx0, ty0, ntiles_x, ntiles_y)
    if not parts:
        print("  domain elev mask: EMPTY contours", flush=True)
        return Polygon()
    u = make_valid(unary_union(parts))
    u = make_valid(u.intersection(clip))
    u = make_valid(u.simplify(SIMPLIFY_ELEV, preserve_topology=True))
    npoly = sum(1 for _ in iter_polys(u))
    print(
        f"  domain elev: area={u.area:.3f} polys≈{npoly} "
        f"raw_px={int(raw.sum())} closed_px={int(mask.sum())}",
        flush=True,
    )
    return u


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
        (117.70, 27.85, True, "Wuyi"),
        (118.60, 25.65, True, "Daiyun"),
        (113.00, 25.00, True, "Nanling"),
        (121.55, 25.03, False, "Taipei basin-ish"),
        (138.50, 36.00, True, "Japanese Alps"),
        (137.50, 35.60, True, "Chubu ridge"),
        (136.90, 35.15, False, "Nagoya plain"),
        (140.70, 39.80, True, "Ou / Tohoku"),
        (121.00, 17.50, True, "Luzon Cordillera"),
        (121.55, 16.20, True, "Sierra Madre"),
        (120.98, 14.60, False, "Manila plain"),
        (128.50, 37.50, True, "Taebaek"),
        (127.00, 37.50, False, "Seoul basin-ish"),
        (127.70, 26.20, False, "Okinawa flat"),
        (130.53, 30.34, True, "Yakushima"),
        (108.66, 12.06, True, "C Highlands VN"),
        (109.20, 12.25, False, "S Vietnam coast"),
        (102.70, 25.05, True, "Hengduan / Kunming edge"),
        (103.80, 27.90, True, "Daliang / SW Sichuan"),
        (104.50, 19.00, True, "Annamite / Laos-VN"),
        (101.00, 18.00, True, "N Laos highlands"),
        (143.00, 43.50, True, "Hokkaido Daisetsu"),
        (140.90, 42.80, True, "Hokkaido Hidaka"),
        (112.50, 30.50, False, "Jianghan plain"),
        (116.40, 39.90, False, "Beijing plain"),
    ]
    print("sample checks:", flush=True)
    n_fail = 0
    for lon, lat, expect, label in pts:
        hit = combined.contains(Point(lon, lat))
        ok = "OK" if hit == expect else "FAIL"
        if hit != expect:
            n_fail += 1
        print(
            f"  [{ok}] {label}: ({lon},{lat}) mountain={hit} expect={expect}",
            flush=True,
        )
    print(f"sample checks: {len(pts) - n_fail}/{len(pts)} OK", flush=True)


def main() -> None:
    if not LAND_SHP.exists():
        sys.exit(f"Missing {LAND_SHP}")

    clip = box(LON0, LAT0, LON1, LAT1)
    inset = box(LON0 + INSET, LAT0 + INSET, LON1 - INSET, LAT1 - INSET)

    print(
        f"building domain-wide elev≥{ELEV_M:.0f}m mountain mask "
        f"(z{MOSAIC_Z} + closing r={CLOSE_R})…",
        flush=True,
    )
    elev_geom = elev_domain_mask(clip)

    print("loading land…", flush=True)
    land = load_land(clip)

    combined = make_valid(elev_geom)
    combined = make_valid(combined.intersection(land).intersection(inset))

    tw_c = taiwan_centroid(combined)
    if tw_c:
        print(f"Taiwan mountain centroid ≈ {tw_c[0]}E, {tw_c[1]}N", flush=True)

    sample_checks(combined)

    tw_box = box(119.5, 21.8, 122.2, 25.5)
    tw_parts = [p for p in iter_polys(combined.intersection(tw_box)) if p.area >= 0.001]
    sc_box = box(108.0, 21.5, 120.2, 30.2)
    sc_parts = [p for p in iter_polys(combined.intersection(sc_box)) if p.area >= 0.001]
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
            or (100 < c.x < 112 and c.y < 23)  # Indochina / VN cordillera
            or (119 < c.x < 122.5 and 21 < c.y < 26)
            or (124 < c.x < 132 and 33 < c.y < 43)  # Korea / Changbai
            or (108 < c.x < 120.5 and 21.5 < c.y < 30.5)
            or (129 < c.x < 146.5 and 30 < c.y < 46)  # Japan + Hokkaido
            or (118 < c.x < 127 and 5 < c.y < 20.5)  # PH
            or (100 < c.x < 108.5 and 21 < c.y < 35)  # Hengduan / W China edge
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
        f"terrarium elev mosaic domain-wide elev≥{ELEV_M:.0f}m "
        f"z{MOSAIC_Z}+closing r={CLOSE_R} / WGS84 inset={INSET} (no NE polys)"
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
