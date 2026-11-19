# Wagering Processor

Serviço backend para processamento de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), controle transacional de saldo, extrato imutável (*ledger*) e publicação confiável de eventos via **Transactional Outbox** e **AWS SQS FIFO**.

## Stack

- **Runtime e Testes:** Bun 1.x + TypeScript (`strict: true`)
- **Framework:** NestJS
- **Banco de Dados:** PostgreSQL 16 + MikroORM v6 (`NUMERIC(20, 2)`)
- **Precisão Monetária:** `decimal.js` (sem uso de `number` ou ponto flutuante para valores financeiros)
- **Mensageria:** AWS SQS FIFO + DLQ (via LocalStack v3.8)
- **Infraestrutura:** Docker Compose + 3 instâncias da aplicação atrás de Nginx

---

## Estrutura do Projeto

O código segue Clean Architecture e DDD, mantendo o domínio isolado de frameworks, ORM e SDKs externos:

```text
src/
├── domain/                    # Regras financeiras puras (sem dependências externas)
│   ├── entities/              # Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage
│   ├── errors/                # Hierarquia DomainError e FailureCode
│   ├── events/                # IntegrationEvent e eventos de domínio
│   └── value-objects/         # Money (decimal.js, ISO-4217, imutável)
├── application/               # Casos de uso, ports e hash canônico SHA-256
│   ├── errors/                # Erros de aplicação (400, 404, 409)
│   ├── ports/                 # Interfaces de repositórios e UnitOfWork
│   ├── use-cases/             # WalletUseCases, ProcessWagerTransactionUseCase
│   └── utils/                 # Canonicalização JSON e cálculo de payloadHash
├── infrastructure/            # Adaptadores de banco, fila e observabilidade
│   ├── database/              # Entidades ORM, mappers, migrations e repositórios MikroORM
│   ├── messaging/             # SqsGateway, SqsWagerConsumer, OutboxPublisherWorker
│   └── observability/         # StructuredLogger (JSON) e MetricsService
└── presentation/              # Camada HTTP REST
    ├── controllers/           # WalletsController, WageringController, HealthController
    ├── filters/               # GlobalHttpExceptionFilter
    └── guards/                # ProviderAuthGuard (ponto de extensão para OIDC/IdP)
```

---

## Como o Fluxo Funciona

```text
Requisição HTTP / Mensagem SQS
        │
        ▼
  [1] Validação de entrada + Money.from() + SHA-256 canônico
        │
        ▼
  [2] Transação SQL (UnitOfWork)
        ├─► Deduplicação na Inbox (quando a entrada vem do SQS)
        ├─► Checagem de Idempotência (idempotencyKey / providerId + externalTransactionId)
        ├─► SELECT ... FOR UPDATE na Wallet (serializa operações por walletId)
        ├─► Avaliação de Referência (WIN / LOSS / REFUND / ROLLBACK)
        │     ├─► Ausente/Pendente ──► status = PENDING_REFERENCE (HTTP 202)
        │     ├─► Inválida        ──► status = REJECTED + failureCode (HTTP 422)
        │     └─► Válida          ──► Atualiza Wallet + grava WalletLedgerEntry
        ├─► Grava eventos na Outbox (mesma transação SQL)
        └─► COMMIT
        │
        ▼
  [3] ACK no SQS (apenas após COMMIT) / Resposta HTTP
```

- **Concorrência por carteira:** `SELECT ... FOR UPDATE` bloqueia somente a linha da `walletId` envolvida. Apostas de jogadores diferentes rodam em paralelo sem contenção global, enquanto o banco garante saldo não-negativo (`CHECK ("balance" >= 0)`) e impede reversões duplicadas via índice único parcial.
- **Idempotência em duas camadas:** Na camada de negócio (`wager_transactions`), `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` combinados ao `payload_hash` (SHA-256 canônico) diferenciam *replays* idênticos (`idempotentReplay: true`) de payloads divergentes (`409 Conflict`). No transporte SQS (`inbox_messages`), `(consumer_name, message_id)` evita efeito duplicado em reentregas *at-least-once*.
- **Outbox e referências fora de ordem:** Eventos são gravados junto com o saldo e publicados por um worker periódico (`FOR UPDATE SKIP LOCKED`) no SQS FIFO. Quando um `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` chega antes da transação original, fica em `PENDING_REFERENCE` (`202 Accepted`) e é reavaliado com *backoff* exponencial (`500ms` até `10s`) até liquidar ou expirar pelo TTL (`REFERENCE_NOT_FOUND`).

As justificativas técnicas, trade-offs, algoritmo de hash canônico, taxonomia completa de `failureCode` e métricas de carga estão detalhados em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Como Executar

### Pré-requisitos

