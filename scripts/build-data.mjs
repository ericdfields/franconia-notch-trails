// Fetches and processes all map data for the Franconia Notch Trails model.
//
//   node scripts/build-data.mjs            (uses .cache/ when present)
//   node scripts/build-data.mjs --refresh  (re-downloads everything)
//
// Sources:
//   - OpenStreetMap via Overpass: Franconia Notch State Park outline, trails, water, wilderness, peaks, towns, roads
//   - USFS National Forest System Trails (official White Mountain National Forest trail inventory)
//   - AWS Terrain Tiles (Terrarium): elevation
//
// Outputs (public/data/):
//   terrain.bin   Uint16 heights (meters * 4), row 0 = north edge
//   map.json      grid metadata, region outline, water, wilderness, labels
//   trails.json   trails grouped by name, with draped 3D polylines + stats
//   future.json   empty planned-trail overlay placeholder

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const REFRESH = process.argv.includes('--refresh');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(path.join(CACHE, 'tiles'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// Model extent (a little larger than the basin itself)
const BBOX = { west: -71.81, east: -71.58, south: 44.06, north: 44.205 };
const GRID_SPACING = 50; // meters between terrain samples
const DEM_ZOOM = 12;
const LAT0 = (BBOX.south + BBOX.north) / 2;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const WIDTH_M = (BBOX.east - BBOX.west) * M_PER_DEG_LON;
const HEIGHT_M = (BBOX.north - BBOX.south) * M_PER_DEG_LAT;

// Hand edits, for things the source data gets wrong or leaves out
const EXCLUDED_TRAILS = new Map([
  ['Franconia Notch Recreation Path', 'paved multi-use path, not a hiking trail'],
  ['Franconia Notch Bike Path', 'paved multi-use path, not a hiking trail'],
  ['Pemi Trail', 'mostly roadside path; excluded to keep mountain trails legible'],
]);
// Roads drawn for context (not counted or listed as trails), by their OpenStreetMap name
const CONTEXT_ROADS = [
  'Franconia Notch Parkway',
  'Daniel Webster Highway',
  'Profile Road',
];

// Local planar coordinates in meters: x east from west edge, y north from south edge
const project = (lon, lat) => [(lon - BBOX.west) * M_PER_DEG_LON, (lat - BBOX.south) * M_PER_DEG_LAT];

// ---------------------------------------------------------------------------
// Fetch helpers

async function cached(name, fetcher) {
  const file = path.join(CACHE, name);
  if (!REFRESH && fs.existsSync(file)) return fs.readFileSync(file);
  console.log(`  fetching ${name}…`);
  const buf = await fetcher();
  fs.writeFileSync(file, buf);
  return buf;
}

async function get(url, init) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'franconia-notch-trails-model/0.1' }, ...init });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`  retrying ${url.slice(0, 80)} (${err.message})`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

const overpass = (query) =>
  get('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
  });

// ---------------------------------------------------------------------------
// Geometry helpers

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// polygons: [{outer: ring, inner: [ring]}]
function pointInPolygons(x, y, polygons) {
  for (const p of polygons) {
    if (x < p.bbox[0] || x > p.bbox[2] || y < p.bbox[1] || y > p.bbox[3]) continue;
    if (pointInRing(x, y, p.outer) && !p.inner.some((r) => pointInRing(x, y, r))) return true;
  }
  return false;
}

function ringBBox(ring) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  return b;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

