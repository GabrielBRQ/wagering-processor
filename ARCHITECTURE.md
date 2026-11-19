# Arquitetura e Decisões Técnicas — Wagering Processor

## 1. Visão Geral e Topologia

O **Wagering Processor** segue **Clean Architecture** e **DDD**, mantendo as regras financeiras desacopladas de HTTP, ORM e mensageria.

```text
[Provedores / Carga] ──► [Nginx Load Balancer :3000]
                                │
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
             [app-1]        [app-2]        [app-3]   (NestJS + Bun)
                 │              │              │
                 └──────────────┼──────────────┘
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
        [PostgreSQL 16]               [LocalStack SQS]
     (Autoridade Transacional)    (wager-transactions.fifo + DLQ)
```

- **`src/domain/`**: Value Object `Money`, entidades (`Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`), eventos de integração e hierarquia `DomainError`. Não importa NestJS, MikroORM ou AWS SDK.
- **`src/application/`**: Casos de uso (`ProcessWagerTransactionUseCase`, `WalletUseCases`), interfaces de persistência (`repositories.port.ts`) e cálculo determinístico de hash canônico (`canonical-hash.ts`).
- **`src/infrastructure/`**: Implementação de banco (MikroORM, Unit of Work, locks pessimistas, migrations), mensageria (`SqsWagerConsumer`, `OutboxPublisherWorker`) e observabilidade (`StructuredLoggerService`, `MetricsService`).
- **`src/presentation/`**: Controllers REST, filtro global de exceções (`GlobalHttpExceptionFilter`) e ponto de extensão de autenticação (`ProviderAuthGuard`).

---

## 2. Autenticação e Identidade de Provedores

### Decisão de Escopo
Para focar o timebox na correção financeira, concorrência e idempotência, a autenticação externa ficou isolada em um ponto de extensão explícito: **`ProviderAuthGuard`** (`src/presentation/guards/provider-auth.guard.ts`).

- **Rotas de negócio (`/wallets`, `/wagering`, `/providers`):** Protegidas por `@UseGuards(ProviderAuthGuard)`, operando atualmente como *no-op* documentado.
- **Rotas operacionais (`/health/live`, `/health/ready`, `/metrics`):** Abertas para health checks do Docker/Nginx e coleta de métricas.
- **Fila SQS (`wager-transactions.fifo`):** Tratada como canal interno confiável, mantendo todas as validações de domínio e unicidade por `(providerId, externalTransactionId)`.

### Desenho Alvo para Produção (OAuth2 / OIDC M2M)
Em produção, o `ProviderAuthGuard` integra-se a um Identity Provider externo (**Keycloak** ou **Zitadel**) via **OAuth2 Client Credentials**:

1. Cada provedor recebe um par `client_id` e `client_secret` no IdP e envia o JWT em `Authorization: Bearer <token>`.
2. O `ProviderAuthGuard` valida localmente assinatura, emissor (`iss`), audiência (`aud`) e expiração (`exp`) usando cache em memória das chaves públicas (**JWKS**) do IdP, evitando chamadas de rede síncronas a cada aposta.
3. O guard compara a identidade autenticada (`client_id` / `azp`) com o `providerId` informado no payload (`token.providerId === payload.providerId`), impedindo que um provedor envie transações em nome de outro.

---

## 3. ORM, Mapeamento de `Money` e Estratégia Transacional

### Escolha do MikroORM
O **MikroORM** foi adotado por três motivos práticos:

- **Unit of Work e Identity Map isolados:** `em.transactional()` cria um `EntityManager` próprio por transação SQL, evitando vazamento de estado entre requisições simultâneas.
- **Locks pessimistas nativos:** `LockMode.PESSIMISTIC_WRITE` traduz-se diretamente para `SELECT ... FOR UPDATE` no PostgreSQL.
- **Separação entre domínio e persistência:** As entidades ORM (`*.orm-entity.ts`) ficam isoladas em `src/infrastructure/database/entities/` e são convertidas via `database.mappers.ts`, preservando construtores privados e factories (`create`, `open`, `rehydrate`) no domínio.

