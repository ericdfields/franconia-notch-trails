const assert = require('node:assert/strict');
const map = require('../public/data/map.json');
const trails = require('../public/data/trails.json');

const byName = new Map(trails.map((trail) => [trail.name, trail]));

for (const name of ['Franconia Ridge Trail', 'Falling Waters Trail', 'Old Bridle Path', 'Greenleaf Trail', 'Lonesome Lake Trail', 'Kinsman Ridge Trail']) {
  assert.ok(byName.has(name), `expected key Franconia hiking route: ${name}`);
}

for (const name of ['Almost All Downhill', 'Doctor No', 'Rough Cut', 'Bickford XC ski trail', 'Scarface XC ski trail', 'Franconia Notch Recreation Path', 'Pemi Trail']) {
  assert.ok(!byName.has(name), `expected non-hiking/bike-park route to be excluded: ${name}`);
}

for (const name of ['Mount Lafayette', 'Mount Lincoln', 'Mount Liberty', 'Mount Flume', 'Cannon Mountain', 'Echo Lake', 'Profile Lake', 'The Basin', 'Pemigewasset River']) {
  assert.ok(map.labels.some((label) => label.name === name), `expected landmark label: ${name}`);
}

assert.deepEqual(map.bbox, { west: -71.81, east: -71.58, south: 44.06, north: 44.205 });
assert.ok(trails.length >= 60 && trails.length <= 120, `unexpected trail count after exclusions: ${trails.length}`);
assert.ok(trails.every((trail) => !/Appalachian|Franconia Ridge|Kinsman Ridge/i.test(trail.name) || !trail.bike), 'ridge/Appalachian routes must not allow bikes');

console.log(`data smoke ok: ${trails.length} trails`);
