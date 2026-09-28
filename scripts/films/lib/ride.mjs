// Shared timeline for "ride" films: open close on a peak with east at the top of the frame,
// pull back to show the whole route, then a hiker moves along it leg by leg while the gold
// line draws on behind them, pausing at named stops. Ends by pulling back to the full route.
//
// Times below are at 1× speed; `speed` plays everything faster except the final hold.

const TRIMMER_PEAK = [-71.644, 44.1608];
const EAST_UP = -Math.PI / 2; // camera to the west, looking east

// --- easing and interpolation
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const smooth = (x) => x * x * (3 - 2 * x);
const progress = ([a, b], t) => clamp01((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const lerpView = (a, b, k) => ({
  target: a.target.map((v, i) => lerp(v, b.target[i], k)),
  zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), k)),
  azimuth: lerp(a.azimuth, b.azimuth, k),
  polar: lerp(a.polar, b.polar, k),
});
const fade = (t, [a, b], inDur, outDur) => clamp01((t - a) / inDur) * clamp01((b - t) / outDur);
const fmt = (n) => n.toLocaleString();

/**
 * @param {object} o
 * @param {string} o.title                 summary caption at the end
 * @param {{name?: string, from?: number[], to: number[], label?: string}[]} o.route  legs (see setRoute);
 *        a part with no name is a straight connector to `to`
 * @param {{afterLeg: number, label: string, seconds?: number}[]} [o.stops]  pauses at the end of a
 *        named leg (counting only named legs)
 * @param {number} [o.speed]               playback speed (2 = twice as fast)
 * @param {number} [o.finalHold]           seconds on the last shot, at any speed
 * @param {number} [o.secondsPerMile]      riding pace on the flat, at 1×
 * @param {number} [o.riderPx]             rider size on screen (1080p pixels)
 */
