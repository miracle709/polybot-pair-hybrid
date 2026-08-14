/**
 * Derive Polymarket CLOB L2 API credentials from PM_PRIVATE_KEY in .env.
 * Usage: node derive-creds.js
 */
import { loadEnv } from './scripts/loadEnv.js';
import { createOrDeriveApiKey } from './src/live/clobClient.js';

loadEnv();

try {
  const { creds, account } = await createOrDeriveApiKey();
  console.log('Paste these into .env:');
  console.log({
    PM_API_KEY: creds.key ?? creds.apiKey,
    PM_API_SECRET: creds.secret,
    PM_API_PASSPHRASE: creds.passphrase,
  });
  console.log('wallet:', account.address);
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
