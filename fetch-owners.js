#!/usr/bin/env node
/**
 * Vlasnici/posjednici za čestice iz darovnog ugovora 18/71.
 *
 * Javni uvid OSS (isti API koji koristi katastar.hr / oss.uredjenazemlja.hr):
 *   GET /oss/public/search-cad-parcels/parcel-numbers?search=&municipalityRegNum=
 *   GET /oss/public/cad/parcel-info?parcelId=
 *   GET /oss/public/lr/lr-unit?lrUnitNumber=&mainBookId=&historicalOverview=false
 *
 * parcelId == CESTICA_ID iz ATOM GML-a (ko-*.zip u repou), s fallbackom na search.
 * Output: vlasnici.csv, vlasnici.json + owners-raw/*.json (puni odgovori API-ja).
 */

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const BASE = "https://oss.uredjenazemlja.hr/oss/public";
const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
};
const RATE_MS = 1300;

const TARGETS = [
  { ko: "KLANAC", mbr: "310778", parcels: ["1374/1","1375/1","1376/1A","1379/2","1391/1A","1394/1","1395/1B","1395/3B","1396/3","1396/4","1396/5","1396/6","1559/4"] },
  { ko: "KRUŠČICA", mbr: "310794", parcels: ["37/3","58","60","109/1","110","113","145/2","148/1","148/2","151/1","154/1","154/2","154/3","172/1B","172/1C1","193/3","194/3"] },
  { ko: "GORNJE PAZARIŠTE", mbr: "310727", parcels: ["45","50","52","82/3"] },
];

const RAW_DIR = path.join(__dirname, "owners-raw");
fs.mkdirSync(RAW_DIR, { recursive: true });

