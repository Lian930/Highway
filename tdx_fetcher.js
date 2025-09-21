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

// ---- 1968 API ----
async function fetch1968Incidents() {
  const { data } = await axios.get(
    "https://1968.freeway.gov.tw/api/getIncidentData?action=incident&area=A&freewayid=1&expresswayid=0"
  );
  return data.response || [];
}

// ---- web_list 解析 ----
function parseWebList(str) {
  if (!str) return { roadId: "NA", direction: "N", km: NaN };
  // 範例: "國道3號南向119.1km"
  const roadMatch = str.match(/國道(\d+)號/);
  const dirMatch = str.match(/(北向|南向|東向|西向)/);
  const kmMatch = str.match(/([\d.]+)\s*km/i);

  let roadId = "NA";
  if (roadMatch) roadId = "F" + roadMatch[1];
  let direction = "N";
  if (dirMatch) {
    const d = dirMatch[1];
    if (d.includes("北")) direction = "N";
    else if (d.includes("南")) direction = "S";
    else if (d.includes("東")) direction = "E";
    else if (d.includes("西")) direction = "W";
  }
  const km = kmMatch ? parseFloat(kmMatch[1]) : NaN;
  return { roadId, direction, km };
}

// ---- 事件轉換 ----
function normalizeIncident(raw) {
  const parsed = parseWebList(raw.web_list);
  return {
    incidentid: raw.incidentid,
    web_list: raw.web_list,
    roadId: parsed.roadId,
    direction: parsed.direction,
    km: parsed.km,
    inc_type_name: raw.inc_type_name,
    inc_name: raw.inc_name,
    event_type: raw.event_type,
    effectiveTime: raw.effectiveTime,
    longitude: raw.longitude,
    latitude: raw.latitude,
    location_type: raw.location_type,
    freewayid: raw.freewayid,
    directionid: raw.directionid,
    from_milepost: raw.from_milepost,
    to_milepost: raw.to_milepost,
    entry_exit: raw.entry_exit,
    block_way: raw.block_way,
    blocked_lanes: raw.blocked_lanes,
    publishTime: raw.publishTime || raw.lastupdateTime
  };
}

// ---- Main ----
(async () => {
  try {
    const token = await getAccessToken();

    // 1) 抓四組資料 (前三個仍走 TDX, 第四個改抓 1968)
    const [liveTraffic, speedVD, congestionRules, incidents] = await Promise.all([
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway?$format=JSON", token),
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$format=JSON", token),
      fetchTDX("https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CongestionLevel/Freeway?$format=JSON", token),
      fetch1968Incidents()
    ]);

    // 2) 存原始 (只保留前三個，事件不備份 raw)
    await Promise.all([
      upsertRaw("liveTraffic", liveTraffic),
      upsertRaw("speedVD", speedVD),
      upsertRaw("congestion_rules", congestionRules),
    ]);
    console.log("✅ 原始資料上傳完成");

    // 3) 事件 → events
    if (Array.isArray(incidents)) {
      const eventTasks = incidents.map((raw) => {
        const e = normalizeIncident(raw);
        return upsertEvent(e.incidentid, e);
      });
      await Promise.all(eventTasks);
      console.log(`✅ 事件標準化完成，共 ${eventTasks.length} 筆`);
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
