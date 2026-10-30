/* ==================================================================
 * 双色球开奖同步 —— 腾讯云云函数（SCF）版
 *
 * 干什么：跑在腾讯云国内机房（广州/上海/北京）上抓福彩官网，
 *        把最新一期写回 GitHub 仓库的 data.json，
 *        顺手把近 100 期写回 history.json（奖金曲线用）。
 *        电脑不用开机，GitHub Pages 一分钟后就更新。
 *
 * 为什么不是 GitHub Actions：福彩官网只对国内 IP 开放，GitHub 机器在海外。
 *
 * 用法：整段复制到 SCF 控制台「函数代码 → index.js」，点「部署」。
 *      第一次跑保持 DRY_RUN 默认值（自检，只抓不写）。
 *      详细步骤见同目录 README.md。
 *
 * 运行环境：Node.js 16 / 18 / 20 都行。
 * 零依赖：只用 Node 内置 https，不需要 npm install，不需要打 zip 包。
 * ================================================================== */

'use strict';

var https = require('https');

/* ---------------- 配置：全部走环境变量 ---------------- */

/**
 * 每次调用时现读，方便在控制台改完环境变量直接生效，
 * 也方便本地测试时临时改 process.env。
 */
function config() {
  return {
    /* GitHub 细粒度 token：
       Settings → Developer settings → Personal access tokens → Fine-grained tokens
       仓库只选 ssq-tianxiang，权限只给 Contents: Read and write。
       注意细粒度 token 有有效期（最长 1 年），到期要换。 */
    token: process.env.GH_TOKEN || '',
    owner: process.env.GH_OWNER || 'cj584361',
    repo: process.env.GH_REPO || 'ssq-tianxiang',
    branch: process.env.GH_BRANCH || 'main',

    /* 默认 1 = 自检模式：只抓官网、打日志，一个字都不往 GitHub 写。
       确认能抓到数据之后，把环境变量改成 DRY_RUN=0 才会真推送。 */
    dryRun: String(process.env.DRY_RUN === undefined ? '1' : process.env.DRY_RUN) !== '0',

    /* 要不要顺带更新 history.json（近 100 期，奖金曲线用）。默认要。 */
    syncHistory: String(process.env.SYNC_HISTORY === undefined ? '1' : process.env.SYNC_HISTORY) !== '0'
  };
}

/* ---------------- 官网接口 ---------------- */

var DRAW_API =
  'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice' +
  '?name=ssq&issueCount=&issueStart=&issueEnd=&dayStart=&dayEnd=' +
  '&pageNo=1&pageSize=1&week=&systemType=PC';

var HISTORY_API =
  'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice' +
  '?name=ssq&issueCount=&issueStart=&issueEnd=&dayStart=&dayEnd=' +
  '&pageNo=1&pageSize=100&week=&systemType=PC';

/* 官网校验 UA 和 Referer，少一个就返回空 */
var UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

var CWL_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
  Accept: 'application/json, text/javascript, */*; q=0.01'
};

/* ---------------- HTTP：只用内置 https，不依赖 fetch ---------------- */

/**
 * 发一个请求，返回 { status, text }。
 * 不用全局 fetch 是故意的：Node 16 没有，装依赖又要打 zip 包。
 */
