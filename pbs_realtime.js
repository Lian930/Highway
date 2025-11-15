// scripts/pbs_realtime.js
// 作用：抓 PBS RoadAll → 正規化 → 去重/TTL → 寫入 Firebase Realtime DB

import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
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
  console.error("❌ 缺少環境變數：FIREBASE_SA_BASE64 or FIREBASE_DB_URL");
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
const Q_HIGHWAYS = `${ORIGIN}/queryHighway`;          // 列出 {name, sn}
const Q_ROAD_ALL = (sn) => `${ORIGIN}/roadAllCache?sn=${sn}`; // 取該國道事件

// ===== 2) Schema（把來源固定成我們要的形狀） =====
const HighwayListSchema = z.object({
  formData: z.array(
    z.object({
      name: z.string(),
      sn: z.string()
    })
  )
});

// RoadAll 來源長相會變動，先寬鬆接，常見欄位盡量 mapping
const RoadAllSchema = z.object({
  formData: z.array(z.record(z.any()))
});

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
  raw: z.record(z.any())              // 保留原始，之後要對齊再用
});

// ===== 3) 工具：安全取數字公里數、做指紋 =====
function toKm(value) {
  if (value == null) return null;
  // 可吃 "34K+500" / "34.5" / "34" 等
  const s = String(value);
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function makeFingerprint(item) {
  // 用「來源 + 國道代碼 + 題目/描述 + 里程 + 更新時間/流水號」做 hash
  const key = {
    src: "PBS",
    sn: item.sn || item.road || item.roadtype,
    title: item.title || item.subject || item.comment,
    desc: item.comment || item.content,
    km: item.kilo || item.km || item.kmStart,
    number: item.number,
    updatedate: item.updatedate || item.updatetime,
    postdate: item.postdate
  };
  return hash(key, { algorithm: "sha1" });
}

// 設定 TTL：預設 2 小時（可視需要調）
const TTL_MS = 2 * 60 * 60 * 1000;

// ===== 4) 來源 → 正規化 =====
function normalizeOne(raw, { highwayName, highwaySn }) {
  const title =
    raw.title || raw.subject || raw.road_bak1 || raw.road || raw.comment || "事件";
  const description =
    raw.comment || raw.srcdetail || raw.content || raw.remark || "";

  const ev = {
    id: makeFingerprint({ ...raw, sn: highwaySn }),
    source: "PBS",
    highwaySn,
    highwayName,
    title,
    description,
    category: raw.category || raw.type || raw.eventtype || "",
    direction: raw.direction || raw.dir || "",
    kmStart: toKm(raw.kilo || raw.km || raw.kmStart),
    kmEnd: toKm(raw.kmEnd || null),
    region: raw.region || "",
    postedAt: raw.postdate ? Date.parse(raw.postdate) : undefined,
    updatedAt: raw.updatedate ? Date.parse(raw.updatedate) :
               raw.updatetime ? Date.parse(raw.updatetime) : Date.now(),
    validUntil: Date.now() + TTL_MS,
    raw
  };

  return NormalizedEventSchema.parse(ev);
}

// ===== 5) 主要流程 =====
async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      "accept": "application/json, text/javascript, */*; q=0.1",
      "user-agent": "HighwayNotifier/1.0 (+github actions)"
    }
  });
  if (!r.ok) {
    throw new Error(`Fetch failed ${r.status} ${url}`);
  }
  return r.json();
}

async function fetchHighways() {
  const j = await fetchJson(Q_HIGHWAYS);
  const data = HighwayListSchema.parse(j).formData;
  // 有些回傳會包含「其它國道」，可以保留但抓不到事件就會是空
  return data;
}

async function fetchRoadAll(sn) {
  const j = await fetchJson(Q_ROAD_ALL(sn));
  const data = RoadAllSchema.parse(j).formData;
  return data;
}

async function upsertNews(items) {
  if (DRY_RUN === "true") {
    console.log(`🧪 DRY_RUN：模擬寫入 ${items.length} 筆`);
    return;
  }
  const ref = db.ref(FIREBASE_NEWS_PATH);
  const updates = {};
  for (const it of items) {
    updates[it.id] = it;
  }
  await ref.update(updates);
}

async function pruneExpired() {
  const snap = await db.ref(FIREBASE_NEWS_PATH).get();
  if (!snap.exists()) return 0;
  const now = Date.now();
  const toDelete = [];
  snap.forEach(ch => {
    const v = ch.val();
    if (v && v.validUntil && v.validUntil < now) {
      toDelete.push(ch.key);
    }
  });
  if (toDelete.length === 0) return 0;
  const updates = {};
  for (const id of toDelete) updates[id] = null;
  await db.ref(FIREBASE_NEWS_PATH).update(updates);
  return toDelete.length;
}

async function main() {
  console.log("== PBS RoadAll → Firebase ==");
  const highways = await fetchHighways(); // [{name, sn}]
  console.log(`取得國道清單：${highways.length} 條`);

  const limit = pLimit(6);
  const allRaw = (
    await Promise.all(
      highways.map(h =>
        limit(async () => {
          try {
            const arr = await fetchRoadAll(h.sn);
            console.log(`sn=${h.sn} ${h.name} → ${arr.length} 筆`);
            return arr.map(ev => ({ h, ev }));
          } catch (e) {
            console.warn(`⚠️ sn=${h.sn} ${h.name} 抓取失敗：${e.message}`);
            return [];
          }
        })
      )
    )
  ).flat();

  // 正規化
  const normalized = [];
  for (const { h, ev } of allRaw) {
    try {
      normalized.push(normalizeOne(ev, { highwaySn: h.sn, highwayName: h.name }));
    } catch (e) {
      console.warn("⚠️ 正規化失敗，略過一筆：", e.message);
    }
  }

  // 去重（以 id 指紋）
  const map = new Map();
  for (const it of normalized) {
    if (!map.has(it.id)) map.set(it.id, it);
  }
  const unique = Array.from(map.values());

  console.log(`合計 ${normalized.length} → 去重後 ${unique.length} 筆。寫入 Firebase 路徑：${FIREBASE_NEWS_PATH}`);
  await upsertNews(unique);

  const removed = await pruneExpired();
  if (removed > 0) {
    console.log(`🧹 清掉過期：${removed} 筆`);
  }
  console.log("✅ 完成");
}

main().catch(err => {
  console.error("❌ 例外：", err);
  process.exit(1);
});
