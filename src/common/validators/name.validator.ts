// Shared by every DTO that collects a person's name (firstName/lastName) —
// keeps the character rule identical across registration, staff, and admin
// creation instead of each DTO re-deriving its own regex.
export const NAME_RE = /^(?=.*\p{L})[\p{L}\s'-]+$/u;
export const NAME_INVALID_MESSAGE =
  'must contain only letters, spaces, hyphens, and apostrophes';
