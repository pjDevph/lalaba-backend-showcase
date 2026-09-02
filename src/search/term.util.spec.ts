import {
  MatchStrength,
  MatchedOn,
  classifyTerm,
  rankOf,
  strengthOfNameMatch,
} from './term.util';

/**
 * The classifier decides what one search box means, so every branch here is a
 * real thing an agent pastes mid-call. The cases that matter most are the
 * collisions: an ObjectId is 24 digits-and-letters and must not read as a
 * phone number, an order number contains digits and must not either.
 */
describe('classifyTerm', () => {
  it('[HP] reads an order number in every shape it gets typed', () => {
    for (const raw of ['LB-000123', 'lb-000123', 'LB000123', 'lb-123']) {
      expect(classifyTerm(raw).orderNumber).toBe('LB-000123');
    }
  });

  it('[HP] normalises every way of writing one Philippine mobile number', () => {
    for (const raw of [
      '09171234567',
      '+639171234567',
      '9171234567',
      '0917 123 4567',
      '(0917) 123-4567',
    ]) {
      expect(classifyTerm(raw).phoneTail).toBe('9171234567');
    }
  });

  it('[EC] does not read an order number as a phone number', () => {
    const term = classifyTerm('LB-000123');
    expect(term.phoneTail).toBeNull();
    expect(term.orderNumber).toBe('LB-000123');
  });

  it('[EC] does not read an ObjectId as a phone number', () => {
    // 24 hex characters contains well over seven digits, which is what the
    // digit-count check alone would have accepted.
    const term = classifyTerm('507f1f77bcf86cd799439011');
    expect(term.objectId).toBe('507f1f77bcf86cd799439011');
    expect(term.phoneTail).toBeNull();
    expect(term.firebaseUid).toBeNull();
  });

  it('[EC] tells a Firebase uid apart from an ObjectId', () => {
    // A Firebase uid is ~28 mixed-case alphanumerics. It has to be its own
    // branch: an order's customer.uid is a Firebase uid, so a pasted one that
    // fell into the ObjectId branch would silently match nothing.
    const term = classifyTerm('AbCdEf1234567890GhIjKlMn5678');
    expect(term.firebaseUid).toBe('AbCdEf1234567890GhIjKlMn5678');
    expect(term.objectId).toBeNull();
  });

  it('[HP] reads an email', () => {
    expect(classifyTerm('  Maria@Example.COM ').email).toBe(
      'maria@example.com',
    );
  });

  it('[EC] treats a plain name as nothing but a name', () => {
    const term = classifyTerm('Maria Santos');
    expect(term.email).toBeNull();
    expect(term.phoneTail).toBeNull();
    expect(term.objectId).toBeNull();
    expect(term.orderNumber).toBeNull();
    expect(term.name).toBe('Maria Santos');
  });

  it('[EC] collapses whitespace so a pasted term still matches', () => {
    expect(classifyTerm('  Maria   Santos  ').normalized).toBe('Maria Santos');
  });

  it('[EC] does not treat a short number as a phone number', () => {
    expect(classifyTerm('2024').phoneTail).toBeNull();
  });
});

describe('rankOf', () => {
  it('[HP] puts exact operational identifiers above every name match', () => {
    const orderNumber = rankOf(MatchedOn.ORDER_NUMBER, MatchStrength.EXACT);
    const phone = rankOf(MatchedOn.PHONE, MatchStrength.EXACT);
    const exactName = rankOf(MatchedOn.NAME, MatchStrength.EXACT);
    const prefixName = rankOf(MatchedOn.NAME, MatchStrength.PREFIX);
    const fuzzyName = rankOf(MatchedOn.NAME, MatchStrength.FUZZY);

    // The ladder the review specified, in order.
    expect(orderNumber).toBeLessThan(phone);
    expect(phone).toBeLessThan(exactName);
    expect(exactName).toBeLessThan(prefixName);
    expect(prefixName).toBeLessThan(fuzzyName);
  });

  it('[EC] never ranks a fuzzy match above any exact one', () => {
    const fuzzy = rankOf(MatchedOn.NAME, MatchStrength.FUZZY);
    for (const on of Object.values(MatchedOn)) {
      expect(rankOf(on, MatchStrength.EXACT)).toBeLessThan(fuzzy);
    }
  });
});

describe('strengthOfNameMatch', () => {
  it('[HP] grades exact, prefix and fuzzy', () => {
    expect(strengthOfNameMatch('Maria Santos', 'maria santos')).toBe(
      MatchStrength.EXACT,
    );
    expect(strengthOfNameMatch('Maria Santos', 'maria')).toBe(
      MatchStrength.PREFIX,
    );
    expect(strengthOfNameMatch('Maria Santos', 'santos')).toBe(
      MatchStrength.FUZZY,
    );
  });

  it('[EC] grades a missing value as fuzzy rather than throwing', () => {
    expect(strengthOfNameMatch(null, 'maria')).toBe(MatchStrength.FUZZY);
  });
});
