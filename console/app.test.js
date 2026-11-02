import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffCandidates, emptyCandidate, fmtDate, shortDigest, parseHash, activationLabel, login, resolveView, setDiff, formatVersion } from './app.js';

describe('纯辅助函数', () => {
  it('空候选差异为空', () => {
    const diff = diffCandidates(emptyCandidate(), emptyCandidate());
    assert.equal(diff.rules.length, 0);
    assert.equal(diff.activationChanged, false);
  });

  it('能检测新增、删除和修改的规则', () => {
    const base = {
      rules: [
        { id: 'a', level: 0, on_hit: 'deny' },
        { id: 'b', level: 1, on_hit: 'confirm' },
      ],
      activation: { includedRuleIds: null, excludedRuleIds: [] },
    };
    const proposed = {
      rules: [
        { id: 'a', level: 0, on_hit: 'deny' },
        { id: 'b', level: 1, on_hit: 'deny' },
        { id: 'c', level: 0, on_hit: 'log' },
      ],
      activation: { includedRuleIds: null, excludedRuleIds: [] },
    };
    const diff = diffCandidates(base, proposed);
    const added = diff.rules.find((r) => r.type === 'added');
    const modified = diff.rules.find((r) => r.type === 'modified');
    const removed = diff.rules.find((r) => r.type === 'removed');
    assert.ok(added && added.id === 'c');
    assert.ok(modified && modified.id === 'b');
    assert.equal(removed, undefined);
  });

  it('激活策略变更被识别', () => {
    const base = { rules: [], activation: { includedRuleIds: null, excludedRuleIds: [] } };
    const proposed = { rules: [], activation: { includedRuleIds: ['r1'], excludedRuleIds: [] } };
    const diff = diffCandidates(base, proposed);
    assert.equal(diff.activationChanged, true);
  });

  it('激活策略标签正确', () => {
    assert.equal(activationLabel({ rules: [], activation: { includedRuleIds: null, excludedRuleIds: [] } }), '全部生效');
    assert.equal(activationLabel({ rules: [{ id: 'a' }], activation: { includedRuleIds: null, excludedRuleIds: ['a'] } }), '全部生效（排除 1 条）');
    assert.equal(activationLabel({ rules: [{ id: 'a' }, { id: 'b' }], activation: { includedRuleIds: ['a'], excludedRuleIds: [] } }), '显式包含 1 条，排除 0 条');
  });

  it('日期格式化', () => {
    assert.equal(fmtDate(null), '—');
    assert.ok(fmtDate('2026-10-30T12:00:00.000Z').includes('2026'));
  });

  it('摘要缩短', () => {
    assert.equal(shortDigest(null), '—');
    assert.equal(shortDigest('abcdef123456'), 'abcdef123456');
    assert.equal(shortDigest('abcdef1234567890', 6), 'abcdef…');
  });

  it('版本格式化', () => {
    assert.equal(formatVersion(null), '0（尚未发布）');
    assert.equal(formatVersion(undefined), '0（尚未发布）');
    assert.equal(formatVersion(0), '0');
    assert.equal(formatVersion(3), '3');
  });

  it('hash 路由解析', () => {
    const original = globalThis.location;
    try {
      globalThis.location = { hash: '#proposals/p-1' };
      assert.deepEqual(parseHash(), { view: 'proposals', param: 'p-1' });
      globalThis.location = { hash: '#rules' };
      assert.deepEqual(parseHash(), { view: 'rules', param: null });
      globalThis.location = { hash: '' };
      assert.deepEqual(parseHash(), { view: 'overview', param: null });
    } finally {
      if (original === undefined) {
        delete globalThis.location;
      } else {
        globalThis.location = original;
      }
    }
  });
});

describe('路由分发', () => {
  it('复数路由带参数映射到详情页', () => {
    assert.deepEqual(resolveView('proposals', 'p-1'), { view: 'proposal', param: 'p-1' });
    assert.deepEqual(resolveView('versions', '3'), { view: 'version', param: '3' });
  });

  it('复数路由无参数保持列表页', () => {
    assert.deepEqual(resolveView('proposals', null), { view: 'proposals', param: null });
    assert.deepEqual(resolveView('versions', null), { view: 'versions', param: null });
  });

  it('单数路由直接透传', () => {
    assert.deepEqual(resolveView('proposal', 'p-1'), { view: 'proposal', param: 'p-1' });
    assert.deepEqual(resolveView('version', '3'), { view: 'version', param: '3' });
  });
});

describe('集合差异', () => {
  it('等数量交换能识别新增与移除', () => {
    const diff = setDiff(['a'], ['b']);
    assert.deepEqual(diff.added, ['b']);
    assert.deepEqual(diff.removed, ['a']);
  });

  it('激活策略排除交换在候选差异中可见', () => {
    const base = { rules: [], activation: { includedRuleIds: null, excludedRuleIds: ['a'] } };
    const proposed = { rules: [], activation: { includedRuleIds: null, excludedRuleIds: ['b'] } };
    const diff = diffCandidates(base, proposed);
    assert.equal(diff.activationChanged, true);
  });
});

describe('登录流程回归', () => {
  it('login 在 POST /api/login 前先 GET /api/session 获取 CSRF', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    let sessionCount = 0;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, method: init?.method || 'GET', headers: init?.headers || {} });
      const ok = (status) => ({ ok: true, status, text: async () => '', json: async () => ({}) });
      if (url === '/api/session') {
        sessionCount += 1;
        const body = sessionCount === 1
          ? { authenticated: false, csrfToken: 'anonymous-csrf' }
          : { authenticated: true, role: 'human', csrfToken: 'auth-csrf' };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (url === '/api/login') {
        return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
      }
      return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) };
    };
    try {
      await login('test-token');
      assert.equal(calls.length, 3, '应产生 3 次请求');
      assert.equal(calls[0].url, '/api/session');
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[1].url, '/api/login');
      assert.equal(calls[1].method, 'POST');
      assert.equal(calls[1].headers['X-CSRF-Token'], 'anonymous-csrf', 'POST 登录须使用先获取的 CSRF');
      assert.equal(calls[2].url, '/api/session');
      assert.equal(calls[2].method, 'GET');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('安全约束静态检查', () => {
  it('app.js 未使用危险 API', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    assert.equal(src.includes('localStorage'), false, '不得使用 localStorage');
    assert.equal(src.includes('eval('), false, '不得使用 eval');
    assert.equal(src.includes('innerHTML'), false, '不得使用 innerHTML 渲染不可信内容');
    assert.equal(/\son\w+\s*=/.test(src), false, '不得使用内联事件处理器');
    assert.equal(src.includes('一次性访问令牌'), false, '登录说明应使用人类访问令牌');
    assert.ok(src.includes('人类访问令牌'), '登录说明应包含人类访问令牌');
  });

  it('index.html 仅引用同域静态资源且无内联脚本/样式', async () => {
    const fs = await import('node:fs');
    const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('<script type="module" src="/app.js"></script>'), '引用 /app.js');
    assert.ok(html.includes('href="/styles.css"'), '引用 /styles.css');
    assert.equal(/<script\b[^>]*>/.test(html.replace('<script type="module" src="/app.js"></script>', '')), false, '无内联脚本');
    assert.equal(html.includes('<style>'), false, '无内联样式块');
    assert.equal(/\son\w+\s*=/.test(html), false, '无内联事件处理器');
  });

  it('styles.css 无外部字体或请求', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    assert.equal(css.includes('@import'), false, '无 @import');
    assert.equal(/url\s*\(\s*['"]?(?:https?:|\/\/)/.test(css), false, '无外部 url() 引用');
  });
});
