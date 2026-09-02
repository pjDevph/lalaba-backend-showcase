/**
 * BOOTSTRAP SMOKE — "does the application actually start?"
 *
 * Regression cover for defect #1 (fixed in f9615aa): a nullable `Date | null`
 * property carrying a bare `@Field()` made @nestjs/graphql unable to infer a
 * GraphQL type, so schema construction threw and the process died on startup.
 * `tsc --noEmit` was clean and all 318 unit specs passed, because none of them
 * ever builds the schema. This spec does, by compiling AppModule and calling
 * app.init().
 */
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { printSchema } from 'graphql';
import { createE2EApp, E2EContext } from './utils/e2e-app';

describe('Application bootstrap (e2e)', () => {
  let ctx: E2EContext;
  let sdl: string;

  beforeAll(async () => {
    ctx = await createE2EApp();
    sdl = printSchema(ctx.app.get(GraphQLSchemaHost).schema);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('compiles AppModule and initialises the Nest application', () => {
    // Reaching here at all is the assertion: a schema-construction failure or
    // an unresolved provider anywhere in the module graph throws in beforeAll.
    expect(ctx.app).toBeDefined();
    expect(ctx.app.getHttpServer()).toBeDefined();
  });

  it('connects to MongoDB during init (readyState === 1)', () => {
    expect(ctx.connection.readyState).toBe(1);
  });

  it('builds a non-empty GraphQL schema with Query and Mutation roots', () => {
    expect(sdl.length).toBeGreaterThan(0);
    expect(ctx.app.get(GraphQLSchemaHost).schema.getQueryType()).toBeTruthy();
    expect(
      ctx.app.get(GraphQLSchemaHost).schema.getMutationType(),
    ).toBeTruthy();
  });

  it.each([
    'healthCheck',
    'discoverProviders',
    'providerProfile',
    'walletSummary',
    'walletLedger',
    'topUpHistory',
  ])('exposes the %s query root field', (field) => {
    const queryFields = ctx.app
      .get(GraphQLSchemaHost)
      .schema.getQueryType()!
      .getFields();
    expect(Object.keys(queryFields)).toContain(field);
  });

  /**
   * Defect #1 in its most direct form: the KYC document-type status object
   * carries nullable Date fields. If any of them regresses to an inferred
   * type the whole schema fails to build (caught by beforeAll above); this
   * asserts the resolved SDL actually types them.
   */
  it('types every nullable Date field on KycDocumentTypeStatus', () => {
    const type = ctx.app
      .get(GraphQLSchemaHost)
      .schema.getType('KycDocumentTypeStatus');
    expect(type).toBeTruthy();
    const block = sdl.slice(
      sdl.indexOf('type KycDocumentTypeStatus'),
      sdl.indexOf('}', sdl.indexOf('type KycDocumentTypeStatus')),
    );
    expect(block).toMatch(/submittedAt:\s*DateTime/);
    expect(block).toMatch(/reviewedAt:\s*DateTime/);
  });

  // -------------------------------------------------------------------------
  // GAP-P0-028 — ON_DELIVERY / TO_PAY_ON_DELIVERY are removed from the contract
  // -------------------------------------------------------------------------
  // Deferred settlement was reinstated (§14, 2026-08-15), so the contract is
  // now exactly two timings. The legacy on_delivery STRING is still banned —
  // see the SDL assertion below — it is read-mapped and migrated, never served.
  it('PaymentTiming exposes exactly ON_PICKUP and AT_FINAL_HANDOVER', () => {
    const enumType = ctx.app
      .get(GraphQLSchemaHost)
      .schema.getType('PaymentTiming') as any;
    expect(enumType).toBeTruthy();
    // sortSchema: true alphabetizes the printed schema, so assert the SET.
    expect(
      enumType
        .getValues()
        .map((v: any) => v.name)
        .sort(),
    ).toEqual(['AT_FINAL_HANDOVER', 'ON_PICKUP']);
  });

  it('the printed schema contains no ON_DELIVERY / TO_PAY_ON_DELIVERY anywhere', () => {
    expect(sdl).not.toMatch(/ON_DELIVERY/);
    expect(sdl).not.toMatch(/TO_PAY_ON_DELIVERY/);
  });

  it('PaymentStatus has no pay-on-delivery member', () => {
    const enumType = ctx.app
      .get(GraphQLSchemaHost)
      .schema.getType('PaymentStatus') as any;
    expect(enumType).toBeTruthy();
    const names: string[] = enumType.getValues().map((v: any) => v.name);
    expect(names.some((n) => /DELIVERY/.test(n))).toBe(false);
  });
});
