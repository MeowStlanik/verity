import { createHash } from 'node:crypto';

/** Stable JSON used by the API, deployment tools and relay when they bind a resolver. */
export function canonicalJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalHash(value) {
  return `0x${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function fixedSources(sources) {
  return sources.map(({ name, url, jsonPath = null, timestampPath = null, timestampValue = null }) => ({
    name, url, jsonPath, timestampPath, timestampValue,
  }));
}
