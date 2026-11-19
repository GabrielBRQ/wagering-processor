import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from '../src/app.module';
import { ProcessWagerTransactionUseCase } from '../src/application/use-cases/process-wager-transaction.use-case';
import { OutboxPublisherWorker } from '../src/infrastructure/messaging/outbox-publisher.worker';
import { SqsGateway } from '../src/infrastructure/messaging/sqs-client.provider';
import { SqsWagerConsumer } from '../src/infrastructure/messaging/sqs-wager.consumer';

process.env.DISABLE_SQS_CONSUMER = 'true';
process.env.OUTBOX_POLL_INTERVAL_MS = '60000';
OutboxPublisherWorker.prototype.tick = async () => {};

describe('Wagering Processor — Integration & Concurrency Suite (Section 13)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let em: EntityManager;
  let sqs: SqsGateway;
  let consumer: SqsWagerConsumer;
  let outboxWorker: OutboxPublisherWorker;
  let processWagerUseCase: ProcessWagerTransactionUseCase;

  async function drainQueue(queueUrl: string): Promise<void> {
    while (true) {
      const res = await sqs.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      );
      const messages = res.Messages ?? [];
      if (messages.length === 0) {
        break;
      }
      for (const msg of messages) {
        if (msg.ReceiptHandle) {
          await sqs.client.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle,
            }),
          );
        }
      }
    }
  }

  async function receiveOneFromQueue(
    queueUrl: string,
    maxAttempts = 5,
    visibilityTimeout?: number,
  ) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await sqs.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
          VisibilityTimeout: visibilityTimeout,
          MessageAttributeNames: ['All'],
        }),
      );
      if (res.Messages && res.Messages.length > 0) {
        return res.Messages[0]!;
      }
    }
    return undefined;
  }

  async function createWallet(
    playerId: string,
    amount: string,
    currency = 'BRL',
    targetUrl = baseUrl,
  ) {
    const res = await fetch(`${targetUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount, currency },
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      id: string;
      playerId: string;
      balance: { amount: string; currency: string };
      version: number;
    };
  }

  async function assertReconciliationConsistent(
    walletId: string,
    expectedCheckedEntries?: number,
  ): Promise<void> {
    const reconRes = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
    });
    expect(reconRes.status).toBe(200);
    const recon = (await reconRes.json()) as {
      consistent: boolean;
      checkedEntries: number;
      storedBalance: { amount: string; currency: string };
      calculatedBalance: { amount: string; currency: string };
      difference: { amount: string; currency: string };
    };

    expect(recon.consistent).toBe(true);
    expect(recon.difference.amount).toBe('0.00');
    expect(recon.storedBalance.amount).toBe(recon.calculatedBalance.amount);
    if (expectedCheckedEntries !== undefined) {
      expect(recon.checkedEntries).toBe(expectedCheckedEntries);
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    await app.listen(0);

    baseUrl = await app.getUrl();
    em = app.get(EntityManager);
    sqs = app.get(SqsGateway);
    consumer = app.get(SqsWagerConsumer);
    outboxWorker = app.get(OutboxPublisherWorker);
    processWagerUseCase = app.get(ProcessWagerTransactionUseCase);

    await outboxWorker.onModuleDestroy();
  });

  beforeEach(async () => {
    await em
      .getConnection()
      .execute(
        'TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE',
      );
    await drainQueue(sqs.queueUrl);
    await drainQueue(sqs.dlqUrl);
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Serializes 20 concurrent BET requests on the same wallet without negative balance or lost updates', async () => {
    const wallet = await createWallet('player-concurrent', '100.00', 'BRL');

    const requests = Array.from({ length: 20 }, (_, i) =>
      fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `concurrent-bet-${i}`,
        },
        body: JSON.stringify({
          providerId: 'pragmatic',
          externalTransactionId: `ext-concurrent-${i}`,
          playerId: 'player-concurrent',
          walletId: wallet.id,
          roundId: `round-${i}`,
          gameId: 'gates-of-olympus',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      }),
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
      status: string;
      failureCode?: string;
    }>;

    const processedCount = statuses.filter((s) => s === 200).length;
    const rejectedCount = statuses.filter((s) => s === 422).length;

    expect(processedCount).toBe(10);
    expect(rejectedCount).toBe(10);
    expect(bodies.filter((b) => b.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(10);

    const walletRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    const updatedWallet = (await walletRes.json()) as {
      balance: { amount: string; currency: string };
      version: number;
    };
    expect(updatedWallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(updatedWallet.version).toBe(11);

    await assertReconciliationConsistent(wallet.id, 11);
  });

  it('2. Enforces idempotency under concurrent duplicate retries and rejects payload conflicts with 409', async () => {
    const wallet = await createWallet('player-idem', '200.00', 'BRL');
    const sharedKey = 'idem-key-shared-001';

    const payload = {
      providerId: 'evolution',
      externalTransactionId: 'ext-idem-001',
      playerId: 'player-idem',
      walletId: wallet.id,
      roundId: 'round-idem-1',
      gameId: 'crazy-time',
      kind: 'BET',
      money: { amount: '50.00', currency: 'BRL' },
    };

    const parallelRetries = Array.from({ length: 8 }, () =>
      fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': sharedKey,
        },
        body: JSON.stringify(payload),
      }),
    );

    const results = await Promise.all(parallelRetries);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const jsonBodies = (await Promise.all(results.map((r) => r.json()))) as Array<{
      transactionId: string;
    }>;
    const uniqueTxIds = new Set(jsonBodies.map((b) => b.transactionId));
    expect(uniqueTxIds.size).toBe(1);

    const walletRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    const walletAfter = (await walletRes.json()) as { balance: { amount: string } };
    expect(walletAfter.balance.amount).toBe('150.00');

    const conflictRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': sharedKey,
      },
      body: JSON.stringify({
        ...payload,
        money: { amount: '75.00', currency: 'BRL' },
      }),
    });
    expect(conflictRes.status).toBe(409);

    await assertReconciliationConsistent(wallet.id, 2);
  });

  it('3. Processes BET, WIN, LOSS, REFUND, prevents double reversal, and rejects ROLLBACK without funds', async () => {
    const wallet = await createWallet('player-lifecycle', '100.00', 'BRL');

    const betRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-bet-1' },
      body: JSON.stringify({
        providerId: 'hacksaw',
        externalTransactionId: 'bet-1',
        playerId: 'player-lifecycle',
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'wanted',
        kind: 'BET',
        money: { amount: '40.00', currency: 'BRL' },
      }),
    });
    expect(betRes.status).toBe(200);

    const lossRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-loss-1' },
      body: JSON.stringify({
        providerId: 'hacksaw',
        externalTransactionId: 'loss-1',
        playerId: 'player-lifecycle',
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'wanted',
        kind: 'LOSS',
        money: { amount: '40.00', currency: 'BRL' },
      }),
    });
    expect(lossRes.status).toBe(200);
    const lossBody = (await lossRes.json()) as { balance: { amount: string } };
    expect(lossBody.balance.amount).toBe('60.00');

    const refundRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-refund-1' },
      body: JSON.stringify({
        providerId: 'hacksaw',
        externalTransactionId: 'refund-1',
        playerId: 'player-lifecycle',
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'wanted',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
      }),
    });
    expect(refundRes.status).toBe(200);
    const refundBody = (await refundRes.json()) as { balance: { amount: string } };
    expect(refundBody.balance.amount).toBe('100.00');

    const doubleRefundRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-refund-2' },
      body: JSON.stringify({
        providerId: 'hacksaw',
        externalTransactionId: 'refund-2',
        playerId: 'player-lifecycle',
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'wanted',
        kind: 'REFUND',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
      }),
    });
    expect(doubleRefundRes.status).toBe(422);
    const doubleRefundBody = (await doubleRefundRes.json()) as { failureCode: string };
    expect(doubleRefundBody.failureCode).toBe('ALREADY_REVERSED');

    await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-win-2' },
      body: JSON.stringify({
        providerId: 'hacksaw',
        externalTransactionId: 'win-2',
        playerId: 'player-lifecycle',
        walletId: wallet.id,
        roundId: 'r-2',
        gameId: 'wanted',
        kind: 'WIN',
        money: { amount: '80.00', currency: 'BRL' },
      }),
    });

    await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-bet-3' },
      body: JSON.stringify({
        providerId: 'hacksaw',
        externalTransactionId: 'bet-3',
        playerId: 'player-lifecycle',
        walletId: wallet.id,
        roundId: 'r-3',
        gameId: 'wanted',
        kind: 'BET',
        money: { amount: '150.00', currency: 'BRL' },
      }),
    });

    const badRollbackRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-rb-win-2' },
      body: JSON.stringify({
        providerId: 'hacksaw',
        externalTransactionId: 'rb-win-2',
        playerId: 'player-lifecycle',
        walletId: wallet.id,
        roundId: 'r-2',
        gameId: 'wanted',
        kind: 'ROLLBACK',
        money: { amount: '80.00', currency: 'BRL' },
        referenceExternalTransactionId: 'win-2',
      }),
    });
    expect(badRollbackRes.status).toBe(422);
    const badRollbackBody = (await badRollbackRes.json()) as { failureCode: string };
    expect(badRollbackBody.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');

    await assertReconciliationConsistent(wallet.id, 5);
  });

  it('4. Handles out-of-order REFUND via PENDING_REFERENCE and resolves once BET arrives (and rejects on TTL expiration)', async () => {
    const wallet = await createWallet('player-ooo', '100.00', 'BRL');

    const earlyRefundRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-ooo-refund' },
      body: JSON.stringify({
        providerId: 'netent',
        externalTransactionId: 'ooo-refund-1',
        playerId: 'player-ooo',
        walletId: wallet.id,
        roundId: 'r-ooo-1',
        gameId: 'starburst',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: 'ooo-bet-1',
      }),
    });
    expect(earlyRefundRes.status).toBe(202);
    const earlyRefundBody = (await earlyRefundRes.json()) as {
      transactionId: string;
      status: string;
    };
    expect(earlyRefundBody.status).toBe('PENDING_REFERENCE');

    const lateBetRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-ooo-bet' },
      body: JSON.stringify({
        providerId: 'netent',
        externalTransactionId: 'ooo-bet-1',
        playerId: 'player-ooo',
        walletId: wallet.id,
        roundId: 'r-ooo-1',
        gameId: 'starburst',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      }),
    });
    expect(lateBetRes.status).toBe(200);

    const resolved = await processWagerUseCase.reprocessPendingReferences(30_000, 50);
    expect(resolved).toBe(1);

    const txDetailsRes = await fetch(
      `${baseUrl}/wagering/transactions/${earlyRefundBody.transactionId}`,
    );
    const txDetails = (await txDetailsRes.json()) as { status: string };
    expect(txDetails.status).toBe('PROCESSED');

    const walletRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    const walletAfter = (await walletRes.json()) as { balance: { amount: string } };
    expect(walletAfter.balance.amount).toBe('100.00');

    const orphanRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-orphan-refund' },
      body: JSON.stringify({
        providerId: 'netent',
        externalTransactionId: 'orphan-refund-1',
        playerId: 'player-ooo',
        walletId: wallet.id,
        roundId: 'r-orphan',
        gameId: 'starburst',
        kind: 'REFUND',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: 'non-existent-bet',
      }),
    });
    expect(orphanRes.status).toBe(202);
    const orphanBody = (await orphanRes.json()) as { transactionId: string };

    await processWagerUseCase.reprocessPendingReferences(0, 50);

    const expiredDetailsRes = await fetch(
      `${baseUrl}/wagering/transactions/${orphanBody.transactionId}`,
    );
    const expiredDetails = (await expiredDetailsRes.json()) as {
      status: string;
      failureCode: string;
    };
    expect(expiredDetails.status).toBe('REJECTED');
    expect(expiredDetails.failureCode).toBe('REFERENCE_NOT_FOUND');

    await assertReconciliationConsistent(wallet.id, 3);
  });

  it('5. Consumes SQS FIFO messages with Inbox deduplication, publishes Outbox events, and routes poison messages to DLQ', async () => {
    const wallet = await createWallet('player-sqs', '100.00', 'BRL');
    const msgId = `sqs-msg-${uuidv4()}`;

    const sqsEnvelope = {
      messageId: msgId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'bgaming',
        externalTransactionId: 'sqs-bet-1',
        idempotencyKey: 'bgaming:sqs-bet-1',
        playerId: 'player-sqs',
        walletId: wallet.id,
        roundId: 'r-sqs-1',
        gameId: 'bonanza',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    };

    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: sqs.queueUrl,
        MessageBody: JSON.stringify(sqsEnvelope),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: msgId,
      }),
    );

    const message = await receiveOneFromQueue(sqs.queueUrl);
    expect(message).toBeDefined();

    await consumer.handleMessage(message!);

    await consumer.handleMessage({
      MessageId: message!.MessageId,
      Body: JSON.stringify(sqsEnvelope),
    });

    const walletRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    const walletAfter = (await walletRes.json()) as { balance: { amount: string } };
    expect(walletAfter.balance.amount).toBe('75.00');

    // 2 eventos do createWallet + 2 eventos do BET = 4 eventos
    const publishedCount = await outboxWorker.publishDueBatch(50);
    expect(publishedCount).toBe(4);

    await consumer.handleMessage({
      MessageId: 'bad-msg-1',
      Body: '{invalid-json',
    });

    const dlqMessage = await receiveOneFromQueue(sqs.dlqUrl);
    expect(dlqMessage).toBeDefined();
    expect(dlqMessage?.Body).toBe('{invalid-json');

    await assertReconciliationConsistent(wallet.id, 2);
  });

  it('6. Recovers from transient Outbox publish failure without duplicating ledger entries and supports cursor pagination', async () => {
    const wallet = await createWallet('player-recovery', '100.00', 'BRL');

    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `k-page-${i}` },
        body: JSON.stringify({
          providerId: 'pragmatic',
          externalTransactionId: `ext-page-${i}`,
          playerId: 'player-recovery',
          walletId: wallet.id,
          roundId: `r-page-${i}`,
          gameId: 'sweet-bonanza',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });
      expect(res.status).toBe(200);
    }

    const page1Res = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=2`);
    const page1 = (await page1Res.json()) as {
      entries: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2Res = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    const page2 = (await page2Res.json()) as {
      entries: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page2.entries).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    const originalSend = sqs.client.send.bind(sqs.client);
    const simulateOutage = true;
    sqs.client.send = (async (command: unknown) => {
      if (simulateOutage) {
        throw new Error('Simulated SQS network timeout');
      }
      return originalSend(command as never);
    }) as typeof sqs.client.send;

    const firstAttemptPublished = await outboxWorker.publishDueBatch(50);
    expect(firstAttemptPublished).toBe(0);

    sqs.client.send = originalSend;
    await em
      .getConnection()
      .execute(`UPDATE outbox_messages SET next_attempt_at = NOW() WHERE published_at IS NULL`);

    // 2 eventos do createWallet + 6 eventos dos 3 BETs = 8 eventos
    const secondAttemptPublished = await outboxWorker.publishDueBatch(50);
    expect(secondAttemptPublished).toBe(8);

    const finalWalletRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    const finalWallet = (await finalWalletRes.json()) as { balance: { amount: string } };
    expect(finalWallet.balance.amount).toBe('70.00');

    await assertReconciliationConsistent(wallet.id, 4);
  });

  it('7. [Section 8 & 13.2] Enforces mandatory scenario: 100.00 BRL wallet with two simultaneous 80.00 BRL bets', async () => {
    const wallet = await createWallet('player-sec8', '100.00', 'BRL');

    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'sec8-bet-a' },
        body: JSON.stringify({
          providerId: 'pragmatic',
          externalTransactionId: 'sec8-ext-a',
          playerId: 'player-sec8',
          walletId: wallet.id,
          roundId: 'r-sec8-a',
          gameId: 'gates-of-olympus',
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
        }),
      }),
      fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'sec8-bet-b' },
        body: JSON.stringify({
          providerId: 'pragmatic',
          externalTransactionId: 'sec8-ext-b',
          playerId: 'player-sec8',
          walletId: wallet.id,
          roundId: 'r-sec8-b',
          gameId: 'gates-of-olympus',
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
        }),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 422]);

    const bodyA = (await resA.json()) as { status: string; failureCode?: string };
    const bodyB = (await resB.json()) as { status: string; failureCode?: string };
    const allBodies = [bodyA, bodyB];

    expect(allBodies.filter((b) => b.status === 'PROCESSED')).toHaveLength(1);
    expect(
      allBodies.filter((b) => b.status === 'REJECTED' && b.failureCode === 'INSUFFICIENT_FUNDS'),
    ).toHaveLength(1);

    const retryA = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'sec8-bet-a' },
      body: JSON.stringify({
        providerId: 'pragmatic',
        externalTransactionId: 'sec8-ext-a',
        playerId: 'player-sec8',
        walletId: wallet.id,
        roundId: 'r-sec8-a',
        gameId: 'gates-of-olympus',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      }),
    });
    const retryABody = (await retryA.json()) as { idempotentReplay: boolean };
    expect(retryABody.idempotentReplay).toBe(true);

    const walletAfterRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    const walletAfter = (await walletAfterRes.json()) as {
      balance: { amount: string };
      version: number;
    };
    expect(walletAfter.balance.amount).toBe('20.00');
    expect(walletAfter.version).toBe(2);

    await assertReconciliationConsistent(wallet.id, 2);
  });

  it('8. [Section 13.1] Processes the exact same bet 50 times in parallel with a single debit and 49 replays', async () => {
    const wallet = await createWallet('player-parallel-50', '500.00', 'BRL');
    const idempotencyKey = `provider-a:parallel-50-${uuidv4()}`;

    const payload = {
      providerId: 'provider-a',
      externalTransactionId: `ext-p50-${uuidv4()}`,
      playerId: 'player-parallel-50',
      walletId: wallet.id,
      roundId: 'round-parallel-50',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    };

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        fetch(`${baseUrl}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(payload),
        }),
      ),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);

    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{
      transactionId: string;
      idempotentReplay: boolean;
      balance: { amount: string };
    }>;

    const uniqueTxIds = new Set(bodies.map((b) => b.transactionId));
    expect(uniqueTxIds.size).toBe(1);
    expect(bodies.filter((b) => b.idempotentReplay === false)).toHaveLength(1);
    expect(bodies.filter((b) => b.idempotentReplay === true)).toHaveLength(49);
    expect(bodies.every((b) => b.balance.amount === '470.00')).toBe(true);

    const walletAfterRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    const walletAfter = (await walletAfterRes.json()) as {
      balance: { amount: string };
      version: number;
    };
    expect(walletAfter.balance.amount).toBe('470.00');
    expect(walletAfter.version).toBe(2);

    await assertReconciliationConsistent(wallet.id, 2);
  });

  it('9. [Section 13.3 & 13.4] Processes distinct wallets in parallel across 3 simultaneous service instances', async () => {
    const mod2 = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app2 = mod2.createNestApplication();
    app2.enableShutdownHooks();
    await app2.init();
    await app2.listen(0);
    await app2.get(OutboxPublisherWorker).onModuleDestroy();

    const mod3 = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app3 = mod3.createNestApplication();
    app3.enableShutdownHooks();
    await app3.init();
    await app3.listen(0);
    await app3.get(OutboxPublisherWorker).onModuleDestroy();

    try {
      const urls = [baseUrl, await app2.getUrl(), await app3.getUrl()];

      const wallets = await Promise.all(
        Array.from({ length: 9 }, (_, idx) =>
          createWallet(`player-multi-${idx}`, '100.00', 'BRL', urls[idx % urls.length]),
        ),
      );

      const sharedWallet = await createWallet('player-shared-cluster', '100.00', 'BRL', urls[0]);

      const distinctWalletCalls = wallets.map((w, idx) =>
        fetch(`${urls[idx % urls.length]}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `cluster-distinct-${idx}`,
          },
          body: JSON.stringify({
            providerId: 'pragmatic',
            externalTransactionId: `ext-cluster-distinct-${idx}`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `r-cluster-${idx}`,
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '25.00', currency: 'BRL' },
          }),
        }),
      );

      const sharedWalletCalls = Array.from({ length: 6 }, (_, idx) =>
        fetch(`${urls[idx % urls.length]}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `cluster-shared-${idx}`,
          },
          body: JSON.stringify({
            providerId: 'pragmatic',
            externalTransactionId: `ext-cluster-shared-${idx}`,
            playerId: 'player-shared-cluster',
            walletId: sharedWallet.id,
            roundId: `r-shared-${idx}`,
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '20.00', currency: 'BRL' },
          }),
        }),
      );

      const allResponses = await Promise.all([...distinctWalletCalls, ...sharedWalletCalls]);
      const distinctResponses = allResponses.slice(0, 9);
      const sharedResponses = allResponses.slice(9);

      expect(distinctResponses.every((r) => r.status === 200)).toBe(true);
      expect(sharedResponses.filter((r) => r.status === 200)).toHaveLength(5);
      expect(sharedResponses.filter((r) => r.status === 422)).toHaveLength(1);

      for (const w of wallets) {
        const res = await fetch(`${baseUrl}/wallets/${w.id}`);
        const body = (await res.json()) as { balance: { amount: string } };
        expect(body.balance.amount).toBe('75.00');
        await assertReconciliationConsistent(w.id, 2);
      }

      const sharedCheck = await fetch(`${baseUrl}/wallets/${sharedWallet.id}`);
      const sharedBody = (await sharedCheck.json()) as { balance: { amount: string } };
      expect(sharedBody.balance.amount).toBe('0.00');
      await assertReconciliationConsistent(sharedWallet.id, 6);
    } finally {
      await app2.close();
      await app3.close();
    }
  });

  it(
    '10. [Section 13.5] Survives worker crash after PostgreSQL commit and before SQS ACK without duplicating debit',
    async () => {
      const wallet = await createWallet('player-crash-ack', '100.00', 'BRL');
      const msgId = `sqs-crash-${uuidv4()}`;

      const sqsEnvelope = {
        messageId: msgId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'bgaming',
          externalTransactionId: 'crash-bet-1',
          idempotencyKey: 'bgaming:crash-bet-1',
          playerId: 'player-crash-ack',
          walletId: wallet.id,
          roundId: 'r-crash-1',
          gameId: 'bonanza',
          kind: 'BET',
          money: { amount: '40.00', currency: 'BRL' },
        },
      };

      await sqs.client.send(
        new SendMessageCommand({
          QueueUrl: sqs.queueUrl,
          MessageBody: JSON.stringify(sqsEnvelope),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: msgId,
        }),
      );

      const firstMsg = await receiveOneFromQueue(sqs.queueUrl, 5, 1);
      expect(firstMsg).toBeDefined();

      // Simula falha antes do SQS ACK: o consumer captura internamente (sqs.consumer.transient_retry) e NÃO envia DeleteMessageCommand
      const originalSend = sqs.client.send.bind(sqs.client);
      sqs.client.send = (async (command: unknown) => {
        if (command instanceof DeleteMessageCommand) {
          throw new Error('Simulated worker process crash before SQS ACK');
        }
        return originalSend(command as never);
      }) as typeof sqs.client.send;

      await consumer.handleMessage(firstMsg!);
      sqs.client.send = originalSend;

      if (firstMsg!.ReceiptHandle) {
        await sqs.client
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: sqs.queueUrl,
              ReceiptHandle: firstMsg!.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          )
          .catch(() => {});
      }

      const redeliveredMsg = await receiveOneFromQueue(sqs.queueUrl, 6);
      expect(redeliveredMsg).toBeDefined();

      // Segunda instância processa a reentrega -> Inbox detecta duplicata, não debita novamente e conclui o ACK
      await consumer.handleMessage(redeliveredMsg!);

      const walletAfterRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
      const walletAfter = (await walletAfterRes.json()) as { balance: { amount: string } };
      expect(walletAfter.balance.amount).toBe('60.00');

      await assertReconciliationConsistent(wallet.id, 2);
    },
    15_000,
  );

  it('11. [Section 13.6] Coordinates two concurrent Outbox publishers via SKIP LOCKED without duplicating events', async () => {
    const mod2 = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app2 = mod2.createNestApplication();
    app2.enableShutdownHooks();
    await app2.init();

    const outboxWorker2 = app2.get(OutboxPublisherWorker);
    await outboxWorker2.onModuleDestroy();

    try {
      const wallet = await createWallet('player-dual-outbox', '500.00', 'BRL');

      // 2 eventos do createWallet + 20 eventos de 10 BETs = 22 eventos pendentes na Outbox
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${baseUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `dual-outbox-${i}` },
          body: JSON.stringify({
            providerId: 'pragmatic',
            externalTransactionId: `ext-dual-outbox-${i}`,
            playerId: 'player-dual-outbox',
            walletId: wallet.id,
            roundId: `r-dual-${i}`,
            gameId: 'gates-of-olympus',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          }),
        });
        expect(res.status).toBe(200);
      }

      const pendingBeforeRows = (await em
        .getConnection()
        .execute(
          `SELECT COUNT(*)::int AS total FROM outbox_messages WHERE published_at IS NULL`,
        )) as Array<{ total: number }>;
      const totalPendingBefore = pendingBeforeRows[0]?.total ?? 0;
      expect(totalPendingBefore).toBe(22);

      const [pub1, pub2] = await Promise.all([
        outboxWorker.publishDueBatch(50),
        outboxWorker2.publishDueBatch(50),
      ]);

      expect(pub1 + pub2).toBe(totalPendingBefore);

      const pendingAfterRows = (await em
        .getConnection()
        .execute(
          `SELECT COUNT(*)::int AS total FROM outbox_messages WHERE published_at IS NULL`,
        )) as Array<{ total: number }>;
      expect(pendingAfterRows[0]?.total ?? 0).toBe(0);

      await assertReconciliationConsistent(wallet.id, 11);
    } finally {
      await app2.close();
    }
  });

  it('12. [Section 13.8 & Constraints] Recovers pending work after service restart and enforces DB constraints', async () => {
    const modRestartA = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const appRestartA = modRestartA.createNestApplication();
    appRestartA.enableShutdownHooks();
    await appRestartA.init();
    await appRestartA.listen(0);
    await appRestartA.get(OutboxPublisherWorker).onModuleDestroy();

    const urlA = await appRestartA.getUrl();
    const wallet = await createWallet('player-restart', '100.00', 'BRL', urlA);

    const dupWalletRes = await fetch(`${urlA}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: 'player-restart',
        initialBalance: { amount: '50.00', currency: 'BRL' },
      }),
    });
    expect(dupWalletRes.status).toBe(409);

    await expect(
      em
        .getConnection()
        .execute(`UPDATE wallets SET balance = -1.00 WHERE id = ?`, [wallet.id]),
    ).rejects.toThrow();

    const betRes = await fetch(`${urlA}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'restart-bet-1' },
      body: JSON.stringify({
        providerId: 'pragmatic',
        externalTransactionId: 'ext-restart-1',
        playerId: 'player-restart',
        walletId: wallet.id,
        roundId: 'r-restart-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '35.00', currency: 'BRL' },
      }),
    });
    expect(betRes.status).toBe(200);
    await appRestartA.close();

    const modRestartB = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const appRestartB = modRestartB.createNestApplication();
    appRestartB.enableShutdownHooks();
    await appRestartB.init();

    const recoveredWorker = appRestartB.get(OutboxPublisherWorker);
    await recoveredWorker.onModuleDestroy();

    try {
      // 2 eventos do createWallet + 2 eventos do BET = 4 eventos
      const drainedCount = await recoveredWorker.publishDueBatch(50);
      expect(drainedCount).toBe(4);

      const walletCheckRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
      const walletCheck = (await walletCheckRes.json()) as { balance: { amount: string } };
      expect(walletCheck.balance.amount).toBe('65.00');

      await assertReconciliationConsistent(wallet.id, 2);
    } finally {
      await appRestartB.close();
    }
  });
});