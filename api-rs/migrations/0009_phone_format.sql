-- Rackpath v2: contact phone numbers in one format. US numbers (10 digits,
-- or 11 starting with the country code 1) become (xxx) xxx-xxxx, as the API
-- now stores them; anything else (international numbers, extensions, notes)
-- is left as typed. The same rule as src/domain/phone.rs.

UPDATE locations SET contact_phone = CASE
    WHEN replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', '') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' THEN '(' || substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 1, 3) || ') ' || substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 4, 3) || '-' || substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 7, 4)
    ELSE '(' || substr(substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 2), 1, 3) || ') ' || substr(substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 2), 4, 3) || '-' || substr(substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 2), 7, 4)
  END
WHERE contact_phone IS NOT NULL
  AND trim(contact_phone) NOT GLOB '*[^0-9 ().+-]*'
  AND (replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', '') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
       OR (replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', '') GLOB '1[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
           AND (trim(contact_phone) NOT LIKE '+%' OR ltrim(substr(trim(contact_phone), 2)) LIKE '1%')))
  AND NOT (trim(contact_phone) LIKE '+%' AND replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', '') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]');

UPDATE rooms SET contact_phone = CASE
    WHEN replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', '') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' THEN '(' || substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 1, 3) || ') ' || substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 4, 3) || '-' || substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 7, 4)
    ELSE '(' || substr(substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 2), 1, 3) || ') ' || substr(substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 2), 4, 3) || '-' || substr(substr(replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', ''), 2), 7, 4)
  END
WHERE contact_phone IS NOT NULL
  AND trim(contact_phone) NOT GLOB '*[^0-9 ().+-]*'
  AND (replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', '') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
       OR (replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', '') GLOB '1[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
           AND (trim(contact_phone) NOT LIKE '+%' OR ltrim(substr(trim(contact_phone), 2)) LIKE '1%')))
  AND NOT (trim(contact_phone) LIKE '+%' AND replace(replace(replace(replace(replace(replace(trim(contact_phone), ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), '+', '') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]');
