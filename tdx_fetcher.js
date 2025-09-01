// cloud/tdx_fetcher.js
// 需要 Secrets：FIREBASE_SERVICE_ACCOUNT、FIREBASE_DB_URL、TDX_CLIENT_ID、TDX_CLIENT_SECRET
// FIREBASE_SERVICE_ACCOUNT 可是 JSON 字串或 base64 字串（會自動判斷）

const admin = require("firebase-admin");
const axios = require("axios");

// ---- 讀取 service account（支援 JSON 直給或 base64）----
function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing");
  try {
    return JSON.parse(raw);                // 直接 JSON
  } catch {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded);            // base64 → JSON
  }
}

// ---- Firebase 初始化 ----
admin.initializeApp({
  credential: admin.credential.cert(readServiceAccount()),
  databaseURL: process.env.FIREBASE_DB_URL,
});
const db = admin.database();

// ---- 工具：台灣時區 ISO 時間 ----
function taiwanIso() {
  const t = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  return t.toISOString();
}

// ---- 取得 TDX Access Token ----
async function getAccessToken() {
  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", process.env.TDX_CLIENT_ID);
  params.append("client_secret", process.env.TDX_CLIENT_SECRET);

  const { data } = await axios.post(
    "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token",
    params,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return data.access_token;
}

// ---- 寫入原始資料 + meta（你原有結構的增強版）----
function upsertRaw(name, payload) {
  const timestamp = taiwanIso();
  const processed = Array.isArray(payload)
    ? payload.map((d) => ({ ...d, timestamp }))
    : { ...payload, timestamp };

  const ref = db.ref(`realtime/${name}`);
  const meta = db.ref(`meta/${name}`);
  return Promise.all([
    ref.set(processed),
    meta.set({ lastUpdate: timestamp, count: Array.isArray(payload) ? payload.length : 1 }),
  ]);
}

// ---- 寫入標準化 Event / SpeedCam ----
function upsertEvent(id, e) {
  return db.ref(`realtime/events/${id}`).set(e);
}
function upsertSpeedCam(id, s) {
  return db.ref(`static/speedCams/${id}`).set(s);
}

// ---- 標準化工具：KM/方向 ----
function parseKm(x) {
  if (x == null) return NaN;
  if (typeof x === "number") return x;
  const s = String(x).trim().toUpperCase();
  const m = s.match(/^(\d+)(?:K\+(\d+))?$/); // 例如 123K+500
  if (m) {
    const km = parseInt(m[1], 10);
    const plus = m[2] ? parseInt(m[2], 10) / 1000 : 0;
    return km + plus;
  }
  const n = Number(s.replace(/[^\d.]/g, ""));
  return isNaN(n) ? NaN : n;
}
function normDir(d) {
  if (!d) return "N";
  const up = String(d).toUpperCase();
  if (up.startsWith("N")) return "N";
  if (up.startsWith("S")) return "S";
  if (up.startsWith("E")) return "E";
  if (up.startsWith("W")) return "W";
  return "N";
}

// ---- TDX News → 標準 Event ----
function toEvent(raw) {
  const startKm = parseKm(raw.StartKM ?? raw.StartKm ?? raw.Start_KM ?? raw.Start);
  const endKm = parseKm(raw.EndKM ?? raw.EndKm ?? raw.End_KM ?? raw.End ?? startKm);
  return {
    type: raw.Type || raw.EventType || "accident",
    startKm,
    endKm,
    direction: normDir(raw.Direction),
    ttl: Date.now() + 10 * 60 * 1000, // 10 分鐘
    source: raw.Source || "TDX",
  };
}

// ---- 取任意 TDX API ----
async function fetchTDX(url, token) {
  const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return data;
}

// ---- Main ----
(async () => {
  try {
    const token = await getAccessToken();

    // 1) 下載四組原始資料
    const [liveTraffic, speedVD, congestion, news] = await Promise.all([
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway?$format=JSON", token),
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$format=JSON", token),
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CongestionLevel/Freeway?$format=JSON", token),
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/News/Freeway?$format=JSON", token),
    ]);

    // 2) 原樣 + timestamp 上傳至 /realtime/* 與 /meta/*
    await Promise.all([
      upsertRaw("liveTraffic", liveTraffic),
      upsertRaw("speedVD", speedVD),
      upsertRaw("congestion", congestion),
      upsertRaw("news", news),
    ]);
    console.log("✅ 原始資料上傳完成");

    // 3) 從 news 轉標準化 Event → /realtime/events/{id}
    if (Array.isArray(news)) {
      const tasks = news.map((item, idx) => {
        const e = toEvent(item);
        // 這裡用簡單 key；未來可改為雜湊（含時間/事件編號等）
        const key = `${e.direction}-${e.startKm ?? "na"}-${e.endKm ?? "na"}-${idx}`;
        return upsertEvent(key, e);
      });
      await Promise.all(tasks);
      console.log(`✅ 事件標準化完成，共 ${news.length} 筆（來源：News）`);
    }

    // 4) SpeedCam：若來源是 PBS 或自有清單，請在此整理後：
    // await upsertSpeedCam(id, { km, limit, direction });
    const fs = require("fs");

  async function upsertAllSpeedCams(list) {
    for (const cam of list) {
      const km = Number(cam.km);
      const limit = Number(cam.limit);
      const direction = (cam.direction || "-").toUpperCase();
      if (!Number.isFinite(km) || !Number.isFinite(limit)) continue; // 基本防呆
      const id = `${direction}-${km.toFixed(3)}`; // 穩定ID（避免重複）
      await upsertSpeedCam(id, { km, limit, direction });
    }
  }
  
  // … news → Event 寫完之後：
  try {
    const cams = JSON.parse(fs.readFileSync("cloud/speedcams.json", "utf8"));
    await upsertAllSpeedCams(cams);
    console.log(`✅ SpeedCam 上傳完成，共 ${cams.length} 筆`);
  } catch (e) {
    console.warn("⚠️ SpeedCam 略過（找不到檔案或讀檔失敗）：", e.message);
  }


    // 5) 全域成功時間
    await db.ref("meta/global/lastSuccessTime").set(taiwanIso());
    console.log("🎉 全流程完成");
  } catch (e) {
    console.error("❌ Pipeline 失敗：", e);
    process.exitCode = 1;
  }
})();
