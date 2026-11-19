import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { WalletUseCases } from '../../application/use-cases/wallet.use-cases';
import { MoneyProps } from '../../domain/value-objects/money';

interface CreateWalletBody {
  playerId: string;
  initialBalance: MoneyProps;
}

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletUseCases: WalletUseCases) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(
    @Body() body: CreateWalletBody,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.walletUseCases.createWallet({
      playerId: body?.playerId,
      initialBalance: body?.initialBalance,
      correlationId,
    });
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string) {
    return this.walletUseCases.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  async getWalletLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw !== undefined ? Number(limitRaw) : 50;
    return this.walletUseCases.getWalletLedger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.walletUseCases.reconcileWallet(walletId, correlationId);
  }
}