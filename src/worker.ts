import 'dotenv/config';
import { prisma } from './db.js';
import { Keypair } from '@solana/web3.js';
import { encryptSecret } from './crypto.js';
import { randomUUID } from 'node:crypto';
import http from 'node:http';

const TARGETS = (process.env.VANITY_PATTERNS || 'SNOW,SB')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MIN_BUFFER = Number(process.env.VANITY_MIN_BUFFER || '5');

function matches(pub: string, pattern: string): boolean {
  // Case-sensitive match at suffix by default for stronger branding; extend if needed
  return pub.endsWith(pattern);
}

async function ensureSchema() {
  try {
    // Create table if it doesn't exist
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "VanityMintPool" (
        "id" text PRIMARY KEY,
        "publicKey" text UNIQUE NOT NULL,
        "encSecret" bytea NOT NULL,
        "pattern" text NOT NULL,
        "caseSensitive" boolean NOT NULL DEFAULT true,
        "status" text NOT NULL DEFAULT 'ready',
        "reservedUntil" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "usedAt" timestamptz
      )
    `);
  } catch (e: any) {
    console.log('[vanity] Table exists or creation error:', e.message);
  }

  try {
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "VanityMintPool_status_idx" ON "VanityMintPool" ("status")`);
  } catch (e: any) {
    console.log('[vanity] Index exists or creation error:', e.message);
  }

  try {
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "VanityMintPool_pattern_caseSensitive_idx" ON "VanityMintPool" ("pattern","caseSensitive")`);
  } catch (e: any) {
    console.log('[vanity] Index exists or creation error:', e.message);
  }
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
            id: randomUUID(),
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
  // Start HTTP server first for health checks
  const port = Number(process.env.PORT) || 10000;
  http
    .createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('vanity-worker healthy');
    })
    .listen(port, () => console.log(`[vanity] http listening on ${port}`));

  console.log(`[vanity] worker starting. patterns=${TARGETS.join(',')} buffer=${MIN_BUFFER}`);
  
  // Wait a bit for port to be detected
  await new Promise(r => setTimeout(r, 1000));
  
  await ensureSchema();
  
  while (true) {
    for (const p of TARGETS) {
      try { 
        await ensureBuffer(p); 
      } catch (e) { 
        console.error('[vanity] ensureBuffer error', e); 
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(err => { console.error(err); process.exit(1); }); 