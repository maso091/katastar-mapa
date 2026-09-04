#!/usr/bin/env node
/**
 * Katastar mapa — čestice iz darovnog ugovora (Duić, K.O. Klanac / Kruščica / Pazarišta)
 *
 * Skida javne GML podatke DGU/OSS ATOM servisa (bez autentikacije):
 *   https://oss.uredjenazemlja.hr/oss/public/atom/ko-{MBR}.zip
 * filtrira tražene čestice, reprojicira EPSG:3765 (HTRS96/TM) -> WGS84
 * i generira parcels.geojson + map.html (Leaflet).
 *
 * KAKO NAĆI MATIČNI BROJ K.O.:
 *   Otvori https://katastar.hr -> pretraži katastarsku općinu (npr. "Klanac").
 *   Matični broj (6-znamenkasti) piše uz naziv KO. Upiši ga dolje u KO_CONFIG.
 *
 * Pokretanje:  node fetch-parcels.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const AdmZip = require("adm-zip");
const proj4 = require("proj4");

// HTRS96/TM (EPSG:3765) -> WGS84
proj4.defs(
  "EPSG:3765",
  "+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
);

// ─────────────────────────────────────────────────────────────
// KONFIGURACIJA — upiši matične brojeve KO (vidi uputu gore)
// ─────────────────────────────────────────────────────────────
const KO_CONFIG = [
  {
    name: "KLANAC",
    mbr: "310778",
    color: "#e74c3c",
    // Z.k.ul. 426 (1/10), 1213 (6/70), 1212 (1/40)
    parcels: [
      "1374/1", "1376/1", "1379/2", "1391/1", "1394/1", "1395/1",
      "1395/3", "1396/3", "1396/4", "1396/5", "1396/6", "1559/4",
      "1375/1", "1516/1",
    ],
  },
  {
    name: "KRUŠČICA",
    mbr: "310794",
    color: "#2980b9",
    // Posjedovni list 70
    parcels: [
      "37/3", "58", "60", "109/1", "110", "113", "145/2",
      "148/1", "148/2", "151/1", "154", "172/1", "193/3", "194/3",
    ],
  },
  {
    name: "GORNJE PAZARIŠTE",
    mbr: "310727",
    color: "#27ae60",
    parcels: ["45", "50", "52", "82/3"],
  },
];
// ─────────────────────────────────────────────────────────────

const OUT_DIR = __dirname;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0 (parcel-mapper)" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          return resolve(download(res.headers.location, dest));
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`HTTP ${res.statusCode} za ${url}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

/** Normalizira broj čestice: makne razmake, lowercase slova, "1376/1a" -> baza "1376/1" */
function normalize(label) {
  return String(label).trim().replace(/\s+/g, "").toLowerCase();
}
function baseNumber(label) {
  // stari brojevi tipa 1376/1a, 172/1b — usporedi i po bazi bez slovnog sufiksa
  const m = normalize(label).match(/^(\d+(?:\/\d+)?)/);
  return m ? m[1] : normalize(label);
}

/** Grubi ali robustan parser INSPIRE CadastralParcel GML-a */
function parseGml(gmlText) {
  const parcels = [];
  const featureRe = /<(?:\w+:)?CadastralParcel\b[\s\S]*?<\/(?:\w+:)?CadastralParcel>/g;
  const labelRe = /<(?:\w+:)?label>([\s\S]*?)<\/(?:\w+:)?label>/;
  const refRe = /<(?:\w+:)?nationalCadastralReference>([\s\S]*?)<\/(?:\w+:)?nationalCadastralReference>/;
  const posListRe = /<(?:\w+:)?posList[^>]*>([\s\S]*?)<\/(?:\w+:)?posList>/g;

  let f;
  while ((f = featureRe.exec(gmlText)) !== null) {
    const block = f[0];
    const label = (labelRe.exec(block) || refRe.exec(block) || [null, ""])[1].trim();
    const rings = [];
    let p;
    while ((p = posListRe.exec(block)) !== null) {
      const nums = p[1].trim().split(/\s+/).map(Number);
      const ring = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        // GML u EPSG:3765 obično dolazi kao (E, N); ako je (N, E), swap ispod
        let [a, b] = [nums[i], nums[i + 1]];
        // heuristika: easting u HR je ~250k–750k, northing ~4.7M–5.15M
        const [e, n] = a > 1000000 ? [b, a] : [a, b];
        const [lon, lat] = proj4("EPSG:3765", "WGS84", [e, n]);
        ring.push([+lon.toFixed(7), +lat.toFixed(7)]);
      }
      if (ring.length >= 3) rings.push(ring);
    }
    if (label && rings.length) parcels.push({ label, rings });
  }
  return parcels;
}

