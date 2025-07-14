const admin = require("firebase-admin");
const json = require("./serviceAccount.json");

admin.initializeApp({
  credential: admin.credential.cert(json),
  databaseURL: "https://highwaynotifier-default-rtdb.asia-southeast1.firebasedatabase.app"
});

module.exports = admin.database();
