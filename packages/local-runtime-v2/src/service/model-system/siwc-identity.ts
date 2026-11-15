import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

import type { VerifyChatGptIdentity } from './siwc-token.js';

const ISSUER = 'https://auth.openai.com';
const openAiKeys = createRemoteJWKSet(new URL('https://auth.openai.com/.well-known/jwks.json'));

// Injecting a local key set is useful for tests. Production must use OpenAI's
// fixed JWKS endpoint and not derive a verification URL from the token header.
export function createChatGptIdentityVerifier(keys: JWTVerifyGetKey = openAiKeys): VerifyChatGptIdentity {
  return async (idToken, clientId, nonce) => {
    const { payload } = await jwtVerify(idToken, keys, {
      algorithms: ['RS256'],
      issuer: ISSUER,
      audience: clientId,
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
      clockTolerance: 5,
    });
    if (payload.nonce !== nonce) throw new Error('ChatGPT identity nonce mismatch.');
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) throw new Error('ChatGPT identity missing subject.');
    if (payload.sid !== undefined && (typeof payload.sid !== 'string' || !payload.sid.trim())) {
      throw new Error('ChatGPT identity has an invalid session ID.');
    }
    return {
      subject: payload.sub,
      ...(typeof payload.email === 'string' && payload.email ? { email: payload.email } : {}),
    };
  };
}
