/**
 * REST e2e THROUGH THE FULL APPLICATION.
 *
 * Regression cover for defects #2 and #3 (both fixed in 211fe3d):
 *   #2 GqlThrottlerGuard is registered as an APP_GUARD, so it runs on plain
 *      HTTP too. It used to unwrap every request as a GraphQL context, which
 *      yields undefined req/res, and the throttler then died on `res.header`.
 *      Result: GET / and POST /webhooks/xendit — the only path that can
 *      credit a wallet — were both dead.
 *   #3 GlobalExceptionFilter is a GqlExceptionFilter: returning the exception
 *      hands control back to Apollo, but on a REST route nobody then writes a
 *      response, so a rejected webhook HUNG instead of answering 401. Xendit
 *      retries a request the server already denied.
 *
 * Every request below goes through supertest against the real HTTP server with
 * the global guard, filter, interceptor and ValidationPipe active — which is
 * precisely what the 318 unit specs bypass.
 */
import request from 'supertest';
import { createE2EApp, E2EContext } from './utils/e2e-app';

const WEBHOOK_PATH = '/webhooks/xendit';
// Must match test/setup-e2e.ts.
const VALID_TOKEN = 'e2e-callback-token';

describe('REST surface (e2e, full app)', () => {
  let ctx: E2EContext;
  let server: any;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // -------------------------------------------------------------------------
  // Defect #2 — REST routes must survive the global throttler guard
  // -------------------------------------------------------------------------
  describe('health / liveness', () => {
    it('GET / returns 200 with the liveness body', async () => {
      const res = await request(server).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toBe('Hello World!');
    });

    it('GET / stays 200 across repeated calls (throttler counts without crashing)', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await request(server).get('/');
        expect(res.status).toBe(200);
      }
    });

    it('GET / sets the throttler rate-limit headers, proving the guard ran on the REST path', async () => {
      const res = await request(server).get('/');
      // If the guard had short-circuited or thrown, these would be absent.
      const headerNames = Object.keys(res.headers).map((h) => h.toLowerCase());
      expect(
        headerNames.some(
          (h) => h.startsWith('x-ratelimit') || h === 'ratelimit',
        ),
      ).toBe(true);
    });

    it('an unknown REST route returns a well-formed 404 JSON body, not a hang', async () => {
      const res = await request(server).get('/definitely-not-a-route');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404 });
    });
  });

  // -------------------------------------------------------------------------
  // Defects #2 + #3 — the Xendit webhook must answer, and answer 401
  // -------------------------------------------------------------------------
  describe('POST /webhooks/xendit — callback token verification', () => {
    const paidBody = {
      id: 'inv_e2e_1',
      external_id: 'some-intent-id',
      status: 'PAID',
      amount: 1000,
      currency: 'PHP',
    };

    it('rejects a request with NO x-callback-token: 401 (never a hang, never a 500)', async () => {
      const res = await request(server).post(WEBHOOK_PATH).send(paidBody);
      expect(res.status).toBe(401);
    });

    it('the no-token rejection body is well-formed JSON, not an empty/HTML response', async () => {
      const res = await request(server).post(WEBHOOK_PATH).send(paidBody);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({
        statusCode: 401,
        message: 'Invalid callback token',
        error: 'Unauthorized',
      });
    });

    it('rejects a WRONG x-callback-token with the same 401 body', async () => {
      const res = await request(server)
        .post(WEBHOOK_PATH)
        .set('x-callback-token', 'totally-wrong-token')
        .send(paidBody);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        statusCode: 401,
        message: 'Invalid callback token',
        error: 'Unauthorized',
      });
    });

    it('rejects a token that is a prefix of the real one (timing-safe compare is length-independent)', async () => {
      const res = await request(server)
        .post(WEBHOOK_PATH)
        .set('x-callback-token', VALID_TOKEN.slice(0, 5))
        .send(paidBody);
      expect(res.status).toBe(401);
    });

    it('answers a rejected webhook well inside Xendit retry territory (no hang)', async () => {
      const started = Date.now();
      const res = await request(server)
        .post(WEBHOOK_PATH)
        .set('x-callback-token', 'wrong')
        .send(paidBody);
      const elapsedMs = Date.now() - started;
      expect(res.status).toBe(401);
      // The pre-fix behaviour never wrote a response at all; this bounds it.
      expect(elapsedMs).toBeLessThan(5000);
    });
  });

  // -------------------------------------------------------------------------
  // Authenticated webhook: payload validation still answers properly
  // -------------------------------------------------------------------------
  describe('POST /webhooks/xendit — authenticated payload handling', () => {
    const authed = () =>
      request(server).post(WEBHOOK_PATH).set('x-callback-token', VALID_TOKEN);

    it('400s a payload with no external_id, with a JSON body', async () => {
      const res = await authed().send({ status: 'PAID', amount: 100 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        message: 'Malformed webhook payload',
      });
    });

    it('400s a PAID payload with no usable amount', async () => {
      const res = await authed().send({
        external_id: 'no-amount-intent',
        status: 'PAID',
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        message: 'Webhook payload has no valid amount',
      });
    });

    it('200-acknowledges an unhandled status without crediting anything', async () => {
      const res = await authed().send({
        external_id: 'some-intent-id',
        status: 'PENDING',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('404s a PAID callback for an intent that does not exist (unknown reference never credits)', async () => {
      const res = await authed().send({
        id: 'inv_missing',
        external_id: '000000000000000000000000',
        status: 'PAID',
        amount: 500,
        currency: 'PHP',
      });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404 });
    });
  });
});
