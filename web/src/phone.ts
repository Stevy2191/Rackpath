// The same rule as the server (api-rs/src/domain/phone.rs), so a number
// shows in its stored form as soon as the field is left: US numbers as
// (979) 203-4748, anything else (international, extensions, notes) as typed.
export function formatPhone(value: string): string {
  const v = value.trim();
  if (!/^[0-9 ().+-]*$/.test(v)) return v;
  const digits = v.replace(/\D/g, '');
  const plus = v.startsWith('+');
  let national: string | null = null;
  if (digits.length === 10 && !plus) national = digits;
  else if (digits.length === 11 && digits.startsWith('1') && (!plus || v.slice(1).trimStart().startsWith('1'))) national = digits.slice(1);
  return national ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` : v;
}
