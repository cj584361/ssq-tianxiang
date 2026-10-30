/* ==================================================================
 * scf-sync/index.js 的本地回归测试
 *
 * 云函数没法在本地真跑（要靠腾讯云控制台），但除了「腾讯云能不能连上官网」
 * 这一条之外，其余逻辑都能在这里用假的 HTTP 层跑通。
 *
 * 跑法：node scf-sync/test.js
 * ================================================================== */

'use strict';

var path = require('path');
var scf = require(path.join(__dirname, 'index.js'));

/* ---------------- 测试夹具：一份官网响应（截自真实接口） ---------------- */

function cwlItem(issue, date, reds, blue, firstMoney, firstNum) {
  return {
    code: issue,
    date: date + '(四)',
    week: '四',
    red: reds.join(','),
    blue: String(blue),
    sales: '346568144',
    poolmoney: '1075698427',
    detailsLink: '/c/2026/10/29/671548.shtml',
    prizegrades: [
      { type: 1, typenum: String(firstNum), typemoney: String(firstMoney) },
      { type: 2, typenum: '184', typemoney: '249525' },
      { type: 3, typenum: '1834', typemoney: '3000' }
    ]
  };
}

var LATEST = cwlItem('2026124', '2026-10-29', [3, 11, 17, 22, 23, 29], 9, 6639739, 7);

/* 100 期历史，期号从 2026025 递增，够 min 10 期门槛 */
function makeHistory(count) {
  var out = [];
  for (var i = 0; i < count; i++) {
    var issue = String(2026025 + i);
    var date = '2026-03-' + (i < 9 ? '0' + (i + 8) : i + 8);
    out.push(cwlItem(issue, date, [1, 2, 3, 4, 5, 6], 7, 5000000 + i, i + 1));
  }
  return out.reverse(); /* 官网是新→旧 */
}

/* ---------------- 假的 GitHub（内存仓库） ---------------- */

function createGithub(initial) {
  var store = {};
  Object.keys(initial || {}).forEach(function (key) {
    store[key] = { text: initial[key], sha: 'sha-' + key + '-1' };
  });

  var calls = [];
  var putCounter = 0;

  function parsePath(url) {
    var match = url.match(/\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  return {
    store: store,
    calls: calls,
    /** 被写上来的文件内容 */
    written: function (name) {
      var hit = calls.filter(function (c) {
        return c.method === 'PUT' && c.file === name;
      });
      return hit.length ? hit[hit.length - 1] : null;
    },
    handle: function (options) {
      var file = parsePath(options.url);
      var method = options.method || 'GET';
      calls.push({ method: method, file: file, url: options.url, body: options.body });

      if (method === 'GET') {
        var found = store[file];
        if (!found) return { status: 404, text: '{"message":"Not Found"}' };
        return {
          status: 200,
          text: JSON.stringify({
            sha: found.sha,
            content: Buffer.from(found.text, 'utf8').toString('base64')
          })
        };
      }

      if (method === 'PUT') {
        var body = JSON.parse(options.body);
        var current = store[file];
        /* 乐观锁：sha 对不上就是 409，跟真 GitHub 一样 */
        if (current && body.sha !== current.sha) {
          return { status: 409, text: '{"message":"sha does not match"}' };
        }
        putCounter++;
        var text = Buffer.from(body.content, 'base64').toString('utf8');
        store[file] = { text: text, sha: 'sha-' + file + '-' + (putCounter + 1) };
        return { status: 200, text: JSON.stringify({ content: { sha: store[file].sha } }) };
      }

      return { status: 405, text: '{}' };
    }
  };
}

/* ---------------- 假的官网 ---------------- */

function createCwl(options) {
  options = options || {};
  var calls = [];

  return {
    calls: calls,
    handle: function (req) {
      calls.push(req.url);

      if (options.status) {
        return { status: options.status, text: 'blocked by waf' };
      }
      if (options.throwError) {
        throw new Error(options.throwError);
      }

      var size = /pageSize=(\d+)/.exec(req.url);
      var pageSize = size ? Number(size[1]) : 1;

      if (pageSize === 1) {
        return { status: 200, text: JSON.stringify({ result: [LATEST] }) };
      }
      if (options.emptyHistory) {
        return { status: 200, text: JSON.stringify({ result: [] }) };
      }
      return { status: 200, text: JSON.stringify({ result: makeHistory(pageSize) }) };
    }
  };
}

/* ---------------- 组装运行环境 ---------------- */

function run(opts) {
  var github = createGithub(opts.files);
  var cwl = createCwl(opts.cwl);

  scf.__setTransport(function (req) {
    if (req.url.indexOf('www.cwl.gov.cn') >= 0) return Promise.resolve(cwl.handle(req));
    if (req.url.indexOf('api.github.com') >= 0) return Promise.resolve(github.handle(req));
    return Promise.reject(new Error('测试里不该请求：' + req.url));
  });

  /* 环境变量逐条设，不设就删，避免上一个用例残留 */
  var env = opts.env || {};
  ['GH_TOKEN', 'GH_OWNER', 'GH_REPO', 'GH_BRANCH', 'DRY_RUN', 'SYNC_HISTORY'].forEach(function (key) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  });

  return scf.__main().then(
    function (report) {
      return { report: report, github: github, cwl: cwl, error: null };
    },
    function (error) {
      return { report: null, github: github, cwl: cwl, error: error };
    }
  );
}

/* ---------------- 断言小工具 ---------------- */

var fails = 0;
var passes = 0;

function t(label, actual, expect) {
  var ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) passes++;
  else fails++;
  console.log(
    (ok ? 'PASS  ' : 'FAIL  ') + label +
    (ok ? '' : '\n        实际 ' + JSON.stringify(actual) + '\n        期望 ' + JSON.stringify(expect))
  );
}