### Persistência de `Money`
No domínio (`src/domain/value-objects/money.ts`), `Money` encapsula `Decimal` (`decimal.js`) + código ISO-4217, rejeitando `number`, `NaN`, `Infinity`, notação científica, valores negativos e mais de 2 casas decimais.

No PostgreSQL (`Migration20261117000001_InitialSchema.ts`), os valores são gravados em colunas separadas — `NUMERIC(20, 2)` para o montante e `VARCHAR(3)` para a moeda — sem conversão para tipos de ponto flutuante. Na leitura, os mappers reconstroem `Money.from({ amount, currency })` e chamam `Entity.rehydrate(...)`.

### Atomicidade Transacional
Cada operação financeira executa dentro de uma única transação SQL (`MikroOrmUnitOfWork.runInTransaction`):

1. Deduplicação persistente em `inbox_messages` (quando a entrada é via SQS);
2. Checagem de idempotência em `wager_transactions`;
3. Lock exclusivo na linha da carteira (`SELECT ... FOR UPDATE`);
4. Execução das regras de domínio (`Wallet.debit` / `Wallet.credit`) e gravação em `wallet_ledger_entries`;
5. Persistência da `WagerTransaction` e inserção dos eventos na `outbox_messages`.

Se qualquer passo falhar, o PostgreSQL executa `ROLLBACK` completo. Nenhum evento é publicado antes do `COMMIT`.

---

## 4. Concorrência e Ordenação

### Unidade de Concorrência: `walletId`
A serialização é restrita ao nível da carteira individual (`walletId`). Não existe lock global nem lock por provedor: transações de carteiras distintas rodam em paralelo entre `app-1`, `app-2` e `app-3` sem interferência.

### Estratégia Escolhida: Pessimistic Locking (`SELECT ... FOR UPDATE`)
Utiliza-se bloqueio pessimista na linha da carteira (`LockMode.PESSIMISTIC_WRITE` em `MikroOrmWalletRepository.findByIdForUpdate`), apoiado pela coluna `version` e pela constraint `CHECK ("balance" >= 0)` no PostgreSQL.

**Por que Pessimistic Locking em vez de Optimistic Locking com retries?**
- **Contenção concentrada (*Hot Wallets*):** Em rodadas rápidas, várias operações (`BET`, `WIN`, `ROLLBACK`) disputam a mesma `walletId` ao mesmo tempo. Com *optimistic locking*, *N* requisições leem a mesma versão inicial, mas apenas 1 conclui o `UPDATE`; as outras *N - 1* falham com conflito de versão, sofrem `ROLLBACK` e precisam repetir toda a transação.
- **Menos retrabalho e latência de cauda mais previsível:** Retries otimistas sob alta contenção aumentam a carga de CPU e WAL no banco e degradam `p95`/`p99`. Com `SELECT ... FOR UPDATE`, o PostgreSQL enfileira as transações na linha da carteira por alguns milissegundos e cada uma já lê o saldo atualizado logo após o `COMMIT` anterior.
- **Sem risco de deadlock entre carteiras:** Cada transação bloqueia apenas uma única linha de `wallets` (`walletId`), evitando ciclos de espera cruzada.
- **Garantia no banco, não no broker:** O `MessageGroupId` do SQS FIFO ajuda na ordenação da entrega, mas as invariantes finais ficam no PostgreSQL (`UNIQUE (provider_id, external_transaction_id)`, `UNIQUE (idempotency_key)` e `CHECK ("balance" >= 0)`).

