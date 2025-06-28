const admin = require("firebase-admin");
const fs = require("fs");

// 讀取 Secret 檔案內容
const raw = fs.readFileSync("serviceAccount.json", "utf-8");

// 如果是 GitHub Secret 格式（轉義過 \n），先解析成 JSON
const serviceAccount = JSON.parse(raw);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://highwaynotifier-default-rtdb.asia-southeast1.firebasedatabase.app"
});

module.exports = admin.database();
