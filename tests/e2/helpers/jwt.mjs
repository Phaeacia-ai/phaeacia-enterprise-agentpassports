/* Test-only JWT minting. Mirrors tests/db/lib.sh server_jwt() for the local HS256 secret and adds
   GoTrue-shaped user tokens and ES256 tokens for the verifier's unit tests. Never used by lib/. */
import { createHmac, createPrivateKey, sign } from 'node:crypto';

const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export function hs256(claims, secret, header = { alg: 'HS256', typ: 'JWT' }) {
  const h = b64u(header);
  const p = b64u(claims);
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

export function es256(claims, privateKeyPem, kid) {
  const h = b64u({ alg: 'ES256', typ: 'JWT', kid });
  const p = b64u(claims);
  const key = createPrivateKey(privateKeyPem);
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${sig}`;
}

/* A GoTrue-shaped access token for a synthetic user. `aal` omitted means the claim is absent. */
export function userClaims({ sub, email, aal, issuer, now = Math.floor(Date.now() / 1000), ttl = 3600, extra = {} }) {
  const c = {
    iss: issuer,
    sub,
    aud: 'authenticated',
    exp: now + ttl,
    iat: now,
    email,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { email_verified: true },
    role: 'authenticated',
    amr: [{ method: 'password', timestamp: now }],
    session_id: '11111111-2222-4333-8444-555555555555',
    is_anonymous: false,
    ...extra,
  };
  if (aal) c.aal = aal;
  return c;
}
