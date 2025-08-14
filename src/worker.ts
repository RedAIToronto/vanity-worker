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
  if (ready >= MIN_BUFFER) {
    console.log(`[vanity] pattern=${pattern} buffer full (${ready}/${MIN_BUFFER})`);
    return;
  }

  const toGenerate = Math.max(0, MIN_BUFFER - ready);
  console.log(`[vanity] pattern=${pattern} current=${ready} need=${toGenerate} searching...`);

  let found = 0;
  let attempts = 0;
  const started = Date.now();
  
  while (found < toGenerate) {
    attempts++;
    const kp = Keypair.generate();
    const pub = kp.publicKey.toBase58();
    
    // Log progress every 10000 attempts
    if (attempts % 10000 === 0) {
      console.log(`[vanity] pattern=${pattern} attempts=${attempts} found=${found}/${toGenerate}`);
    }
    
    if (matches(pub, pattern)) {
      console.log(`[vanity] FOUND match! ${pub} ends with ${pattern}`);
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
        const rate = (found * 1000) / Math.max(1, Date.now() - started);
        console.log(`[vanity] stored ${found}/${toGenerate} for ${pattern} rate=${rate.toFixed(2)}/s`);
      } catch (e: any) {
        if (e?.code !== 'P2002') {
          console.error(`[vanity] Error storing: ${e.message}`);
          throw e;
        }
        console.log(`[vanity] Duplicate key, skipping`);
      }
    }
  }
  
  const elapsed = (Date.now() - started) / 1000;
  console.log(`[vanity] Completed ${pattern}: generated ${found} in ${elapsed.toFixed(1)}s (${attempts} attempts)`);
}

async function main() {
  // Start HTTP server first for health checks
  const port = Number(process.env.PORT) || 10000;
  const host = '0.0.0.0'; // Bind to all interfaces for Render
  http
    .createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('vanity-worker healthy');
    })
    .listen(port, host, () => console.log(`[vanity] http listening on ${host}:${port}`));

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