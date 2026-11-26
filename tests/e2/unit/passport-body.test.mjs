/* The raw passport body mode (E3 design 2.6 item 3): body: 'passport' hands the route the bytes the client
   sent, as a Buffer, never decoded. At the pipeline: the three media types reach the handler and any other is
   415 before anything else; 262,144 bytes reach it and 262,145 are 413; an absent or empty body is 422;
   invalid UTF-8 arrives byte-identical and the pinned transport() still refuses it with E_NOT_UTF8. Through
   toNetlify: an oversized content-length pulls no chunk, an unsized stream stops at 262,145 kept, one 8 MiB
   chunk is cut before it is kept or copied, a failing stream is 422, and a JSON route still keeps at most
   MAX_BODY_BYTES + 1. The bound is read back from the pinned upstream so the two cannot drift. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.ENTERPRISE_ACCESS_STATE = 'open';

const { COOKIES } = await import('../../../lib/session.mjs');
const { MAX_BODY_BYTES, MAX_PASSPORT_BYTES, makeRequest } = await import('../../../lib/http/request.mjs');
const { route } = await import('../../../lib/http/pipeline.mjs');
const { json } = await import('../../../lib/http/response.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { toNetlify } = await import('../../../lib/http/netlify.mjs');
const validator = await import('../../../vendor/passport/web/lib/_validate.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
const cookie = () =>
  `${COOKIES.access}=${hs256(userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1` }), SECRET)}`;
const parse = (r) => (r.body === null ? null : JSON.parse(r.body));

/* A passport route as E3 will declare upload: everything the pipeline does, then the Buffer recorded. */
const received = [];
const upload = route(
  {
    method: 'POST',
    path: '/api/companies/:companyId/candidates',
    uuidParams: ['companyId'],
    body: 'passport',
    handle: async ({ body }) => {
      received.push(body);
      return json(200, { ok: true, bytes: body.byteLength });
    },
  },
  { log: () => {} },
);
upload.routeName = 'probeUpload';
const deployed = toNetlify(upload);

const passport = ({ headers, ...over } = {}) =>
  makeRequest({
    method: 'POST',
    path: `/api/companies/${COMPANY}/candidates`,
    params: { companyId: COMPANY },
    headers: { cookie: cookie(), 'content-type': 'text/markdown', ...headers },
    ...over,
  });
async function atPipeline(over) {
  received.length = 0;
  const res = await upload(passport(over));
  return { status: res.status, code: parse(res)?.code, got: received.slice() };
}

/* A passport of `length` bytes whose content does not matter here. */
const bytesOf = (length) => Buffer.alloc(length, 0x61);

/* A valid header, then bytes no UTF-8 decoder accepts: a lone 0xff and 0xfe, 0xc3 followed by a non
   continuation, a stray continuation 0x80, an encoded surrogate (ed a0 80) and a code point above U+10FFFF
   (f4 90 80 80). Then enough text to be over the pinned MIN_BYTES, so size is not what refuses it. */
const INVALID_UTF8 = Buffer.concat([
  Buffer.from('# Agent Passport\n\n', 'utf8'),
  Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x80, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0x0a]),
  Buffer.alloc(600, 0x61),
]);

