// pbs_realtime.js
// 功能：抓 PBS RoadAll → 正規化 → 去重/TTL → 寫入 Firebase Realtime DB（/realtime/news/pbs）
// 只依賴環境變數：FIREBASE_SA_BASE64, FIREBASE_DB_URL, (可選)FIREBASE_NEWS_PATH, (可選)DRY_RUN

import { fetch } from "undici";
import pLimit from "p-limit";
import hash from "object-hash";
import { z } from "zod";
import admin from "firebase-admin";

// ===== 0) 讀 ENV、初始化 Firebase =====
const {
  FIREBASE_SA_BASE64,
  FIREBASE_DB_URL,
  FIREBASE_NEWS_PATH = "/realtime/news/pbs",
  DRY_RUN
} = process.env;

if (!FIREBASE_SA_BASE64 || !FIREBASE_DB_URL) {
  console.error("❌ 缺少環境變數：FIREBASE_SA_BASE64 或 FIREBASE_DB_URL");
  process.exit(1);
}

const serviceAccount = JSON.parse(
  Buffer.from(FIREBASE_SA_BASE64, "base64").toString("utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DB_URL,
});
const db = admin.database();

// ===== 1) PBS 來源端點（以 RoadAll.html 為準） =====
const ORIGIN = "https://rtr.pbs.gov.tw/pbsmgt";
const Q_HIGHWAYS = `${ORIGIN}/queryHighway`;             // 回 { formData: [{ name, sn }, ...] }
const Q_ROAD_ALL = (sn) => `${ORIGIN}/roadAllCache?sn=${sn}`; // 回 { formData: [ ...事件... ] }

// ===== 2) Schema（把來源固定成我們要的形狀） =====
const HighwayListSchema = z.object({
  formData: z.array(z.object({ name: z.string(), sn: z.string() }))
});
const RoadAllSchema = z.object({ formData: z.array(z.record(z.any())) });

const NormalizedEventSchema = z.object({
  id: z.string(),                // 穩定 ID（hash）
  source: z.literal("PBS"),
  highwaySn: z.string().optional(),
  highwayName: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  direction: z.string().optional(),
  kmStart: z.number().nullable().optional(),
  kmEnd: z.number().nullable().optional(),
  region: z.string().optional(), // N/C/S/E 類
  postedAt: z.number().optional(),    // ms
  updatedAt: z.number().optional(),   // ms
  validUntil: z.number().optional(),  // ms (TTL)
  raw: z.record(z.any())
});

// ===== 3) 工具：公里數/指紋/TTL =====
function toKm(value) {
  if (value == null) return null;
  const s = String(value);
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}
function makeFingerprint(item) {
  const key = {
    src: "PBS",
    sn: item.sn || item.road || item.roadtype,
    title: item.title || item.subject || item.comment,
    desc: item.comment || item.content || item.srcdetail,
    km: item.kilo || item.km || item.kmStart || item.fromkm,
    number: item.number,
    updatedate: item.updatedate || item.updatetime || item.lastmodified,
    postdate: item.postdate || item.happendate
  };
  return hash(key, { algorithm: "sha1" });
}
const TTL_MS = 2 * 60 * 60 * 1000; // 預設 2 小時

// ===== 4) 來源 → 正規化 =====
function normalizeOne(raw, { highwayName, highwaySn }) {
  const title =
    raw.title || raw.subject || raw.road_bak1 || raw.road || raw.name || raw.comment || "路況事件";
  const description =
    raw.comment || raw.srcdetail || raw.content || raw.remark || "";

  const ev = {
    id: makeFingerprint({ ...raw, sn: highwaySn }),
    source: "PBS",
    highwaySn,
    highwayName,
    title,
    description,
    category: raw.category || raw.type || raw.eventtype || raw.roadtype || "",
    direction: raw.direction || raw.dir || "",
    kmStart: toKm(raw.kilo || raw.km || raw.kmStart || raw.fromkm),
    kmEnd: toKm(raw.kmEnd || raw.tokm || null),
    region: raw.region || "",
    postedAt: raw.postdate ? Date.parse(raw.postdate) : undefined,
    updatedAt: raw.updatedate ? Date.parse(raw.updatedate)
            : raw.updatetime ? Date.parse(raw.updatetime)
            : raw.lastmodified ? Date.parse(raw.lastmodified)
            : Date.now(),
    validUntil: Date.now() + TTL_MS,
    raw
  };

  return NormalizedEventSchema.parse(ev);
}

// ===== 5) 抓取與入庫 =====
async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      "accept": "application/json, text/javascript, */*; q=0.1",
      "user-agent": "HighwayNotifier/1.0 (+github actions)"
    }
  });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} ${url}`);
  return r.json();
}
async function fetchHighways() {
  const j = await fetchJson(Q_HIGHWAYS);
  return HighwayListSchema.parse(j).formData; // [{name, sn}]
}
async function fetchRoadAll(sn) {
  const j = await fetchJson(Q_ROAD_ALL(sn));
  return RoadAllSchema.parse(j).formData; // [events...]
}
async function upsertNews(items) {
  if (DRY_RUN === "true") {
    console.log(`🧪 DRY_RUN：模擬寫入 ${items.length} 筆`);
    return;
  }
  const ref = db.ref(FIREBASE_NEWS_PATH);
  const updates = {};
  for (const it of items) updates[it.id] = it;
  await ref.update(updates);
}
async function pruneExpired() {
  const snap = await db.ref(FIREBASE_NEWS_PATH).get();
  if (!snap.exists()) return 0;
  const now = Date.now();
  const updates = {};
  let cnt = 0;
  snap.forEach(ch => {
    const v = ch.val();
    if (v && v.validUntil && v.validUntil < now) {
      updates[ch.key] = null; cnt++;
    }
  });
  if (cnt) await db.ref(FIREBASE_NEWS_PATH).update(updates);
  return cnt;
}

// ===== 6) 主流程 =====
async function main() {
  console.log("== PBS RoadAll → Firebase ==");
  const highways = await fetchHighways();
  console.log(`取得國道清單：${highways.length} 條`);
  const limit = pLimit(6);

  const allRaw = (await Promise.all(
    highways.map(h => limit(async () => {
      try {
        const arr = await fetchRoadAll(h.sn);
        console.log(`sn=${h.sn} ${h.name} → ${arr.length} 筆`);
        return arr.map(ev => ({ h, ev }));
      } catch (e) {
        console.warn(`⚠️ sn=${h.sn} ${h.name} 抓取失敗：${e.message}`);
        return [];
      }
    }))
  )).flat();

  const normalized = [];
  for (const { h, ev } of allRaw) {
    try { normalized.push(normalizeOne(ev, { highwaySn: h.sn, highwayName: h.name })); }
    catch (e) { console.warn("⚠️ 正規化失敗，略過一筆：", e.message); }
  }

  // 去重（以 id 指紋）
  const map = new Map();
  for (const it of normalized) if (!map.has(it.id)) map.set(it.id, it);
  const unique = Array.from(map.values());

  console.log(`合計 ${normalized.length} → 去重後 ${unique.length} 筆。寫入：${FIREBASE_NEWS_PATH}`);
  await upsertNews(unique);

  const removed = await pruneExpired();
  if (removed > 0) console.log(`🧹 清掉過期：${removed} 筆`);

  console.log("✅ 完成");
}

main().catch(err => { console.error("❌ 例外：", err); process.exit(1); });
