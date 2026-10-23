/** Shared visual venue catalogue. IDs travel with the match; physics stays identical. */
export const MASKWA_ARENA = 3;

export const ARENAS = [
  { id: 0, name: 'Daylight Stadium', description: 'Open sky, green turf and a full grandstand.' },
  { id: 1, name: 'Neon Night', description: 'A night stadium lit in blue, violet and orange.' },
  { id: 2, name: 'Industrial Indoor', description: 'Steel trusses, concrete walls and overhead lights.' },
  { id: MASKWA_ARENA, name: 'Maskwa Arena', description: 'Maskwacis Cree High School colours, bears and school pride.' },
] as const;

export function isArena(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && ARENAS.some(a => a.id === value);
}

/** Old saved settings and older peer hosts fall back to the original venue. */
export function normalizeArena(value: unknown): number { return isArena(value) ? value : 0; }
