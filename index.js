const puppeteer = require("puppeteer");
const db = require("./firebase");
const cron = require("node-cron");

function parseDateTime(dateStr, timeStr) {
  const [year, month, day] = dateStr.split("/").map(Number);
  const [hour, minute] = timeStr.split(":" ).map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

async function cleanOldData() {
  const now = new Date();
  const ref = db.ref("roadConditions");
  const snapshot = await ref.once("value");
  snapshot.forEach(child => {
    const data = child.val();
    const dt = parseDateTime(data.日期, data.時間);
    const age = (now - dt) / 1000 / 60 / 60; // 小時
    if (age > 24) {
      ref.child(child.key).remove();
    }
  });
  console.log("🧹 已刪除 24 小時前的資料");
}

async function fetchAndWrite() {
  const browser = await puppeteer.launch({
  headless: "new",
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
  const page = await browser.newPage();
  
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
  await page.goto("https://www.pbs.gov.tw/cht/index.php?code=list&ids=163", {
  waitUntil: "networkidle2",
  timeout: 90000 // 90 秒
});

  await page.waitForSelector("#JsonArrayInput tr");

  const data = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#JsonArrayInput tr"));
    return rows.map(row => {
      const cols = Array.from(row.querySelectorAll("td")).map(col => col.innerText.trim());
      return {
        編號: cols[0],
        類別: cols[1],
        地點: cols[2],
        說明: cols[3],
        日期: cols[4],
        時間: cols[5],
        消息來源: cols[6]
      };
    });
  });

  const filtered = data.filter(d => d.類別 && d.類別 !== "其他");
    console.log("抓到的資料數量：", filtered.length);

  for (const item of filtered) {
      try {
        await db.ref("roadConditions").push(item);
        console.log("✅ 成功寫入一筆：", item.地點 || item.說明);
      } catch (e) {
        console.error("❌ 寫入失敗：", item, e);
      }
    }

  console.log("✅ 寫入 Firebase 成功 @", new Date().toLocaleTimeString());
  await browser.close();

  // 執行刪除 24 小時前資料
  await cleanOldData();
}

// 🕒 每5分鐘自動執行一次
cron.schedule("*/5 * * * *", () => {
  console.log("⏰ 執行定時抓取...");
  fetchAndWrite();
});

// 🚀 立即執行一次
fetchAndWrite();

