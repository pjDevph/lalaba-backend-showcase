// product.schema imports InventoryUnit (an enum) as a @Prop type; NestJS/reflect-metadata
// cannot infer enum types at runtime and throws on module load. Mock the schema so the
// decorator never runs — we only need Product.name for getModelToken() anyway.
jest.mock('../products/schemas/product.schema', () => ({
  Product: class Product {},
  ProductSchema: {},
  ProductCategory: {
    powdered_detergent: 'powdered_detergent',
    fabric_conditioner: 'fabric_conditioner',
    bleach: 'bleach',
    softener: 'softener',
    other: 'other',
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { User } from '../users/schemas/user.schema';
import { PaymentMethod } from '../pos_transactions/schemas/pos-transaction.schema';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PosOrdersService } from './pos-orders.service';
import { PosOrder } from './schemas/pos-order.schema';
import { PosTransaction } from '../pos_transactions/schemas/pos-transaction.schema';
import { Service } from '../services/schemas/service.schema';
import { Product } from '../products/schemas/product.schema';
import { Inventory } from '../inventory/schemas/inventory.schema';
import { InventoryTransaction } from '../inventory/schemas/inventory-transaction.schema';
import { Branch } from '../branches/schemas/branch.schema';
import { Permission } from '../permissions/schemas/permission.schema';
import {
  PaymentStatus,
  LaundryStatus,
  DiscountType,
  OrderItemType,
} from './schemas/pos-order.schema';
import { TransactionStatus } from '../pos_transactions/schemas/pos-transaction.schema';
import { PricingType } from '../services/schemas/service.schema';

// ─── Mock factory ────────────────────────────────────────────────────────────

function makeModel(overrides: Record<string, any> = {}) {
  const self: any = {
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn().mockReturnThis(),
    findById: jest.fn().mockReturnThis(),
    findByIdAndUpdate: jest.fn().mockReturnThis(),
    findOneAndUpdate: jest.fn().mockReturnThis(),
    findByIdAndDelete: jest.fn().mockReturnThis(),
    session: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(null),
    countDocuments: jest.fn().mockReturnThis(),
    create: jest.fn().mockResolvedValue({}),
    save: jest
      .fn()
      .mockResolvedValue({ _id: 'order-id-1', claimCode: 'ABC123' }),
    ...overrides,
  };

  // Constructor mock — so `new this.orderModel({...})` returns an object with save()
  const ctor: any = jest.fn().mockImplementation(() => ({ ...self }));
  Object.assign(ctor, self);
  return ctor;
}

// Mongoose connection mock — `withTransaction` just invokes the callback so the
// service's transactional code paths run without a real replica-set session.
function makeConnection() {
  return {
    startSession: jest.fn().mockResolvedValue({
      withTransaction: jest.fn(async (fn: () => Promise<any>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

// NOTE: `User.role` is declared `role!: string` on the schema but is a POPULATED
// Role document at runtime — pos-orders.service.ts concedes this itself with
// `user.role as unknown as Role` in getRole(). These fixtures model reality, so
// one documented cast lives here at the factory seam. Fixing it properly means
// correcting the schema type, which ripples well beyond a spec file.
function makeMerchantUser(overrides: Partial<User> = {}): User {
  return {
    _id: 'merchant-uid-1',
    email: 'merchant@test.com',
    firstName: 'Test',
    lastName: 'Merchant',
    phoneNumber: '09171234567',
    isActive: true,
    role: {
      _id: 'role-1',
      roleId: 'merchant',
      roleName: 'Merchant',
      description: 'Merchant role',
    },
    ...overrides,
  } as unknown as User;
}

function makeStaffUser(overrides: Partial<User> = {}): User {
  return {
    _id: 'staff-uid-1',
    email: 'staff@test.com',
    firstName: 'Test',
    lastName: 'Staff',
    phoneNumber: '09179876543',
    isActive: true,
    merchantId: 'merchant-uid-1',
    branchIds: ['branch-id-1'],
    role: {
      _id: 'role-2',
      roleId: 'staff',
      roleName: 'Staff',
      description: 'Staff role',
    },
    ...overrides,
  } as unknown as User;
}

function makeBranch(overrides: Partial<any> = {}): any {
  return {
    _id: 'branch-id-1',
    uid: 'merchant-uid-1',
    branchName: 'Main Branch',
    isActive: true,
    isOnline: true,
    branchPhoneNumber: '09171111111',
    branchAddress: {
      regionName: 'NCR',
      cityMunicipalityName: 'Makati',
      streetAddress: '123 Test St',
    },
    ...overrides,
  };
}

function makeService(overrides: Partial<any> = {}): any {
  return {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    uid: 'merchant-uid-1',
    serviceName: 'Wash & Fold',
    serviceCode: 'WF01',
    price: 80,
    pricingType: PricingType.PER_KILO,
    defaultProducts: [],
    isActive: true,
    isArchived: false,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<any> = {}): any {
  return {
    _id: 'product-id-1',
    inventoryId: 'inv-id-1',
    productName: 'Detergent Sachet',
    price: 15,
    quantity: 1,
    isActive: true,
    isArchived: false,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<any> = {}): any {
  return {
    _id: 'order-id-1',
    uid: 'merchant-uid-1',
    branchId: 'branch-id-1',
    claimCode: 'ABC123',
    customerName: 'Juan Dela Cruz',
    items: [],
    subtotal: 100,
    discount: 0,
    totalAmount: 100,
    paymentStatus: PaymentStatus.UNPAID,
    laundryStatus: LaundryStatus.PENDING,
    createdBy: 'merchant-uid-1',
    createdByType: 'merchant',
    save: jest
      .fn()
      .mockResolvedValue({ _id: 'order-id-1', claimCode: 'ABC123' }),
    ...overrides,
  };
}

function makeServiceOrderInput(overrides: Partial<any> = {}): any {
  return {
    branchId: 'branch-id-1',
    customerName: 'Juan Dela Cruz',
    items: [
      {
        type: OrderItemType.service,
        serviceId: 'aaaaaaaaaaaaaaaaaaaaaaaa', // must be valid 24-char hex for new Types.ObjectId()
        quantity: 3,
      },
    ],
    ...overrides,
  };
}

// ─── Test suite ────────────────────────────────────────────────────────────────

describe('PosOrdersService', () => {
  let service: PosOrdersService;
  let orderModel: ReturnType<typeof makeModel>;
  let txModel: ReturnType<typeof makeModel>;
  let serviceModel: ReturnType<typeof makeModel>;
  let productModel: ReturnType<typeof makeModel>;
  let inventoryModel: ReturnType<typeof makeModel>;
  let invTxModel: ReturnType<typeof makeModel>;
  let branchModel: ReturnType<typeof makeModel>;
  let permissionModel: ReturnType<typeof makeModel>;
  let connection: ReturnType<typeof makeConnection>;

  beforeEach(async () => {
    orderModel = makeModel();
    txModel = makeModel();
    serviceModel = makeModel();
    productModel = makeModel();
    inventoryModel = makeModel();
    invTxModel = makeModel();
    branchModel = makeModel();
    permissionModel = makeModel();
    connection = makeConnection();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PosOrdersService,
        { provide: getModelToken(PosOrder.name), useValue: orderModel },
        { provide: getModelToken(PosTransaction.name), useValue: txModel },
        { provide: getModelToken(Service.name), useValue: serviceModel },
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Inventory.name), useValue: inventoryModel },
        {
          provide: getModelToken(InventoryTransaction.name),
          useValue: invTxModel,
        },
        { provide: getModelToken(Branch.name), useValue: branchModel },
        { provide: getModelToken(Permission.name), useValue: permissionModel },
        { provide: getConnectionToken(), useValue: connection },
      ],
    }).compile();

    service = module.get<PosOrdersService>(PosOrdersService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // calculateDiscount (tested via the private method indirectly — we expose
  // coverage through create(), but direct access via bracket notation is fine
  // in tests since the method is private-by-declaration only in TS)
  // ──────────────────────────────────────────────────────────────────────────

  describe('calculateDiscount (HP/EC — private method via cast)', () => {
    const calc = (subtotal: number, type?: DiscountType, value?: number) =>
      (service as any).calculateDiscount(subtotal, type, value);

    it('[HP] returns 0 when no discountType provided', () => {
      expect(calc(200)).toBe(0);
    });

    it('[HP] flat discount subtracts exact value when value < subtotal', () => {
      expect(calc(200, DiscountType.flat, 50)).toBe(50);
    });

    it('[EC] flat discount is capped at subtotal when value > subtotal', () => {
      expect(calc(30, DiscountType.flat, 100)).toBe(30);
    });

    it('[HP] percentage discount calculates correctly', () => {
      // 20% of 200 = 40
      expect(calc(200, DiscountType.percentage, 20)).toBe(40);
    });

    it('[EC] percentage > 100 is capped to 100% (cannot exceed subtotal)', () => {
      // 150% should be treated as 100% → discount === subtotal
      expect(calc(200, DiscountType.percentage, 150)).toBe(200);
    });

    it('[EC] zero discountValue returns 0', () => {
      expect(calc(200, DiscountType.flat, 0)).toBe(0);
    });

    it('[EC] discountValue of null returns 0', () => {
      // passing undefined for value
      expect(calc(200, DiscountType.percentage, undefined)).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // create()
  // ──────────────────────────────────────────────────────────────────────────

  describe('create()', () => {
    const merchantUser = makeMerchantUser();
    const branch = makeBranch();
    const svc = makeService();

    beforeEach(() => {
      // Default happy-path setup: branch found, service found, claim code unique
      branchModel.exec.mockResolvedValue(branch);
      serviceModel.exec.mockResolvedValue(svc);
      // First exec call for getUniqueClaimCode → null (code is unique)
      orderModel.exec.mockResolvedValue(null);
      inventoryModel.exec.mockResolvedValue(null);
      invTxModel.create.mockResolvedValue({});
    });

    it('[HP] idempotencyKey returns existing order without creating a new one', async () => {
      const existingOrder = makeOrder({ idempotencyKey: 'key-abc' });
      // The first findOne() call (idempotency check) returns an existing order
      orderModel.exec.mockResolvedValue(existingOrder);

      const input = makeServiceOrderInput({ idempotencyKey: 'key-abc' });
      const result = await service.create(input, merchantUser);

      expect(result).toEqual(existingOrder);
      // orderModel constructor should NOT have been called
      expect(orderModel).not.toHaveBeenCalledWith(
        expect.objectContaining({ claimCode: expect.anything() }),
      );
    });

    it('[EC] throws BadRequestException when branch is not found', async () => {
      // Idempotency check returns null, branch lookup returns null
      orderModel.exec.mockResolvedValue(null);
      branchModel.exec.mockResolvedValue(null);

      const input = makeServiceOrderInput();
      await expect(service.create(input, merchantUser)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(input, merchantUser)).rejects.toThrow(
        'Branch not found or does not belong to you',
      );
    });

    it('[EC] throws BadRequestException when branch belongs to a different merchant', async () => {
      orderModel.exec.mockResolvedValue(null);
      branchModel.exec.mockResolvedValue(
        makeBranch({ uid: 'other-merchant-uid' }),
      );

      const input = makeServiceOrderInput();
      await expect(service.create(input, merchantUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('[EC] throws BadRequestException when branch is inactive', async () => {
      orderModel.exec.mockResolvedValue(null);
      branchModel.exec.mockResolvedValue(makeBranch({ isActive: false }));

      const input = makeServiceOrderInput();
      await expect(service.create(input, merchantUser)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(input, merchantUser)).rejects.toThrow(
        'Branch is inactive',
      );
    });

    it('[EC] throws BadRequestException when staff is not assigned to the branch', async () => {
      const staffUser = makeStaffUser({ branchIds: ['different-branch-id'] });
      orderModel.exec.mockResolvedValue(null);
      branchModel.exec.mockResolvedValue(branch);

      const input = makeServiceOrderInput();
      await expect(service.create(input, staffUser)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(input, staffUser)).rejects.toThrow(
        'You are not assigned to this branch',
      );
    });

    it('[HP] staff assigned to branch can create an order', async () => {
      const staffUser = makeStaffUser({ branchIds: ['branch-id-1'] });
      const savedOrder = makeOrder();

      // exec sequence: [idempotency null] → [claim code null (unique)] → [service lookup]
      orderModel.exec
        .mockResolvedValueOnce(null) // idempotency check
        .mockResolvedValueOnce(null); // getUniqueClaimCode check

      branchModel.exec.mockResolvedValue(branch);
      serviceModel.exec.mockResolvedValue(svc);

      const instanceSave = jest.fn().mockResolvedValue(savedOrder);
      orderModel.mockImplementationOnce(() => ({ save: instanceSave }));

      const input = makeServiceOrderInput();
      const result = await service.create(input, staffUser);

      expect(instanceSave).toHaveBeenCalled();
      expect(result).toEqual(savedOrder);
    });

    it('[HP] creates order with correct totalAmount after flat discount', async () => {
      const savedOrder = makeOrder({
        subtotal: 240,
        discount: 50,
        totalAmount: 190,
      });

      orderModel.exec
        .mockResolvedValueOnce(null) // idempotency
        .mockResolvedValueOnce(null); // claim code uniqueness

      branchModel.exec.mockResolvedValue(branch);
      // PER_KILO: 3 kg × 80 = 240
      serviceModel.exec.mockResolvedValue(svc);

      const instanceSave = jest.fn().mockResolvedValue(savedOrder);
      orderModel.mockImplementationOnce(() => ({ save: instanceSave }));

      const input = makeServiceOrderInput({
        discountType: DiscountType.flat,
        discountValue: 50,
      });
      await service.create(input, merchantUser);

      // Verify the constructor was called with correct discount figures
      expect(orderModel).toHaveBeenCalledWith(
        expect.objectContaining({ discount: 50, totalAmount: 190 }),
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // processPayment()
  // ──────────────────────────────────────────────────────────────────────────

  describe('processPayment()', () => {
    const merchantUser = makeMerchantUser();
    const order = makeOrder({ totalAmount: 100 });

    it('[EC] throws BadRequestException when order is already PAID', async () => {
      const paidOrder = makeOrder({ paymentStatus: PaymentStatus.PAID });
      // Two invocations each need: [atomic lock null] + [fallback findOne → paidOrder]
      orderModel.exec
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(paidOrder) // call 1
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(paidOrder); // call 2

      await expect(
        service.processPayment(
          'order-id-1',
          'merchant-uid-1',
          { paymentMethod: PaymentMethod.cash, amountPaid: 100 },
          merchantUser,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.processPayment(
          'order-id-1',
          'merchant-uid-1',
          { paymentMethod: PaymentMethod.cash, amountPaid: 100 },
          merchantUser,
        ),
      ).rejects.toThrow('Order is already paid');
    });

    it('[EC] throws NotFoundException when order does not exist', async () => {
      orderModel.exec
        .mockResolvedValueOnce(null) // atomic lock fails
        .mockResolvedValueOnce(null); // findOne returns null too

      await expect(
        service.processPayment(
          'bad-id',
          'merchant-uid-1',
          { paymentMethod: PaymentMethod.cash, amountPaid: 100 },
          merchantUser,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('[EC] throws BadRequestException when non-cash payment has no referenceId', async () => {
      // Atomic lock succeeds (returns pre-update doc)
      orderModel.exec
        .mockResolvedValueOnce(order) // atomic lock success
        .mockResolvedValueOnce(null) // rollback exec
        .mockResolvedValueOnce(
          makeOrder({ paymentStatus: PaymentStatus.PAID }),
        ); // final findOne after rollback

      await expect(
        service.processPayment(
          'order-id-1',
          'merchant-uid-1',
          { paymentMethod: PaymentMethod.gcash, amountPaid: 100 },
          merchantUser,
        ),
      ).rejects.toThrow(BadRequestException);
      // Reset and retry to confirm message
      orderModel.exec.mockResolvedValueOnce(order).mockResolvedValueOnce(null);
      await expect(
        service.processPayment(
          'order-id-1',
          'merchant-uid-1',
          { paymentMethod: PaymentMethod.gcash, amountPaid: 100 },
          merchantUser,
        ),
      ).rejects.toThrow(
        'A reference number is required for non-cash payments.',
      );
    });

    it('[EC] throws BadRequestException when amountPaid < totalAmount', async () => {
      orderModel.exec
        .mockResolvedValueOnce(order) // atomic lock success
        .mockResolvedValueOnce(null); // rollback exec

      await expect(
        service.processPayment(
          'order-id-1',
          'merchant-uid-1',
          { paymentMethod: PaymentMethod.cash, amountPaid: 50 },
          merchantUser,
        ),
      ).rejects.toThrow(BadRequestException);
      // Re-run to check message
      orderModel.exec.mockResolvedValueOnce(order).mockResolvedValueOnce(null);
      await expect(
        service.processPayment(
          'order-id-1',
          'merchant-uid-1',
          { paymentMethod: PaymentMethod.cash, amountPaid: 50 },
          merchantUser,
        ),
      ).rejects.toThrow('Amount paid is less than total amount');
    });

    it('[HP] success: creates a COMPLETED transaction and returns updated order', async () => {
      const updatedOrder = makeOrder({ paymentStatus: PaymentStatus.PAID });

      orderModel.exec
        .mockResolvedValueOnce(order) // atomic lock — returns pre-update doc
        .mockResolvedValueOnce(updatedOrder); // final findOne

      const result = await service.processPayment(
        'order-id-1',
        'merchant-uid-1',
        { paymentMethod: PaymentMethod.cash, amountPaid: 120 },
        merchantUser,
      );

      expect(txModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'order-id-1',
          paymentMethod: 'cash',
          amountPaid: 120,
          change: 20,
          status: TransactionStatus.COMPLETED,
        }),
      );
      expect(result).toEqual(updatedOrder);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // cancelOrder()
  // ──────────────────────────────────────────────────────────────────────────

  describe('cancelOrder()', () => {
    const merchantUser = makeMerchantUser();

    it('[EC] throws BadRequestException when order is COMPLETED', async () => {
      const completedOrder = makeOrder({
        laundryStatus: LaundryStatus.COMPLETED,
      });
      orderModel.exec.mockResolvedValue(completedOrder);

      await expect(
        service.cancelOrder('order-id-1', 'merchant-uid-1', merchantUser),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.cancelOrder('order-id-1', 'merchant-uid-1', merchantUser),
      ).rejects.toThrow('Only pending or in-progress orders can be cancelled');
    });

    it('[EC] throws BadRequestException when order is PAID (should use voidOrder)', async () => {
      const paidOrder = makeOrder({
        laundryStatus: LaundryStatus.PENDING,
        paymentStatus: PaymentStatus.PAID,
      });
      orderModel.exec.mockResolvedValue(paidOrder);

      await expect(
        service.cancelOrder('order-id-1', 'merchant-uid-1', merchantUser),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.cancelOrder('order-id-1', 'merchant-uid-1', merchantUser),
      ).rejects.toThrow('Order is already paid. Use voidOrder instead');
    });

    it('[HP] PENDING order is cancelled and inventory is returned', async () => {
      const pendingOrder = makeOrder({
        laundryStatus: LaundryStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        items: [], // empty items → returnInventory is a no-op
      });
      const cancelledOrder = makeOrder({
        laundryStatus: LaundryStatus.CANCELLED,
      });

      orderModel.exec
        .mockResolvedValueOnce(pendingOrder) // findById
        .mockResolvedValueOnce(cancelledOrder); // findOneAndUpdate

      const result = await service.cancelOrder(
        'order-id-1',
        'merchant-uid-1',
        merchantUser,
        'Test cancel',
      );

      expect(orderModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'order-id-1', uid: 'merchant-uid-1' }),
        expect.objectContaining({
          $set: expect.objectContaining({
            laundryStatus: LaundryStatus.CANCELLED,
          }),
        }),
        expect.objectContaining({ new: true }),
      );
      expect(result).toEqual(cancelledOrder);
    });

    it('[HP] IN_PROGRESS order can also be cancelled', async () => {
      const inProgressOrder = makeOrder({
        laundryStatus: LaundryStatus.IN_PROGRESS,
        paymentStatus: PaymentStatus.UNPAID,
        items: [],
      });
      const cancelledOrder = makeOrder({
        laundryStatus: LaundryStatus.CANCELLED,
      });

      orderModel.exec
        .mockResolvedValueOnce(inProgressOrder)
        .mockResolvedValueOnce(cancelledOrder);

      const result = await service.cancelOrder(
        'order-id-1',
        'merchant-uid-1',
        merchantUser,
      );
      expect(result).toEqual(cancelledOrder);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // voidOrder()
  // ──────────────────────────────────────────────────────────────────────────

  describe('voidOrder()', () => {
    const merchantUser = makeMerchantUser();

    it('[EC] throws BadRequestException when order is already VOID', async () => {
      const voidOrder = makeOrder({ laundryStatus: LaundryStatus.VOID });
      orderModel.exec.mockResolvedValue(voidOrder);

      await expect(
        service.voidOrder('order-id-1', 'merchant-uid-1', merchantUser),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.voidOrder('order-id-1', 'merchant-uid-1', merchantUser),
      ).rejects.toThrow('Order is already voided');
    });

    it('[EC] throws BadRequestException when order is CANCELLED', async () => {
      const cancelledOrder = makeOrder({
        laundryStatus: LaundryStatus.CANCELLED,
      });
      orderModel.exec.mockResolvedValue(cancelledOrder);

      await expect(
        service.voidOrder('order-id-1', 'merchant-uid-1', merchantUser),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.voidOrder('order-id-1', 'merchant-uid-1', merchantUser),
      ).rejects.toThrow('Cannot void a cancelled order');
    });

    it('[HP] PAID order creates a REFUNDED transaction and sets paymentStatus to REFUNDED', async () => {
      const paidOrder = makeOrder({
        laundryStatus: LaundryStatus.READY,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 200,
        items: [],
      });
      const originalTx = {
        paymentMethod: 'cash',
        status: TransactionStatus.COMPLETED,
      };
      const voidedOrder = makeOrder({
        laundryStatus: LaundryStatus.VOID,
        paymentStatus: PaymentStatus.REFUNDED,
      });

      orderModel.exec
        .mockResolvedValueOnce(paidOrder) // findById
        .mockResolvedValueOnce(voidedOrder); // findOneAndUpdate

      txModel.exec.mockResolvedValue(originalTx); // txModel.findOne for original tx

      const result = await service.voidOrder(
        'order-id-1',
        'merchant-uid-1',
        merchantUser,
        'Customer request',
      );

      expect(txModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            orderId: 'order-id-1',
            paymentMethod: 'cash',
            totalAmount: 200,
            amountPaid: 200,
            change: 0,
            status: TransactionStatus.REFUNDED,
          }),
        ],
        expect.objectContaining({ session: expect.anything() }),
      );
      expect(result).toEqual(voidedOrder);
    });

    // REGRESSION: this path used to write the literal 'unknown' into
    // PosTransaction.paymentMethod, which is `enum: PaymentMethod` — Mongoose
    // rejected the document and, inside withTransaction, aborted the entire
    // refund. A walk-in customer could be denied their money back because a
    // historical transaction record was missing. paymentMethod is now nullable
    // for exactly this case.
    it('[EDGE] PAID order with NO original transaction still refunds, with a null paymentMethod', async () => {
      const paidOrder = makeOrder({
        laundryStatus: LaundryStatus.READY,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 200,
        items: [],
      });
      const voidedOrder = makeOrder({
        laundryStatus: LaundryStatus.VOID,
        paymentStatus: PaymentStatus.REFUNDED,
      });

      orderModel.exec
        .mockResolvedValueOnce(paidOrder)
        .mockResolvedValueOnce(voidedOrder);

      // No COMPLETED transaction exists for this order.
      txModel.exec.mockResolvedValue(null);

      const result = await service.voidOrder(
        'order-id-1',
        'merchant-uid-1',
        merchantUser,
        'Customer request',
      );

      expect(txModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            orderId: 'order-id-1',
            paymentMethod: null,
            totalAmount: 200,
            status: TransactionStatus.REFUNDED,
          }),
        ],
        expect.objectContaining({ session: expect.anything() }),
      );
      expect(result).toEqual(voidedOrder);
    });

    it('[HP] UNPAID order is voided without creating a refund transaction', async () => {
      const unpaidOrder = makeOrder({
        laundryStatus: LaundryStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        items: [],
      });
      const voidedOrder = makeOrder({
        laundryStatus: LaundryStatus.VOID,
        paymentStatus: PaymentStatus.UNPAID,
      });

      orderModel.exec
        .mockResolvedValueOnce(unpaidOrder) // findById
        .mockResolvedValueOnce(voidedOrder); // findOneAndUpdate

      const result = await service.voidOrder(
        'order-id-1',
        'merchant-uid-1',
        merchantUser,
      );

      expect(txModel.create).not.toHaveBeenCalled();
      expect(result).toEqual(voidedOrder);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // markInProgress()
  // ──────────────────────────────────────────────────────────────────────────

  describe('markInProgress()', () => {
    it('[EC] throws BadRequestException when order is not PENDING', async () => {
      const inProgressOrder = makeOrder({
        laundryStatus: LaundryStatus.IN_PROGRESS,
      });
      orderModel.exec.mockResolvedValue(inProgressOrder);

      await expect(
        service.markInProgress('order-id-1', 'merchant-uid-1'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.markInProgress('order-id-1', 'merchant-uid-1'),
      ).rejects.toThrow('Order must be pending to mark in progress');
    });

    it('[HP] PENDING order transitions to IN_PROGRESS', async () => {
      const pendingOrder = makeOrder({ laundryStatus: LaundryStatus.PENDING });
      const inProgressOrder = makeOrder({
        laundryStatus: LaundryStatus.IN_PROGRESS,
      });

      orderModel.exec
        .mockResolvedValueOnce(pendingOrder) // findById
        .mockResolvedValueOnce(inProgressOrder); // findOneAndUpdate

      const result = await service.markInProgress(
        'order-id-1',
        'merchant-uid-1',
      );

      expect(orderModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'order-id-1', uid: 'merchant-uid-1' }),
        { $set: { laundryStatus: LaundryStatus.IN_PROGRESS } },
        { new: true },
      );
      expect(result).toEqual(inProgressOrder);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // markReady()
  // ──────────────────────────────────────────────────────────────────────────

  describe('markReady()', () => {
    it('[EC] throws BadRequestException when order is not IN_PROGRESS', async () => {
      const pendingOrder = makeOrder({ laundryStatus: LaundryStatus.PENDING });
      orderModel.exec.mockResolvedValue(pendingOrder);

      await expect(
        service.markReady('order-id-1', 'merchant-uid-1'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.markReady('order-id-1', 'merchant-uid-1'),
      ).rejects.toThrow('Order must be in progress to mark ready');
    });

    it('[HP] IN_PROGRESS order transitions to READY', async () => {
      const inProgressOrder = makeOrder({
        laundryStatus: LaundryStatus.IN_PROGRESS,
      });
      const readyOrder = makeOrder({ laundryStatus: LaundryStatus.READY });

      orderModel.exec
        .mockResolvedValueOnce(inProgressOrder) // findById
        .mockResolvedValueOnce(readyOrder); // findOneAndUpdate

      const result = await service.markReady('order-id-1', 'merchant-uid-1');

      expect(orderModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'order-id-1', uid: 'merchant-uid-1' }),
        { $set: { laundryStatus: LaundryStatus.READY } },
        { new: true },
      );
      expect(result).toEqual(readyOrder);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // findAll()
  // ──────────────────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('[HP] returns paginated results with correct defaults', async () => {
      const orders = [makeOrder(), makeOrder({ _id: 'order-id-2' })];

      // find chain and countDocuments chain both resolve via exec
      orderModel.exec
        .mockResolvedValueOnce(orders) // find().sort().skip().limit().exec()
        .mockResolvedValueOnce(2); // countDocuments().exec()

      const result = await service.findAll('merchant-uid-1', [], {});

      expect(result.data).toEqual(orders);
      expect(result.total).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(0);
    });

    it('[HP] applies branchId filter from branchIds when no specific branchId given', async () => {
      orderModel.exec.mockResolvedValueOnce([]).mockResolvedValueOnce(0);

      await service.findAll(
        'merchant-uid-1',
        ['branch-id-1', 'branch-id-2'],
        {},
      );

      expect(orderModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: { $in: ['branch-id-1', 'branch-id-2'] },
        }),
      );
    });

    it('[HP] search filter applies case-insensitive regex on customerName', async () => {
      orderModel.exec.mockResolvedValueOnce([]).mockResolvedValueOnce(0);

      await service.findAll('merchant-uid-1', [], { search: 'Juan' });

      expect(orderModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          customerName: { $regex: 'Juan', $options: 'i' },
        }),
      );
    });

    it('[EC] safeLimit is capped at 100 even when a higher limit is requested', async () => {
      orderModel.exec.mockResolvedValueOnce([]).mockResolvedValueOnce(0);

      const result = await service.findAll('merchant-uid-1', [], {
        limit: 500,
      });

      expect(orderModel.limit).toHaveBeenCalledWith(100);
      expect(result.limit).toBe(100);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // getMerchantId() / getBranchIds() helper methods
  // ──────────────────────────────────────────────────────────────────────────

  describe('getMerchantId() and getBranchIds()', () => {
    it('[HP] getMerchantId returns user._id for merchant role', () => {
      const merchantUser = makeMerchantUser();
      expect(service.getMerchantId(merchantUser)).toBe('merchant-uid-1');
    });

    it('[HP] getMerchantId returns user.merchantId for staff role', () => {
      const staffUser = makeStaffUser({ merchantId: 'merchant-uid-1' });
      expect(service.getMerchantId(staffUser)).toBe('merchant-uid-1');
    });

    it('[HP] getBranchIds returns branchIds array for staff role', () => {
      const staffUser = makeStaffUser({
        branchIds: ['branch-id-1', 'branch-id-2'],
      });
      expect(service.getBranchIds(staffUser)).toEqual([
        'branch-id-1',
        'branch-id-2',
      ]);
    });

    // SEC-016: an owner is UNRESTRICTED, which is `null`. It used to be `[]`,
    // indistinguishable from staff assigned to no branches — and the query
    // builders read `[]` as "no constraint", so such a staff member silently
    // got merchant-wide visibility.
    it('[HP] getBranchIds returns null (unrestricted) for merchant role', () => {
      const merchantUser = makeMerchantUser();
      expect(service.getBranchIds(merchantUser)).toBeNull();
    });

    it('[EC] getBranchIds returns [] for staff assigned no branches', () => {
      const staffUser = makeStaffUser();
      staffUser.branchIds = [];
      expect(service.getBranchIds(staffUser)).toEqual([]);
    });
  });
});
