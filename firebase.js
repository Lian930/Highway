const admin = require("firebase-admin");
const fs = require("fs");
console.log("所有 env 變數：", Object.keys(process.env));

const raw = fs.readFileSync("serviceAccount.json", "utf-8");
const json = require("./serviceAccount.json");

admin.initializeApp({
  credential: admin.credential.cert(json),
  databaseURL: "https://highwaynotifier-default-rtdb.asia-southeast1.firebasedatabase.app" // 替換為你的
});

module.exports = admin.database();

