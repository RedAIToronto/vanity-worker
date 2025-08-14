import 'dotenv/config';
import { prisma } from './db.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { encryptSecret } from './crypto.js';

const TARGETS = (process.env.VANITY_PATTERNS || 'SNOW,SB')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MIN_BUFFER = Number(process.env.VANITY_MIN_BUFFER || '5');

function matches(pub: string, pattern: string): boolean {
  // Case-sensitive match at suffix by default for stronger branding; extend if needed
  return pub.endsWith(pattern);
}

async function ensureBuffer(pattern: string) {
  const ready = await prisma.vanityMintPool.count({ where: { pattern, caseSensitive: true, status: 'ready' } });
  if (ready >= MIN_BUFFER) return;

  const toGenerate = Math.max(0, MIN_BUFFER - ready);
  console.log(`[vanity] pattern=${pattern} need=${toGenerate}`);

  let found = 0;
  const started = Date.now();
  while (found < toGenerate) {
    const kp = Keypair.generate();
    const pub = kp.publicKey.toBase58();
    if (matches(pub, pattern)) {
      const enc = encryptSecret(kp.secretKey);
      try {
        await prisma.vanityMintPool.create({
          data: {
            publicKey: pub,
            encSecret: enc,
            pattern,
            caseSensitive: true,
            status: 'ready'
          }
        });
        found += 1;
        if (found % 1 === 0) {
          const rate = (found * 1000) / Math.max(1, Date.now() - started);
          console.log(`[vanity] stored ${found}/${toGenerate} for ${pattern} rate=${rate.toFixed(2)}/s`);
        }
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e; // unique violation -> skip
      }
    }
  }
}

async function main() {
  console.log(`[vanity] worker starting. patterns=${TARGETS.join(',')} buffer=${MIN_BUFFER}`);
  while (true) {
    for (const p of TARGETS) {
      try { await ensureBuffer(p); } catch (e) { console.error('[vanity] ensureBuffer error', e); }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(err => { console.error(err); process.exit(1); }); 