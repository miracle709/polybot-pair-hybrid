/**
 * Single construction path for Polymarket CLOB V2.
 * Live trading and credential derivation both use this factory.
 */
import { ClobClient, Chain } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const DEFAULT_HOST = 'https://clob.polymarket.com';

function requirePrivateKey() {
  const pk = process.env.PM_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error('Set a valid PM_PRIVATE_KEY (0x + 64 hex chars)');
  }
  return /** @type {`0x${string}`} */ (pk);
}

export function createClobSigner() {
  const account = privateKeyToAccount(requirePrivateKey());
  const signer = createWalletClient({
    account,
    transport: http(),
  });
  return { account, signer };
}

/**
 * @param {Object} [opts]
 * @param {{ key: string, secret: string, passphrase: string } | null} [opts.creds]
 * @param {string} [opts.host]
 */
export function createClobClient({ creds = null, host } = {}) {
  const { account, signer } = createClobSigner();
  const client = new ClobClient({
    host: host ?? process.env.PM_CLOB_HOST ?? DEFAULT_HOST,
    chain: Chain.POLYGON,
    signer,
    ...(creds ? { creds } : {}),
  });
  return { client, account, signer };
}

/** L1-only client → derive or create L2 API credentials. */
export async function createOrDeriveApiKey(opts = {}) {
  const { client, account } = createClobClient(opts);
  const creds = await client.createOrDeriveApiKey();
  return { creds, account };
}
