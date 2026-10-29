import { formatCost as sourceCost, type Estimate } from '../core/gen/models.ts';
import { getLanguage, ui } from './language.ts';

/** Units are UI copy; quoted amounts and the submitted numeric confirmation stay untouched. */
export function formatCost(estimate: Estimate): string {
  const text = sourceCost(estimate);
  if (getLanguage() !== 'en') return text;
  if (estimate.requiresQuote) return ui('рассчитать цену Higgsfield');
  return text.replace(' кр Higgsfield', ' Higgsfield credits').replace(' кр', ' credits');
}


/** Localize the deterministic server tariff note; preserve unknown provider descriptions. */
export function tariffNote(note: string | undefined): string | undefined {
  if (!note || getLanguage() !== 'en') return note;
  const match = /^Ориентир по тарифу Higgsfield для 16:9: \$(\d+(?:\.\d+)?)\/с × (\d+) с, до скидок аккаунта\. Фактическое списание зависит от размеров результата и может отличаться\. Это не верхний предел расходов\.$/.exec(note);
  return match ? `Reference Higgsfield tariff for 16:9: $${match[1]}/s × ${match[2]} s, before account discounts. Actual charges depend on output dimensions and may differ. This is not a spending cap.` : note;
}
