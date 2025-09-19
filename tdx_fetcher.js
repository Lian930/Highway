// cloud/tdx_fetcher.js
// 需要 Secrets：FIREBASE_SERVICE_ACCOUNT、FIREBASE_DB_URL、TDX_CLIENT_ID、TDX_CLIENT_SECRET

const admin = require("firebase-admin");
const axios = require("axios");

// ---- 讀取 service account ----
function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing");
  try {
    return JSON.parse(raw); // 直接 JSON
  } catch {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded); // base64 → JSON
  }
}

// ---- Firebase 初始化 ----
admin.initializeApp({
  credential: admin.credential.cert(readServiceAccount()),
  databaseURL: process.env.FIREBASE_DB_URL,
});
const db = admin.database();

// ---- 工具 ----
function taiwanIso() {
  const t = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  return t.toISOString();
}
function parseKm(x) {
  if (x == null) return NaN;
  if (typeof x === "number") return x;
  const s = String(x).trim().toUpperCase();
  const m = s.match(/^(\d+)(?:K\+(\d+))?$/);
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

// ---- Firebase Upsert ----
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
function upsertEvent(id, e) {
  return db.ref(`realtime/events/${id}`).set(e);
}
function upsertShoulderOpen(id, s) {
  return db.ref(`realtime/shoulderOpen/${id}`).set(s);
}
function upsertCongestion(id, c) {
  return db.ref(`realtime/congestion/${id}`).set(c);
}

// ---- 事件轉換 ----
function toEvent(raw) {
  const startKm = parseKm(raw.StartKM ?? raw.StartKm ?? raw.Start_KM ?? raw.Start);
  const endKm = parseKm(raw.EndKM ?? raw.EndKm ?? raw.End_KM ?? raw.End ?? startKm);
  return {
    type: raw.Type || raw.EventType || "ACCIDENT",
    startKm,
    endKm,
    direction: normDir(raw.Direction),
    ttl: Date.now() + 10 * 60 * 1000,
    source: raw.Source || "TDX",
  };
}

// ---- 等級判斷 ----
function calcLevel(speed) {
  if (speed >= 80) return 1;
  if (speed >= 60) return 2;
  if (speed >= 40) return 3;
  if (speed >= 20) return 4;
  if (speed >= 0) return 5;
  return 0;
}

// ---- API ----
async function fetchTDX(url, token) {
  const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return data;
}
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

// ---- Main ----
(async () => {
  try {
    const token = await getAccessToken();

    // 1) 抓四組資料
    const [liveTraffic, speedVD, congestionRules, news] = await Promise.all([
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway?$format=JSON", token),
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$format=JSON", token),
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CongestionLevel/Freeway?$format=JSON", token),
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/News/Freeway?$format=JSON", token),
    ]);

    // 2) 原始資料存檔
    await Promise.all([
      upsertRaw("liveTraffic", liveTraffic),
      upsertRaw("speedVD", speedVD),
      upsertRaw("congestion_rules", congestionRules), // 存原始規則表
      upsertRaw("news", news),
    ]);
    console.log("✅ 原始資料上傳完成");

    // 3) News → events & shoulderOpen
    if (Array.isArray(news)) {
      const eventTasks = [];
      const shoulderTasks = [];
      news.forEach((item, idx) => {
        const e = toEvent(item);
        const key = `${e.direction}-${e.startKm ?? "na"}-${e.endKm ?? "na"}-${idx}`;
        eventTasks.push(upsertEvent(key, e));
        if (item.Title && item.Title.includes("路肩")) {
          const s = {
            roadId: item.RoadID || "NA",
            startKm: parseKm(item.StartKM),
            endKm: parseKm(item.EndKM),
            direction: normDir(item.Direction),
            timeRange: `${item.PublishTime} ~ ${item.UpdateTime}`,
            source: "NEWS",
          };
          shoulderTasks.push(upsertShoulderOpen(item.NewsID, s));
        }
      });
      await Promise.all([...eventTasks, ...shoulderTasks]);
      console.log(`✅ 事件標準化完成，共 ${eventTasks.length} 筆`);
      console.log(`✅ 路肩開放上傳完成，共 ${shoulderTasks.length} 筆`);
    }

    // 4) liveTraffic → congestion 結構
    if (Array.isArray(liveTraffic)) {
      const tasks = liveTraffic.map((seg, idx) => {
        const startKm = parseKm(seg.StartKM);
        const endKm = parseKm(seg.EndKM ?? seg.StartKM);
        const speed = Number(seg.AvgSpeed ?? seg.Speed ?? 0);
        const level = calcLevel(speed);
        const c = {
          roadId: seg.RoadID || "NA",
          sectionId: seg.SectionID || `S${idx}`,
          startKm,
          endKm,
          direction: normDir(seg.Direction),
          level,
          speed,
          travelTime: Number(seg.TravelTime ?? 0),
        };
        const id = `${c.roadId}-${c.direction}-${c.sectionId}`;
        return upsertCongestion(id, c);
      });
      await Promise.all(tasks);
      console.log(`✅ 壅塞標準化完成，共 ${liveTraffic.length} 筆`);
    }

    // 5) meta
    await db.ref("meta/global/lastSuccessTime").set(taiwanIso());
    console.log("🎉 全流程完成");

    // ---- 結束處理 ----
    db.goOffline();
    process.exit(0);

  } catch (e) {
    console.error("❌ Pipeline 失敗：", e);
    process.exit(1);
  }
})();
