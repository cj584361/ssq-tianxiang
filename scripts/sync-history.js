/* ==================================================================
 * 抓取福彩官网近 N 期开奖，写成 history.json
 *
 * 用途：给「奖金走势」曲线提供数据。
 * data.json 只有最新一期，画不了曲线，所以单独存一份历史。
 *
 * 本地也能跑：node scripts/sync-history.js
 * 抓不到时保留旧文件、退出码 0，不让 Actions 变红。
 * ================================================================== */

var fs = require("fs");
var path = require("path");

var OUT = path.join(__dirname, "..", "history.json");

/* 100 期约合 8 个月，文件约 14 KB。再多画在手机上也看不清 */
var PERIODS = 100;

var API =
  "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
  "?name=ssq&issueCount=&issueStart=&issueEnd=&dayStart=&dayEnd=" +
  "&pageNo=1&pageSize=" + PERIODS + "&week=&systemType=PC";

/** 从 prizegrades 里取某一等奖级 (type 1~6) 的注数与单注奖金 */
function gradeOf(grades, type) {
  var list = Array.isArray(grades) ? grades : [];
  for (var i = 0; i < list.length; i++) {
    if (Number(list[i].type) === type) {
      var num = parseInt(list[i].typenum, 10);
      var money = parseInt(list[i].typemoney, 10);
      return {
        num: isNaN(num) ? 0 : num,
        money: isNaN(money) ? 0 : money
      };
    }
  }
  return { num: 0, money: 0 };
}

/** 官网字段 → 曲线要的形状。只保留画图用得上的，压体积 */
function normalize(item) {
  var first = gradeOf(item.prizegrades, 1);
  var second = gradeOf(item.prizegrades, 2);

  return {
    issue: String(item.code || ""),
    date: String(item.date || "").replace(/\(.*\)$/, ""),
    pool: Number(item.poolmoney) || 0,
    sales: Number(item.sales) || 0,
    firstNum: first.num,
    firstMoney: first.money,
    secondNum: second.num,
    secondMoney: second.money
  };
}

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
  var list = (body && body.result) || [];
  if (!list.length) {
    throw new Error("官网没有返回开奖记录");
  }

  /* 官网按新→旧返回，反过来存成旧→新，前端直接按数组顺序画 */
  var items = list
    .map(normalize)
    .filter(function isValid(row) {
      return row.issue && row.date;
    })
    .reverse();

  if (items.length < 10) {
    throw new Error("只拿到 " + items.length + " 期，太少，放弃写入");
  }

  var previous = readExisting();
  var same =
    previous && Array.isArray(previous.items) &&
    previous.items.length === items.length &&
    previous.items[previous.items.length - 1].issue ===
      items[items.length - 1].issue &&
    previous.items[0].issue === items[0].issue;

  if (same) {
    console.log("历史数据未变化（" + items.length + " 期），跳过写入");
    return;
  }

  var payload = {
    ok: true,
    updatedAt: new Date().toISOString(),
    count: items.length,
    items: items
  };

  fs.writeFileSync(OUT, JSON.stringify(payload) + "\n", "utf8");

  var last = items[items.length - 1];
  console.log(
    "已写入 " + items.length + " 期历史，" +
    "最新第 " + last.issue + " 期 " + last.date +
    "，奖池 " + (last.pool / 1e8).toFixed(2) + " 亿，" +
    "一等 " + last.firstNum + " 注 / " + last.firstMoney + " 元"
  );
}

main().catch(function onError(error) {
  console.warn("抓取失败，保留现有 history.json：" + error.message);
  /* 同 sync-draw.js：用退出码 2 让本地脚本能分辨失败，Actions 用 || true 兜 */
  process.exitCode = 2;
});
