const admin = require("firebase-admin");
const fs = require("fs");

// 讀取 escape 過的一行 JSON 字串
const rawEscaped = fs.readFileSync("serviceAccount.json", "utf-8");

// 將已轉義（含 \\n）字串 → 正常 JSON 格式
const jsonString = rawEscaped.replace(/\\n/g, '\n');

// 再轉為 JSON 物件
const serviceAccount = JSON.parse(jsonString);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://highwaynotifier-default-rtdb.asia-southeast1.firebasedatabase.app"
});

module.exports = admin.database();

