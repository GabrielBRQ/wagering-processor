import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import {
  IdempotencyConflictError,
  NotFoundApplicationError,
  ValidationApplicationError,
  WalletConflictError,
} from '../../application/errors/application.errors';
import { DomainError } from '../../domain/errors/domain.errors';

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof ValidationApplicationError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof NotFoundApplicationError) {
      response.status(HttpStatus.NOT_FOUND).json({
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof WalletConflictError || exception instanceof IdempotencyConflictError) {
      response.status(HttpStatus.CONFLICT).json({
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof DomainError) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof BadRequestException) {
      response.status(HttpStatus.BAD_REQUEST).json({
        code: 'INVALID_PAYLOAD',
        message: exception.message,
      });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        code: 'HTTP_ERROR',
        message: exception.message,
      });
      return;
    }

    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      code: 'TRANSIENT_INFRASTRUCTURE_ERROR',
      message: 'Temporary infrastructure failure; safe to retry with the same Idempotency-Key',
    });
  }
}