let lastReq = 0;
async function api(endpoint, params, attempt = 0) {
  const wait = lastReq + RATE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const url = `${BASE}${endpoint}?${new URLSearchParams(params)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    clearTimeout(t);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt < 3) {
      const backoff = 3000 * (attempt + 1);
      console.log(`  retry ${attempt + 1} (${e.message}) za ${endpoint}`);
      await new Promise((r) => setTimeout(r, backoff));
      return api(endpoint, params, attempt + 1);
    }
    console.error(`  ✗ ${endpoint} ${JSON.stringify(params)}: ${e.message}`);
    return { __error: e.message };
  }
}

/** broj čestice -> CESTICA_ID iz GML-a */
function idsFromGml(mbr) {
  const zip = new AdmZip(path.join(__dirname, `ko-${mbr}.zip`));
  const gml = zip.readAsText(
    zip.getEntries().find((e) => /katastarske_cestice\.gml$/i.test(e.entryName))
  );
  const map = {};
  const re = /<oss:CESTICA_ID>(\d+)<\/oss:CESTICA_ID><oss:BROJ_CESTICE>([^<]*)<\/oss:BROJ_CESTICE>/g;
  let m;
  while ((m = re.exec(gml)) !== null) map[m[2].trim().toUpperCase()] = m[1];
  return map;
}

/** generički walk: nađi sve {lrUnitNumber, mainBookId} parove bilo gdje u JSON-u */
function findLrRefs(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) { obj.forEach((o) => findLrRefs(o, out)); return out; }
  const num = obj.lrUnitNumber ?? obj.lr_unit_number;
  const book = obj.mainBookId ?? obj.main_book_id ?? (obj.mainBook && obj.mainBook.id);
  if (num != null && book != null) out.push({ lrUnitNumber: String(num), mainBookId: String(book) });
  Object.values(obj).forEach((v) => findLrRefs(v, out));
  return out;
}

/** generički walk: skupi osobe {name, address?, ownership?/fraction?} */
function findParties(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) { obj.forEach((o) => findParties(o, out)); return out; }
  if (typeof obj.name === "string" && obj.name.trim() &&
      ("address" in obj || "ownership" in obj || "taxNumber" in obj || "lrOwnerId" in obj || "partyTypeId" in obj || "possessorId" in obj)) {
    out.push({
      name: obj.name.trim(),
      address: (obj.address || "").trim() || null,
      share: obj.ownership || (obj.numerator != null && obj.denominator != null ? `${obj.numerator}/${obj.denominator}` : null),
    });
  }
  Object.values(obj).forEach((v) => findParties(v, out));
  return out;
}

/** iz lr-unit JSON-a: udjeli (description tipa "1. Suvlasnički dio: 4/8") s vlasnicima */
function extractLrOwners(lr) {
  const shares = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    const owners = o.lrOwners || o.owners;
    if (Array.isArray(owners) && owners.length) {
      shares.push({
        share: o.description || (o.numerator != null && o.denominator != null ? `${o.numerator}/${o.denominator}` : "") || "",
        owners: owners.filter((x) => x && x.name).map((x) => ({
          name: String(x.name).trim(),
          address: (x.address || "").trim() || null,
        })),
      });
    }
    Object.values(o).forEach(walk);
  })(lr);
  return shares;
}

(async () => {
  const results = [];
  const lrUnits = new Map(); // key: book/unit -> {refKey, data, parcels:[]}

  for (const t of TARGETS) {
    const ids = idsFromGml(t.mbr);
    console.log(`\n== K.O. ${t.ko} (${t.mbr}) ==`);
    for (const broj of t.parcels) {
      let pid = ids[broj.toUpperCase()];
      let info = pid ? await api("/cad/parcel-info", { parcelId: pid }) : null;
      const okInfo = (x) => x && !x.__error && (x.parcelNumber || x.parcelId || x.possessionSheets);

      if (!okInfo(info) || (info.parcelNumber && String(info.parcelNumber).toUpperCase() !== broj.toUpperCase())) {
        const found = await api("/search-cad-parcels/parcel-numbers", { search: broj, municipalityRegNum: t.mbr });
        const hit = Array.isArray(found)
          ? found.find((r) => String(r.parcelNumber || "").toUpperCase() === broj.toUpperCase())
          : null;
        if (hit) { pid = hit.parcelId; info = await api("/cad/parcel-info", { parcelId: pid }); }
      }

      if (!okInfo(info)) {
        console.log(`  ${broj}: NIJE DOHVAĆENO`);
        results.push({ ko: t.ko, broj, error: (info && info.__error) || "not found" });
        continue;
      }

      fs.writeFileSync(path.join(RAW_DIR, `parcel-${t.mbr}-${broj.replace(/[\/]/g, "_")}.json`), JSON.stringify(info, null, 1));

      const possessors = findParties(info.possessionSheets || []);
      const refs = findLrRefs(info);
      const refKeys = [...new Set(refs.map((r) => `${r.mainBookId}/${r.lrUnitNumber}`))];
      refKeys.forEach((k) => {
        if (!lrUnits.has(k)) {
          const [mainBookId, lrUnitNumber] = k.split("/");
          lrUnits.set(k, { mainBookId, lrUnitNumber, parcels: [] });
        }
        lrUnits.get(k).parcels.push(`${t.ko} ${broj}`);
      });

      console.log(`  ${broj}: posjednika ${possessors.length}, ZK ul. [${refKeys.join(", ") || "—"}]`);
      results.push({ ko: t.ko, broj, parcelId: pid, area: info.area || null, address: info.address || null, possessors, lrRefs: refKeys });
    }
  }

  console.log(`\n== ZK ulošci (${lrUnits.size}) ==`);
  for (const [key, u] of lrUnits) {
    const data = await api("/lr/lr-unit", { lrUnitNumber: u.lrUnitNumber, mainBookId: u.mainBookId, historicalOverview: "false" });
    if (data && !data.__error) {
      fs.writeFileSync(path.join(RAW_DIR, `lr-${u.mainBookId}-${u.lrUnitNumber}.json`), JSON.stringify(data, null, 1));
      u.owners = extractLrOwners(data);
      console.log(`  ul. ${u.lrUnitNumber} (knjiga ${u.mainBookId}): udjela ${u.owners.length}`);
    } else {
      u.error = (data && data.__error) || "no data";
      console.log(`  ul. ${u.lrUnitNumber}: ✗ ${u.error}`);
    }
  }

  const lrOut = Object.fromEntries([...lrUnits].map(([k, v]) => [k, v]));
  fs.writeFileSync(path.join(__dirname, "vlasnici.json"), JSON.stringify({ generated: new Date().toISOString(), parcels: results, lrUnits: lrOut }, null, 1));

  // CSV (Excel-friendly)
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = ["\uFEFFKO;Čestica;Površina m2;Posjednici (katastar);ZK uložak;ZK vlasnici (udio)"];
  for (const r of results) {
    const pos = (r.possessors || []).map((p) => p.name + (p.share ? ` (${p.share})` : "")).join(" | ");
    const zk = (r.lrRefs || []).map((k) => {
      const u = lrUnits.get(k);
      const owners = (u && u.owners || []).map((s) => s.owners.map((o) => o.name).join(", ") + (s.share ? ` [${s.share}]` : "")).join(" | ");
      return `ul.${u ? u.lrUnitNumber : "?"}: ${owners || u && u.error || "?"}`;
    }).join(" || ");
    lines.push([r.ko, r.broj, r.area || "", pos, (r.lrRefs || []).join(","), zk].map(esc).join(";"));
  }
  fs.writeFileSync(path.join(__dirname, "vlasnici.csv"), lines.join("\n"));
  console.log(`\nGotovo: vlasnici.csv (${results.length} čestica), vlasnici.json, owners-raw/`);
})();
