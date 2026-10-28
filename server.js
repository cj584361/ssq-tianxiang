/* ==================================================================
 * 双色球天象选号 · 本地小服务
 *
 * 作用有两个：
 *   1. 托管 index.html（本地起服务后浏览器打开 http://127.0.0.1:5173）
 *   2. 提供 /api/latest，把福彩官网的开奖数据转发给页面
 *
 * 为什么要这一层：福彩官网接口不返回 CORS 头，
 * 浏览器里直接 fetch 会被跨域拦截，所以必须同源转发。
 *
 * 零依赖，不需要 npm install。
 * 启动：node server.js
 * 改端口：PORT=8080 node server.js
 * ================================================================== */

var http = require("http");
var https = require("https");
var fs = require("fs");
var path = require("path");

var PORT = Number(process.env.PORT) || 5173;
/* 云端部署时平台要求监听 0.0.0.0，本地默认只绑本机更安全 */
var HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
var ROOT = __dirname;

/* 上游缓存 8 分钟：一期开奖结果不会变，没必要每次都回源 */
var CACHE_MS = 8 * 60 * 1000;
var UPSTREAM_PATH =
  "/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
  "?name=ssq&issueCount=&issueStart=&issueEnd=&dayStart=&dayEnd=&pageNo=1&pageSize=1&week=&systemType=PC";

var cache = { at: 0, data: null };

/* 历史曲线：100 期约合 8 个月，缓存久一点，反正只在新开奖时才变 */
var HISTORY_MS = 6 * 60 * 60 * 1000;
var HISTORY_PERIODS = 100;
var HISTORY_PATH =
  "/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice" +
  "?name=ssq&issueCount=&issueStart=&issueEnd=&dayStart=&dayEnd=" +
  "&pageNo=1&pageSize=" + HISTORY_PERIODS + "&week=&systemType=PC";
var HISTORY_FILE = path.join(ROOT, "history.json");

var historyCache = { at: 0, data: null };

/* ---------------------------------------------------------------
 * 一、上游取数
 * --------------------------------------------------------------- */

/** 把官网返回的一条记录整理成前端要的形状 */
function normalize(item) {
  var reds = String(item.red || "")
    .split(",")
    .map(function toNumber(text) {
      return parseInt(text, 10);
    })
    .filter(function isValid(n) {
      return !isNaN(n);
    });

  return {
    issue: String(item.code || ""),
    date: String(item.date || "").replace(/\(.*\)$/, ""),
    week: String(item.week || ""),
    reds: reds,
    blue: parseInt(item.blue, 10),
    sales: Number(item.sales) || 0,
    pool: Number(item.poolmoney) || 0,
    detail: "https://www.cwl.gov.cn" + (item.detailsLink || "")
  };
}

/** 请求官网接口，回调 (err, data) */
function fetchUpstream(callback) {
  var settled = false;

  function done(err, data) {
    if (settled) return;
    settled = true;
    callback(err, data);
  }

  var request = https.request(
    {
      hostname: "www.cwl.gov.cn",
      path: UPSTREAM_PATH,
      method: "GET",
      timeout: 12000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/",
        Accept: "application/json, text/javascript, */*; q=0.01"
      }
    },
    function onResponse(response) {
      var chunks = [];
      response.on("data", function onChunk(chunk) {
        chunks.push(chunk);
      });
      response.on("end", function onEnd() {
        if (response.statusCode !== 200) {
          done(new Error("上游返回 HTTP " + response.statusCode));
          return;
        }
        var text = Buffer.concat(chunks).toString("utf8");
        var json;
        try {
          json = JSON.parse(text);
        } catch (error) {
          done(new Error("上游返回内容不是 JSON"));
          return;
        }
        var item = json && json.result && json.result[0];
        if (!item) {
          done(new Error("上游没有开奖数据"));
          return;
        }
        done(null, normalize(item));
      });
      response.on("error", done);
    }
  );

  request.on("timeout", function onTimeout() {
    request.destroy();
    done(new Error("上游超时"));
  });
  request.on("error", done);
  request.end();
}

/* ---------------------------------------------------------------
 * 一·二、历史取数（给奖金走势曲线用）
 * --------------------------------------------------------------- */

/** 从 prizegrades 里取某一奖级的注数与单注奖金，字段与 sync-history.js 一致 */
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

/** 一条历史记录的瘦身版：只留画曲线用得上的字段 */
function normalizeHistory(item) {
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

/** 请求官网历史列表，回调 (err, items) */
function fetchHistoryUpstream(callback) {
  var settled = false;

  function done(err, items) {
    if (settled) return;
    settled = true;
    callback(err, items);
  }

  var request = https.request(
    {
      hostname: "www.cwl.gov.cn",
      path: HISTORY_PATH,
      method: "GET",
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Referer: "https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/",
        Accept: "application/json, text/javascript, */*; q=0.01"
      }
    },
    function onResponse(response) {
      var chunks = [];
      response.on("data", function onChunk(chunk) {
        chunks.push(chunk);
      });
      response.on("end", function onEnd() {
        if (response.statusCode !== 200) {
          done(new Error("上游返回 HTTP " + response.statusCode));
          return;
        }
        var json;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
          done(new Error("上游返回内容不是 JSON"));
          return;
        }
        var list = (json && json.result) || [];
        if (!list.length) {
          done(new Error("上游没有历史数据"));
          return;
        }
        /* 官网按新→旧返回，反过来存成旧→新，前端直接按顺序画 */
        var items = list
          .map(normalizeHistory)
          .filter(function isValid(row) {
            return row.issue && row.date;
          })
          .reverse();
        done(null, items);
      });
      response.on("error", done);
    }
  );

  request.on("timeout", function onTimeout() {
    request.destroy();
    done(new Error("上游超时"));
  });
  request.on("error", done);
  request.end();
}

