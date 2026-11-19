const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const TOTAL_REQUESTS = Number(process.env.LOAD_TOTAL_REQUESTS ?? 300);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 30);
const PARALLEL_WALLETS = Number(process.env.LOAD_PARALLEL_WALLETS ?? 15);

interface WalletTarget {
  walletId: string;
  playerId: string;
  label: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[idx].toFixed(2));
}

async function createWallet(initialAmount: string, label: string): Promise<WalletTarget> {
  const playerId = crypto.randomUUID();
  const res = await fetch(`${BASE_URL}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: initialAmount, currency: 'BRL' },
    }),
  });

  if (!res.ok) {
    throw new Error(`Falha ao criar wallet (${label}): HTTP ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { id: string };
  return { walletId: data.id, playerId, label };
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE_URL}/health/ready`);
  if (!health.ok) {
    throw new Error(`Cluster indisponível em ${BASE_URL}/health/ready (HTTP ${health.status})`);
  }

  // 1. Cria 1 hot wallet (disputa intensa de lock) + N carteiras paralelas
  const hotWallet = await createWallet('1000.00', 'hot-wallet');
  const parallelWallets: WalletTarget[] = [];
  for (let i = 0; i < PARALLEL_WALLETS; i++) {
    parallelWallets.push(await createWallet('1000.00', `parallel-${i + 1}`));
  }
  const allWallets = [hotWallet, ...parallelWallets];

  // 2. Monta carga mista: 40% na hot wallet (10.00 BRL) e 60% nas carteiras paralelas (5.00 BRL)
  const jobs = Array.from({ length: TOTAL_REQUESTS }, (_, idx) => {
    const isHot = idx % 5 < 2;
    const target = isHot ? hotWallet : parallelWallets[idx % parallelWallets.length];
    const amount = isHot ? '10.00' : '5.00';
    const externalTransactionId = `load-tx-${crypto.randomUUID()}`;

    return {
      idempotencyKey: `load-provider:${externalTransactionId}`,
      body: JSON.stringify({
        providerId: 'load-provider',
        externalTransactionId,
        playerId: target.playerId,
        walletId: target.walletId,
        roundId: `round-${idx % 50}`,
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      }),
    };
  });

  const latencies: number[] = [];
  const statusCounts: Record<number, number> = {};
  const upstreams = new Set<string>();
  let networkErrors = 0;
  let maxOutboxLag = 0;
  let cursor = 0;

  const suiteStart = performance.now();

  async function worker(): Promise<void> {
    while (true) {
      const current = cursor++;
      if (current >= jobs.length) break;

      const job = jobs[current];
      const reqStart = performance.now();
      try {
        const res = await fetch(`${BASE_URL}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': job.idempotencyKey,
          },
          body: job.body,
        });
        await res.arrayBuffer();
        const elapsed = performance.now() - reqStart;

        latencies.push(elapsed);
        statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
        const upstream = res.headers.get('x-upstream-instance');
        if (upstream) upstreams.add(upstream);
      } catch {
        networkErrors += 1;
      }
    }
  }

  // Coleta amostra de lag da Outbox durante o pico de carga
  const lagSampler = setInterval(async () => {
    try {
      const mRes = await fetch(`${BASE_URL}/metrics`);
      if (mRes.ok) {
        const m = (await mRes.json()) as { outboxLagSeconds?: number };
        if (typeof m.outboxLagSeconds === 'number' && m.outboxLagSeconds > maxOutboxLag) {
          maxOutboxLag = m.outboxLagSeconds;
        }
      }
    } catch {
      // ignora falha transitória de amostragem
    }
  }, 200);

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  clearInterval(lagSampler);

  const totalSeconds = (performance.now() - suiteStart) / 1000;
  latencies.sort((a, b) => a - b);

  // Aguarda breve drenagem da Outbox e lê métricas finais
  await Bun.sleep(1500);
  const metricsRes = await fetch(`${BASE_URL}/metrics`);
  const metrics = (await metricsRes.json()) as {
    lockConflictsTotal?: number;
    outboxLagSeconds?: number;
    reconciliationDiscrepanciesTotal?: number;
  };
  if (typeof metrics.outboxLagSeconds === 'number' && metrics.outboxLagSeconds > maxOutboxLag) {
    maxOutboxLag = metrics.outboxLagSeconds;
  }

  // 3. Reconciliação contábil de 100% das carteiras criadas
  let consistentCount = 0;
  for (const w of allWallets) {
    const recRes = await fetch(`${BASE_URL}/wallets/${w.walletId}/reconciliation`, {
      method: 'POST',
    });
    const rec = (await recRes.json()) as { consistent: boolean; difference: { amount: string } };
    if (rec.consistent && rec.difference.amount === '0.00') {
      consistentCount += 1;
    }
  }

  const server5xx = Object.entries(statusCounts)
    .filter(([code]) => Number(code) >= 500)
    .reduce((acc, [, count]) => acc + count, 0);
  const infraErrorRate = (((server5xx + networkErrors) / TOTAL_REQUESTS) * 100).toFixed(2);
  const throughput = (TOTAL_REQUESTS / totalSeconds).toFixed(2);

  console.log('\n=== RESULTADOS DO TESTE DE CARGA (SEÇÃO 8) ===');
  console.log(`Instâncias atendidas (Nginx): ${upstreams.size} (${[...upstreams].join(', ')})`);
  console.log(`Total de requisições: ${TOTAL_REQUESTS} | Concorrência: ${CONCURRENCY}`);
  console.log(`Status HTTP: ${JSON.stringify(statusCounts)}`);
  console.log(`Throughput: ${throughput} req/s`);
  console.log(
    `Latência: p50 = ${percentile(latencies, 50)} ms | p95 = ${percentile(latencies, 95)} ms | p99 = ${percentile(latencies, 99)} ms`,
  );
  console.log(`Taxa de erro de infraestrutura (5xx): ${infraErrorRate}%`);
  console.log(`Conflitos de lock (lockConflictsTotal): ${metrics.lockConflictsTotal ?? 0}`);
  console.log(`Outbox lag máximo (outboxLagSeconds): ${maxOutboxLag}s`);
  console.log(
    `Reconciliação pós-carga: ${consistentCount}/${allWallets.length} carteiras consistentes (difference = 0.00)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});