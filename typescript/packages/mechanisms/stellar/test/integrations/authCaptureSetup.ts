import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
export const RPC_TESTNET = "https://soroban-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

/**
 * Funds a fresh account with Friendbot, retrying transient failures.
 *
 * @param address - Account to fund
 */
export async function friendbot(address: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
    if (res.ok) return;
    if (attempt === 2) throw new Error(`Friendbot failed for ${address}: ${res.status}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

/**
 * Submits a Soroban transaction prepared through RPC and waits for it.
 *
 * @param server - RPC server
 * @param source - Source keypair
 * @param operation - Host-function operation
 */
async function submitSoroban(
  server: rpc.Server,
  source: Keypair,
  operation: ReturnType<typeof Operation.createStellarAssetContract>,
): Promise<void> {
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .setTimeout(60)
    .addOperation(operation)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(source);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new Error(`SAC deploy failed: ${sent.status}`);
  const result = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (result.status !== "SUCCESS") throw new Error(`SAC deploy failed: ${result.status}`);
}

/**
 * Issues a fresh classic asset, deploys its SAC, adds trustlines for `holders`, and pays
 * `funded` to the first holder.
 *
 * @param issuer - Issuer keypair (funded)
 * @param holders - Accounts that need a trustline (funded)
 * @param funded - Amount in base units paid to `holders[0]`
 * @returns The asset and its SAC contract id
 */
export async function issueTestToken(
  issuer: Keypair,
  holders: Keypair[],
  funded: bigint,
): Promise<{ asset: Asset; token: string }> {
  const code = `AC${Math.floor(Math.random() * 1e8)}`.slice(0, 12);
  const asset = new Asset(code, issuer.publicKey());
  const horizon = new Horizon.Server(HORIZON_TESTNET);
  const account = await horizon.loadAccount(issuer.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(60);
  for (const holder of holders) {
    builder.addOperation(Operation.changeTrust({ asset, source: holder.publicKey() }));
  }
  builder.addOperation(
    Operation.payment({
      destination: holders[0].publicKey(),
      asset,
      amount: (Number(funded) / 1e7).toFixed(7),
    }),
  );
  const tx = builder.build();
  tx.sign(issuer, ...holders);
  await horizon.submitTransaction(tx);

  const server = new rpc.Server(RPC_TESTNET);
  await submitSoroban(server, issuer, Operation.createStellarAssetContract({ asset }));
  return { asset, token: asset.contractId(Networks.TESTNET) };
}
