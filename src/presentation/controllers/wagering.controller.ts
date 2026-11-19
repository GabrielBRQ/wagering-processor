import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ValidationApplicationError } from '../../application/errors/application.errors';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.entity';
import { MoneyProps } from '../../domain/value-objects/money';

interface SubmitTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

@Controller()
export class WageringController {
  constructor(private readonly processWagerUseCase: ProcessWagerTransactionUseCase) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: SubmitTransactionBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new ValidationApplicationError('Header "Idempotency-Key" is required');
    }

    const result = await this.processWagerUseCase.execute({
      providerId: body?.providerId,
      externalTransactionId: body?.externalTransactionId,
      idempotencyKey: idempotencyKey.trim(),
      playerId: body?.playerId,
      walletId: body?.walletId,
      roundId: body?.roundId,
      gameId: body?.gameId,
      kind: body?.kind,
      money: body?.money,
      referenceExternalTransactionId: body?.referenceExternalTransactionId,
      correlationId,
    });

    if (result.status === WagerTransactionStatus.PendingReference) {
      res.status(HttpStatus.ACCEPTED);
    } else if (result.status === WagerTransactionStatus.Rejected) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else {
      res.status(HttpStatus.OK);
    }

    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async getTransactionById(@Param('transactionId') transactionId: string) {
    return this.processWagerUseCase.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.processWagerUseCase.getByProviderAndExternalId(providerId, externalTransactionId);
  }
}