function truthy(label, value) {
  var ok = !!value;
  if (ok) passes++;
  else fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  （实际 ' + JSON.stringify(value) + '）'));
}

function contains(label, haystack, needle) {
  var ok = String(haystack || '').indexOf(needle) >= 0;
  if (ok) passes++;
  else fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  （没找到「' + needle + '」）'));
}

/* ---------------- 开始 ---------------- */

async function suite() {
  console.log('=== 1. 自检模式：默认什么都不写 ===');
  var r1 = await run({ env: {} /* DRY_RUN 不设，走默认 */ });
  t('自检模式跑成功', r1.error && r1.error.message, null);
  t('报告里带上模式', r1.report && r1.report.mode, '自检（只抓不写）');
  t('拿到期号', r1.report && r1.report.issue, '2026124');
  t('红球 6 个', r1.report && r1.report.draw.reds.length, 6);
  t('蓝球 9', r1.report && r1.report.draw.blue, 9);
  t('日期去掉了括号星期', r1.report && r1.report.draw.date, '2026-10-29');
  t('详情链接补全域名', r1.report && r1.report.draw.detail, 'https://www.cwl.gov.cn/c/2026/10/29/671548.shtml');
  t('历史 100 期', r1.report && r1.report.historyCount, 100);
  t('一个 PUT 都没发', r1.github.calls.filter(function (c) { return c.method === 'PUT'; }).length, 0);

  console.log('\n=== 2. 自动模式但没配 token ===');
  var r2 = await run({ env: { DRY_RUN: '0' } });
  truthy('报错', r2.error);
  contains('错误说清是 GH_TOKEN 的问题', r2.error && r2.error.message, 'GH_TOKEN');

  console.log('\n=== 3. 自动模式：仓库已是最新一期 ===');
  var existingData = JSON.stringify({ ok: true, data: { issue: '2026124' } }, null, 2);
  var existingHistory = JSON.stringify({ ok: true, count: 100, items: makeHistory(100).reverse().map(function (x) {
    return { issue: x.code };
  }) });
  var r3 = await run({
    env: { DRY_RUN: '0', GH_TOKEN: 'fake' },
    files: { 'data.json': existingData, 'history.json': existingHistory }
  });
  t('没报错', r3.error && r3.error.message, null);
  t('没写任何文件', r3.report && r3.report.changed, []);
  t('跳过了两个文件', r3.report && r3.report.skipped.length, 2);
  t('依然一个 PUT 都没发', r3.github.calls.filter(function (c) { return c.method === 'PUT'; }).length, 0);

  console.log('\n=== 4. 自动模式：仓库停在旧一期，要写两个文件 ===');
  var oldData = JSON.stringify({ ok: true, data: { issue: '2026123' } });
  var r4 = await run({
    env: { DRY_RUN: '0', GH_TOKEN: 'fake' },
    files: { 'data.json': oldData }
  });
  t('没报错', r4.error && r4.error.message, null);
  t('改了两个文件', r4.report && r4.report.changed, ['data.json', 'history.json']);

  var putData = r4.github.written('data.json');
  var putHistory = r4.github.written('history.json');
  truthy('data.json 有 PUT', putData);
  truthy('history.json 有 PUT', putHistory);

  var dataBody = JSON.parse(putData.body);
  t('data.json 提交信息带期号', dataBody.message, 'chore: 腾讯云函数同步第 2026124 期开奖');
  t('data.json 指定分支', dataBody.branch, 'main');
  t('data.json 带上旧 sha（乐观锁）', dataBody.sha, 'sha-data.json-1');

  var writtenData = JSON.parse(r4.github.store['data.json'].text);
  t('写进去的期号', writtenData.data.issue, '2026124');
  t('写进去的红球', writtenData.data.reds, [3, 11, 17, 22, 23, 29]);
  t('cached 标记是 false', writtenData.cached, false);
  truthy('updatedAt 是 ISO 时间', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(writtenData.updatedAt));

  var writtenHistory = JSON.parse(r4.github.store['history.json'].text);
  t('历史期数', writtenHistory.count, 100);
  t('历史是旧→新（最后一条最新）', writtenHistory.items[99].issue, String(2026025 + 99));
  t('历史带一等奖注数', writtenHistory.items[0].firstNum, 1);
  t('历史带一等奖单注奖金', writtenHistory.items[0].firstMoney, 5000000);
  t('历史带二等奖注数', writtenHistory.items[0].secondNum, 184);
  t('新文件没有旧 sha（首次创建）', JSON.parse(putHistory.body).sha, undefined);

  console.log('\n=== 5. 历史抓取失败，不该挡住最新一期 ===');
  var r5 = await run({
    env: { DRY_RUN: '0', GH_TOKEN: 'fake' },
    files: { 'data.json': oldData },
    cwl: { emptyHistory: true }
  });
  t('没报错', r5.error && r5.error.message, null);
  t('只写了 data.json', r5.report && r5.report.changed, ['data.json']);
  truthy('历史被记成跳过', r5.report && r5.report.skipped.join().indexOf('history.json') >= 0);
  t('历史期数是 0', r5.report && r5.report.historyCount, 0);

  console.log('\n=== 6. 官网 403：要给出能照着做的提示 ===');
  var r6 = await run({ env: {}, cwl: { status: 403 } });
  truthy('报错', r6.error);
  contains('错误里带 HTTP 403', r6.error && r6.error.message, '403');
  contains('错误里提示换地域', r6.error && r6.error.message, '换地域');

  console.log('\n=== 7. 网络异常穿透 ===');
  var r7 = await run({ env: {}, cwl: { throwError: 'ECONNRESET' } });
  truthy('报错', r7.error);
  contains('错误里带原因', r7.error && r7.error.message, 'ECONNRESET');

  console.log('\n=== 8. token 失效要能看懂 ===');
  var github401 = {
    calls: [],
    handle: function () {
      return { status: 401, text: '{"message":"Bad credentials"}' };
    }
  };
  scf.__setTransport(function (req) {
    if (req.url.indexOf('www.cwl.gov.cn') >= 0) return Promise.resolve(createCwl().handle(req));
    return Promise.resolve(github401.handle(req));
  });
  process.env.GH_TOKEN = 'expired';
  process.env.DRY_RUN = '0';
  var r8 = await scf.__main().then(function (x) { return { report: x }; }, function (e) { return { error: e }; });
  truthy('报错', r8.error);
  contains('错误里提示 token 无效', r8.error && r8.error.message, 'token');

  console.log('\n=== 9. 关掉 history 同步 ===');
  var r9 = await run({
    env: { DRY_RUN: '0', GH_TOKEN: 'fake', SYNC_HISTORY: '0' },
    files: { 'data.json': oldData }
  });
  t('只写 data.json', r9.report && r9.report.changed, ['data.json']);
  t('没请求 100 期', r9.cwl.calls.filter(function (u) { return u.indexOf('pageSize=100') >= 0; }).length, 0);

  /* 收尾：清掉环境变量，别影响后面手动跑 */
  ['GH_TOKEN', 'GH_OWNER', 'GH_REPO', 'GH_BRANCH', 'DRY_RUN', 'SYNC_HISTORY'].forEach(function (key) {
    delete process.env[key];
  });

  console.log('\n' + (fails ? ('有 ' + fails + ' 条失败，' + passes + ' 条通过') : ('全部通过（' + passes + ' 条）')));
  process.exitCode = fails ? 1 : 0;
}

suite().catch(function (error) {
  console.error('测试自身崩溃：' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
