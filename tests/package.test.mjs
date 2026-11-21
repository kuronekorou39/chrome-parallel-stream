// ファイルどうしの食い違いを検証する。どれも、ずれても実機で開くまで気づけないもの。
//   - manifest.json が指すファイルが実在し、配布 ZIP(tools/release.mjs の PACK)にも入っている
//   - multiview.js の EMBEDDABLE_HOSTS と、rules.json が埋め込み制限を外す対象が一致している
//   - rules.json が効く範囲が、このページと対応サイトだけに限られている
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(ROOT, name), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const rules = JSON.parse(read('rules.json'));

// ソース中の `const NAME = [ … ];` を配列として読む。
function arrayConst(file, name) {
  const m = read(file).match(new RegExp(`^const ${name} = (\\[[\\s\\S]*?\\]);`, 'm'));
  if (!m) throw new Error(`${file} に ${name} が見つかりません`);
  return new Function(`return ${m[1]};`)();
}

const PACK = arrayConst('tools/release.mjs', 'PACK');
const EMBEDDABLE_HOSTS = arrayConst('multiview.js', 'EMBEDDABLE_HOSTS');
const PAGES_HOST = 'kuronekorou39.github.io';

function manifestFiles() {
  const files = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...manifest.declarative_net_request.rule_resources.map((r) => r.path),
  ];
  return [...new Set(files)];
}

test('manifest.json が指すファイルは実在し、配布 ZIP にも入る', () => {
  for (const file of manifestFiles()) {
    assert.ok(existsSync(join(ROOT, file)), `${file} がありません`);
    assert.ok(PACK.includes(file), `${file} が release.mjs の PACK にありません`);
  }
});

test('配布 ZIP に入れるファイルは実在する。manifest.json とライセンス類も入る', () => {
  for (const file of PACK) assert.ok(existsSync(join(ROOT, file)), `${file} がありません`);
  for (const file of ['manifest.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    assert.ok(PACK.includes(file), `${file} が PACK にありません`);
  }
});

test('ポップアップが読み込むファイルは配布 ZIP に入る', () => {
  const html = read(manifest.action.default_popup);
  const refs = [...html.matchAll(/(?:src|href)="([^":]+\.(?:js|css|png))"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const file of refs) assert.ok(PACK.includes(file), `${file} が PACK にありません`);
});

test('埋め込み制限を外す対象(rules.json)は、枠に表示できるサイト(EMBEDDABLE_HOSTS)と一致する', () => {
  const frameRule = rules.find((r) => r.action.responseHeaders.some((h) => h.header === 'x-frame-options'));
  assert.ok(frameRule, 'X-Frame-Options を外すルールがありません');
  // youtu.be は短縮 URL で、枠には youtube.com の埋め込みプレイヤーへ変換して入れる。
  // youtu.be そのものを枠に読み込むことは無いので、制限を外す対象には入れていない。
  const expected = EMBEDDABLE_HOSTS.filter((h) => h !== 'youtu.be').sort();
  assert.deepEqual([...frameRule.condition.requestDomains].sort(), expected);
});

test('rules.json が効くのは、枠(sub_frame)への、このページか対応サイトからの読み込みだけ', () => {
  for (const rule of rules) {
    const c = rule.condition;
    assert.deepEqual(c.resourceTypes, ['sub_frame'], `ルール ${rule.id}`);
    assert.ok(c.initiatorDomains.includes(PAGES_HOST), `ルール ${rule.id}`);
    for (const d of [...c.initiatorDomains, ...c.requestDomains]) {
      assert.ok(d === PAGES_HOST || EMBEDDABLE_HOSTS.includes(d), `ルール ${rule.id}: ${d} は対応サイトではありません`);
    }
    assert.ok(!c.requestDomains.includes(PAGES_HOST), `ルール ${rule.id}`);
  }
});

test('枠の中のスクリプトは、対応サイトにだけ入る', () => {
  for (const cs of manifest.content_scripts) {
    for (const pattern of cs.matches) {
      const host = pattern.match(/^[^:]+:\/\/(?:\*\.)?([^/]+)\//)[1];
      const ok = host === PAGES_HOST || EMBEDDABLE_HOSTS.some((d) => host === d || host.endsWith('.' + d));
      assert.ok(ok, `${cs.js.join(', ')}: ${pattern} は対応サイトではありません`);
    }
  }
});
