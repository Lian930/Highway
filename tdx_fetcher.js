const axios = require("axios");
const db = require("./firebase");

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

async function fetchAndPush(path, url, token) {
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const ref = db.ref(path);
    await ref.set(data);

    // 👉 更新 lastUpdate 時間戳記
    const timeRef = db.ref(`meta/${path}/lastUpdate`);
    await timeRef.set(new Date().toISOString());

    console.log(`✅ ${path} 上傳成功，共 ${Array.isArray(data) ? data.length : 0} 筆`);
  } catch (e) {
    console.error(`❌ ${path} 上傳失敗：`, e.message);
  }
}

(async () => {
  const token = await getAccessToken();
  await Promise.all([
    fetchAndPush("liveTraffic", "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway?$format=JSON", token),
    fetchAndPush("events", "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Event/Freeway?$format=JSON", token),
    fetchAndPush("speedCams", "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/SpeedCam/Freeway?$format=JSON", token)
  ]);
  console.log("✅ 所有資料上傳完成！");
})();
