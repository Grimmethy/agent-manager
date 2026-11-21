/**
 * Split a blocked-task signature of the form `${source}::${category}` into its parts.
 * Splits on the LAST '::', so a source containing '::' stays intact
 * (e.g. 'a::b::c' -> { source: 'a::b', category: 'c' }).
 * With no '::' present, lastIndexOf returns -1 (the last character is dropped from source);
 * that is the pre-existing behavior, kept as-is.
 *
 * @param {string} signature
 * @returns {{ source: string, category: string }}
 */
function parseSignature(signature) {
  const sepIdx = signature.lastIndexOf('::');
  return {
    source: signature.slice(0, sepIdx),
    category: signature.slice(sepIdx + 2),
  };
}

module.exports = { parseSignature };
