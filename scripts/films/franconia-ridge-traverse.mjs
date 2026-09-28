// Falling Waters Trail → Franconia Ridge Trail → Greenleaf Trail → Old Bridle Path
// A hiking traverse over Little Haystack, Lincoln, and Lafayette, then down past Greenleaf Hut.

import { ride } from './lib/ride.mjs';

export const setup = ride({
  title: 'Franconia Ridge Traverse',
  speed: 2.2,
  secondsPerMile: 4.0,
  riderPx: 42,
  route: [
    { name: 'Falling Waters Trail', from: [-71.6817, 44.1418], to: [-71.6452, 44.1402], label: 'Falling Waters Trail' },
    { name: 'Franconia Ridge Trail', from: [-71.6452, 44.1402], to: [-71.6440, 44.1608], label: 'Franconia Ridge' },
    { name: 'Greenleaf Trail', from: [-71.6440, 44.1608], to: [-71.6619, 44.1604], label: 'Greenleaf Trail' },
    { name: 'Old Bridle Path', from: [-71.6619, 44.1604], to: [-71.6817, 44.1418], label: 'Old Bridle Path' },
  ],
  stops: [
    { afterLeg: 0, label: 'Little Haystack', seconds: 1.2 },
    { afterLeg: 1, label: 'Mount Lafayette', seconds: 1.4 },
    { afterLeg: 2, label: 'Greenleaf Hut', seconds: 1.2 },
  ],
});
