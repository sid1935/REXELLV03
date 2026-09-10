/**
 * Print the four secrets a deployment needs, each independently generated.
 *
 *   node scripts/gen-secrets.js >> .env
 *
 * Separate values rather than one reused four ways: VAULT_MASTER_KEY has a
 * completely different lifetime from the rest. The others can be rotated on a
 * quiet afternoon; that one cannot be rotated at all without re-encrypting
 * every stored template, and there is no routine for that yet. Sharing it with
 * a key you might casually roll is how it gets rolled by accident.
 */
import { randomBytes } from 'node:crypto';

const key = () => randomBytes(32).toString('base64');

console.log(`VAULT_MASTER_KEY=${key()}`);
console.log(`VAULT_RECEIPT_KEY=${key()}`);
console.log(`VAULT_TOKEN=${randomBytes(32).toString('base64url')}`);
console.log(`ONSALE_SECRET=${key()}`);
console.log(`SIGNUP_INVITE_TOKEN=${randomBytes(24).toString('base64url')}`);
