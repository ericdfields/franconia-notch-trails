import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { Terrain, Trail, toWorld } from './data';

export const COLORS = {
  bike: new THREE.Color('#d2532c'), // vermilion: open to bikes
  hike: new THREE.Color('#6a3d6e'), // plum: foot traffic only
  selected: new THREE.Color('#f2b632'),
  halo: new THREE.Color('#fffaf0'),
};

// Optional planned trail overlay colors. Hex values are mirrored in style.css.
export const PLAN_COLORS = {
  ebike: '#c92f7b', // raspberry: new trail open to bikes + Class 1 e-bikes
  nonmoto: '#3b4fb5', // indigo: new non-motorized trail (no e-bikes)
  moto: '#a8651a', // amber: new motorcycle trail
  designate: '#16949f', // teal: existing trail newly open to e-bikes
  decommission: '#8a8078', // grey: to be removed
};

const LIFT = 0.12; // world units above the ground so lines don't sink into the mesh

export type Filter = 'all' | 'hike' | 'bike';
export type PlanGroup = 'new' | 'designate' | 'decommission';

interface Style {
  color: THREE.Color;
  width: number;
  dashed: boolean;
  /** a darker, wider line underneath, like the edges of a road on a paper map */
  casing?: THREE.Color;
  /** a wide translucent wash under the line, like a highlighter stroke of paint */
  wash: boolean;
  renderOrder: number;
}

export function planGroup(t: Trail): PlanGroup | null {
  if (!t.plan) return null;
  if (t.plan.kind === 'decommission') return 'decommission';
  return t.plan.kind === 'designate' ? 'designate' : 'new';
}

function styleKey(t: Trail): string {
  if (t.road) return 'road';
  if (!t.plan) return t.bike ? 'bike' : 'hike';
  const group = planGroup(t)!;
  if (group !== 'new') return group === 'designate' && t.plan.mode === 'moto' ? 'moto-designate' : group;
  return t.plan.mode === 'ebike' ? 'ebike' : t.plan.mode === 'moto' ? 'moto' : 'nonmoto';
}

const STYLES: Record<string, Style> = {
  road: { color: new THREE.Color('#f4ead6'), casing: new THREE.Color('#7c6858'), width: 2, dashed: false, wash: false, renderOrder: 0.5 },
  bike: { color: COLORS.bike, width: 2, dashed: false, wash: false, renderOrder: 1 },
  hike: { color: COLORS.hike, width: 2, dashed: true, wash: false, renderOrder: 1 },
  ebike: { color: new THREE.Color(PLAN_COLORS.ebike), width: 3.2, dashed: true, wash: true, renderOrder: 3 },
  nonmoto: { color: new THREE.Color(PLAN_COLORS.nonmoto), width: 3.2, dashed: true, wash: true, renderOrder: 3 },
  moto: { color: new THREE.Color(PLAN_COLORS.moto), width: 3.2, dashed: true, wash: true, renderOrder: 3 },
  designate: { color: new THREE.Color(PLAN_COLORS.designate), width: 2.6, dashed: false, wash: true, renderOrder: 2 },
  'moto-designate': { color: new THREE.Color(PLAN_COLORS.moto), width: 2.6, dashed: false, wash: true, renderOrder: 2 },
  decommission: { color: new THREE.Color(PLAN_COLORS.decommission), width: 2.2, dashed: true, wash: false, renderOrder: 2 },
};

export function trailColor(t: Trail): THREE.Color {
  return STYLES[styleKey(t)].color;
}

export class TrailLayer {
  readonly group = new THREE.Group();
  private world: Float32Array[][] = []; // per trail, per line: flat xyz
  private base = new Map<string, { line: LineSegments2; wash?: LineSegments2; casing?: LineSegments2 }>();
  private hover: { halo: LineSegments2; line: LineSegments2 };
  private selected: { halo: LineSegments2; line: LineSegments2 };
  private materials: LineMaterial[] = [];
  private projected: { trail: number; pts: Float32Array }[] = [];
  private projectedFor = '';
  filter: Filter = 'all';
  /** Which planned-change groups are shown; empty means the plan overlay is off */
  plans = new Set<PlanGroup>();

