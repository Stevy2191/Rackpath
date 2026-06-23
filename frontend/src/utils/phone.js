// Phone fields across the app store raw digits in the DB and format them as
// (xxx) xxx-xxxx for display - including while the user is mid-typing, where
// a partial number still gets partial formatting.
export function formatPhoneNumber(digits) {
  const d = (digits || '').replace(/\D/g, '').slice(0, 10);
  if (d.length === 0) return '';
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function onlyDigits(value) {
  return (value || '').replace(/\D/g, '').slice(0, 10);
}
