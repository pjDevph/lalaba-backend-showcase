const WEIGHT_TO_GRAMS: Record<string, number> = { g: 1, kg: 1000 };
const VOLUME_TO_ML: Record<string, number> = { ml: 1, L: 1000 };

// Converts `quantity` from `fromUnit` to `toUnit`. Only weight (g/kg) and
// volume (ml/L) are convertible — count-based units (pieces, pack, scoop, ...)
// have no fixed ratio, so mismatched count units are returned unconverted.
export function convertQuantity(
  quantity: number,
  fromUnit?: string | null,
  toUnit?: string | null,
): number {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return quantity;
  if (fromUnit in WEIGHT_TO_GRAMS && toUnit in WEIGHT_TO_GRAMS) {
    return (quantity * WEIGHT_TO_GRAMS[fromUnit]) / WEIGHT_TO_GRAMS[toUnit];
  }
  if (fromUnit in VOLUME_TO_ML && toUnit in VOLUME_TO_ML) {
    return (quantity * VOLUME_TO_ML[fromUnit]) / VOLUME_TO_ML[toUnit];
  }
  return quantity;
}
