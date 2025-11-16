// scripts/pbs_to_firebase.js
// 把 PBS RoadAllServlet 的資料清洗後寫入 Firebase Realtime Database

const axios = require("axios");
const admin = require("firebase-admin");

// ======== 設定區（請依照自己的 Firebase 換掉） ========

// Github Secrets 裡放 service account JSON 字串
// 例如在 GitHub -> Settings -> Secrets and variables -> Actions
// 建一個叫 FIREBASE_SERVICE_ACCOUNT 的 secret，內容整個貼 serviceAccount.json
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) {
  console.error("環境變數 FIREBASE_SERVICE_ACCOUNT 未設定");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountJson);
} catch (e) {
  console.error("解析 FIREBASE_SERVICE_ACCOUNT JSON 失敗:", e);
  process.exit(1);
}

// ❗這個請換成你自己的 Realtime Database URL
// 例如：https://your-project-id.firebaseio.com
const databaseURL = process.env.FIREBASE_DB_URL;
if (!databaseURL) {
  console.error("環境變數 FIREBASE_DB_URL 未設定");
  process.exit(1);
}

// PBS API
const ROADALL_URL =
  "https://rtr.pbs.gov.tw/pbsmgt/RoadAllServlet?ajaxAction=roadAllCache";
const QUERYHIGHWAY_URL =
  "https://rtr.pbs.gov.tw/pbsmgt/RoadAllServlet?ajaxAction=queryHighway";

// Firebase 路徑
const EVENTS_BASE_PATH = "events/pbs";      // 寫到 /events/pbs/<number>
const QUERYHIGHWAY_PATH = "queryHighway";  // 寫到 /queryHighway

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ======== 初始化 Firebase ========

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL,
});

const db = admin.database();

// ======== 小工具：安全抓文字 + JSON.parse ========

async function fetchText(url) {
  const resp = await axios.get(url, {
    responseType: "text",
    timeout: 15000,
    headers: {
      // 伪裝正常瀏覽器，避免被擋
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "*/*",
    },
    // 避免自動幫你 parse 成 JSON
    transformResponse: [(data) => data],
  });

  let text = resp.data;
  if (typeof text !== "string") {
    text = String(text || "");
  }

  // 去掉 BOM + 前後空白
  text = text.replace(/^\uFEFF/, "").trim();

  if (!text) {
    throw new Error(`從 ${url} 拿到空內容`);
  }

  // 如果是 HTML（以 < 開頭），表示打錯 endpoint 或被擋
  if (text[0] === "<") {
    throw new Error(
      `從 ${url} 拿到看起來像 HTML 的內容，前 120 字：\n` +
        text.slice(0, 120)
    );
  }

  return text;
}

function parseJsonFromText(text, url) {
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`解析 ${url} JSON 失敗，前 200 字：\n${text.slice(0, 200)}`);
    throw err;
  }
}

// ======== 時間處理：轉成 timestamp(ms) ========

