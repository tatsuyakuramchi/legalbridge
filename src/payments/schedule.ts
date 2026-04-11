export type ClosingType = "monthly" | "half_monthly";

export function parseDateRaw(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatDateRaw(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatDateJa(value: Date): string {
  return `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日`;
}

export function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

export function calculateInspectionDeadline(baseDate: Date, inspectionDays: number): Date {
  return addDays(baseDate, inspectionDays);
}

export function calculateClosingDate(baseDate: Date, closingDay: number, closingType: ClosingType): Date {
  const y = baseDate.getFullYear();
  const m = baseDate.getMonth();
  const d = baseDate.getDate();

  if (closingType === "monthly") {
    const targetDay = closingDay === 0
      ? endOfMonth(y, m + 1).getDate()
      : closingDay;

    if (d <= targetDay || closingDay === 0) {
      return closingDay === 0
        ? endOfMonth(y, m + 1)
        : new Date(y, m, closingDay);
    }

    return closingDay === 0
      ? endOfMonth(y, m + 2)
      : new Date(y, m + 1, closingDay);
  }

  if (d <= 15) {
    return new Date(y, m, 15);
  }
  return endOfMonth(y, m + 1);
}

export function calculatePaymentDueDate(closingDate: Date, monthOffset: number, paymentDay: number): Date {
  const y = closingDate.getFullYear();
  const m = closingDate.getMonth();
  const targetMonth = m + monthOffset;
  const targetYear = y + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;

  if (paymentDay === 0) {
    return endOfMonth(targetYear, normalizedMonth + 1);
  }
  return new Date(targetYear, normalizedMonth, paymentDay);
}

export function buildPaymentConditionSummary(
  closingDay: string,
  monthOffset: number,
  paymentDay: string
): string {
  const closingLabel = closingDay === "末日" ? "月末締め" : `${closingDay}日締め`;
  const offsetLabel = monthOffset === 1 ? "翌月" : `翌${monthOffset}ヶ月`;
  const paymentLabel = paymentDay === "末日" ? "末日払い" : `${paymentDay}日払い`;
  return `${closingLabel}${offsetLabel}${paymentLabel}`;
}

function endOfMonth(year: number, month: number): Date {
  return new Date(year, month, 0);
}
