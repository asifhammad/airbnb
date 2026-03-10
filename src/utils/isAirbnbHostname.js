export function isAirbnbHostname(hostname) {
  if (!hostname) return false;
  const normalized = String(hostname).toLowerCase().replace(/\.+$/, '');
  const labels = normalized.split('.').filter(Boolean);
  if (labels.length < 2) return false;

  const secondLevel = labels[labels.length - 2];
  if (secondLevel === 'airbnb') return true;

  const thirdLevel = labels[labels.length - 3];
  if (thirdLevel !== 'airbnb') return false;

  const allowedSecondLevel = new Set(['com', 'co']);
  return allowedSecondLevel.has(secondLevel);
}

export default isAirbnbHostname;
