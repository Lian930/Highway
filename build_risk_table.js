import admin from "firebase-admin";

const { GOOGLE_APPLICATION_CREDENTIALS_JSON, FIREBASE_DB_URL } = process.env;

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON)),
  databaseURL: FIREBASE_DB_URL
});
const db = admin.database();

/** 先寫 10 個假 icId 範例結構（exitRisk=0.1），之後替換為真實計算 */
async function main() {
  const icIds = ["IC_001","IC_002","IC_003","IC_004","IC_005","IC_006","IC_007","IC_008","IC_009","IC_010"];
  const updates = {};
  for (const icId of icIds) {
    const node = {};
    for (let dow=1; dow<=7; dow++) {
      const kd = `dow_${dow}`;
      node[kd] = {};
      for (let h=0; h<24; h++) {
        const kh = `h_${String(h).padStart(2,"0")}`;
        node[kd][kh] = { exitRisk: 0.1, altRisk: {} };
      }
    }
    updates[`risk_lookup/${icId}`] = node;
  }
  await db.ref().update(updates);
  console.log("risk_lookup bootstrap (0.1) done:", icIds.length);
}
main().catch(e => { console.error(e); process.exit(1); });
