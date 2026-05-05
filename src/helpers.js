const config = require('./config');

/**
 * Namespace-aware key builder.
 * All keys stored as: {namespace}::{key}
 */
function nsKey(namespace, key) {
    return `${namespace}${config.NAMESPACE_SEPARATOR}${key}`;
}

/**
 * Strip namespace prefix from key for clean responses.
 */
function stripNs(namespacedKey) {
    const idx = namespacedKey.indexOf(config.NAMESPACE_SEPARATOR);
    return idx >= 0 ? namespacedKey.slice(idx + config.NAMESPACE_SEPARATOR.length) : namespacedKey;
}

/**
 * Build a SCAN pattern for a namespace.
 */
function nsPattern(namespace, pattern = '*') {
    return `${namespace}${config.NAMESPACE_SEPARATOR}${pattern}`;
}

/**
 * Sanitize and clamp TTL value.
 */
function sanitizeTTL(ttl) {
    if (ttl === undefined || ttl === null) return config.DEFAULT_TTL;
    const n = parseInt(ttl, 10);
    if (isNaN(n) || n <= 0) return config.DEFAULT_TTL;
    return Math.min(n, config.MAX_TTL);
}

// ─── Data type detection ─────────────────────────────────────────────────────
// Preserves exact JS type through serialization/deserialization cycle.
// Handles: null, undefined, boolean, number, string, array, object, Buffer/binary, Date
function detectType(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'date';
    if (Buffer.isBuffer(value)) return 'buffer';
    return typeof value; // 'string', 'number', 'boolean', 'object'
}

/**
 * Serialize value for storage.
 * Wraps in metadata envelope v2 for full type preservation.
 * Handles: null, undefined, boolean, number, string, array, object, Date, Buffer
 */
function serialize(value, tags = []) {
    const type = detectType(value);
    let storedValue;

    switch (type) {
        case 'null':
        case 'undefined':
            storedValue = null;
            break;
        case 'date':
            storedValue = value.toISOString();
            break;
        case 'buffer':
            storedValue = value.toString('base64');
            break;
        case 'number':
        case 'boolean':
            storedValue = value;
            break;
        case 'string':
            storedValue = value;
            break;
        default: // 'object', 'array'
            storedValue = value;
            break;
    }

    // BUG FIX: old code used fragile string.replace('"_sz":0', ...) which
    // would silently corrupt data if a stored value happened to contain that
    // exact string. Correct approach: stringify without _sz, measure, then
    // build the final envelope with the real byte count.
    const envelope = {
        _v: 2,
        _t: type,
        _ts: Date.now(),
        _tags: Array.isArray(tags) ? tags : [],
        _sz: 0,  // placeholder — overwritten below
        d: storedValue,
    };

    // First pass: measure size of the content (without _sz being accurate)
    const probe = JSON.stringify(envelope);
    // Second pass: write the real byte count into _sz
    envelope._sz = Buffer.byteLength(probe);
    return JSON.stringify(envelope);
}

/**
 * Deserialize stored value — unwraps envelope, restores original type.
 */
function deserialize(raw) {
    if (raw === null || raw === undefined) return null;

    try {
        const envelope = JSON.parse(raw);

        // v2 envelope (type-safe)
        if (envelope && envelope._v === 2) {
            let value;
            switch (envelope._t) {
                case 'null':
                case 'undefined':
                    value = null;
                    break;
                case 'date':
                    value = new Date(envelope.d);
                    break;
                case 'buffer':
                    value = Buffer.from(envelope.d, 'base64');
                    break;
                case 'number':
                    value = Number(envelope.d);
                    break;
                case 'boolean':
                    value = Boolean(envelope.d);
                    break;
                default: // string, object, array
                    value = envelope.d;
                    break;
            }
            return {
                value,
                type: envelope._t,
                storedAt: envelope._ts,
                tags: envelope._tags || [],
                sizeBytes: envelope._sz || 0,
            };
        }

        // v1 envelope (legacy compat)
        if (envelope && envelope._v === 1) {
            return {
                value: envelope.d,
                type: envelope._t,
                storedAt: envelope._ts,
                tags: envelope._tags || [],
                sizeBytes: 0,
            };
        }

        // Plain JSON value (no envelope at all — from other tools writing to same Redis)
        return { value: envelope, type: typeof envelope, storedAt: null, tags: [], sizeBytes: 0 };
    } catch {
        // Plain string (non-JSON)
        return { value: raw, type: 'string', storedAt: null, tags: [], sizeBytes: Buffer.byteLength(raw) };
    }
}

/**
 * Validate key format.
 */
function validateKey(key) {
    if (!key || typeof key !== 'string') return 'Key must be a non-empty string';
    if (key.length > 512) return 'Key must be <= 512 characters';
    if (key.includes(config.NAMESPACE_SEPARATOR)) return `Key must not contain "${config.NAMESPACE_SEPARATOR}"`;
    if (key.startsWith('__')) return 'Keys starting with "__" are reserved for system use';
    return null; // valid
}

/**
 * Check value size.
 */
function validateValueSize(serialized) {
    const bytes = Buffer.byteLength(serialized);
    if (bytes > config.MAX_VALUE_BYTES) {
        return `Value is ${(bytes / 1024 / 1024).toFixed(2)}MB — exceeds ${config.MAX_VALUE_BYTES / 1024 / 1024}MB limit`;
    }
    return null;
}

/**
 * Generate a short request ID for tracing.
 */
function generateRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
    nsKey,
    stripNs,
    nsPattern,
    sanitizeTTL,
    serialize,
    deserialize,
    validateKey,
    validateValueSize,
    generateRequestId,
};