  constructor(
    readonly trails: Trail[],
    terrain: Terrain,
  ) {
    const map = terrain.map;
    for (const t of trails) {
      this.world.push(
        t.lines.map((line) => {
          const out = new Float32Array((line.length / 3) * 3);
          for (let i = 0; i < line.length; i += 3) {
            const x = line[i];
            const y = line[i + 1];
            const [wx, wy, wz] = toWorld(map, x, y, terrain.heightAt(x, y));
            out[i] = wx;
            out[i + 1] = wy + LIFT;
            out[i + 2] = wz;
          }
          return out;
        }),
      );
    }

    for (const [key, st] of Object.entries(STYLES)) {
      const line = this.makeLines(this.material(st.color, st.width, 0.95, st.dashed), st.renderOrder);
      if (st.wash) Object.assign(line.material, { dashSize: 2.2, gapSize: 0.9 }); // long "proposed" dashes
      if (key === 'decommission') Object.assign(line.material, { dashSize: 0.35, gapSize: 0.65 }); // dotted
      // Opaque pale tint rather than a translucent stroke: overlapping segments would stack alpha into blobs
      const tint = st.color.clone().lerp(COLORS.halo, 0.68);
      const wash = st.wash ? this.makeLines(this.material(tint, st.width * 2.6, 1), st.renderOrder - 0.5) : undefined;
      if (wash) {
        // Same pass as the (translucent) core line, so renderOrder puts the wash underneath it
        wash.material.transparent = true;
        wash.material.depthWrite = false;
      }
      const casing = st.casing ? this.makeLines(this.material(st.casing, st.width + 2.4, 1), st.renderOrder - 0.1) : undefined;
      if (casing) {
        Object.assign(line.material, { transparent: false, opacity: 1 });
        // The casing mustn't occlude the fill where neighboring segments meet at slightly different depths
        casing.material.depthWrite = false;
      }
      this.base.set(key, { line, wash, casing });
    }
    this.hover = {
      halo: this.makeLines(this.material(COLORS.halo, 9, 0.85), 5),
      line: this.makeLines(this.material(COLORS.bike, 4.5, 1), 6),
    };
    this.selected = {
      halo: this.makeLines(this.material(COLORS.halo, 11, 0.95), 7),
      line: this.makeLines(this.material(COLORS.selected, 5.5, 1), 8),
    };
    // Highlights draw on top of everything; keeping them all in the transparent pass
    // makes renderOrder (halo, then line) hold.
    for (const l of [this.hover.halo, this.hover.line, this.selected.halo, this.selected.line]) {
      l.material.depthTest = false;
      l.material.transparent = true;
    }
    this.rebuildBase();
  }

  private material(color: THREE.Color, width: number, opacity: number, dashed = false) {
    const m = new LineMaterial({
      color: color.getHex(),
      linewidth: width,
      transparent: opacity < 1,
      opacity,
      dashed,
      dashSize: 1,
      gapSize: 0.6,
      worldUnits: false,
    });
    this.materials.push(m);
    return m;
  }

  private makeLines(material: LineMaterial, renderOrder = 1) {
    const l = new LineSegments2(new LineSegmentsGeometry(), material);
    l.renderOrder = renderOrder;
    l.frustumCulled = false;
    l.visible = false;
    this.group.add(l);
    return l;
  }

  /** Line segments for these trails. `reveal` < 1 keeps only that fraction of each trail, measured
   * along its length from the start (or from the end, with `reverse`), for "drawing on" a trail. */
  private segmentsFor(ids: number[], reveal = 1, reverse = false) {
    const out: number[] = [];
    for (const id of ids) {
      const lines = reverse ? [...this.world[id]].reverse() : this.world[id];
      let total = 0;
      for (const line of lines) for (let i = 0; i < line.length - 3; i += 3) total += segLength(line, i);
      let budget = total * reveal;
      for (const line of lines) {
        const idx = Array.from({ length: line.length / 3 - 1 }, (_, k) => k * 3);
        if (reverse) idx.reverse();
        for (const i of idx) {
          if (budget <= 0) break;
          const len = segLength(line, i);
          const [a, b] = reverse ? [i + 3, i] : [i, i + 3];
          const t = Math.min(1, budget / len);
          out.push(line[a], line[a + 1], line[a + 2]);
          for (let k = 0; k < 3; k++) out.push(line[a + k] + (line[b + k] - line[a + k]) * t);
          budget -= len;
        }
      }
    }
    return new Float32Array(out);
  }

  private setLines(l: LineSegments2, ids: number[], reveal = 1, reverse = false) {
    l.geometry.dispose();
    const g = new LineSegmentsGeometry();
    const segs = this.segmentsFor(ids, reveal, reverse);
    if (segs.length) {
      g.setPositions(segs);
      l.geometry = g;
      l.computeLineDistances();
    }
    l.visible = segs.length > 0;
  }

  matches(t: Trail) {
    if (t.road) return true; // context roads show under every filter
    const group = planGroup(t);
    if (group && !this.plans.has(group)) return false;
    // decommissioned trails aren't open to anyone, but they belong in every view of the plan
    if (group === 'decommission') return true;
    if (this.filter === 'bike') return t.bike || t.bikePartial;
    if (this.filter === 'hike') return t.hike;
    return true;
  }