/* Stream helpers, as in netlify.test.mjs. highWaterMark 0: a pull is an actual read. */
function countedStream(chunks, size = 1024) {
  const stats = { pulls: 0, cancelled: false };
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (stats.pulls >= chunks) {
          controller.close();
          return;
        }
        stats.pulls++;
        controller.enqueue(new Uint8Array(size).fill(0x61));
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}
function chunkedStream(bytes, size) {
  let offset = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size)));
        offset += size;
      },
    },
    { highWaterMark: 0 },
  );
}
function failingStream() {
  let pulls = 0;
  return new ReadableStream(
    {
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(new Uint8Array([0x23]));
        else controller.error(new Error('synthetic-body-read-failure'));
      },
    },
    { highWaterMark: 0 },
  );
}
const webRequest = (body, headers = {}, path = `/api/companies/${COMPANY}/candidates`) =>
  new Request(`https://enterprise.example.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/markdown', cookie: cookie(), ...headers },
    body,
    duplex: 'half',
  });
async function throughAdapter(fn, req) {
  received.length = 0;
  let res;
  try {
    res = await fn(req, { params: { companyId: COMPANY } });
  } catch (e) {
    assert.fail(`the adapter rejected: ${e?.message}`);
  }
  const body = await res.json();
  return { status: res.status, code: body.code, res, got: received.slice() };
}
/* Buffer.concat wrapped without changing its result; the byte lengths it is given and returns are recorded. */
async function recordingConcat(fn) {
  const concat = Buffer.concat;
  const copies = [];
  Buffer.concat = function recordedConcat(list, totalLength) {
    const result = concat.call(this, list, totalLength);
    copies.push({ given: list.reduce((n, b) => n + b.byteLength, 0), returned: result.byteLength });
    return result;
  };
  try {
    return { result: await fn(), copies };
  } finally {
    Buffer.concat = concat;
  }
}

test('MAX_PASSPORT_BYTES equals the bound the pinned upstream fixes in preflight.py, scrub.py and the validator', () => {
  assert.equal(MAX_PASSPORT_BYTES, 262144);
  const read = (file, name) =>
    [
      ...readFileSync(new URL(`../../../vendor/passport/tools/${file}`, import.meta.url), 'utf8').matchAll(
        new RegExp(`^\\s*${name} = (\\d+)\\s*$`, 'gm'),
      ),
    ].map((m) => Number(m[1]));
  assert.deepEqual(read('preflight.py', 'MAX_BYTES'), [MAX_PASSPORT_BYTES], 'vendor/passport/tools/preflight.py');
  assert.deepEqual(read('scrub.py', 'MAX_INPUT_BYTES'), [MAX_PASSPORT_BYTES], 'vendor/passport/tools/scrub.py');
  assert.equal(validator.MAX_BYTES, MAX_PASSPORT_BYTES, 'vendor/passport/web/lib/_validate.mjs MAX_BYTES');
});

test('makeRequest keeps a Buffer as the same Buffer and views a Uint8Array as one, never through String()', async () => {
  const buf = Buffer.from([0x23, 0xff, 0x0a]);
  assert.equal(await makeRequest({ body: buf }).readBody(), buf);
  const view = new Uint8Array([0x00, 0x23, 0xff, 0x0a, 0x00]).subarray(1, 4);
  const got = await makeRequest({ body: view }).readBody();
  assert.ok(Buffer.isBuffer(got));
  assert.deepEqual(got, buf);
  assert.equal(await makeRequest({ body: '{"a":1}' }).readBody(), '{"a":1}');
  assert.equal(await makeRequest({ body: null }).readBody(), null);
  assert.equal(await makeRequest({}).readBody(), null);
});

/* HTTP-D1 (evidence/http-d1.md): the adapter's reader is memoised, so a handler that asks the request again gets the
   Buffer the pipeline already handed it rather than a second read of a stream the first read locked. */
test('HTTP-D1: a handler calling request.readBody() again gets the same Buffer, and the stream is read once', async () => {
  const pairs = [];
  const again = route(
    {
      method: 'POST',
      path: '/api/companies/:companyId/candidates',
      uuidParams: ['companyId'],
      body: 'passport',
      handle: async ({ request, body }) => {
        pairs.push([body, await request.readBody()]);
        return json(200, { ok: true });
      },
    },
    { log: () => {} },
  );
  again.routeName = 'probeReadAgain';
  const { stream, stats } = countedStream(8, 1024);
  const r = await throughAdapter(toNetlify(again), webRequest(stream));
  assert.equal(r.status, 200);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0][0].byteLength, 8 * 1024);
  assert.equal(pairs[0][1], pairs[0][0], 'the second call returned another value than the first');
  assert.equal(stats.pulls, 8);
});

test('HTTP-D1: fromWebRequest pulls nothing, and its reader pulls nothing for an over-bound declaration or body: none', async () => {
  const { fromWebRequest } = await import('../../../lib/http/netlify.mjs');
  const built = countedStream(64, 1024);
  const req = fromWebRequest(webRequest(built.stream), { params: { companyId: COMPANY } }, 'passport');
  assert.equal(built.stats.pulls, 0, 'chunks pulled while building the request');
  const kept = await req.readBody();
  assert.ok(Buffer.isBuffer(kept));
  assert.equal(kept.byteLength, 64 * 1024);
  assert.equal(built.stats.pulls, 64);

  for (const [label, mode, headers] of [
    ['a passport declared over 262,144', 'passport', { 'content-length': String(MAX_PASSPORT_BYTES + 1) }],
    ['a JSON body declared over 16,384', 'json', { 'content-length': String(MAX_BODY_BYTES + 1) }],
    ['a submission declared over 262,144', 'submission', { 'content-length': String(MAX_PASSPORT_BYTES + 1) }],
    ['a body: none route', 'none', {}],
  ]) {
    const { stream, stats } = countedStream(64, 1024);
    const r = fromWebRequest(webRequest(stream, headers), {}, mode);
    assert.equal(await r.readBody(), null, label);
    assert.equal(stats.pulls, 0, `${label}: chunks pulled`);
  }
  /* E3b critique F1: a submission is JSON on the passport budget. 20 KiB, over the JSON bound and under the passport
     one, is kept whole and handed on as text; the same stream on a JSON route keeps MAX_BODY_BYTES + 1. */
  const between = countedStream(20, 1024);
  const text = await fromWebRequest(webRequest(between.stream), {}, 'submission').readBody();
  assert.equal(typeof text, 'string');
  assert.equal(text.length, 20 * 1024);
  assert.equal(between.stats.pulls, 20);
  const jsonKept = await fromWebRequest(webRequest(countedStream(20, 1024).stream), {}, 'json').readBody();
  assert.equal(jsonKept.length, MAX_BODY_BYTES + 1);
});

test('the three media types reach the handler; any other, or none, is 415 before anything else looks at the bytes', async () => {
  for (const type of [
    'text/markdown',
    'text/plain',
    'application/octet-stream',
    'text/markdown; charset=utf-8',
    'TEXT/PLAIN',
    'application/octet-stream ; x=y',
  ]) {
    const sent = bytesOf(1024);
    const r = await atPipeline({ headers: { 'content-type': type }, body: sent });
    assert.equal(r.status, 200, type);
    assert.equal(r.got.length, 1, type);
    assert.equal(r.got[0], sent, `${type}: the handler receives the request's own Buffer`);
  }
  for (const type of [
    'application/json',
    'text/html',
    'text/markdownx',
    'multipart/form-data; boundary=x',
    'application/x-www-form-urlencoded',
    '',
    undefined,
  ]) {
    for (const [label, over] of [
      ['a valid body', { body: bytesOf(1024) }],
      ['an empty body', { body: Buffer.alloc(0) }],
      ['no body', { body: null }],
      ['an oversized body', { body: bytesOf(MAX_PASSPORT_BYTES + 1) }],
      ['an oversized declaration', { body: null, headers: { 'content-length': String(10 * 1024 * 1024) } }],
    ]) {
      const r = await atPipeline({ ...over, headers: { ...over.headers, 'content-type': type } });
      assert.deepEqual([r.status, r.code], [415, 'E_UNSUPPORTED_MEDIA_TYPE'], `${JSON.stringify(type)}, ${label}`);
      assert.equal(r.got.length, 0);
    }
  }
});

