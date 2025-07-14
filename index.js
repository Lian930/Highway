const axios = require("axios");
const db = require("./firebase");

async function fetchAndPush(path, url) {
  try {
    const { data } = await axios.get(url);
    const ref = db.ref(path);
    await ref.set(data);
    console.log(`✅ ${path} 成功上傳，共 ${Array.isArray(data) ? data.length : Object.keys(data).length} 筆`);
  } catch (e) {
    console.error(`❌ ${path} 上傳失敗：`, e.message);
  }
}

async function main() {
  await Promise.all([
    fetchAndPush("liveTraffic", "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/Freeway?$format=JSON"),
    fetchAndPush("events", "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Event/Freeway?$format=JSON"),
    fetchAndPush("speedCams", "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/SpeedCam/Freeway?$format=JSON")
  ]);
  console.log("✅ 所有資料上傳完成！");
}

main();