export function ride(o) {
  const speed = o.speed ?? 2;
  const finalHold = o.finalHold ?? 3.5;
  const secondsPerMile = o.secondsPerMile ?? 3.5;
  const riderPx = o.riderPx ?? 44;
  const pad = { left: 140, right: 140, top: 90, bottom: 250 }; // leaves room for captions

  return async function setup({ film, captions }) {
    const stats = await film('setRoute', o.route);
    const named = o.route.filter((part) => part.name); // connector-only parts have no leg
    const legs = stats.legs.map((leg, i) => ({ ...leg, label: named[i].label ?? leg.name }));
    const peak = await film('pointView', ...TRIMMER_PEAK, 7, EAST_UP);
    const whole = await film('routeView', pad, EAST_UP);

    // Pre-sample the route so the timeline is pure math
    const N = 800;
    const targets = [];
    for (let i = 0; i <= N; i++) targets.push(await film('routeTarget', i / N));
    const ele = await film('routeProfile', N);
    const targetAt = (u) => {
      const f = clamp01(u) * N;
      const i = Math.min(N - 1, Math.floor(f));
      return targets[i].map((v, k) => lerp(v, targets[i + 1][k], f - i));
    };

    // Effort along the route: climbing is slower than the flat, descending faster
    const stepMiles = stats.miles / N;
    const effort = [0];
    for (let i = 1; i <= N; i++) {
      const grade = (ele[i] - ele[i - 1]) / (stepMiles * 1609.34);
      const pace = grade > 0.02 ? 1.2 : grade < -0.02 ? 0.85 : 1;
      effort.push(effort[i - 1] + stepMiles * pace);
    }
    const uForEffort = (e) => {
      let i = 1;
      while (i < N && effort[i] < e) i++;
      return (i - 1 + (e - effort[i - 1]) / (effort[i] - effort[i - 1] || 1)) / N;
    };
    const effortAt = (u) => {
      const f = clamp01(u) * N;
      const i = Math.min(N - 1, Math.floor(f));
      return lerp(effort[i], effort[i + 1], f - i);
    };

    // --- the schedule: intro, then ride sections split by stops, then the pull-back
    const INTRO = { holdPeak: [0, 2.5], toRoute: [2.5, 6.5] };
    const rideStart = 7.5;
    const stops = (o.stops ?? []).map((s) => ({ ...s, u: legs[s.afterLeg].uEnd, seconds: s.seconds ?? 1.5 }));
    const cuts = [0, ...stops.map((s) => s.u), 1];
    const sections = []; // { t0, t1, u0, u1 } riding, then pauses between
    const pauses = [];
    let t = rideStart;
    for (let i = 0; i < cuts.length - 1; i++) {
      const duration = (effortAt(cuts[i + 1]) - effortAt(cuts[i])) * secondsPerMile;
      sections.push({ t0: t, t1: t + duration, u0: cuts[i], u1: cuts[i + 1] });
      t += duration;
      if (stops[i]) {
        pauses.push({ ...stops[i], t0: t, t1: t + stops[i].seconds });
        t += stops[i].seconds;
      }
    }
    const rideEnd = t;
    const pullBack = [rideEnd, rideEnd + 3];
    const sceneEnd = pullBack[1] + finalHold * speed; // the hold is measured at 1×, then sped up

    const riderU = (time) => {
      if (time <= rideStart) return 0;
      for (const s of sections) {
        if (time < s.t1) {
          if (time < s.t0) return s.u0; // paused at the stop before this section
          const e0 = effortAt(s.u0);
          const e1 = effortAt(s.u1);
          return uForEffort(lerp(e0, e1, ease(progress([s.t0, s.t1], time))));
        }
      }
      return 1;
    };
    const timeAtU = (u) => {
      for (const s of sections) {
        if (u <= s.u1) {
          // invert the eased section by bisection
          let lo = s.t0;
          let hi = s.t1;
          for (let k = 0; k < 30; k++) {
            const mid = (lo + hi) / 2;
            if (riderU(mid) < u) lo = mid;
            else hi = mid;
          }
          return (lo + hi) / 2;
        }
      }
      return rideEnd;
    };

    // Captions: each leg as the rider starts it, each stop while paused, then a summary
    const events = [];
    legs.forEach((leg) => {
      const up = leg.gainFt >= leg.lossFt;
      events.push({
        start: timeAtU(leg.uStart) - 0.3,
        len: 4.4,
        title: leg.label,
        subtitle: up ? `${leg.miles} mi · ↗ ${fmt(leg.gainFt)}′ of climbing` : `${leg.miles} mi · ↘ ${fmt(leg.lossFt)}′ of descent`,
      });
    });
    pauses.forEach((p) => events.push({ start: p.t0 - 0.3, len: p.seconds + 1.6, title: p.label, subtitle: `${fmt(legs[p.afterLeg].endFt)}′` }));
    events.push({
      start: pullBack[0] + 0.6,
      len: Infinity,
      title: o.title,
      subtitle: `${stats.miles} miles · ↗ ${fmt(stats.gainFt)}′ up · ↘ ${fmt(stats.lossFt)}′ down`,
    });
    events.sort((a, b) => a.start - b.start);
    events.forEach((e, i) => (e.end = Math.min(e.start + e.len, events[i + 1] ? events[i + 1].start - 0.1 : Infinity)));

    // While riding, frame halfway between the whole route and the rider, a bit closer in
    const rideView = (u) => ({
      target: whole.target.map((v, i) => lerp(v, targetAt(u)[i], 0.6)),
      zoom: whole.zoom * 1.9,
      azimuth: EAST_UP,
      polar: whole.polar,
    });

    const scene = (time) => {
      const u = riderU(time);
      let view;
      if (time < INTRO.toRoute[0]) view = { ...peak, zoom: peak.zoom * (1 + 0.04 * smooth(time / INTRO.toRoute[0])) };
      else if (time < rideStart) view = lerpView({ ...peak, zoom: peak.zoom * 1.04 }, whole, ease(progress(INTRO.toRoute, time)));
      else if (time < pullBack[0]) view = lerpView(whole, rideView(u), smooth(progress([rideStart, rideStart + 2], time)));
      else view = lerpView(rideView(1), whole, ease(progress(pullBack, time)));

      const preview = smooth(progress([INTRO.toRoute[1] - 1.5, INTRO.toRoute[1]], time));
      const riderIn = smooth(progress([rideStart - 0.6, rideStart], time));
      const riderOut = 1 - smooth(progress([pullBack[1] - 0.5, pullBack[1] + 0.5], time));
      const focus = 0.5 * smooth(progress([INTRO.toRoute[0] + 1, INTRO.toRoute[1]], time));

      let caption;
      if (captions) {
        const e = events.find((e) => time >= e.start && time <= e.end);
        if (e) caption = { title: e.title, subtitle: e.subtitle, opacity: fade(time, [e.start, e.end], 0.6, 0.6) };
      }
      return { time, view, route: { reveal: u, preview, riderPx: riderPx * riderIn * riderOut }, focus, caption };
    };

    return {
      duration: pullBack[1] / speed + finalHold,
      at: (t) => scene(Math.min(t * speed, sceneEnd)),
      info: { stats, legs, rideSeconds: (rideEnd - rideStart) / speed },
    };
  };
}
