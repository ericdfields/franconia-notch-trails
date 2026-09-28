# Where the data comes from

| Layer | Source |
| --- | --- |
| Region outline | OpenStreetMap Franconia Notch State Park boundary |
| Trails | OpenStreetMap Overpass + USDA Forest Service National Forest System Trails |
| Water, wilderness, parks, peaks, towns, roads | OpenStreetMap |
| Elevation | AWS Terrain Tiles Terrarium |

The pipeline lives in `scripts/build-data.mjs` and writes `public/data/`.

Trail selection keeps named trail-like paths in the Franconia Notch frame and drops paved bike/recreation paths, sidewalks, informal approaches, and motorized/winter routes. USFS White Mountain National Forest trails fill gaps where OSM lacks coverage.

Bike access is conservative for Franconia Notch: hiking-only unless OSM/USFS explicitly marks bicycle access. Wilderness and Appalachian Trail / Franconia Ridge / Kinsman Ridge segments are no-bike.

The region outline uses Franconia Notch State Park rather than a watershed because it gives the cleanest diorama silhouette for the Notch corridor while still framing the major adjacent ridge hikes.