- [Bun](https://bun.sh/) `>= 1.1`
- Docker e Docker Compose

### 1. Subir o ambiente completo (3 instâncias + Nginx + PostgreSQL + LocalStack)

```bash
cp .env.example .env
docker compose up -d --build
```

Verifique os containers e a resposta do Nginx na porta `3000`:

```bash
docker compose ps
curl -i http://localhost:3000/health/ready
```

### 2. Rodar a aplicação localmente (fora do Docker)

Mantendo apenas PostgreSQL e LocalStack nos containers:

```bash
bun install
docker compose up -d postgres localstack sqs-init
bun run build
bun run dist/infrastructure/database/migrate.js
bun run start:dev
```

### 3. Rodar os testes (Unidade, Integração e Concorrência)

Antes de executar a suíte de integração, pare os containers da API para evitar que eles consumam mensagens da fila SQS durante os testes:

```bash
docker compose stop app-1 app-2 app-3 nginx
docker compose up -d postgres localstack sqs-init migrator
bun test
```

### 4. Rodar o teste de carga

Com o cluster completo ativo (`docker compose up -d --build`):

```bash
bun run test:load
```

---

## Variáveis de Ambiente Principais

Os valores padrão estão em `.env.example`. Os principais parâmetros operacionais são:

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `PENDING_REFERENCE_TTL_MS` | `30000` | Tempo máximo (em ms) que uma transação aguarda em `PENDING_REFERENCE` antes de expirar como `REJECTED` (`REFERENCE_NOT_FOUND`). |
| `OUTBOX_POLL_INTERVAL_MS` | Definido no `.env` | Intervalo (em ms) do ciclo periódico de publicação da Outbox e reprocessamento de referências pendentes. |

---

## Endpoints HTTP

| Método | Rota | Descrição |
| :--- | :--- | :--- |
| `POST` | `/wallets` | Cria carteira para `(playerId, currency)` com saldo inicial opcional (`201` / `409`) |
| `GET` | `/wallets/:walletId` | Consulta saldo atual e versão da carteira |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | Extrato imutável paginado por cursor opaco |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo armazenado com a soma histórica do ledger |
| `POST` | `/wagering/transactions` | Processa `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` (requer header `Idempotency-Key`) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta transação pelo ID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta transação pelo ID externo do provedor |
| `GET` | `/health/live` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe (valida conexão com PostgreSQL e SQS) |
| `GET` | `/metrics` | Contadores operacionais, latência de processamento e *lag* da Outbox |

### Mapeamento de Status HTTP

| Status HTTP | Categoria | Quando Ocorre | Ação Esperada do Provedor |
| :--- | :--- | :--- | :--- |
| **`200 OK`** | Sucesso / Replay | Consulta realizada, reconciliação concluída ou *replay* idêntico (`idempotentReplay: true`). | Usar a resposta retornada; não reenviar. |
| **`201 Created`** | Criação / Liquidação | Carteira criada (`POST /wallets`) ou transação liquidada (`PROCESSED`). | Registrar confirmação. |
| **`202 Accepted`** | Aceite Pendente | Transação referenciada chegou antes da original (`status: PENDING_REFERENCE`). | Aguardar processamento assíncrono ou consultar status depois. |
| **`400 Bad Request`** | Payload Inválido | JSON malformado, campo obrigatório ausente, header `Idempotency-Key` ausente, `Money` inválido ou cursor malformado. | Corrigir formato/contrato antes de reenviar. |
| **`404 Not Found`** | Recurso Inexistente | `walletId` ou `transactionId` não encontrado nas consultas ou reconciliação. | Verificar identificadores antes de nova chamada. |
| **`409 Conflict`** | Conflito de Estado / Idempotência | Carteira duplicada `(playerId, currency)` ou mesma `Idempotency-Key` / `(providerId, externalTransactionId)` com `payloadHash` divergente. | Não reenviar com a mesma chave; investigar divergência. |
| **`422 Unprocessable Entity`** | Rejeição por Regra de Negócio | Transação persistida como `REJECTED` com `failureCode` explícito (`INSUFFICIENT_FUNDS`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`, etc.). | Consultar o `failureCode` (Seção 5 do `ARCHITECTURE.md`) antes de agir. |
| **`503 Service Unavailable`** | Falha Transitória de Infraestrutura | Indisponibilidade temporária de banco/fila ou erro inesperado (`TRANSIENT_INFRASTRUCTURE_ERROR`). | Seguro reenviar com *backoff* mantendo a mesma `Idempotency-Key`. |

---

## Observabilidade e Shutdown

- **Logs JSON:** Cada evento registra `timestamp`, `level`, `event`, `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, sem expor payloads completos.
- **Métricas (`/metrics`):** Expõe transações por status, duplicatas detectadas, *retries*, mensagens enviadas para DLQ, divergências de reconciliação, atraso da Outbox (`outboxLagSeconds`) e latência média/máxima.
- **Graceful Shutdown:** `app.enableShutdownHooks()` intercepta `SIGTERM`/`SIGINT`, interrompe novas leituras do SQS, aguarda o processamento em andamento e encerra as conexões com o banco.