test('exactly 262,144 bytes reach the handler; 262,145 kept, or declared, are 413', async () => {
  const atBound = bytesOf(MAX_PASSPORT_BYTES);
  const ok = await atPipeline({ body: atBound, headers: { 'content-length': String(MAX_PASSPORT_BYTES) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.got[0], atBound);
  assert.equal(ok.got[0].byteLength, 262144);
  for (const [label, over] of [
    ['262,145 kept', { body: bytesOf(MAX_PASSPORT_BYTES + 1) }],
    ['262,145 declared, nothing read', { body: null, headers: { 'content-length': String(MAX_PASSPORT_BYTES + 1) } }],
    ['262,145 declared, 10 bytes kept', { body: bytesOf(10), headers: { 'content-length': '262145' } }],
  ]) {
    const r = await atPipeline(over);
    assert.deepEqual([r.status, r.code], [413, 'E_BODY_TOO_LARGE'], label);
    assert.equal(r.got.length, 0, label);
  }
});

test('an absent or empty passport body, or one already decoded to text, is 422 E_BODY_INVALID', async () => {
  for (const [label, body] of [
    ['absent', null],
    ['empty', Buffer.alloc(0)],
    ['a string, which is not the bytes the client sent', '# Agent Passport'],
  ]) {
    const r = await atPipeline({ body });
    assert.deepEqual([r.status, r.code], [422, 'E_BODY_INVALID'], label);
    assert.equal(r.got.length, 0, label);
  }
});

test('a passport route keeps the pipeline order: session and route id refusals precede the media type', async () => {
  const noCookie = await atPipeline({ headers: { cookie: undefined, 'content-type': 'text/html' }, body: null });
  assert.deepEqual([noCookie.status, noCookie.code], [401, 'E_UNAUTHENTICATED']);
  const badId = await atPipeline({ params: { companyId: 'not-a-uuid' }, headers: { 'content-type': 'text/html' } });
  assert.deepEqual([badId.status, badId.code], [404, 'E_NOT_FOUND']);
});

/* HTTP-D1 at the pipeline, with a counting reader and no adapter: readPassportBody itself checks the media type and
   the declared length before it calls readBody. The adapter's reader also declines an over-bound declaration, so
   through toNetlify a reader that read first would still pull nothing; only this test sees the reader's own order. */
test('HTTP-D1: on a passport route readBody is not called for 401, 404, 415 or a declared 413, and once otherwise', async () => {
  let calls = 0;
  const counting = async () => {
    calls++;
    return bytesOf(1024);
  };
  for (const [label, over, status] of [
    ['no session cookie', { headers: { cookie: undefined } }, 401],
    ['malformed route id', { params: { companyId: 'not-a-uuid' } }, 404],
    ['text/html', { headers: { 'content-type': 'text/html' } }, 415],
    ['declared over 262,144', { headers: { 'content-length': String(MAX_PASSPORT_BYTES + 1) } }, 413],
  ]) {
    calls = 0;
    const r = await atPipeline({ ...over, readBody: counting });
    assert.equal(r.status, status, label);
    assert.equal(calls, 0, `${label}: the reader was called before the refusal`);
    assert.equal(r.got.length, 0, label);
  }
  calls = 0;
  const ok = await atPipeline({ readBody: counting });
  assert.equal(ok.status, 200);
  assert.equal(ok.got[0].byteLength, 1024);
  assert.equal(calls, 1);
});

test('invalid UTF-8 reaches the handler byte-identical, and the pinned transport() still refuses it with E_NOT_UTF8', async () => {
  /* Preconditions: the fixture is invalid UTF-8, a decode would change it, and a decoded copy no longer
     draws E_NOT_UTF8. That last one is the silent loss this mode exists to prevent. */
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(INVALID_UTF8));
  const decoded = Buffer.from(INVALID_UTF8.toString('utf8'), 'utf8');
  assert.notDeepEqual(decoded, INVALID_UTF8);
  assert.ok(decoded.includes(Buffer.from([0xef, 0xbf, 0xbd])), 'decoding introduced U+FFFD');
  assert.notEqual(validator.transport(decoded, 'text/markdown').error?.code, 'E_NOT_UTF8');

  const pipeline = await atPipeline({ body: Buffer.from(INVALID_UTF8) });
  assert.equal(pipeline.status, 200);
  assert.ok(Buffer.isBuffer(pipeline.got[0]));
  assert.deepEqual(pipeline.got[0], INVALID_UTF8);
  assert.equal(validator.transport(pipeline.got[0], 'text/markdown').error?.code, 'E_NOT_UTF8');

  /* Through the adapter, in chunks of 5 and of 1 byte, so the invalid and the valid multi-byte sequences are
     split across chunk boundaries. */
  const mixed = Buffer.concat([
    INVALID_UTF8,
    Buffer.from('caf', 'utf8'),
    Buffer.from([0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]),
  ]);
  for (const size of [5, 1]) {
    const r = await throughAdapter(deployed, webRequest(chunkedStream(mixed, size)));
    assert.equal(r.status, 200, `chunks of ${size}`);
    assert.ok(Buffer.isBuffer(r.got[0]), `chunks of ${size}`);
    assert.deepEqual(r.got[0], mixed, `chunks of ${size}`);
    assert.equal(validator.transport(r.got[0], 'text/markdown').error?.code, 'E_NOT_UTF8');
  }
});

test('adapter: a declared content-length over 262,144 is 413 without pulling a single chunk', async () => {
  const { stream, stats } = countedStream(1024, 1024);
  const r = await throughAdapter(deployed, webRequest(stream, { 'content-length': String(MAX_PASSPORT_BYTES + 1) }));
  assert.deepEqual([r.status, r.code], [413, 'E_BODY_TOO_LARGE']);
  assert.equal(stats.pulls, 0, 'chunks pulled for an oversized declaration');
  assert.equal(r.got.length, 0);

  /* Control: declared at the bound, and the stream holds exactly that. */
  const atBound = countedStream(256, 1024);
  const ok = await throughAdapter(
    deployed,
    webRequest(atBound.stream, { 'content-length': String(MAX_PASSPORT_BYTES) }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.got[0].byteLength, MAX_PASSPORT_BYTES);
});

test('adapter: a lying content-length under the bound cannot admit a body over it (critique finding 2, HTTP-D3)', async () => {
  /* Declared 10 bytes, 300 KiB actually streamed. The declaration may only ever refuse; it never admits. The
     critic's one-condition mutant, refusing an over-bound kept body only when no length was declared, passed
     every earlier test in this file; this is the case that kills it. */
  const { stream, stats } = countedStream(300, 1024);
  const r = await throughAdapter(deployed, webRequest(stream, { 'content-length': '10' }));
  assert.deepEqual([r.status, r.code], [413, 'E_BODY_TOO_LARGE']);
  assert.equal(r.got.length, 0, 'a body over the bound reached the handler behind a small declaration');
  assert.ok(stats.pulls * 1024 <= MAX_PASSPORT_BYTES + 1 + 1024, `pulled ${stats.pulls} KiB chunks`);

  /* Control: the same lie over a body that really is under the bound reaches the handler at its true length. */
  const small = countedStream(4, 1024);
  const ok = await throughAdapter(deployed, webRequest(small.stream, { 'content-length': '10' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.got[0].byteLength, 4096);
});

test('adapter: an unsized stream over the bound is 413 and the read stops at 262,145 kept', async () => {
  const chunks = 4096; /* 4 MiB on offer at 1 KiB per chunk */
  const { stream, stats } = countedStream(chunks, 1024);
  const req = webRequest(stream);
  assert.equal(req.headers.get('content-length'), null, 'the request is unsized');
  const { result: r, copies } = await recordingConcat(() => throughAdapter(deployed, req));
  assert.deepEqual([r.status, r.code], [413, 'E_BODY_TOO_LARGE']);
  assert.ok(stats.pulls * 1024 <= MAX_PASSPORT_BYTES + 1 + 1024, `pulled ${stats.pulls} KiB chunks`);
  assert.ok(stats.pulls < chunks, 'the stream was not consumed to the end');
  assert.equal(stats.cancelled, true);
  assert.equal(Math.max(...copies.map((c) => c.returned)), MAX_PASSPORT_BYTES + 1, JSON.stringify(copies));
});

test('adapter: one 8 MiB chunk on an unsized stream is cut to 262,145 before it is kept or copied', async (t) => {
  const bound = MAX_PASSPORT_BYTES + 1;
  const { stream, stats } = countedStream(1, 8 * 1024 * 1024);
  const { result: r, copies } = await recordingConcat(() => throughAdapter(deployed, webRequest(stream)));
  t.diagnostic(`Buffer.concat calls: ${JSON.stringify(copies)}; pulls ${stats.pulls}; cancelled ${stats.cancelled}`);
  assert.deepEqual([r.status, r.code], [413, 'E_BODY_TOO_LARGE']);
  assert.equal(stats.pulls, 1);
  assert.equal(stats.cancelled, true);
  assert.ok(copies.length >= 1, 'no Buffer.concat call observed: the instrument no longer sees the copy');
  assert.deepEqual(
    copies.filter((c) => c.given > bound || c.returned > bound),
    [],
    `bytes given to or returned by Buffer.concat above ${bound}: ${JSON.stringify(copies)}`,
  );
  assert.equal(Math.max(...copies.map((c) => c.returned)), bound, 'the kept body is exactly the budget');
});

test('adapter: a failing stream on a passport route is a controlled 422, not a rejection', async () => {
  const r = await throughAdapter(deployed, webRequest(failingStream()));
  assert.deepEqual([r.status, r.code], [422, 'E_BODY_INVALID']);
  assert.equal(r.res.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.got.length, 0);
});

/* HTTP-D1 (evidence/http-d1.md): no chunk is pulled before the pipeline reaches step 6, so a failing or oversized
   stream cannot pre-empt a refusal that comes before it. These are the three cases of the order probe in
   evidence/http-bundle.md appendix D; at 725447e they answered 422, 422, and 401 only after 263,168 bytes. */
test('HTTP-D1: no session cookie and a failing stream on a passport route is 401, not 422', async () => {
  const r = await throughAdapter(deployed, webRequest(failingStream(), { cookie: '' }));
  assert.deepEqual([r.status, r.code], [401, 'E_UNAUTHENTICATED']);
  assert.equal(r.got.length, 0);
});

test('HTTP-D1: text/html and a failing stream on a passport route is 415, not 422, and pulls nothing', async () => {
  const r = await throughAdapter(deployed, webRequest(failingStream(), { 'content-type': 'text/html' }));
  assert.deepEqual([r.status, r.code], [415, 'E_UNSUPPORTED_MEDIA_TYPE']);
  assert.equal(r.got.length, 0);
  const { stream, stats } = countedStream(300, 1024);
  const counted = await throughAdapter(deployed, webRequest(stream, { 'content-type': 'text/html' }));
  assert.deepEqual([counted.status, counted.code], [415, 'E_UNSUPPORTED_MEDIA_TYPE']);
  assert.equal(stats.pulls * 1024, 0, 'bytes pulled before the 415');
});

test('HTTP-D1: no session cookie and an unsized 300 KiB stream on a passport route pull nothing before the 401', async () => {
  const { stream, stats } = countedStream(300, 1024);
  const req = webRequest(stream, { cookie: '' });
  assert.equal(req.headers.get('content-length'), null, 'the request is unsized');
  const r = await throughAdapter(deployed, req);
  assert.deepEqual([r.status, r.code], [401, 'E_UNAUTHENTICATED']);
  assert.equal(stats.pulls * 1024, 0, 'bytes pulled before the 401');
  assert.equal(r.got.length, 0);
});

test('adapter: a closed switch answers 503 on a passport route without pulling a chunk', async () => {
  process.env.ENTERPRISE_ACCESS_STATE = 'closed';
  try {
    const { stream, stats } = countedStream(64, 1024);
    const r = await throughAdapter(deployed, webRequest(stream));
    assert.deepEqual([r.status, r.code], [503, 'E_MAINTENANCE']);
    assert.equal(stats.pulls, 0);
  } finally {
    process.env.ENTERPRISE_ACCESS_STATE = 'open';
  }
});

test('adapter: a JSON route still keeps at most MAX_BODY_BYTES + 1, so the passport budget did not leak', async () => {
  const routes = makeRoutes({ log: () => {} });
  const json20k = toNetlify(routes.invitationsAccept);
  /* 20 KiB lies between the two bounds: a JSON route reading on the passport budget would keep all of it and
     still answer 413, so the kept bytes are what is asserted, not only the status. */
  for (const [label, stream] of [
    ['20 KiB unsized', countedStream(20, 1024).stream],
    ['one 8 MiB chunk', countedStream(1, 8 * 1024 * 1024).stream],
  ]) {
    const { result: r, copies } = await recordingConcat(() =>
      throughAdapter(json20k, webRequest(stream, { 'content-type': 'application/json' }, '/api/invitations/accept')),
    );
    assert.deepEqual([r.status, r.code], [413, 'E_BODY_TOO_LARGE'], label);
    assert.equal(Math.max(...copies.map((c) => c.returned)), MAX_BODY_BYTES + 1, `${label}: ${JSON.stringify(copies)}`);
  }
  const declared = countedStream(64, 1024);
  const r = await throughAdapter(
    json20k,
    webRequest(
      declared.stream,
      { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) },
      '/api/invitations/accept',
    ),
  );
  assert.deepEqual([r.status, r.code], [413, 'E_BODY_TOO_LARGE']);
  assert.equal(declared.stats.pulls, 0, 'a JSON declaration over 16 KiB is not read');
});
