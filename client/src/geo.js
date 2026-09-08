/**
 * Координаты и, что важнее, честность про их отсутствие.
 *
 * Приложение не молчит и не пишет мусор. Если сигнала нет или он недостоверен,
 * оно прямо это говорит и просит поставить точку на карте вручную.
 */

const GNSS_TIMEOUT_MS = 8_000;

/** Точность хуже этого считаем недостоверной и предлагаем уточнить вручную. */
const SUSPICIOUS_ACCURACY_M = 100;

export const NO_POSITION = { lat: null, lon: null, accuracy_m: null, source: 'none' };

/**
 * Одно измерение.
 * Возвращает { position, problem }: problem — null либо человекочитаемая
 * причина, по которой координатам верить нельзя.
 */
export function getPosition({ timeout = GNSS_TIMEOUT_MS } = {}) {
  if (!('geolocation' in navigator)) {
    return Promise.resolve({
      position: NO_POSITION,
      problem: 'Устройство не отдаёт координаты',
    });
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const position = {
          lat: coords.latitude,
          lon: coords.longitude,
          accuracy_m: coords.accuracy ?? null,
          source: 'gnss',
        };
        const imprecise = coords.accuracy != null && coords.accuracy > SUSPICIOUS_ACCURACY_M;
        resolve({
          position,
          problem: imprecise
            ? `Точность ${Math.round(coords.accuracy)} м, координаты недостоверны`
            : null,
        });
      },
      (error) => {
        resolve({ position: NO_POSITION, problem: describe(error) });
      },
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
    );
  });
}

function describe(error) {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'Доступ к геолокации закрыт';
    case error.POSITION_UNAVAILABLE:
      return 'Сигнал GNSS потерян';
    case error.TIMEOUT:
      return 'GNSS не ответил вовремя';
    default:
      return 'Координаты недоступны';
  }
}

/** Точка, поставленная пальцем на карте. */
export function positionFromMap(lat, lon) {
  return { lat, lon, accuracy_m: null, source: 'map' };
}

/** Координаты, введённые числами. */
export function positionFromInput(lat, lon) {
  return { lat, lon, accuracy_m: null, source: 'manual' };
}

export function hasCoordinates(position) {
  return position && position.lat != null && position.lon != null;
}

export function formatPosition(position) {
  if (!hasCoordinates(position)) return 'нет координат';
  const accuracy = position.accuracy_m != null ? `, ±${Math.round(position.accuracy_m)} м` : '';
  return `${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}${accuracy}`;
}
