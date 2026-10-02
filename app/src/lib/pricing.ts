// 画面の「お会計」表示用の計算。DB の record_visit と同じ規則だが、
// 確定金額は必ず DB が決める(ここは入力中のプレビューのみ)
export const REFERRAL_DISCOUNT = 1000;

export interface PriceInput {
  menuPrice: number;
  coveredByPass: boolean;   // 回数券で支払う(既存の回数券を使う or 購入した回数券をすぐ使う)
  productPrice: number;     // この来店で購入する回数券の価格(購入しないなら 0)
  referral: boolean;
  creditUse: number;
}

export interface PriceResult {
  menuCharge: number;
  productCharge: number;
  referralDiscount: number;
  creditUse: number;
  total: number;
  maxCredit: number;        // この会計で使えるクレジットの上限(残高は別途)
}

export function calcPrice(i: PriceInput): PriceResult {
  const menuCharge = i.coveredByPass ? 0 : i.menuPrice;
  const referralDiscount = i.referral ? REFERRAL_DISCOUNT : 0;
  const subtotal = Math.max(menuCharge + i.productPrice - referralDiscount, 0);
  const maxCredit = i.referral ? 0 : subtotal;
  const creditUse = Math.min(Math.max(i.creditUse, 0), maxCredit);
  return {
    menuCharge,
    productCharge: i.productPrice,
    referralDiscount,
    creditUse,
    total: subtotal - creditUse,
    maxCredit,
  };
}

export const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;