/** 读本地 history.json，给上游失败时兜底 */
function readHistoryFile() {
  try {
    var parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return parsed && Array.isArray(parsed.items) ? parsed : null;
  } catch (error) {
    return null;
  }
}

/* ---------------------------------------------------------------
 * 二、静态文件
 * --------------------------------------------------------------- */

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

function sendJson(response, status, payload) {
  var body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(body);
}

function serveStatic(response, pathname) {
  var relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  var filePath = path.join(ROOT, relative);

  /* 防目录穿越：解析后的真实路径必须仍在项目目录内 */
  if (filePath.indexOf(ROOT) !== 0) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("403");
    return;
  }

  fs.readFile(filePath, function onRead(error, content) {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("404 " + relative + " 不存在");
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(content);
  });
}

/* ---------------------------------------------------------------
 * 三、路由
 * --------------------------------------------------------------- */

var server = http.createServer(function onRequest(request, response) {
  var pathname = decodeURIComponent(request.url.split("?")[0]);

  /* 允许 file:// 打开页面时也能取数：那时 Origin 是 null，靠通配放行 */
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "*");

  console.log(
    new Date().toTimeString().slice(0, 8) +
      "  " + request.method + " " + pathname +
      "  origin=" + (request.headers.origin || "-")
  );

  if (request.method === "OPTIONS") {
    response.writeHead(204, { "Access-Control-Max-Age": "600" });
    response.end();
    return;
  }

  if (pathname === "/api/latest") {
    var now = Date.now();
    var fresh = cache.data && now - cache.at < CACHE_MS;

    if (fresh) {
      sendJson(response, 200, {
        ok: true,
        cached: true,
        ageSeconds: Math.round((now - cache.at) / 1000),
        data: cache.data
      });
      return;
    }

    fetchUpstream(function onFetched(error, data) {
      if (error) {
        /* 上游挂了但有旧缓存：宁可给旧数据也不要报错，页面标一下即可 */
        if (cache.data) {
          sendJson(response, 200, {
            ok: true,
            cached: true,
            stale: true,
            ageSeconds: Math.round((Date.now() - cache.at) / 1000),
            message: error.message,
            data: cache.data
          });
          return;
        }
        sendJson(response, 502, { ok: false, message: error.message });
        return;
      }
      cache.at = Date.now();
      cache.data = data;
      sendJson(response, 200, {
        ok: true,
        cached: false,
        ageSeconds: 0,
        data: data
      });
    });
    return;
  }

  if (pathname === "/api/history") {
    var nowH = Date.now();
    if (historyCache.data && nowH - historyCache.at < HISTORY_MS) {
      sendJson(response, 200, {
        ok: true,
        cached: true,
        data: historyCache.data
      });
      return;
    }

    fetchHistoryUpstream(function onFetched(error, items) {
      if (error) {
        /* 回源失败：先用内存，再退本地文件，都没有才报错 */
        if (historyCache.data) {
          sendJson(response, 200, {
            ok: true,
            cached: true,
            stale: true,
            message: error.message,
            data: historyCache.data
          });
          return;
        }
        var local = readHistoryFile();
        if (local) {
          historyCache.at = nowH;
          historyCache.data = local;
          sendJson(response, 200, {
            ok: true,
            cached: true,
            stale: true,
            message: error.message,
            data: local
          });
          return;
        }
        sendJson(response, 502, { ok: false, message: error.message });
        return;
      }

      var payload = {
        ok: true,
        updatedAt: new Date().toISOString(),
        count: items.length,
        items: items
      };

      historyCache.at = Date.now();
      historyCache.data = payload;

      /* 顺手落盘：下次就算官网抽风，Pages 和本地都还有一份 */
      fs.writeFile(HISTORY_FILE, JSON.stringify(payload) + "\n", function onWritten(writeError) {
        if (writeError) console.warn("history.json 写入失败：" + writeError.message);
      });

      sendJson(response, 200, {
        ok: true,
        cached: false,
        data: payload
      });
    });
    return;
  }

  if (pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      upstreamCachedAt: cache.at ? new Date(cache.at).toISOString() : null,
      historyCachedAt: historyCache.at ? new Date(historyCache.at).toISOString() : null,
      historyCount: historyCache.data ? historyCache.data.count : null,
      issue: cache.data ? cache.data.issue : null
    });
    return;
  }

  serveStatic(response, pathname);
});

server.on("error", function onServerError(error) {
  if (error.code === "EADDRINUSE") {
    console.error("");
    console.error("  端口 " + PORT + " 已被占用。");
    console.error("  换个端口启动：PORT=5174 node server.js");
    console.error("  或者关掉已在运行的那个窗口。");
    console.error("");
  } else {
    console.error("服务启动失败：" + error.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, function onListen() {
  var shown = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log("");
  console.log("  双色球天象选号已启动");
  console.log("  打开：http://" + shown + ":" + PORT);
  console.log("  开奖数据：http://" + shown + ":" + PORT + "/api/latest");
  console.log("  按 Ctrl+C 停止");
  console.log("");
});
