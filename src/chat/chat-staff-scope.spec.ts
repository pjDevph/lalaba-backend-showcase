import { ChatService } from './chat.service';

// Staff answer a customer AS THE BRANCH. That means two things must hold, and
// neither is obvious from reading the query:
//
//   1. A staff member's own uid owns no conversations. Resolving by it would
//      hand them an empty inbox and, worse, would fragment the customer's
//      thread into one per employee on shift.
//   2. Speaking for the business must not mean speaking for ALL of it. A staff
//      member assigned to Makati must not read BGC's conversations.

const OWNER = 'merchant-uid-1';
const MAKATI = 'branch-makati';
const BGC = 'branch-bgc';

/** Captures the filter myConversations builds, which is the whole contract. */
const makeService = () => {
  const captured: Record<string, unknown>[] = [];
  const conversationModel = {
    find: (filter: Record<string, unknown>) => {
      captured.push(filter);
      return { sort: () => ({ exec: async () => [] }) };
    },
  };
  const svc = new ChatService(
    conversationModel as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, captured };
};

const staff = (branchIds: string[]) =>
  ({
    _id: 'staff-uid-1',
    merchantId: OWNER,
    branchIds,
    role: { roleId: 'staff' },
  }) as never;

const merchant = () => ({ _id: OWNER, role: { roleId: 'merchant' } }) as never;

const customer = () =>
  ({ _id: 'customer-uid-1', role: { roleId: 'customer' } }) as never;

describe('chat scoping — staff speak for the branch', () => {
  it('[HP] a staff member resolves through their employer, not their own uid', async () => {
    const { svc, captured } = makeService();
    await svc.myConversations(staff([MAKATI]), MAKATI);
    expect(captured[0].providerUid).toBe(OWNER);
    expect(captured[0].providerUid).not.toBe('staff-uid-1');
  });

  it('[SEC] and only for the branch they are working', async () => {
    const { svc, captured } = makeService();
    await svc.myConversations(staff([MAKATI, BGC]), MAKATI);
    expect(captured[0].branchId).toEqual({ $in: [MAKATI] });
  });

  it('[SEC] an active branch outside their assignment yields nothing', async () => {
    // A device still pinned to a branch the owner has since un-assigned.
    const { svc, captured } = makeService();
    await svc.myConversations(staff([MAKATI]), BGC);
    expect(captured[0].branchId).toEqual({ $in: [] });
  });

  it('[SEC] no active branch yields nothing, not everything', async () => {
    const { svc, captured } = makeService();
    await svc.myConversations(staff([MAKATI]), null);
    expect(captured[0].branchId).toEqual({ $in: [] });
  });

  it('[HP] the owner is unrestricted across their own branches', async () => {
    const { svc, captured } = makeService();
    await svc.myConversations(merchant(), null);
    expect(captured[0].providerUid).toBe(OWNER);
    expect(captured[0].branchId).toBeUndefined();
  });

  it('[HP] a customer still resolves by their own uid', async () => {
    const { svc, captured } = makeService();
    await svc.myConversations(customer(), null);
    expect(captured[0].customerUid).toBe('customer-uid-1');
    expect(captured[0].providerUid).toBeUndefined();
  });
});
