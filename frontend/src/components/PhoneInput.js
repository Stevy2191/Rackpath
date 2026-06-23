import React from 'react';
import { formatPhoneNumber, onlyDigits } from '../utils/phone';

// Drop-in replacement for <input> on any phone/contact-number field. `value`
// is the raw-digits string (what's stored in the DB); this renders it
// formatted as (xxx) xxx-xxxx and reports raw digits back through onChange.
export default function PhoneInput({ value, onChange, ...rest }) {
  return (
    <input
      {...rest}
      type="tel"
      inputMode="tel"
      value={formatPhoneNumber(value)}
      onChange={(e) => onChange(onlyDigits(e.target.value))}
    />
  );
}
