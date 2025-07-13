const admin = require("firebase-admin");
const fs = require("fs");
console.log("serviceAccount env 前 100 字:", process.env.FIREBASE_SERVICE_ACCOUNT?.slice(0, 100));

const raw = fs.readFileSync("serviceAccount.json", "utf-8");
const json = require("./serviceAccount.json");

admin.initializeApp({
  credential: admin.credential.cert(json),
  databaseURL: "https://highwaynotifier-default-rtdb.asia-southeast1.firebasedatabase.app" // 替換為你的
});

module.exports = admin.database();

