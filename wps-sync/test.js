/* ==================================================================
 * airsync.js 的本地验证：用 mock 顶掉 HTTP / console，跑真实脚本代码
 *
 * 跑法：node wps-sync/test.js
 * 目的：AirScript 只能在金山文档里跑，没法本地调试。把能离线验证的部分
 *      （base64、字段归一化、GitHub 读写流程、禁用语法）全测一遍，
 *      避免粘进编辑器才发现语法报错。
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'airsync.js'), 'utf8');

/* 极简的官网响应，字段名与真实接口一致 */
const SAMPLE = JSON.stringify({
  state: 0,
  message: '查询成功',
  total: 1,
  result: [
    {
      name: '双色球',
      code: '2026124',
      detailsLink: '/c/2026/10/29/671548.shtml',
      date: '2026-10-29(四)',
      week: '四',
      red: '03,11,17,22,23,29',
      blue: '09',
      sales: '346568144',
      poolmoney: '1075698427',
    },
  ],
});

let fails = 0;
function check(label, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + extra : ''));
}

function response(status, text) {
  return { status, text: () => text, json: () => JSON.parse(text) };
}

/** 在沙箱里跑脚本，收集日志 */
function run(source, httpMock) {
  const logs = [];
  const fakeConsole = { log: (m) => logs.push(String(m)) };
  let error = null;
  try {
    new Function('HTTP', 'console', 'Date', source)(httpMock, fakeConsole, Date);
  } catch (e) {
    error = e;
  }
  return { logs, error };
}

// ---------- 1. 自检模式：只抓不推 ----------
const r1 = run(SRC, {
  fetch: () => response(200, SAMPLE),
  get: () => {
    throw new Error('自检模式不该调用 get');
  },
});
check('自检模式不报错', !r1.error, r1.error ? r1.error.message : '');
check('日志里有官网期号', r1.logs.some((l) => l.includes('2026124')));
check('日志含红蓝球', r1.logs.some((l) => /红 0?3 11 17 22 23 29/.test(l)));
check('自检模式没有推送', !r1.logs.some((l) => l.includes('已推送')));

// ---------- 2. 正式模式：仓库是旧的一期 → 应当 PUT ----------
const oldPayload =
  JSON.stringify({ ok: true, cached: false, updatedAt: '2026-10-28T06:26:31.672Z', data: { issue: '2026123' } }, null, 2) + '\n';
// GitHub 返回的 content 带换行，脚本必须能处理
const wrappedOld = Buffer.from(oldPayload, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');

let putCalls = 0;
let captured = null;
const httpPush = {
  fetch: (url, opts) => {
    if (opts && opts.method === 'PUT') {
      putCalls++;
      captured = { url, opts };
      return response(200, '{"content":{"sha":"newsha"}}');
    }
    return response(200, SAMPLE);
  },
  get: () => response(200, JSON.stringify({ sha: 'oldsha', content: wrappedOld, encoding: 'base64' })),
};

const pushSrc = SRC.replace('TEST_ONLY: true', 'TEST_ONLY: false').replace("TOKEN: ''", "TOKEN: 'ghp_test'");
const r2 = run(pushSrc, httpPush);
check('正式模式不报错', !r2.error, r2.error ? r2.error.message : '');
check('发起 1 次 PUT', putCalls === 1, '实际 ' + putCalls);
check('日志提示准备写入 2026124', r2.logs.some((l) => l.includes('准备写入第 2026124 期')));

if (captured) {
  const body = JSON.parse(captured.opts.body);
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
  } catch (e) {
    parsed = null;
  }

  check('PUT 带上旧 sha（乐观锁）', body.sha === 'oldsha', '实际 ' + body.sha);
  check('PUT 指向 main 分支', body.branch === 'main');
  check('content 是合法 base64 → 合法 JSON', parsed !== null);
  check('写入期号 2026124', parsed && parsed.data.issue === '2026124');
  check('红球 6 个', parsed && parsed.data.reds.length === 6, parsed ? parsed.data.reds.join(',') : '');
  check('蓝球 9', parsed && parsed.data.blue === 9);
  check('week 去掉括号后缀', parsed && parsed.data.week === '四', parsed ? parsed.data.week : '');
  check('date 是纯日期', parsed && parsed.data.date === '2026-10-29', parsed ? parsed.data.date : '');
  check('奖池是数字', parsed && typeof parsed.data.pool === 'number' && parsed.data.pool > 0);
  check('updatedAt 是 ISO 格式', parsed && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.updatedAt), parsed ? parsed.updatedAt : '');
  check('detail 是官网链接', parsed && /cwl\.gov\.cn/.test(parsed.data.detail));

  const current = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  check(
    '字段与现有 data.json 完全一致',
    JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(Object.keys(current).sort()) &&
      JSON.stringify(Object.keys(parsed.data).sort()) === JSON.stringify(Object.keys(current.data).sort())
  );
  // 前端拿 updatedAt 跟 Date.now() 比，格式必须能被解析
  check('updatedAt 可被 Date 解析', !isNaN(new Date(parsed.updatedAt).getTime()));
}

// ---------- 3. 仓库已是同一期 → 不该 PUT ----------
putCalls = 0;
const sameB64 = Buffer.from(JSON.stringify({ ok: true, data: { issue: '2026124' } }, null, 2) + '\n', 'utf8').toString('base64');
const r3 = run(pushSrc, {
  fetch: (url, opts) => {
    if (opts && opts.method === 'PUT') {
      putCalls++;
      return response(200, '{}');
    }
    return response(200, SAMPLE);
  },
  get: () => response(200, JSON.stringify({ sha: 's', content: sameB64 })),
});
check('同期不重复推送', putCalls === 0 && !r3.error, r3.error ? r3.error.message : '');
check('同期日志说明无需更新', r3.logs.some((l) => l.includes('无需更新')));

// ---------- 4. 官网返回脏数据 → 明确报错 ----------
const r4 = run(SRC, {
  fetch: () => response(200, '<html>系统繁忙</html>'),
  get: () => response(200, '{}'),
});
check('脏数据报错且说明原因', !!r4.error && /不是 JSON/.test(r4.error.message), r4.error ? r4.error.message.slice(0, 50) : '没报错');

// ---------- 5. base64 与标准实现逐字节比对 ----------
const helpers = new Function(SRC.replace('main();', '') + '\nreturn { base64Encode: base64Encode, base64Decode: base64Decode };')();
['双色球', 'hello', '第 2026124 期 🎱 开奖', '', 'a', 'ab', 'abc', '中文混合 abc 123 结束'].forEach((s) => {
  const mine = helpers.base64Encode(s);
  const native = Buffer.from(s, 'utf8').toString('base64');
  check('base64 编码与标准一致：' + JSON.stringify(s), mine === native, mine === native ? '' : 'got ' + mine);
  check('base64 解码还原：' + JSON.stringify(s), helpers.base64Decode(mine) === s);
});

// ---------- 6. AirScript 禁用语法扫描 ----------
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
[
  [/\?\./, '可选链 ?.'],
  [/\basync\b/, 'async'],
  [/\bawait\b/, 'await'],
  [/\bclass\s+\w+/, 'class'],
  [/\bBuffer\b/, 'Buffer'],
  [/\bbtoa\b/, 'btoa'],
  [/\bTextEncoder\b/, 'TextEncoder'],
].forEach(([re, name]) => check('未使用禁用语法：' + name, !re.test(code)));

console.log(fails ? '\n有 ' + fails + ' 条失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