async function processKo(ko) {
  if (!/^\d+$/.test(ko.mbr)) {
    console.warn(`⚠ ${ko.name}: matični broj nije upisan — preskačem. Nađi ga na katastar.hr i upiši u KO_CONFIG.`);
    return [];
  }
  const zipPath = path.join(OUT_DIR, `ko-${ko.mbr}.zip`);
  if (!fs.existsSync(zipPath)) {
    const url = `https://oss.uredjenazemlja.hr/oss/public/atom/ko-${ko.mbr}.zip`;
    console.log(`↓ ${ko.name}: ${url}`);
    await download(url, zipPath);
  } else {
    console.log(`✓ ${ko.name}: koristim cached ${zipPath}`);
  }

  const zip = new AdmZip(zipPath);
  const entry = zip
    .getEntries()
    .find((e) => /katastarske_cestice.*\.gml$/i.test(e.entryName));
  if (!entry) throw new Error(`${ko.name}: katastarske_cestice.gml nije u ZIP-u`);
  const all = parseGml(zip.readAsText(entry));
  console.log(`  ${ko.name}: ${all.length} čestica u KO`);

  const wantedExact = new Set(ko.parcels.map(normalize));
  const wantedBase = new Set(ko.parcels.map(baseNumber));

  const features = [];
  const found = new Set();
  for (const p of all) {
    const nl = normalize(p.label);
    const nb = baseNumber(p.label);
    const exact = wantedExact.has(nl);
    const partial = !exact && wantedBase.has(nb);
    if (!exact && !partial) continue;
    found.add(exact ? nl : nb);
    features.push({
      type: "Feature",
      properties: {
        ko: ko.name,
        cestica: p.label,
        match: exact ? "exact" : "base-match (provjeri sufiks!)",
        color: ko.color,
      },
      geometry:
        p.rings.length === 1
          ? { type: "Polygon", coordinates: p.rings }
          : { type: "MultiPolygon", coordinates: p.rings.map((r) => [r]) },
    });
  }

  const missing = ko.parcels.filter(
    (w) => !found.has(normalize(w)) && !found.has(baseNumber(w))
  );
  if (missing.length)
    console.warn(`  ⚠ ${ko.name}: nisu nađene: ${missing.join(", ")} (moguće preimenovane u novoj izmjeri — provjeri na katastar.hr)`);
  console.log(`  ✓ ${ko.name}: mapirano ${features.length} čestica`);
  return features;
}

function buildMap(features) {
  const geojson = { type: "FeatureCollection", features };
  fs.writeFileSync(path.join(OUT_DIR, "parcels.geojson"), JSON.stringify(geojson, null, 1));

  const html = `<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Katastarske čestice — darovni ugovor</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html,body,#map{height:100%;margin:0}
  .legend{background:#fff;padding:8px 12px;border-radius:6px;box-shadow:0 1px 5px rgba(0,0,0,.4);font:13px/1.5 sans-serif}
  .legend i{width:12px;height:12px;display:inline-block;margin-right:6px;border-radius:2px}
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const data = ${JSON.stringify(geojson)};

const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap'});
const map = L.map('map', {layers:[osm]});

// DGU INSPIRE WMS — službeni katastarski plan kao podloga (javno, bez tokena)
const dkp = L.tileLayer.wms('https://api.uredjenazemlja.hr/services/inspire/cp_wms/wms', {
  layers: 'CP.CadastralParcel,CP.CadastralZoning',
  format: 'image/png', transparent: true, maxZoom: 20, attribution: 'DGU'
});

const layer = L.geoJSON(data, {
  style: f => ({color:f.properties.color, weight:2, fillOpacity:.35}),
  onEachFeature: (f,l) => l.bindPopup(
    '<b>K.O. '+f.properties.ko+'</b><br>čest.kat.br. <b>'+f.properties.cestica+'</b><br><small>'+f.properties.match+'</small>'
  ).bindTooltip(f.properties.cestica, {permanent:true, direction:'center', className:'plabel'})
}).addTo(map);

if (data.features.length) map.fitBounds(layer.getBounds().pad(0.15));
else map.setView([44.63, 15.42], 12); // Lika fallback

L.control.layers({'OSM':osm}, {'Katastarski plan (DGU WMS)':dkp, 'Čestice':layer}).addTo(map);

const legend = L.control({position:'bottomleft'});
legend.onAdd = () => {
  const div = L.DomUtil.create('div','legend');
  const kos = [...new Set(data.features.map(f=>JSON.stringify([f.properties.ko,f.properties.color])))].map(JSON.parse);
  div.innerHTML = '<b>Darovni ugovor 18/71</b><br>' + kos.map(([n,c])=>'<i style="background:'+c+'"></i>K.O. '+n).join('<br>');
  return div;
};
legend.addTo(map);
</script>
</body>
</html>`;
  fs.writeFileSync(path.join(OUT_DIR, "map.html"), html);
}

(async () => {
  let features = [];
  for (const ko of KO_CONFIG) {
    try {
      features = features.concat(await processKo(ko));
    } catch (e) {
      console.error(`✗ ${ko.name}: ${e.message}`);
    }
  }
  buildMap(features);
  console.log(`\nGotovo → parcels.geojson (${features.length} čestica) + map.html`);
  console.log("Otvori map.html u browseru (ili baci na VPS).");
})();
