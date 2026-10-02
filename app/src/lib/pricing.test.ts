import { describe, expect, it } from 'vitest';
import { calcPrice } from './pricing';

const base = { menuPrice: 4000, coveredByPass: false, productPrice: 0, referral: false, creditUse: 0 };

describe('calcPrice(DB の record_visit と同じ結果になること)', () => {
  it('通常', () => expect(calcPrice(base).total).toBe(4000));
  it('紹介割引', () => expect(calcPrice({ ...base, referral: true }).total).toBe(3000));
  it('紹介中はクレジットを使えない', () => {
    const r = calcPrice({ ...base, referral: true, creditUse: 500 });
    expect(r.creditUse).toBe(0);
    expect(r.total).toBe(3000);
  });
  it('クレジットは料金までしか使えない', () => {
    const r = calcPrice({ ...base, creditUse: 9999 });
    expect(r.creditUse).toBe(4000);
    expect(r.total).toBe(0);
  });
  it('月2回プランを購入して同時に使う', () =>
    expect(calcPrice({ ...base, coveredByPass: true, productPrice: 10000 }).total).toBe(10000));
  it('月2回プランを申込だけ(今回のメニュー + プラン)', () =>
    expect(calcPrice({ ...base, productPrice: 10000 }).total).toBe(14000));
  it('既存の回数券を使う', () => expect(calcPrice({ ...base, coveredByPass: true }).total).toBe(0));
});
