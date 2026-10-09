/** Seconds the bus takes to pull in to the stop, and to drive off. */
export const BUS_IN = 2.2;
export const BUS_OUT = 2.4;

/** The campus bus: it pulls in at `since`, waits at the stop until `until`, then drives off. */
export interface Bus { since: number; until: number }

export const createBus = (): Bus => ({ since: -100, until: -100 });

/** Brings the bus for `stay` seconds at the stop, or keeps it there longer if it is already waiting. */
export function callBus(bus: Bus, now: number, stay: number): void {
  if (now >= bus.since && now < bus.until) {
    bus.until = Math.max(bus.until, now + stay);
    return;
  }
  bus.since = Math.max(now, bus.until + BUS_OUT);
  bus.until = bus.since + BUS_IN + stay;
}

/** Where the bus is, from -1 (off the left edge) through 0 (at the stop) to 1 (off the right edge); `null` when away. */
export function busPhase(bus: Bus, now: number): number | null {
  if (now < bus.since || now > bus.until + BUS_OUT) return null;
  if (now < bus.since + BUS_IN) {
    const u = (now - bus.since) / BUS_IN;
    return -((1 - u) ** 2);
  }
  if (now <= bus.until) return 0;
  const u = (now - bus.until) / BUS_OUT;
  return u * u;
}
