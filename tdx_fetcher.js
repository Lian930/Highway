const axios = require("axios");
const db = require("./firebase");

function getTaiwanTime() {
  const taiwanTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  return taiwanTime.toISOString();
}

async function getAccessToken() {
  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", process.env.TDX_CLIENT_ID);
  params.append("client_secret", process.env.TDX_CLIENT_SECRET);

  const res = await axios.post(
    "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token",
    params,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return res.data.access_token;
}

async function fetchAndPush(name, url, token) {
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const timestamp = getTaiwanTime();
    const processedData = Array.isArray(data)
      ? data.map(d => ({ ...d, timestamp }))
      : { ...data, timestamp };

    const ref = db.ref(`realtime/${name}`);
    await ref.set(processedData);

    const metaRef = db.ref(`meta/${name}`);
    await metaRef.set({
      lastUpdate: timestamp,
      count: Array.isArray(data) ? data.length : 1
    });

    console.log(`✅ ${name} 上傳成功，共 ${Array.isArray(data) ? data.length : 0} 筆`);
    return true;
  } catch (e) {
    console.error(`❌ ${name} 上傳失敗：`, e.message);
    return false;
  }
}

(async () => {
  const token = await getAccessToken();
  const success = await Promise.all([
    fetchAndPush("liveTraffic", "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway?$format=JSON", token),
    fetchAndPush("events", "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Event/Freeway?$format=JSON", token),
    fetchAndPush("speedCams", "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/SpeedCam/Freeway?$format=JSON", token)
  ]);

  const allSuccess = success.every(Boolean);
  if (allSuccess) {
    const globalRef = db.ref("meta/global/lastSuccessTime");
    await globalRef.set(getTaiwanTime());
  }

  console.log("✅ 所有資料上傳完成！");
})();
