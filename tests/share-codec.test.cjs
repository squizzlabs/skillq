const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'js/codec.js'), 'utf8') + '\n' +
  app.slice(app.indexOf('function bytesToBase64Url('), app.indexOf('async function encodeShareJumpClonesPayload('));
function context(compression = true) {
  const ctx = vm.createContext({ Buffer, Blob, Response, TextEncoder, TextDecoder, console,
    CompressionStream: compression ? CompressionStream : undefined,
    DecompressionStream: compression ? DecompressionStream : undefined,
    SHARE_EMPTY_SKILLS_TOKEN: '-' });
  vm.runInContext(source, ctx);
  return ctx;
}
const plain = value => JSON.parse(JSON.stringify(value));
const timed = row => row.training_start != null || row.training_end != null;
function equivalent(actual, expected) {
  assert.deepEqual(plain(actual.filter(timed)), plain(expected.filter(timed)));
  const sort = rows => plain(rows.filter(row => !timed(row))).sort((a, b) => a.type_id - b.type_id || a.level - b.level);
  assert.deepEqual(sort(actual), sort(expected));
}
test('real legacy share becomes much smaller without losing skills or queue', async () => {
  const ctx = context();
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/share-skills.txt'), 'utf8').trim();
  const records = await ctx.decodeShareSkillsPayload(original);
  const before = JSON.stringify(records);
  const encoded = await ctx.encodeShareSkillsPayload(records);
  equivalent(await ctx.decodeShareSkillsPayload(encoded), records);
  assert.equal(JSON.stringify(records), before);
  assert.ok(encoded.length < original.length * 0.6);
  console.log(`Actual example: ${records.length} records; skill payload ${original.length} -> ${encoded.length} characters`);
});
for (const compression of [true, false]) {
  test(`round trips with compression ${compression}`, async () => {
    const ctx = context(compression);
    for (const records of [[], [{type_id: 3300, level: 0}], [
      {type_id: 99999, level: 5}, {type_id: 3300, level: 0},
      {type_id: 3301, level: 3, training_start: 1800000000, training_end: 3600},
      {type_id: 3301, level: 4, training_end: 7200},
      {type_id: 3300, level: 1, training_end: 0},
      {type_id: 3302, level: 5}
    ]]) {
      const encoded = await ctx.encodeShareSkillsPayload(records);
      ctx.inputRecords = records;
      const raw = vm.runInContext('SkillUrlCodecSafe.encode(inputRecords)', ctx);
      const legacy = [raw];
      if (compression) {
        legacy.push('c2d_' + ctx.bytesToBase64Url(await ctx.deflateBytes(ctx.base64UrlToBytes(raw))));
        legacy.push('c2g_' + ctx.bytesToBase64Url(await ctx.gzipBytes(ctx.base64UrlToBytes(raw))));
      }
      assert.ok(encoded.length <= Math.min(...legacy.map(value => value.length)));
      for (const payload of legacy) equivalent(await ctx.decodeShareSkillsPayload(payload), records);
      equivalent(await ctx.decodeShareSkillsPayload(encoded), records);
    }
  });
}