function httpRequest(options) {
  return new Promise(function (resolve, reject) {
    var target;
    try {
      target = new URL(options.url);
    } catch (error) {
      reject(new Error('URL 不合法：' + options.url));
      return;
    }

    var req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: options.method || 'GET',
        headers: options.headers || {}
      },
      function (res) {
        var chunks = [];
        res.on('data', function (chunk) {
          chunks.push(chunk);
        });
        res.on('end', function () {
          resolve({
            status: res.statusCode,
            headers: res.headers || {},
            text: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    req.setTimeout(options.timeout || 20000, function () {
      req.destroy(new Error('请求超时（' + (options.timeout || 20000) + 'ms）：' + options.url.slice(0, 90)));
    });

    req.on('error', reject);

    if (options.body) req.write(options.body);
    req.end();
  });
}

/* 测试时替换成假实现，生产环境就是上面这个 */
var transport = httpRequest;

/* ---------------- 官网字段 → 前端要的形状 ---------------- */

function log(message) {
  console.log('[双色球同步] ' + message);
}

/** 安全取 JSON：先拿文本再 parse，非 JSON 响应时能看清状态码和前几个字 */
function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(label + ' 不是 JSON（前 120 字：' + String(text).slice(0, 120) + '）');
  }
}

/** 最新一期。跟 scripts/sync-draw.js 的 normalize 保持一致 */
function normalizeDraw(item) {
  var reds = String(item.red || '')
    .split(',')
    .map(function toNumber(part) {
      return parseInt(part, 10);
    })
    .filter(function isValid(n) {
      return !isNaN(n);
    });

  return {
    issue: String(item.code || ''),
    date: String(item.date || '').replace(/\(.*\)$/, ''),
    week: String(item.week || ''),
    reds: reds,
    blue: parseInt(item.blue, 10),
    sales: Number(item.sales) || 0,
    pool: Number(item.poolmoney) || 0,
    detail: item.detailsLink ? 'https://www.cwl.gov.cn' + item.detailsLink : ''
  };
}

/** 取某一奖级（type 1~6）的注数与单注奖金 */
function gradeOf(grades, type) {
  var list = Array.isArray(grades) ? grades : [];
  for (var i = 0; i < list.length; i++) {
    if (Number(list[i].type) === type) {
      var num = parseInt(list[i].typenum, 10);
      var money = parseInt(list[i].typemoney, 10);
      return { num: isNaN(num) ? 0 : num, money: isNaN(money) ? 0 : money };
    }
  }
  return { num: 0, money: 0 };
}

/** 曲线用的一行。跟 scripts/sync-history.js 保持一致 */
function normalizeHistory(item) {
  var first = gradeOf(item.prizegrades, 1);
  var second = gradeOf(item.prizegrades, 2);

  return {
    issue: String(item.code || ''),
    date: String(item.date || '').replace(/\(.*\)$/, ''),
    pool: Number(item.poolmoney) || 0,
    sales: Number(item.sales) || 0,
    firstNum: first.num,
    firstMoney: first.money,
    secondNum: second.num,
    secondMoney: second.money
  };
}

async function fetchLatestDraw() {
  var resp = await transport({ url: DRAW_API, headers: CWL_HEADERS, timeout: 20000 });
  log('官网状态码：' + resp.status);

  if (resp.status !== 200) {
    throw new Error(
      '官网返回 HTTP ' + resp.status +
      '。腾讯云机房 IP 也可能被官网挡（它会按 IP 段限流/封禁）。' +
      '可以换地域（上海 / 北京）再试一次；实在不行回退本机 sync-push.bat。' +
      '前 120 字：' + resp.text.slice(0, 120)
    );
  }

  var body = parseJson(resp.text, '官网响应');
  var first = body && body.result && body.result[0];
  if (!first) {
    throw new Error('官网没返回开奖记录（result 为空）。可能是官网改版，也可能是被 WAF 挡了。');
  }

  var draw = normalizeDraw(first);
  if (draw.reds.length !== 6 || isNaN(draw.blue) || !draw.issue) {
    throw new Error('开奖数据不完整：' + JSON.stringify(draw));
  }
  return draw;
}

async function fetchHistory() {
  var resp = await transport({ url: HISTORY_API, headers: CWL_HEADERS, timeout: 25000 });

  if (resp.status !== 200) {
    throw new Error('官网返回 HTTP ' + resp.status);
  }

  var body = parseJson(resp.text, '官网响应');
  var list = (body && body.result) || [];
  if (!list.length) {
    throw new Error('官网没返回历史记录');
  }

  /* 官网按新→旧给，翻转成旧→新，前端照数组顺序画 */
  var items = list
    .map(normalizeHistory)
    .filter(function isValid(row) {
      return row.issue && row.date;
    })
    .reverse();

  if (items.length < 10) {
    throw new Error('只拿到 ' + items.length + ' 期，太少，放弃');
  }
  return items;
}

/* ---------------- GitHub 读写（Contents API） ---------------- */

function ghHeaders(cfg) {
  return {
    Authorization: 'Bearer ' + cfg.token,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'ssq-scf-sync',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function ghFileUrl(cfg, file) {
  return 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + file;
}

/** 读仓库里的文件，返回 { exists, sha, text } */
async function readRemote(cfg, file) {
  var resp = await transport({
    url: ghFileUrl(cfg, file) + '?ref=' + encodeURIComponent(cfg.branch),
    headers: ghHeaders(cfg),
    timeout: 20000
  });

  if (resp.status === 404) return { exists: false, sha: null, text: null };
  if (resp.status === 401) {
    throw new Error('GitHub 返回 401：token 无效或已过期。重新生成一个 Fine-grained token。');
  }
  if (resp.status === 403) {
    throw new Error('GitHub 返回 403：token 没有 Contents 写权限，或被限流。');
  }
  if (resp.status !== 200) {
    throw new Error('读 ' + file + ' 失败：HTTP ' + resp.status + ' ' + resp.text.slice(0, 180));
  }

  var payload = parseJson(resp.text, 'GitHub contents');
  var text = null;
  try {
    text = Buffer.from(String(payload.content || ''), 'base64').toString('utf8');
  } catch (error) {
    text = null;
  }
  return { exists: true, sha: payload.sha, text: text };
}

/** 写仓库文件。sha 必须带上（乐观锁），否则并发写会打架 */
async function writeRemote(cfg, file, text, message) {
  var current = await readRemote(cfg, file);

  var body = {
    message: message,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: cfg.branch
  };
  if (current.sha) body.sha = current.sha;

  var resp = await transport({
    url: ghFileUrl(cfg, file),
    method: 'PUT',
    headers: ghHeaders(cfg),
    body: JSON.stringify(body),
    timeout: 30000
  });

  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error('写 ' + file + ' 失败：HTTP ' + resp.status + ' ' + resp.text.slice(0, 220));
  }
  return current;
}

/* ---------------- 主流程 ---------------- */

function isoNow() {
  return new Date().toISOString();
}

/** 从远端 data.json 文本里抠出期号，抠不到就返回空串 */
function issueOfDataJson(text) {
  if (!text) return '';
  try {
    var parsed = JSON.parse(text);
    return parsed && parsed.data ? String(parsed.data.issue || '') : '';
  } catch (error) {
    return '';
  }
}

/** 从远端 history.json 文本里抠出 { count, lastIssue } */
function summaryOfHistoryJson(text) {
  if (!text) return { count: 0, lastIssue: '' };
  try {
    var parsed = JSON.parse(text);
    var items = Array.isArray(parsed.items) ? parsed.items : [];
    return {
      count: items.length,
      lastIssue: items.length ? String(items[items.length - 1].issue || '') : ''
    };
  } catch (error) {
    return { count: 0, lastIssue: '' };
  }
}

async function main() {
  var cfg = config();
  var report = {
    ok: true,
    mode: cfg.dryRun ? '自检（只抓不写）' : '自动（抓取 + 推送 GitHub）',
    issue: '',
    draw: null,
    historyCount: 0,
    changed: [],
    skipped: []
  };

  log('开始运行：' + isoNow());
  log('模式：' + report.mode);

  /* 1. 抓最新一期。抓不到就直接失败，这是整个任务的唯一硬依赖 */
  var draw = await fetchLatestDraw();
  report.issue = draw.issue;
  report.draw = draw;
  log(
    '官网最新：第 ' + draw.issue + ' 期 ' + draw.date +
    '（周' + draw.week + '）红 ' + draw.reds.join(' ') + ' 蓝 ' + draw.blue
  );

  /* 2. 抓近 100 期。失败不算致命，最新一期照样能推 */
  var history = null;
  if (cfg.syncHistory) {
    try {
      history = await fetchHistory();
      report.historyCount = history.length;
      log('官网历史：' + history.length + ' 期，最新 ' + history[history.length - 1].issue);
    } catch (error) {
      log('历史抓取失败（不影响最新一期）：' + error.message);
      report.skipped.push('history.json（抓取失败）');
    }
  }

  /* 3. 自检模式到此为止，一个字都不写 */
  if (cfg.dryRun) {
    log('自检模式（DRY_RUN=1），没有推送。');
    log('如果上面能看到期号和红蓝球，说明腾讯云能访问官网 → 加 GH_TOKEN 并把 DRY_RUN 改成 0 即可全自动。');
    return report;
  }

  if (!cfg.token) {
    throw new Error('GH_TOKEN 没配。要么先保持 DRY_RUN=1 自检，要么在「函数配置 → 环境变量」里加上 GH_TOKEN。');
  }

  /* 4. data.json：期号没变就不提交，别制造空提交 */
  var remoteDraw = await readRemote(cfg, 'data.json');
  var remoteIssue = issueOfDataJson(remoteDraw.text);

  if (remoteIssue === draw.issue) {
    log('data.json 已经是第 ' + remoteIssue + ' 期，跳过');
    report.skipped.push('data.json（已是最新）');
  } else {
    var drawPayload = {
      ok: true,
      cached: false,
      updatedAt: isoNow(),
      data: draw
    };
    await writeRemote(
      cfg,
      'data.json',
      JSON.stringify(drawPayload, null, 2) + '\n',
      'chore: 腾讯云函数同步第 ' + draw.issue + ' 期开奖'
    );
    report.changed.push('data.json');
    log('已写入 data.json：' + (remoteIssue || '（空）') + ' → ' + draw.issue);
  }

  /* 5. history.json：靠「期数 + 最新期号」判断有没有变 */
  if (history) {
    var remoteHistory = await readRemote(cfg, 'history.json');
    var summary = summaryOfHistoryJson(remoteHistory.text);
    var latestIssue = history[history.length - 1].issue;

    if (summary.count === history.length && summary.lastIssue === latestIssue) {
      log('history.json 没变化（' + history.length + ' 期，最新 ' + latestIssue + '），跳过');
      report.skipped.push('history.json（已是最新）');
    } else {
      var historyPayload = {
        ok: true,
        updatedAt: isoNow(),
        count: history.length,
        items: history
      };
      await writeRemote(
        cfg,
        'history.json',
        JSON.stringify(historyPayload) + '\n',
        'chore: 腾讯云函数同步近 ' + history.length + ' 期历史（至 ' + latestIssue + '）'
      );
      report.changed.push('history.json');
      log('已写入 history.json：' + history.length + ' 期，最新 ' + latestIssue);
    }
  }

  if (!report.changed.length) {
    log('这次没有任何变化，没提交。');
  } else {
    log('已提交：' + report.changed.join('、') + '。约 1 分钟后线上生效：https://cj584361.github.io/ssq-tianxiang/');
  }

  return report;
}

/* ---------------- SCF 入口 ---------------- */

exports.main_handler = async function main_handler(event, context) {
  try {
    return await main();
  } catch (error) {
    /* 不往外抛，避免日志里只剩一句堆栈；把原因写清楚，控制台直接可读 */
    var message = error && error.message ? error.message : String(error);
    console.error('[双色球同步] 失败：' + message);
    return {
      ok: false,
      error: message,
      hint:
        message.indexOf('HTTP 4') === 0 || message.indexOf('官网返回 HTTP') >= 0
          ? '官网拒绝了这个请求，多半是腾讯云机房的 IP 被限。换地域（上海/北京）再试，或回退本机 sync-push.bat。'
          : ''
    };
  }
};

/* 本地测试用：替换掉 HTTP 层 */
exports.__setTransport = function __setTransport(fn) {
  transport = fn || httpRequest;
};
exports.__main = main;
