'use strict';

// Returns ctx[field] when it is a non-empty string after trimming.
// Otherwise records the field name in `empties` and returns `placeholder`.
function optionalContextText(ctx, field, placeholder, empties) {
  const v = ctx && typeof ctx === 'object' ? ctx[field] : undefined;
  if (typeof v === 'string' && v.trim() !== '') return v;
  empties.push(field);
  return placeholder;
}

module.exports = { optionalContextText };
