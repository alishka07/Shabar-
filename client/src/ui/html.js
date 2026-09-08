/**
 * Текст донесения приходит от другого устройства и попадает в разметку панели
 * управления. Экранируем, чтобы чужое поле «описание» оставалось текстом.
 */
export function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
