/* ==================================================================
 * 双色球开奖同步 —— 金山文档 AirScript 版
 *
 * 干什么：跑在金山云（国内 IP）上抓福彩官网，把最新一期写回 GitHub 仓库的
 *        data.json，GitHub Pages 一分钟后自动生效。电脑不用开机。
 *
 * 为什么不用云函数：金山文档自带的定时任务免费，不用实名开云账号。
 * 为什么不让 GitHub Actions 干：福彩官网只对国内 IP 开放，GitHub 机器在海外。
 *
 * ⚠️ 用法见同目录 README.md。第一次跑请保持 TEST_ONLY = true。
 *
 * ⚠️ AirScript 不是完整 Node/浏览器环境，以下写法一律不能用，本文件已全部避开：
 *    async / await、?. 可选链、对象里简写方法 { foo() {} }、class、
 *    Buffer / btoa / TextEncoder
 *    另外 HTTP 请求是同步的，天然不需要 async。
 * ================================================================== */

/* ---------------- 配置区 ---------------- */

var CONFIG = {
  /* 第一次先保持 true：只抓官网、把结果打到日志，不碰 GitHub。
     确认抓得到数据之后，填好 token 再改成 false。 */
  TEST_ONLY: true,

  /* GitHub 细粒度 token（Fine-grained PAT）：
     Settings → Developer settings → Personal access tokens → Fine-grained tokens
     仓库只选 ssq-tianxiang，权限只给 Contents: Read and write，别的都不用勾。
     注意：细粒度 token 最长 1 年有效期，到期要换。 */
  TOKEN: '',

  OWNER: 'cj584361',
  REPO: 'ssq-tianxiang',
  BRANCH: 'main',
  FILE: 'data.json'
};

/* 官网接口。带 UA 和 Referer 是必须的，少一个就返回空。 */
var DRAW_API =
  'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice' +
  '?name=ssq&issueCount=&issueStart=&issueEnd=&dayStart=&dayEnd=' +
  '&pageNo=1&pageSize=1&week=&systemType=PC';

var UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* ---------------- 工具函数 ---------------- */

function pad2(value) {
  return value < 10 ? '0' + value : '' + value;
}

/** ISO 时间（UTC，带毫秒），跟 node 版脚本输出的 updatedAt 保持一致 */
function isoNow() {
  var d = new Date();
  return (
    d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
    'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) +
    '.' + ('00' + d.getUTCMilliseconds()).slice(-3) + 'Z'
  );
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字符串 → UTF-8 字节数组（手写，不依赖 TextEncoder） */
function utf8Bytes(text) {
  var bytes = [];
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      /* 代理对：把两个 16 位拼成一个码点，再按 4 字节编码 */
      var next = text.charCodeAt(i + 1);
      var point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      i++;
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      );
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

/** base64 编码。GitHub 的 contents 接口要求 content 是 base64（不能带换行） */
function base64Encode(text) {
  var bytes = utf8Bytes(text);
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;

    out += B64.charAt(b0 >> 2);
    out += B64.charAt(((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4));
    out += b1 < 0 ? '=' : B64.charAt(((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6));
    out += b2 < 0 ? '=' : B64.charAt(b2 & 63);
  }
  return out;
}

/** base64 解码，用来读回仓库里现有的 data.json 判断期号 */
function base64Decode(text) {
  var clean = String(text).replace(/[\r\n\s]/g, '');
  var bytes = [];
  var buffer = 0;
  var bits = 0;

  for (var i = 0; i < clean.length; i++) {
    var ch = clean.charAt(i);
    if (ch === '=') break;
    var index = B64.indexOf(ch);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  /* UTF-8 解码 */
  var out = '';
  for (var j = 0; j < bytes.length; ) {
    var b = bytes[j++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[j++] & 0x3f));
    } else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[j++] & 0x3f) << 6) | (bytes[j++] & 0x3f));
    } else {
      var point =
        ((b & 0x07) << 18) |
        ((bytes[j++] & 0x3f) << 12) |
        ((bytes[j++] & 0x3f) << 6) |
        (bytes[j++] & 0x3f);
      point -= 0x10000;
      out += String.fromCharCode(0xd800 + (point >> 10), 0xdc00 + (point & 0x3ff));
    }
  }
  return out;
}

function log(message) {
  console.log('[双色球同步] ' + message);
}