### Paralelismo entre Instâncias (`SKIP LOCKED`)
Nos workers assíncronos (`OutboxPublisherWorker` e reprocessamento de `PENDING_REFERENCE`), utiliza-se `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`SELECT ... FOR UPDATE SKIP LOCKED`), permitindo que múltiplas instâncias processem lotes disjuntos em paralelo sem colisão.

---

## 5. Referências Fora de Ordem e Taxonomia de Erros

### Política de `PENDING_REFERENCE` e TTL
Quando uma transação com referência (`WIN`, `LOSS`, `REFUND` ou `ROLLBACK`) chega antes da operação original (ou enquanto ela ainda não está `PROCESSED`), o registro é salvo como `PENDING_REFERENCE` (`202 Accepted`) e o evento `WagerTransactionPendingReference` é gravado na Outbox.

- **Worker agendado e backoff exponencial:** O ciclo periódico do `OutboxPublisherWorker` (`OUTBOX_POLL_INTERVAL_MS`) chama `reprocessPendingReferences` em lotes de até 50 registros. Enquanto a referência não chega, o agendador aplica *backoff* exponencial conforme `min(500ms × 2^(tentativa - 1), 10.000ms)` (`500ms`, `1s`, `2s`, `4s`, `8s`, limitado a `10s`) para não sobrecarregar o banco.
- **TTL (`PENDING_REFERENCE_TTL_MS`, padrão: `30000` ms / 30 segundos):** Janela suficiente para absorver atrasos curtos de rede e reordenação entre HTTP e SQS sem manter pendências abertas indefinidamente.
- **Expiração:** Quando `now - createdAt >= PENDING_REFERENCE_TTL_MS`, a transação passa para o estado terminal `REJECTED` com `failureCode = REFERENCE_NOT_FOUND` e grava `WagerTransactionRejected` na Outbox.

### Taxonomia de `FailureCode`

| `FailureCode` | Significado | Retentável pelo Provedor? | Ação Esperada |
| :--- | :--- | :---: | :--- |
| `INSUFFICIENT_FUNDS` | Saldo insuficiente na carteira para liquidar um `BET`. | Não (com o mesmo saldo) | Informar jogador ou aguardar depósito antes de nova tentativa. |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` de um `WIN` deixaria a carteira negativa (prêmio já utilizado). | Não | Desistir da reversão e abrir tratativa operacional/auditoria. |
| `ALREADY_REVERSED` | A transação referenciada já possui um `REFUND` ou `ROLLBACK` processado. | Não | Desistir; a reversão já foi aplicada anteriormente. |
| `AMOUNT_MISMATCH` | Valor do `REFUND` ou `ROLLBACK` difere do montante da transação original. | Não (sem correção) | Corrigir o payload enviando o valor exato da operação referenciada. |
| `WALLET_CURRENCY_MISMATCH` | Moeda da transação difere da moeda cadastrada na carteira (`walletId`). | Não (sem correção) | Corrigir a moeda no payload ou apontar para a carteira correta. |
| `PLAYER_WALLET_MISMATCH` | O `playerId` informado não corresponde ao titular da `walletId`. | Não (sem correção) | Corrigir o vínculo entre `playerId` e `walletId` antes de reenviar. |
| `WALLET_NOT_FOUND` | A carteira informada (`walletId`) não existe na base. | Não (sem criar carteira) | Garantir a criação da carteira (`POST /wallets`) ou corrigir o `walletId`. |
| `INVALID_OPERATION_KIND` | Tipo de operação inválido ou não permitido no endpoint (ex.: `OPENING` externo). | Não (sem correção) | Enviar um dos tipos válidos (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`). |
| `INVALID_REFERENCE_KIND` | Tipo de referência incompatível (ex.: `REFUND` apontando para `WIN` em vez de `BET`). | Não (sem correção) | Corrigir o tipo da operação (`REFUND` vs. `ROLLBACK`) ou o ID referenciado. |
| `INVALID_REFERENCE_STATUS` | A transação referenciada não está apta para liquidação (ex.: já `REJECTED` ou `FAILED`). | Não | Desistir; não é possível liquidar ou reverter uma transação rejeitada. |
| `REFERENCE_MISMATCH` | Referência pertence a outro `providerId`, `playerId`, `walletId`, `roundId` ou moeda. | Não (sem correção) | Corrigir os metadados de contexto da rodada na requisição. |
| `REFERENCE_NOT_FOUND` | Transação referenciada não chegou dentro do TTL de `PENDING_REFERENCE`. | Não | Verificar se a operação original foi enviada ao motor antes de reenviar. |
| `INFRASTRUCTURE_ERROR` | Falha transitória interna de persistência ou infraestrutura durante o processamento. | Sim (com backoff) | Reenviar a requisição mantendo exatamente a mesma `Idempotency-Key`. |

---

## 6. Algoritmo de Hash Canônico (`computeWagerPayloadHash`)

Para diferenciar um *replay* idêntico (`idempotentReplay: true`) do reuso de `Idempotency-Key` com dados divergentes (`409 Conflict`), o sistema gera um hash determinístico em `src/application/utils/canonical-hash.ts`:

1. **Projeção dos campos de negócio:** Extrai apenas `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (`{ amount, currency }`) e `referenceExternalTransactionId` (quando preenchido após `.trim()`). Headers HTTP (`Idempotency-Key`, `X-Correlation-Id`) e metadados SQS (`messageId`, `occurredAt`) ficam de fora.
2. **Normalização:** `money.amount` é normalizado em 2 casas decimais (`"25.00"`), `money.currency` em ISO-4217 maiúsculo (`"BRL"`) e propriedades `undefined` são removidas.
3. **Ordenação recursiva de chaves:** As chaves do objeto raiz e de objetos aninhados (`money`) são ordenadas lexicograficamente (`Object.keys(obj).sort()`).
4. **Serialização e SHA-256:** O objeto ordenado é serializado com `JSON.stringify` sem espaços e resumido em SHA-256 (hexadecimal minúsculo de 64 caracteres, gravado em `payload_hash`).

Exemplo de entrada com chaves fora de ordem:

```json
{
  "money": { "currency": "BRL", "amount": "25.00" },
  "kind": "BET",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "gameId": "fortune-chimp",
  "roundId": "round-987",
  "externalTransactionId": "tx-1",
  "providerId": "provider-a"
}
```

String canônica gerada antes do SHA-256:

```text
{"externalTransactionId":"tx-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}
```

---

## 7. Trade-offs e Limitações Conhecidas

- **Outbox Polling vs. CDC (Change Data Capture):** O *polling* com `FOR UPDATE SKIP LOCKED` evita subir Kafka Connect/Debezium e mantém latência sub-segundo, ao custo de consultas leves periódicas quando a tabela está vazia.
- **Contenção em *Hot Wallet*:** Como o lock pessimista serializa transações da mesma carteira, picos concentrados em uma única `walletId` formam fila no PostgreSQL, enquanto carteiras distintas escalam em paralelo.
- **Ledger Single-Entry:** Cada movimentação grava `balanceBefore`, `amount`, `balanceAfter` e `direction` em `wallet_ledger_entries` com validação no domínio, `CHECK` no banco e endpoint de reconciliação (`POST /wallets/:walletId/reconciliation`). Contabilidade por partidas dobradas ficou fora de escopo.

---

## 8. Resultados do Teste de Carga (`bun run test:load`)

- **Ambiente:** Docker Compose local (`app-1`, `app-2`, `app-3` atrás do Nginx na porta `3000`, PostgreSQL 16 e LocalStack SQS).
- **Cenário executado:** `300` requisições concorrentes (`concorrência = 30`) em `POST /wagering/transactions`, concentrando 40% da carga (120 apostas de `10.00 BRL`) em uma *hot wallet* com saldo inicial de `1000.00 BRL` e 60% (180 apostas de `5.00 BRL`) distribuídas entre 15 carteiras paralelas.
- **Métricas coletadas:**
  - **Balanceamento via Nginx:** `3/3` instâncias atendidas (`172.18.0.4:3000`, `172.18.0.5:3000`, `172.18.0.6:3000`)
  - **Respostas HTTP:** `280` liquidadas (`200 OK`) e `20` rejeitadas por saldo insuficiente na *hot wallet* (`422 Unprocessable Entity`)
  - **Throughput:** `107.30 req/s`
  - **Latência:** `p50 = 137.15 ms | p95 = 694.66 ms | p99 = 774.85 ms`
  - **Taxa de erro de infraestrutura (`5xx`):** `0.00%`
  - **Contenção de lock (`lockConflictsTotal` em `/metrics`):** `49` esperas de serialização registradas na *hot wallet*
  - **Outbox lag máximo (`outboxLagSeconds` em `/metrics`):** `1.87s`
  - **Reconciliação pós-carga:** `16/16` carteiras (`100%`) consistentes (`difference = 0.00`).