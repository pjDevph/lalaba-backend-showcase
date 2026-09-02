import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * SEC-014 — Xendit invoice callback body.
 *
 * This was a TypeScript `interface`, which is erased at compile time: Nest's
 * global ValidationPipe had no class metadata to work with, so NOTHING
 * validated the body and `@Body()` handed the raw JSON straight through. That
 * let non-string shapes reach the intent lookup — most importantly
 * `{"external_id": {"$ne": null}}`, a Mongo operator object that turns the
 * "find the intent named by the webhook" query into "find ANY intent",
 * pointing a credit at an arbitrary top-up.
 *
 * As a DTO class the pipe runs for real: `whitelist: true` strips unknown
 * keys, and each declared field must be the primitive type it claims to be, so
 * an operator object is rejected at the boundary with a 400 before any query
 * is built.
 *
 * Amounts arrive from Xendit in whole pesos; the controller converts to
 * integer centavos.
 * https://developers.xendit.co/api-reference/#invoice-callback
 */
export class XenditInvoiceCallbackDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  external_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  status?: string;

  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsNumber()
  paid_amount?: number;

  // Type-constrained but not value-constrained: a 400 here would make Xendit
  // retry the callback forever, so currency mismatches are handled downstream
  // against the stored intent rather than rejected at the boundary.
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;
}