/** 安全取 JSON：先拿文本再 parse，避免 .json() 在非 JSON 响应上直接抛 */
function readJson(resp, label) {
  var text = resp.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(label + ' 不是 JSON（HTTP ' + resp.status + '，前 120 字：' + text.slice(0, 120) + '）');
  }
}

/* ---------------- 抓官网 ---------------- */

/** 官网字段 → 前端要的形状，跟 scripts/sync-draw.js 的 normalize 保持一致 */
function normalize(item) {
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

function fetchLatestDraw() {
  var resp = HTTP.fetch(DRAW_API, {
    method: 'GET',
    timeout: 20000,
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
      Accept: 'application/json, text/javascript, */*; q=0.01'
    }
  });

  log('官网 HTTP 状态：' + resp.status);

  var body = readJson(resp, '官网响应');
  var first = body && body.result && body.result[0];
  if (!first) {
    throw new Error('官网没返回开奖记录（result 为空）');
  }

  var data = normalize(first);
  if (data.reds.length !== 6 || isNaN(data.blue) || !data.issue) {
    throw new Error('开奖数据不完整：' + JSON.stringify(data));
  }
  return data;
}

/* ---------------- 读写 GitHub ---------------- */

function githubHeaders() {
  return {
    Authorization: 'Bearer ' + CONFIG.TOKEN,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'ssq-airsync',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function fileUrl() {
  return (
    'https://api.github.com/repos/' + CONFIG.OWNER + '/' + CONFIG.REPO +
    '/contents/' + CONFIG.FILE
  );
}

/** 读仓库里现有的 data.json，返回 { issue, sha }；读不到返回空对象 */
function readRemote() {
  var resp = HTTP.get(fileUrl() + '?ref=' + CONFIG.BRANCH, { timeout: 20000, headers: githubHeaders() });

  if (resp.status === 404) return {};
  if (resp.status !== 200) {
    throw new Error('读 GitHub 失败：HTTP ' + resp.status + ' ' + resp.text().slice(0, 160));
  }

  var payload = readJson(resp, 'GitHub contents');
  var result = { sha: payload.sha };

  try {
    var decoded = JSON.parse(base64Decode(payload.content));
    result.issue = decoded && decoded.data ? String(decoded.data.issue || '') : '';
  } catch (error) {
    result.issue = '';
  }
  return result;
}

function writeRemote(data, sha) {
  var payload = {
    ok: true,
    cached: false,
    updatedAt: isoNow(),
    data: data
  };

  var body = JSON.stringify({
    message: 'chore: 金山云 AirScript 同步第 ' + data.issue + ' 期',
    content: base64Encode(JSON.stringify(payload, null, 2) + '\n'),
    branch: CONFIG.BRANCH,
    sha: sha
  });

  var resp = HTTP.fetch(fileUrl(), {
    method: 'PUT',
    timeout: 30000,
    headers: githubHeaders(),
    body: body
  });

  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error('写 GitHub 失败：HTTP ' + resp.status + ' ' + resp.text().slice(0, 200));
  }
  return true;
}

/* ---------------- 主流程 ---------------- */

function main() {
  log('开始运行，' + isoNow());

  /* 1. 抓官网 */
  var data = fetchLatestDraw();
  log(
    '官网最新：第 ' + data.issue + ' 期 ' + data.date +
    '（周' + data.week + '）红 ' + data.reds.join(' ') + ' 蓝 ' + data.blue
  );

  /* 2. 自检模式：只报告，不动仓库 */
  if (CONFIG.TEST_ONLY) {
    log('自检模式（TEST_ONLY = true），没有推送。');
    log('抓取能力正常。要让它自动更新线上，把 TEST_ONLY 改成 false 并填好 TOKEN。');
    return;
  }

  if (!CONFIG.TOKEN) {
    throw new Error('TOKEN 还没填。要不先保持 TEST_ONLY = true 只看抓取结果？');
  }

  /* 3. 跟仓库里现有的比一比，是同一期就什么都不做 */
  var remote = readRemote();
  if (remote.issue === data.issue) {
    log('仓库里已经是第 ' + remote.issue + ' 期，无需更新。');
    return;
  }

  log('仓库里是 ' + (remote.issue || '（空）') + '，准备写入第 ' + data.issue + ' 期');

  /* 4. 推上去 */
  writeRemote(data, remote.sha);
  log('已推送。约 1 分钟后线上生效：https://cj584361.github.io/ssq-tianxiang/');
}

/* AirScript 直接执行整个脚本，最后一行调用入口 */
main();
