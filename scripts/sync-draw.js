/* ==================================================================
 * 抓取福彩官网最新一期开奖，写成 data.json
 *
 * 用途：给 GitHub Pages 版提供数据。
 * 静态托管跑不了 server.js，所以改由 GitHub Actions 定时执行本脚本，
 * 把结果提交回仓库；页面读同源的 data.json，绕开跨域限制。
 *
 * 本地也能跑：node scripts/sync-draw.js
 * 抓不到时保留旧文件、退出码 0，不让 Actions 变红。
 * ================================================================== */

var fs = require("fs");
var path = require("path");

var OUT = path.join(__dirname, "..", "data.json");

var API =
  "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
  "?name=ssq&issueCount=&issueStart=&issueEnd=&dayStart=&dayEnd=" +
  "&pageNo=1&pageSize=1&week=&systemType=PC";

/** 官网字段 → 前端要的形状，与 server.js 的 normalize 保持一致 */
function normalize(item) {
  var reds = String(item.red || "")
    .split(",")
    .map(function toNumber(text) { return parseInt(text, 10); })
    .filter(function isValid(n) { return !isNaN(n); });

  return {
    issue: String(item.code || ""),
    date: String(item.date || "").replace(/\(.*\)$/, ""),
    week: String(item.week || ""),
    reds: reds,
    blue: parseInt(item.blue, 10),
    sales: Number(item.sales) || 0,
    pool: Number(item.poolmoney) || 0,
    detail: item.detailsLink ? "https://www.cwl.gov.cn" + item.detailsLink : ""
  };
}

/** 读现有 data.json，用于比对是否变化、以及抓取失败时保留旧值 */
function readExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUT, "utf8"));
  } catch (error) {
    return null;
  }
}

async function main() {
  var response = await fetch(API, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/",
      Accept: "application/json, text/javascript, */*; q=0.01"
    }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  var body = await response.json();
  var first = (body && body.result && body.result[0]) || null;
  if (!first) {
    throw new Error("官网没有返回开奖记录");
  }

  var data = normalize(first);
  if (data.reds.length !== 6 || isNaN(data.blue) || !data.issue) {
    throw new Error("开奖数据不完整：" + JSON.stringify(data));
  }

  var previous = readExisting();
  var unchanged =
    previous && previous.data &&
    previous.data.issue === data.issue &&
    previous.data.date === data.date &&
    (previous.data.reds || []).join(",") === data.reds.join(",") &&
    Number(previous.data.blue) === Number(data.blue);

  if (unchanged) {
    console.log("第 " + data.issue + " 期无变化，跳过写入");
    return;
  }

  var payload = {
    ok: true,
    cached: false,
    updatedAt: new Date().toISOString(),
    data: data
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(
    "已写入第 " + data.issue + " 期 " + data.date +
    " 红 " + data.reds.join(" ") + " 蓝 " + data.blue
  );
}

main().catch(function onError(error) {
  console.warn("抓取失败，保留现有 data.json：" + error.message);
  /* 退出码 2：让 sync-push.bat 能分清「抓到了但没变化」和「根本没抓到」。
     这两个在命令行里都是 0，看不出区别。GitHub Actions 那边用 || true 兜，
     不让它变红发一堆邮件。 */
  process.exitCode = 2;
});