function parseDateTimeToMs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return NaN;

  const datePart = String(dateStr).trim(); // 例如 "2025-11-12"
  let timePart = String(timeStr).trim();   // 例如 "15:03" 或 "15:03:20.6400000"

  // 保留到秒，後面小數直接丟掉
  const m = timePart.match(/^(\d{2}:\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;

  const hhmm = m[1]; // "15:03"
  const ss = m[2] || "00";

  const iso = `${datePart}T${hhmm}:${ss}Z`; // 當作 UTC 即可，TTL 只看差值
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

function parseLastModifiedToMs(lastmodified) {
  if (!lastmodified) return NaN;
  // 例如 "2025-11-12 15:15:00.0" 或 "2025-11-12 15:15:00.0000000"
  const parts = String(lastmodified).trim().split(/\s+/);
  if (parts.length < 2) return NaN;
  const [datePart, timePartRaw] = parts;
  return parseDateTimeToMs(datePart, timePartRaw);
}

// 給單筆 roadAllCache 的 raw event，算出 eventTimestamp
function calcEventTimestampMs(raw) {
  // 1. 優先用 lastmodified（看起來比較像最後更新時間）
  let ts = parseLastModifiedToMs(raw.lastmodified);
  if (!Number.isNaN(ts)) return ts;

  // 2. 再試試 happendate + happentime
  ts = parseDateTimeToMs(raw.happendate, raw.happentime);
  if (!Number.isNaN(ts)) return ts;

  // 3. 再試 updatedate + updatetime
  ts = parseDateTimeToMs(raw.updatedate, raw.updatetime);
  if (!Number.isNaN(ts)) return ts;

  // 4. 實在不行就用現在時間
  return Date.now();
}

// ======== 寫入 /queryHighway ========

async function writeQueryHighway(queryHighwayJson) {
  // 這個 JSON 是 { formData: [ {name, sn}, ... ] }
  // 為了簡單 & 不出錯，直接整包寫進 /queryHighway
  const ref = db.ref(QUERYHIGHWAY_PATH);
  const payload = {
    ...queryHighwayJson,
    updatedAt: new Date().toISOString(),
  };

  await ref.set(payload);
  console.log(
    `[queryHighway] 已更新 /${QUERYHIGHWAY_PATH}，筆數：${
      Array.isArray(queryHighwayJson.formData)
        ? queryHighwayJson.formData.length
        : 0
    }`
  );
}

// ======== 寫入 /events/pbs + 24 小時 TTL ========

async function writeEvents(roadAllJson) {
  const list = Array.isArray(roadAllJson.formData)
    ? roadAllJson.formData
    : [];

  const now = Date.now();
  const ref = db.ref(EVENTS_BASE_PATH);
  const updates = {};

  let keptCount = 0;
  let skippedOld = 0;

  for (const raw of list) {
    if (!raw || !raw.number) continue;

    const ts = calcEventTimestampMs(raw);
    const ageMs = now - ts;

    // 超過 24 小時就直接跳過（不新增）
    if (ageMs > ONE_DAY_MS) {
      skippedOld++;
      continue;
    }

    const key = raw.number; // PBS 的 number 當作主 key，避免重複
    updates[key] = {
      ...raw,
      source: "pbs_roadAllCache",
      eventTimestamp: ts,
      eventTimestampIso: new Date(ts).toISOString(),
      lastFetchedAt: now,
    };
    keptCount++;
  }

  // 寫入 /events/pbs，新增 / 更新 現有事件
  if (Object.keys(updates).length > 0) {
    await ref.update(updates);
  }

  console.log(
    `[events] 從 PBS 取回 ${list.length} 筆，新增/更新：${keptCount} 筆；` +
      `因超過 24 小時而忽略：${skippedOld} 筆`
  );

  // 再掃一遍 DB，把已經存在但超過 24 小時的舊紀錄刪掉
  const snap = await ref.once("value");
  const deletes = {};
  snap.forEach((child) => {
    const val = child.val() || {};
    const ts = val.eventTimestamp || 0;
    if (!ts) return;

    if (now - ts > ONE_DAY_MS) {
      deletes[child.key] = null; // 在 update 裡設成 null 代表刪除
    }
  });

  const deleteCount = Object.keys(deletes).length;
  if (deleteCount > 0) {
    await ref.update(deletes);
  }

  console.log(`[events] 已刪除超過 24 小時的舊紀錄：${deleteCount} 筆`);
}

// ======== 主流程 ========

async function main() {
  try {
    console.log("開始從 PBS 抓資料…");

    const [roadAllText, queryHighwayText] = await Promise.all([
      fetchText(ROADALL_URL),
      fetchText(QUERYHIGHWAY_URL),
    ]);

    const roadAllJson = parseJsonFromText(roadAllText, ROADALL_URL);
    const queryHighwayJson = parseJsonFromText(
      queryHighwayText,
      QUERYHIGHWAY_URL
    );

    console.log(
      "成功解析 PBS JSON：",
      `roadAllCache 筆數 = ${
        Array.isArray(roadAllJson.formData) ? roadAllJson.formData.length : 0
      }`,
      `, queryHighway 筆數 = ${
        Array.isArray(queryHighwayJson.formData)
          ? queryHighwayJson.formData.length
          : 0
      }`
    );

    await writeQueryHighway(queryHighwayJson);
    await writeEvents(roadAllJson);

    console.log("全部完成 ✅");
    process.exit(0);
  } catch (err) {
    console.error("執行失敗：", err);
    process.exit(1);
  }
}

main();