// Join open way fragments into closed rings (for OSM multipolygon relations)
function assembleRings(lines) {
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const pending = lines.filter((l) => l.length > 1).map((l) => l.slice());
  const rings = [];
  while (pending.length) {
    let ring = pending.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const end = key(ring[ring.length - 1]);
      const idx = pending.findIndex((l) => key(l[0]) === end || key(l[l.length - 1]) === end);
      if (idx < 0) break;
      let next = pending.splice(idx, 1)[0];
      if (key(next[0]) !== end) next = next.reverse();
      ring = ring.concat(next.slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function osmPolygons(el) {
  const toXY = (g) => g.map((p) => project(p.lon, p.lat));
  if (el.type === 'way') {
    const ring = toXY(el.geometry);
    return [{ outer: ring, inner: [], bbox: ringBBox(ring) }];
  }
  if (!el.members) return [];
  const outers = assembleRings(el.members.filter((m) => m.role !== 'inner' && m.geometry).map((m) => toXY(m.geometry)));
  const inners = assembleRings(el.members.filter((m) => m.role === 'inner' && m.geometry).map((m) => toXY(m.geometry)));
  return outers.map((outer) => ({
    outer,
    inner: inners.filter((r) => pointInRing(r[0][0], r[0][1], outer)),
    bbox: ringBBox(outer),
  }));
}

// Douglas-Peucker
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2));
      const d = Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function lineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Region outline

console.log('Franconia Notch State Park boundary');
const ctxBox = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
const regionGeo = JSON.parse(
  await cached('franconia-notch-state-park.json', () =>
    overpass(`[out:json][timeout:180];
(
  relation["name"="Franconia Notch State Park"](${ctxBox});
  way["name"="Franconia Notch State Park"](${ctxBox});
);
out body geom;`)
  )
);
const regionPolys = regionGeo.elements.flatMap(osmPolygons);
if (!regionPolys.length) throw new Error('Could not find Franconia Notch State Park boundary in OSM');
const basin = regionPolys.sort((a, b) => ringArea(b.outer) - ringArea(a.outer));
const basinRing = basin[0].outer;
const inBasin = (x, y) => pointInPolygons(x, y, basin);
console.log(`  ${basin.length} polygon(s), largest ${(ringArea(basinRing) / 1e6).toFixed(1)} km²`);

// ---------------------------------------------------------------------------
// 2. Terrain

console.log('Terrain');
const lon2tile = (lon) => ((lon + 180) / 360) * 2 ** DEM_ZOOM;
const lat2tile = (lat) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** DEM_ZOOM;
const tx0 = Math.floor(lon2tile(BBOX.west));
const tx1 = Math.floor(lon2tile(BBOX.east));
const ty0 = Math.floor(lat2tile(BBOX.north));
const ty1 = Math.floor(lat2tile(BBOX.south));
const tiles = new Map();
for (let tx = tx0; tx <= tx1; tx++) {
  for (let ty = ty0; ty <= ty1; ty++) {
    const buf = await cached(`tiles/${DEM_ZOOM}-${tx}-${ty}.png`, () =>
      get(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEM_ZOOM}/${tx}/${ty}.png`)
    );
    tiles.set(`${tx},${ty}`, PNG.sync.read(buf));
  }
}
function demPixel(px, py) {
  const tx = Math.floor(px / 256);
  const ty = Math.floor(py / 256);
  const t = tiles.get(`${tx},${ty}`);
  const i = ((py - ty * 256) * 256 + (px - tx * 256)) * 4;
  return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
}
// Elevation at local meters (bilinear over the source DEM)
function demAt(x, y) {
  x = Math.max(0, Math.min(WIDTH_M, x));
  y = Math.max(0, Math.min(HEIGHT_M, y));
  const lon = BBOX.west + x / M_PER_DEG_LON;
  const lat = BBOX.south + y / M_PER_DEG_LAT;
  const fx = lon2tile(lon) * 256 - 0.5;
  const fy = lat2tile(lat) * 256 - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const u = fx - x0;
  const v = fy - y0;
  return (
    demPixel(x0, y0) * (1 - u) * (1 - v) +
    demPixel(x0 + 1, y0) * u * (1 - v) +
    demPixel(x0, y0 + 1) * (1 - u) * v +
    demPixel(x0 + 1, y0 + 1) * u * v
  );
}
const gridW = Math.round(WIDTH_M / GRID_SPACING) + 1;
const gridH = Math.round(HEIGHT_M / GRID_SPACING) + 1;
const heights = new Uint16Array(gridW * gridH);
let minEle = Infinity;
let maxEle = -Infinity;
for (let j = 0; j < gridH; j++) {
  const y = HEIGHT_M - (j / (gridH - 1)) * HEIGHT_M;
  for (let i = 0; i < gridW; i++) {
    const e = demAt((i / (gridW - 1)) * WIDTH_M, y);
    minEle = Math.min(minEle, e);
    maxEle = Math.max(maxEle, e);
    heights[j * gridW + i] = Math.max(0, Math.round(e * 4));
  }
}
fs.writeFileSync(path.join(OUT, 'terrain.bin'), Buffer.from(heights.buffer));
console.log(`  ${gridW}×${gridH} grid, ${minEle.toFixed(0)}–${maxEle.toFixed(0)} m`);

// ---------------------------------------------------------------------------
// 3. OSM context: water, wilderness, peaks, towns

console.log('OSM context');
const osmCtx = JSON.parse(
  await cached('osm2.json', () =>
    overpass(`[out:json][timeout:180];
(
 way["natural"="water"](${ctxBox});
 relation["natural"="water"](${ctxBox});
 relation["boundary"="protected_area"]["name"~"Wilderness"](${ctxBox});
 relation["leisure"="nature_reserve"]["name"~"Wilderness"](${ctxBox});
 node["natural"="peak"]["name"](${ctxBox});
 node["place"~"^(town|village|hamlet|city)$"](${ctxBox});
 way["boundary"="protected_area"]["name"~"State Park|State Recreation Area"](${ctxBox});
 relation["boundary"="protected_area"]["name"~"State Park|State Recreation Area"](${ctxBox});
 way["leisure"="park"]["name"~"State Park|State Recreation Area"](${ctxBox});
 relation["leisure"="park"]["name"~"State Park|State Recreation Area"](${ctxBox});
);
out body geom;`)
  )
);

const inExtent = ([x, y]) => x >= 0 && y >= 0 && x <= WIDTH_M && y <= HEIGHT_M;
const lakes = [];
const wilderness = [];
const wildernessPolys = [];
const stateParkPolys = [];
const labels = [];
const seenWild = new Set();
for (const el of osmCtx.elements) {
  const t = el.tags || {};
  if (t.natural === 'water' && (el.type === 'way' || el.type === 'relation')) {
    if (t.water && !['lake', 'reservoir', 'pond'].includes(t.water)) continue;
    for (const poly of osmPolygons(el)) {
      const area = ringArea(poly.outer);
      if (area < 12000 || !poly.outer.some(inExtent)) continue;
      // Water surface: low percentile of DEM along the shoreline
      const shore = poly.outer.filter(inExtent).map(([x, y]) => demAt(x, y)).sort((a, b) => a - b);
      const level = shore[Math.floor(shore.length * 0.2)];
      const tol = area > 5e7 ? 20 : 6;
      lakes.push({
        name: t.name || null,
        area: Math.round(area),
        level: Math.round(level * 10) / 10,
        outer: simplify(poly.outer, tol).map(([x, y]) => [Math.round(x), Math.round(y)]),
        inner: poly.inner.map((r) => simplify(r, tol).map(([x, y]) => [Math.round(x), Math.round(y)])),
      });
    }
  } else if (/State Park|State Recreation Area/.test(t.name || '')) {
    stateParkPolys.push(...osmPolygons(el));
  } else if (/Wilderness/.test(t.name || '') && el.type === 'relation') {
    if (seenWild.has(t.name)) continue;
    seenWild.add(t.name);
    const polys = osmPolygons(el);
    wildernessPolys.push(...polys);
    wilderness.push({
      name: t.name,
      rings: polys.map((p) => simplify(p.outer, 30).map(([x, y]) => [Math.round(x), Math.round(y)])),
    });
  } else if (t.natural === 'peak') {
    const [x, y] = project(el.lon, el.lat);
    if (!inExtent([x, y])) continue;
    labels.push({ kind: 'peak', name: t.name, x: Math.round(x), y: Math.round(y), ele: Math.round(t.ele ? parseFloat(t.ele) : demAt(x, y)) });
  } else if (t.place) {
    const [x, y] = project(el.lon, el.lat);
    if (!inExtent([x, y])) continue;
    labels.push({ kind: t.place === 'town' || t.place === 'city' ? 'town' : 'village', name: t.name, x: Math.round(x), y: Math.round(y) });
  }
}
// Hand-placed labels for small landmarks that OSM polygons/points do not consistently label.
for (const [kind, name, lon, lat] of [
  ['water', 'Profile Lake', -71.6806, 44.1617],
  ['water', 'The Basin', -71.6817, 44.1195],
  ['water', 'Pemigewasset River', -71.6810, 44.1315],
  ['road', 'I-93 / Franconia Notch Parkway', -71.6810, 44.1450],
  ['road', 'NH-18', -71.7375, 44.1760],
]) {
  const [x, y] = project(lon, lat);
  if (inExtent([x, y])) labels.push({ kind, name, x: Math.round(x), y: Math.round(y) });
}

// Named lake labels at a point well inside the lake
for (const lake of lakes) {
  if (!lake.name || lake.area < 150000) continue;
  const b = ringBBox(lake.outer);
  let best = null;
  const steps = 24;
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const x = b[0] + ((b[2] - b[0]) * i) / steps;
      const y = b[1] + ((b[3] - b[1]) * j) / steps;
      if (!pointInRing(x, y, lake.outer) || !inExtent([x, y])) continue;
      let d = Infinity;
      for (const [px, py] of lake.outer) d = Math.min(d, Math.hypot(px - x, py - y));
      if (!best || d > best.d) best = { x, y, d };
    }
  }
  if (best) labels.push({ kind: 'lake', name: lake.name, x: Math.round(best.x), y: Math.round(best.y), area: lake.area });
}
const inWilderness = (x, y) => pointInPolygons(x, y, wildernessPolys);
const inStatePark = (x, y) => pointInPolygons(x, y, stateParkPolys);
console.log(`  ${lakes.length} lakes, ${wilderness.length} wilderness areas, ${labels.length} labels`);

// ---------------------------------------------------------------------------
// 4. Trails

console.log('Trails');
const osmTrails = JSON.parse(
  await cached('osm.json', () =>
    overpass(`[out:json][timeout:180];
(
 way["highway"~"^(path|footway|track|bridleway|cycleway)$"]["name"](${ctxBox});
);
out tags geom;`)
  )
);
const usfs = JSON.parse(
  await cached('usfs.geojson', () =>
    get(
      `https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query?where=1%3D1&geometry=${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326&f=geojson`
    )
  )
);

const ROAD_NAME = /\b(road|rd|drive|lane|avenue|ave|court|street|boulevard|circle|crescent|way|highway)\b/i;
const NOT_A_TRAIL = /bike path|recreation path|shared use path|climb|boulder|approach|acess|access|snow storage|parcourse|decommis|^\d|spires|multipitch|monty python|space invaders|far side/i;
const MOTORIZED = /4WD|OHV|JEEP|MOTORCYCLE|SNOWMOBILE|\bSKI\b|NORDIC|WINTER|BOAT|CAMPSITE|STABLES|CORRAL TRAILS|URBAN|BIKE PATH|RACE|XC$/i;

const segments = []; // { name, pts:[[x,y]], hike, bike, bikeInferred, mtbScale, sacScale, surface, operator, source }
const inBasinLine = (pts) => pts.filter((_, i) => i % 4 === 0 || i === pts.length - 1).some(([x, y]) => inBasin(x, y));
const inMapLine = (pts) => pts.some(inExtent);

for (const w of osmTrails.elements) {
  const t = w.tags;
  const name = t.name.trim();
  if (NOT_A_TRAIL.test(name)) continue;
  if (['private', 'no'].includes(t.access) || t.informal === 'yes' || t.footway === 'sidewalk' || t.footway === 'crossing') continue;
  if (t.highway === 'cycleway') continue; // paved bike paths aren't trails
  const designated = t.bicycle === 'designated' || t.foot === 'designated' || t.horse === 'designated' || t['mtb:scale'] != null;
  const trailish = /trail|loop|connector|spur|flume/i.test(name);
  if (t.highway === 'track' && !designated && !trailish) continue;
  if (t.highway === 'footway' && !trailish) continue;
  if (ROAD_NAME.test(name) && !trailish && !designated) continue;
  const pts = w.geometry.map((p) => project(p.lon, p.lat));
  if (!inMapLine(pts)) continue;
  const mid = pts[Math.floor(pts.length / 2)];
  const wild = inWilderness(mid[0], mid[1]);
  const stateParks = /state park|parks and rec/i.test(t.operator || '') || inStatePark(mid[0], mid[1]);
  let bike = null;
  if (['yes', 'designated', 'permissive'].includes(t.bicycle) || t['mtb:scale'] != null) bike = true;
  else if (['no', 'dismount'].includes(t.bicycle)) bike = false;
  const bikeInferred = bike === null;
  if (bike === null) bike = false; // Franconia Notch hiking routes are assumed hiking-only unless explicit data says otherwise
  if (wild) bike = false;
  segments.push({
    name,
    pts,
    hike: t.foot !== 'no',
    bike,
    bikeInferred,
    mtbScale: t['mtb:scale'] ?? null,
    sacScale: t.sac_scale ?? null,
    surface: t.surface ?? null,
    operator: t.operator ?? null,
    source: 'osm',
  });
}
console.log(`  ${segments.length} OSM segments kept`);

// Spatial hash of OSM trail vertices so we can tell which USFS trails are already covered
const HASH = 60;
const hash = new Map();
const hkey = (x, y) => `${Math.floor(x / HASH)},${Math.floor(y / HASH)}`;
for (const s of segments) for (const [x, y] of densify(s.pts, 30)) {
  const k = hkey(x, y);
  if (!hash.has(k)) hash.set(k, []);
  hash.get(k).push([x, y, s]);
}
function nearestOsm(x, y, r) {
  let best = null;
  let bd = r;
  const cx = Math.floor(x / HASH);
  const cy = Math.floor(y / HASH);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const [px, py, s] of hash.get(`${cx + i},${cy + j}`) || []) {
      const d = Math.hypot(px - x, py - y);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
  }
  return best;
}

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bAt\b/g, 'AT')
    .replace(/\bMtn\b/g, 'Mountain')
    .replace(/\bMt\.? /g, 'Mount ')
    .replace(/\bMdw\b/g, 'Meadow')
    .replace(/\bT\/H\b/gi, 'Trailhead')
    .replace(/\bKbn\b/g, 'Kingsbury North')
    .replace(/\bKbs\b/g, 'Kingsbury South')
    .replace(/\bTra$/, 'Trail');
const isOn = (v) => v != null && v !== 'N/A' && String(v).trim() !== '';

// Names are compared loosely: "CORRAL TRAIL" and "Corral Trail" are the same trail, and every
// piece of the Appalachian / Franconia Ridge / Kinsman Ridge trails belongs to the whole.
const LONG_DISTANCE = /appalachian trail|franconia ridge trail|kinsman ridge trail/i;
const normName = (n) => {
  const base = n.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (LONG_DISTANCE.test(base)) return base.match(LONG_DISTANCE)[0].toLowerCase();
  return base
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(trail|trails|tr)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

// OSM trail vertices by trail name, for spotting USFS lines that duplicate a mapped trail
const osmByName = new Map();
for (const s of segments) {
  const k = normName(s.name);
  if (!osmByName.has(k)) osmByName.set(k, []);
  osmByName.get(k).push(...densify(s.pts, 40));
}
const SAME_TRAIL_RADIUS = 200; // m: a same-named USFS line this close is the same trail, drawn differently
const MAX_STRAY = 600; // m: …unless it wanders off for longer than this, which means it's trail OSM lacks

let usfsAdded = 0;
const usfsDuplicates = [];
for (const f of usfs.features) {
  const p = f.properties;
  if (p.trail_type !== 'TERRA' || !p.trail_name || MOTORIZED.test(p.trail_name)) continue;
  if (p.terra_motorized === 'Y' || isOn(p.motorcycle_managed) || isOn(p.fourwd_managed) || isOn(p.atv_managed)) continue;
  const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const line of lines) {
    const pts = line.map(([lon, lat]) => project(lon, lat));
    if (pts.length < 2 || !inBasinLine(pts)) continue;
    const dense = densify(pts, 25);
    const matches = dense.map(([x, y]) => nearestOsm(x, y, 45));
    const covered = matches.filter(Boolean).length / dense.length;
    // Mark matching OSM segments as confirmed by the official inventory
    for (const m of matches) if (m) m.official = true;
    if (covered > 0.6) continue;
    // The USFS and OSM lines for the same trail can run tens of meters apart. If OSM has a
    // trail by this name and this line follows it closely, never straying more than a few
    // hundred meters, it's the same trail drawn differently and OSM's version wins. A longer
    // stray stretch is trail OSM doesn't have (a gap in the Rim Trail, say), so it's kept.
    const sameName = osmByName.get(normName(titleCase(p.trail_name.trim())));
    if (sameName) {
      let stray = 0;
      let longestStray = 0;
      let near = 0;
      for (const [x, y] of dense) {
        const close = sameName.some(([ox, oy]) => Math.hypot(ox - x, oy - y) < SAME_TRAIL_RADIUS);
        if (close) near++;
        stray = close ? 0 : stray + 25;
        longestStray = Math.max(longestStray, stray);
      }
      if (near / dense.length > 0.6 && longestStray < MAX_STRAY) {
        usfsDuplicates.push(titleCase(p.trail_name.trim()));
        continue;
      }
    }
    const mid = pts[Math.floor(pts.length / 2)];
    const wild = inWilderness(mid[0], mid[1]);
    let bike = null;
    if (isOn(p.bicycle_managed) || isOn(p.bicycle_accpt) || isOn(p.bicycle_accpt_disc)) bike = true;
    else if (isOn(p.bicycle_restricted)) bike = false;
    const bikeInferred = bike === null;
    if (bike === null) bike = false; // White Mountain hiking routes are assumed hiking-only unless explicit data says otherwise
    if (wild) bike = false;
    segments.push({
      name: titleCase(p.trail_name.trim()),
      pts,
      hike: !isOn(p.hiker_pedestrian_restricted),
      bike,
      bikeInferred,
      mtbScale: null,
      sacScale: null,
      surface: p.trail_surface ? titleCase(p.trail_surface) : null,
      operator: 'USFS',
      trailClass: p.trail_class ?? null,
      source: 'usfs',
      official: true,
    });
    usfsAdded++;
  }
}
console.log(`  ${usfsAdded} USFS segments added where OSM lacks coverage`);
console.log(`  skipped USFS lines that duplicate OSM trails: ${[...new Set(usfsDuplicates)].sort().join(', ')}`);

// Group segments into named trails (same name + spatially connected)
const byName = new Map();
for (const s of segments) {
  const k = normName(s.name);
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(s);
}

function components(segs, tol) {
  const parent = segs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (find(i) === find(j)) continue;
      const a = segs[i].pts;
      const b = segs[j].pts;
      let near = false;
      for (const p of [a[0], a[a.length - 1]]) {
        for (const q of b) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < tol) near = true;
      }
      for (const p of [b[0], b[b.length - 1]]) {
        for (const q of a) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < tol) near = true;
      }
      if (near) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  segs.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  });
  return [...groups.values()];
}

// Chain segments that share endpoints into longer polylines
function chain(segs) {
  const lines = segs.map((s) => s.pts.slice());
  const close = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 3;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines.length; j++) {
        if (i === j) continue;
        const a = lines[i];
        const b = lines[j];
        let joined = null;
        if (close(a[a.length - 1], b[0])) joined = a.concat(b.slice(1));
        else if (close(a[a.length - 1], b[b.length - 1])) joined = a.concat(b.slice().reverse().slice(1));
        else if (close(a[0], b[b.length - 1])) joined = b.concat(a.slice(1));
        if (joined) {
          lines[i] = joined;
          lines.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return lines;
}

const MTB_LABEL = { 0: 'Easy', 1: 'Intermediate', 2: 'Difficult', 3: 'Very difficult', 4: 'Extreme', 5: 'Extreme', 6: 'Extreme' };
const SAC_LABEL = {
  hiking: 'Easy hiking',
  mountain_hiking: 'Mountain hiking',
  demanding_mountain_hiking: 'Demanding',
  alpine_hiking: 'Alpine',
  demanding_alpine_hiking: 'Demanding alpine',
};

// Densify polylines, drape them on the DEM, and total up distance and climbing.
function measure(lines) {
  let length = 0;
  let gain = 0;
  let loss = 0;
  let lo = Infinity;
  let hi = -Infinity;
  const outLines = [];
  for (const line of lines) {
    const dense = densify(simplify(line, 3), 20);
    length += lineLength(dense);
    const eles = dense.map(([x, y]) => demAt(x, y));
    // Hysteresis-filtered climbing so DEM noise doesn't inflate gain
    let ref = eles[0];
    for (const e of eles) {
      lo = Math.min(lo, e);
      hi = Math.max(hi, e);
      if (e - ref > 4) {
        gain += e - ref;
        ref = e;
      } else if (ref - e > 4) {
        loss += ref - e;
        ref = e;
      }
    }
    outLines.push(dense.flatMap(([x, y], i) => [Math.round(x), Math.round(y), Math.round(eles[i])]));
  }
  return { outLines, length, gain, loss, lo, hi };
}

// Bikes are prohibited on the Appalachian Trail and in wilderness.
for (const s of segments) {
  if (/appalachian|franconia ridge|kinsman ridge/i.test(s.name)) {
    s.bike = false;
    s.bikeInferred = false;
  }
}

const trails = [];
for (const [key, segs] of byName) {
  const groups = LONG_DISTANCE.test(key) ? [segs] : components(segs, 250);
  for (const group of groups) {
    const { outLines, length, gain, loss, lo, hi } = measure(chain(group));
    if (length < 150) continue;
    // Pick the most common spelling as the display name
    const counts = new Map();
    for (const s of group) {
      const n = s.name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
      const w = lineLength(s.pts) * (s.source === 'osm' ? 1.5 : 1);
      counts.set(n, (counts.get(n) || 0) + w);
    }
    let name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (LONG_DISTANCE.test(name)) name = titleCase(key);
    const lenWeighted = (pred) => group.filter(pred).reduce((a, s) => a + lineLength(s.pts), 0) / group.reduce((a, s) => a + lineLength(s.pts), 0);
    const bikeShare = lenWeighted((s) => s.bike);
    const mtb = group.map((s) => s.mtbScale).filter((v) => v != null).map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
    const sac = group.map((s) => s.sacScale).filter(Boolean);
    const surfaces = [...new Set(group.map((s) => s.surface).filter(Boolean))];
    const operators = [...new Set(group.map((s) => s.operator).filter(Boolean))];
    trails.push({
      name,
      hike: group.some((s) => s.hike),
      bike: bikeShare > 0.5,
      bikePartial: bikeShare > 0.05 && bikeShare <= 0.5,
      bikeInferred: group.every((s) => s.bikeInferred || !s.bike),
      difficulty: mtb.length ? MTB_LABEL[Math.max(...mtb)] : null,
      mtbScale: mtb.length ? Math.max(...mtb) : null,
      hikeDifficulty: sac.length ? SAC_LABEL[sac.sort()[0]] ?? null : null,
      surface: surfaces.slice(0, 2).join(', ') || null,
      operator: operators.slice(0, 2).join(' · ') || null,
      official: group.some((s) => s.official),
      sources: [...new Set(group.map((s) => s.source))],
      wilderness: group.some((s) => inWilderness(s.pts[0][0], s.pts[0][1])),
      lengthMi: Math.round((length / 1609.34) * 10) / 10,
      gainFt: Math.round(gain * 3.28084),
      lossFt: Math.round(loss * 3.28084),
      minFt: Math.round(lo * 3.28084),
      maxFt: Math.round(hi * 3.28084),
      lines: outLines,
    });
  }
}
for (let i = trails.length - 1; i >= 0; i--) {
  if (EXCLUDED_TRAILS.has(trails[i].name)) {
    console.log(`  dropping ${trails[i].name} (${EXCLUDED_TRAILS.get(trails[i].name)})`);
    trails.splice(i, 1);
  }
}
trails.sort((a, b) => a.name.localeCompare(b.name) || b.lengthMi - a.lengthMi);
// Disambiguate duplicate names with a location hint
const nameCount = new Map();
for (const t of trails) nameCount.set(t.name, (nameCount.get(t.name) || 0) + 1);
const towns = labels.filter((l) => l.kind === 'town' || l.kind === 'village');
trails.forEach((t, i) => {
  t.id = i;
  if (nameCount.get(t.name) > 1) {
    const [x, y] = t.lines[0];
    const near = towns.reduce((a, b) => (Math.hypot(a.x - x, a.y - y) < Math.hypot(b.x - x, b.y - y) ? a : b));
    t.area = `near ${near.name}`;
  }
});
console.log(`  ${trails.length} trails, ${trails.reduce((a, t) => a + t.lengthMi, 0).toFixed(0)} miles total`);

// ---------------------------------------------------------------------------
// 5. Planned changes

console.log('Planned changes');
const plans = [];
const trailheads = [];
console.log('  no Franconia Notch future trail overlay configured');

// ---------------------------------------------------------------------------
// 6. Context roads: a few named roads that matter for getting to trails

console.log('Context roads');
const roadNames = CONTEXT_ROADS.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const osmRoads = JSON.parse(
  await cached('roads.json', () =>
    overpass(`[out:json][timeout:60];
way["highway"]["name"~"^(${roadNames})$"](${ctxBox});
out tags geom;`),
  ),
);
const roads = [];
for (const name of CONTEXT_ROADS) {
  const ways = osmRoads.elements.filter((w) => w.tags.name === name);
  if (!ways.length) {
    console.warn(`  warning: no road named ${name} in OpenStreetMap`);
    continue;
  }
  const { outLines, length, gain, loss, lo, hi } = measure(chain(ways.map((w) => ({ pts: w.geometry.map((p) => project(p.lon, p.lat)) }))));
  const longest = outLines.reduce((a, b) => (b.length > a.length ? b : a));
  const mid = Math.floor(longest.length / 6) * 3;
  const paved = ways.some((w) => /asphalt|paved|concrete/.test(w.tags.surface ?? ''));
  roads.push({
    name,
    surface: paved ? 'paved' : 'dirt',
    lengthMi: Math.round((length / 1609.34) * 10) / 10,
    gainFt: Math.round(gain * 3.28084),
    lossFt: Math.round(loss * 3.28084),
    minFt: Math.round(lo * 3.28084),
    maxFt: Math.round(hi * 3.28084),
    lines: outLines,
  });
  labels.push({ kind: 'road', name, x: longest[mid], y: longest[mid + 1] });
  console.log(`  ${name}: ${roads.at(-1).lengthMi} mi, ${roads.at(-1).surface}`);
}

// ---------------------------------------------------------------------------
// 7. Write

const map = {
  bbox: BBOX,
  widthM: Math.round(WIDTH_M),
  heightM: Math.round(HEIGHT_M),
  grid: { width: gridW, height: gridH, spacing: GRID_SPACING, scale: 4 },
  elevation: { min: Math.round(minEle), max: Math.round(maxEle) },
  basin: simplify(basinRing, 25).map(([x, y]) => [Math.round(x), Math.round(y)]),
  lakes,
  wilderness,
  roads,
  labels,
  attribution: [
    'Trails © OpenStreetMap contributors (ODbL)',
    'USDA Forest Service National Forest System Trails',
    'Franconia Notch State Park boundary © OpenStreetMap contributors',
    'Elevation: AWS Terrain Tiles (USGS 3DEP, SRTM)',
  ],
};
fs.writeFileSync(path.join(OUT, 'map.json'), JSON.stringify(map));
fs.writeFileSync(path.join(OUT, 'trails.json'), JSON.stringify(trails));
fs.writeFileSync(
  path.join(OUT, 'future.json'),
  JSON.stringify({
    project: 'Franconia Notch planned trails',
    decision: null,
    source: null,
    plans,
    trailheads,
  }),
);
for (const f of ['terrain.bin', 'map.json', 'trails.json', 'future.json']) {
  console.log(`  ${f}: ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} KB`);
}
