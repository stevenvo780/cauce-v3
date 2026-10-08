import { useEffect, useState } from 'react';

/** Night runs from 20:00 to 07:00 on the viewer's clock. */
export function isNightHour(hour: number): boolean {
  return hour >= 20 || hour < 7;
}

/** Follows the viewer's local hour; re-checks once a minute and only re-renders when the period flips. */
export function useNight(): boolean {
  const [night, setNight] = useState(() => isNightHour(new Date().getHours()));
  useEffect(() => {
    const timer = window.setInterval(() => { setNight(isNightHour(new Date().getHours())); }, 60_000);
    return () => { window.clearInterval(timer); };
  }, []);
  return night;
}