  rebuildBase() {
    const byStyle = new Map<string, number[]>();
    for (const t of this.trails) {
      if (!this.matches(t)) continue;
      const key = styleKey(t);
      if (!byStyle.has(key)) byStyle.set(key, []);
      byStyle.get(key)!.push(t.id);
    }
    for (const [key, { line, wash, casing }] of this.base) {
      const ids = byStyle.get(key) ?? [];
      this.setLines(line, ids);
      if (wash) this.setLines(wash, ids);
      if (casing) this.setLines(casing, ids);
    }
    // Existing trails step back while the plan overlay is up
    const dim = this.plans.size > 0;
    for (const key of ['bike', 'hike']) this.base.get(key)!.line.material.opacity = dim ? 0.4 : 0.95;
    this.projectedFor = '';
  }

  setHover(id: number | null) {
    if (id === null) {
      this.hover.halo.visible = this.hover.line.visible = false;
      return;
    }
    this.hover.line.material.color.copy(trailColor(this.trails[id]));
    this.setLines(this.hover.halo, [id]);
    this.setLines(this.hover.line, [id]);
  }

  setSelected(id: number | null, reveal = 1, reverse = false) {
    if (id === null || reveal <= 0) {
      this.selected.halo.visible = this.selected.line.visible = false;
      return;
    }
    this.setLines(this.selected.halo, [id], reveal, reverse);
    this.setLines(this.selected.line, [id], reveal, reverse);
  }

  /** Fade the everyday trail lines (0 = normal, 1 = nearly gone), for spotlighting one trail */
  setBaseFade(f: number) {
    const base = this.plans.size > 0 ? 0.4 : 0.95;
    for (const key of ['bike', 'hike']) this.base.get(key)!.line.material.opacity = base * (1 - 0.75 * f);
  }

  /** Keep dashes a constant on-screen size as the camera zooms */
  setPixelsPerUnit(ppu: number) {
    for (const m of this.materials) if (m.dashed) m.dashScale = ppu / 7;
  }

  setResolution(w: number, h: number) {
    for (const m of this.materials) m.resolution.set(w, h);
  }

  bounds(id: number): THREE.Box3 {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const line of this.world[id]) {
      for (let i = 0; i < line.length; i += 3) box.expandByPoint(v.set(line[i], line[i + 1], line[i + 2]));
    }
    return box;
  }

  /** Nearest visible trail to a screen point (CSS px), within `radius` px. */
  pick(camera: THREE.Camera, sx: number, sy: number, width: number, height: number, radius = 9): number | null {
    const key = camera.matrixWorld.elements.join(',') + camera.projectionMatrix.elements.join(',') + width + height;
    if (key !== this.projectedFor) {
      this.project(camera, width, height);
      this.projectedFor = key;
    }
    let best: number | null = null;
    let bestD = radius * radius;
    for (const { trail, pts } of this.projected) {
      for (let i = 0; i < pts.length - 2; i += 2) {
        const ax = pts[i];
        const ay = pts[i + 1];
        const bx = pts[i + 2];
        const by = pts[i + 3];
        if (ax === -1e9 || bx === -1e9) continue;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / len2));
        const ex = ax + t * dx - sx;
        const ey = ay + t * dy - sy;
        const d = ex * ex + ey * ey;
        if (d < bestD) {
          bestD = d;
          best = trail;
        }
      }
    }
    return best;
  }

  private project(camera: THREE.Camera, width: number, height: number) {
    this.projected = [];
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = m.elements;
    for (const t of this.trails) {
      if (t.road || !this.matches(t)) continue; // roads aren't clickable
      for (const line of this.world[t.id]) {
        const out = new Float32Array((line.length / 3) * 2);
        for (let i = 0, j = 0; i < line.length; i += 3, j += 2) {
          const x = line[i];
          const y = line[i + 1];
          const z = line[i + 2];
          const w = e[3] * x + e[7] * y + e[11] * z + e[15];
          const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
          const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
          if (nx < -1.2 || nx > 1.2 || ny < -1.2 || ny > 1.2) {
            out[j] = out[j + 1] = -1e9;
            continue;
          }
          out[j] = ((nx + 1) / 2) * width;
          out[j + 1] = ((1 - ny) / 2) * height;
        }
        this.projected.push({ trail: t.id, pts: out });
      }
    }
  }
}

function segLength(line: Float32Array, i: number) {
  return Math.hypot(line[i + 3] - line[i], line[i + 4] - line[i + 1], line[i + 5] - line[i + 2]);
}
