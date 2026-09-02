import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';

import { NowQueueService } from './now-queue.service';
import { WorkItemType, WorkPriority } from './models/work-item.model';
import { User } from '../users/schemas/user.schema';
import { Wallet } from '../wallets/schemas/wallet.schema';
import { WalletLedgerEntry } from '../wallets/schemas/wallet-ledger-entry.schema';
import { KycDocument } from '../kyc/schemas/kyc-document.schema';
import { OnlineOrder } from '../online-orders/schemas/online-order.schema';
import { SupportTicket } from '../support-tickets/schemas/support-ticket.schema';
import { TicketPriority } from '../support-tickets/schemas/support-ticket.schema';

/**
 * The point of this service is that "overdue" and "stuck" are decided HERE
 * rather than in React, so the tests are mostly about the arithmetic and about
 * which sources a role is allowed to look at.
 *
 * `now` is injected rather than read from the clock: a queue whose tests
 * depend on the hour they run is a queue that fails at midnight.
 */
const NOW = new Date('2026-08-26T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

type Chain = Record<string, jest.Mock>;

function chainModel(rows: unknown[] = [], aggregate: unknown[] = []): Chain {
  const chain: Chain = {};
  const self = () => chain;
  chain.find = jest.fn(self);
  chain.select = jest.fn(self);
  chain.sort = jest.fn(self);
  chain.limit = jest.fn(self);
  chain.exec = jest.fn().mockResolvedValue(rows);
  chain.aggregate = jest.fn(() => ({
    exec: jest.fn().mockResolvedValue(aggregate),
  }));
  return chain;
}

describe('NowQueueService', () => {
  let service: NowQueueService;
  let models: Record<string, Chain>;

  async function build(seed: {
    tickets?: unknown[];
    kyc?: unknown[];
    orders?: unknown[];
    wallets?: unknown[];
    ledger?: unknown[];
  }) {
    models = {
      user: chainModel([]),
      wallet: chainModel(seed.wallets ?? []),
      ledger: chainModel([], seed.ledger ?? []),
      kyc: chainModel(seed.kyc ?? []),
      order: chainModel(seed.orders ?? []),
      ticket: chainModel(seed.tickets ?? []),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NowQueueService,
        { provide: getModelToken(User.name), useValue: models.user },
        { provide: getModelToken(Wallet.name), useValue: models.wallet },
        {
          provide: getModelToken(WalletLedgerEntry.name),
          useValue: models.ledger,
        },
        { provide: getModelToken(KycDocument.name), useValue: models.kyc },
        { provide: getModelToken(OnlineOrder.name), useValue: models.order },
        { provide: getModelToken(SupportTicket.name), useValue: models.ticket },
      ],
    }).compile();

    service = moduleRef.get(NowQueueService);
  }

  it('[HP] calls an urgent ticket overdue after 30 minutes, not after 8 hours', async () => {
    // The per-priority target is the whole reason this is not sorted by age:
    // a 45-minute URGENT is late while a 6-hour NORMAL is not.
    await build({
      tickets: [
        {
          _id: 't1',
          subject: 'Payment missing',
          ticketNumber: 'TK-1',
          priority: TicketPriority.URGENT,
          createdAt: minutesAgo(45),
        },
        {
          _id: 't2',
          subject: 'General question',
          ticketNumber: 'TK-2',
          priority: TicketPriority.NORMAL,
          createdAt: minutesAgo(6 * 60),
        },
      ],
    });

    const { items } = await service.build('support', NOW);
    const urgent = items.find((i) => i.title.startsWith('TK-1'));
    const normal = items.find((i) => i.title.startsWith('TK-2'));

    expect(urgent?.type).toBe(WorkItemType.TICKET_OVERDUE);
    expect(urgent?.priority).toBe(WorkPriority.HIGH);
    expect(urgent?.overdueMinutes).toBe(15);

    expect(normal?.type).toBe(WorkItemType.TICKET_UNASSIGNED);
    expect(normal?.priority).toBe(WorkPriority.MEDIUM);
    expect(normal?.overdueMinutes).toBeLessThan(0);
  });

  it('[HP] sorts high priority first, then longest waiting', async () => {
    await build({
      tickets: [
        {
          _id: 't-short',
          subject: 'A',
          priority: TicketPriority.URGENT,
          createdAt: minutesAgo(40),
        },
        {
          _id: 't-long',
          subject: 'B',
          priority: TicketPriority.URGENT,
          createdAt: minutesAgo(300),
        },
      ],
    });

    const { items } = await service.build('admin', NOW);
    expect(items[0].title).toBe('B');
    expect(items[1].title).toBe('A');
  });

  it('[SEC] never shows support a wallet variance, and never queries wallets', async () => {
    await build({
      wallets: [{ branchId: 'b1', balanceCentavos: 5000 }],
      ledger: [{ _id: 'b1', total: 1000 }],
    });

    const support = await service.build('support', NOW);
    expect(support.items).toHaveLength(0);
    expect(support.searchedTypes).not.toContain(WorkItemType.WALLET_VARIANCE);
    expect(models.wallet.find).not.toHaveBeenCalled();

    const admin = await service.build('admin', NOW);
    expect(admin.items[0].type).toBe(WorkItemType.WALLET_VARIANCE);
    expect(admin.items[0].amountCentavos).toBe(4000);
    expect(admin.items[0].priority).toBe(WorkPriority.HIGH);
  });

  it('[SEC] gives a role outside the matrix nothing at all', async () => {
    await build({
      tickets: [
        {
          _id: 't',
          subject: 'x',
          priority: TicketPriority.URGENT,
          createdAt: minutesAgo(600),
        },
      ],
    });
    const { items, searchedTypes } = await service.build('merchant', NOW);
    expect(items).toEqual([]);
    expect(searchedTypes).toEqual([]);
    expect(models.ticket.find).not.toHaveBeenCalled();
  });

  it('[EC] reports a clean platform as clean, with the types it checked', async () => {
    await build({});
    const { items, searchedTypes, truncated } = await service.build(
      'admin',
      NOW,
    );
    expect(items).toEqual([]);
    expect(truncated).toBe(false);
    // The distinction that stops "nothing found" being read as "never looked".
    expect(searchedTypes).toContain(WorkItemType.WALLET_VARIANCE);
    expect(searchedTypes).toContain(WorkItemType.TICKET_OVERDUE);
  });

  it('[EC] survives one source failing rather than losing the whole page', async () => {
    await build({
      tickets: [
        {
          _id: 't1',
          subject: 'Still here',
          priority: TicketPriority.URGENT,
          createdAt: minutesAgo(120),
        },
      ],
    });
    models.order.exec.mockRejectedValue(new Error('orders unavailable'));

    const { items } = await service.build('admin', NOW);
    expect(items.some((i) => i.title === 'Still here')).toBe(true);
  });

  it('[HP] states the reason in words, not in status codes', async () => {
    // A row that needs you to know the state machine has not saved you the
    // lookup it exists to save.
    await build({
      tickets: [
        {
          _id: 't1',
          subject: 'x',
          priority: TicketPriority.URGENT,
          createdAt: minutesAgo(90),
        },
      ],
    });
    const { items } = await service.build('admin', NOW);
    expect(items[0].reason).toBe('First reply overdue by 1h');
    expect(items[0].reason).not.toMatch(/status|_/);
  });

  describe('maySee', () => {
    it('[SEC] pins the source matrix so a widening is deliberate', () => {
      expect(
        NowQueueService.maySee(WorkItemType.WALLET_VARIANCE, 'admin'),
      ).toBe(true);
      expect(
        NowQueueService.maySee(WorkItemType.WALLET_VARIANCE, 'support'),
      ).toBe(false);
      expect(
        NowQueueService.maySee(WorkItemType.TICKET_OVERDUE, 'support'),
      ).toBe(true);
      for (const role of [
        'customer',
        'merchant',
        'washer',
        'staff',
        'courier',
      ]) {
        expect(
          NowQueueService.maySee(WorkItemType.KYC_AWAITING_REVIEW, role),
        ).toBe(false);
      }
    });
  });
});
