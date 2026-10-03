import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../pages/Questionnaire';

// supabase/tests/visits.test.mjs の「電話番号の正規化は現行 GAS と同じ」と同じ入力・期待値
describe('normalizePhone(DB の normalize_phone と同じ結果)', () => {
  const cases: [string, string][] = [
    ['090-1234-5678', '09012345678'], ['+81 90 1234 5678', '09012345678'],
    ['０９０１２３４５６７８', '09012345678'], ['9012345678', '09012345678'], ['', ''],
    ['(090) 1234.5678', '09012345678'],
  ];
  for (const [input, want] of cases) it(input || '(空)', () => expect(normalizePhone(input)).toBe(want));
});
