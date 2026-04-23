/**
 * SkillUrlCodecSafe
 *
 * Compact URL-safe encoder/decoder for records shaped like:
 *
 * {
 *   type_id: number,
 *   level: number,           // 0-5
 *   training_start?: number, // unix time, optional
 *   training_end?: number    // unix time, optional
 * }
 *
 * Design goals:
 * - Small binary format
 * - URL-safe output using base64url
 * - Not human readable
 * - Safe for missing optional fields
 * - More compact than plain JSON
 *
 * Encoding format, version 3:
 *
 * Header:
 * - version: varuint
 * - record count: varuint
 *
 * Per record:
 * - type_id:
 *   - first record: full unsigned varint
 *   - later records: delta from previous type_id as unsigned varint
 * - flags: 1 byte
 *   - bits 0-2: level (0-7, we only allow 0-5)
 *   - bit 3: training_start present
 *   - bit 4: training_end present
 * - training_start: unsigned varint, only if present
 * - training_end: unsigned varint, only if present
 *
 * Notes:
 * - Records are sorted by type_id during encoding to improve compression.
 * - Decoded records are returned in type_id order.
 * - This implementation supports both browser and Node.js environments.
 */
const SkillUrlCodecSafe = (() => {
	/**
	 * Binary format version.
	 * Bump this if the encoding layout changes in the future.
	 */
	const VERSION = 1;

	/**
	 * Validates that a value is a JavaScript safe integer.
	 *
	 * @param {number} n - Value to validate.
	 * @param {string} name - Field name used in error messages.
	 * @throws {Error} If the value is not a safe integer.
	 */
	function assertSafeInt(n, name) {
		if (!Number.isSafeInteger(n)) {
			throw new Error(`${name} must be a safe integer`);
		}
	}

	/**
	 * Writes an unsigned variable-length integer to the output byte array.
	 *
	 * Varuint format:
	 * - Uses 7 bits of data per byte
	 * - High bit indicates continuation
	 *
	 * Example:
	 * - Small numbers use 1 byte
	 * - Larger numbers use more bytes
	 *
	 * @param {number[]} out - Output byte array.
	 * @param {number} value - Unsigned integer to write.
	 * @throws {Error} If value is negative or not a safe integer.
	 */
	function writeVarUint(out, value) {
		assertSafeInt(value, "varuint");

		if (value < 0) {
			throw new Error("varuint cannot be negative");
		}

		while (value >= 0x80) {
			out.push((value & 0x7f) | 0x80);
			value = Math.floor(value / 128);
		}

		out.push(value);
	}

	/**
	 * Reads an unsigned variable-length integer from a byte array.
	 *
	 * The current read position is stored in state.offset and is advanced
	 * as bytes are consumed.
	 *
	 * @param {Uint8Array} bytes - Source bytes.
	 * @param {{offset:number}} state - Mutable read state.
	 * @returns {number} The decoded unsigned integer.
	 * @throws {Error} If the input ends unexpectedly or grows beyond safe JS range.
	 */
	function readVarUint(bytes, state) {
		let result = 0;
		let shift = 0;

		while (true) {
			if (state.offset >= bytes.length) {
				throw new Error("Unexpected end of data while reading varuint");
			}

			const byte = bytes[state.offset++];
			result += (byte & 0x7f) * Math.pow(2, shift);

			if ((byte & 0x80) === 0) {
				break;
			}

			shift += 7;

			if (shift > 49) {
				throw new Error("Varuint too large for JS safe integers");
			}
		}

		return result;
	}

	/**
	 * Converts raw bytes into base64url text.
	 *
	 * Differences from normal base64:
	 * - '+' becomes '-'
	 * - '/' becomes '_'
	 * - trailing '=' padding is removed
	 *
	 * This makes the output safe to place inside a URL.
	 *
	 * @param {Uint8Array} bytes - Bytes to encode.
	 * @returns {string} Base64url string.
	 */
	function bytesToBase64Url(bytes) {
		let base64;

		if (typeof Buffer !== "undefined") {
			base64 = Buffer.from(bytes).toString("base64");
		} else {
			let binary = "";
			for (let i = 0; i < bytes.length; i++) {
				binary += String.fromCharCode(bytes[i]);
			}
			base64 = btoa(binary);
		}

		return base64
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/g, "");
	}

	/**
	 * Converts a base64url string back into raw bytes.
	 *
	 * @param {string} str - Base64url input.
	 * @returns {Uint8Array} Decoded bytes.
	 */
	function base64UrlToBytes(str) {
		const base64 = str
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(str.length / 4) * 4, "=");

		if (typeof Buffer !== "undefined") {
			return Uint8Array.from(Buffer.from(base64, "base64"));
		}

		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);

		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}

		return bytes;
	}

	/**
	 * Validates and normalizes a single record into the internal shape used
	 * by the encoder.
	 *
	 * Rules:
	 * - type_id must be a non-negative safe integer
	 * - level must be an integer between 0 and 5
	 * - training_start and training_end, when present, must be non-negative safe integers
	 *
	 * @param {object} rec - Input record.
	 * @returns {{
	 *   type_id:number,
	 *   level:number,
	 *   training_start?:number,
	 *   training_end?:number
	 * }} Normalized record.
	 * @throws {Error} If the record is invalid.
	 */
	function normalizeRecord(rec) {
		if (!rec || typeof rec !== "object") {
			throw new Error("Each record must be an object");
		}

		const out = {
			type_id: rec.type_id,
			level: rec.level
		};

		assertSafeInt(out.type_id, "type_id");
		assertSafeInt(out.level, "level");

		if (out.type_id < 0) {
			throw new Error("type_id cannot be negative");
		}

		if (out.level < 0 || out.level > 5) {
			throw new Error("level must be between 0 and 5");
		}

		if (rec.training_start !== undefined && rec.training_start !== null) {
			assertSafeInt(rec.training_start, "training_start");

			if (rec.training_start < 0) {
				throw new Error("training_start cannot be negative");
			}

			out.training_start = rec.training_start;
		}

		if (rec.training_end !== undefined && rec.training_end !== null) {
			assertSafeInt(rec.training_end, "training_end");

			if (rec.training_end < 0) {
				throw new Error("training_end cannot be negative");
			}

			out.training_end = rec.training_end;
		}

		return out;
	}

	/**
	 * Encodes an array of skill records into a compact base64url string.
	 *
	 * Behavior:
	 * - Validates all records
	 * - Sorts records by type_id to improve delta compression
	 * - Writes the binary format described at the top of this file
	 * - Returns base64url text safe for use in URLs
	 *
	 * Important:
	 * - Because records are sorted during encoding, decoded output will also
	 *   be sorted by type_id rather than original input order.
	 *
	 * @param {Array<{
	 *   type_id:number,
	 *   level:number,
	 *   training_start?:number,
	 *   training_end?:number
	 * }>} records - Records to encode.
	 * @returns {string} Base64url-encoded compact payload.
	 * @throws {Error} If the input is not an array or contains invalid records.
	 */
	function encode(records) {
		if (!Array.isArray(records)) {
			throw new Error("encode() expects an array");
		}

		const normalized = records.map(normalizeRecord);

		normalized.sort((a, b) => a.type_id - b.type_id);

		const out = [];

		// Write file format version.
		writeVarUint(out, VERSION);

		// Write number of records.
		writeVarUint(out, normalized.length);

		let prevTypeId = 0;

		for (let i = 0; i < normalized.length; i++) {
			const rec = normalized[i];
			const hasStart = rec.training_start !== undefined;
			const hasEnd = rec.training_end !== undefined;

			// Write type_id as:
			// - full value for first record
			// - delta from previous type_id for later records
			if (i === 0) {
				writeVarUint(out, rec.type_id);
			} else {
				writeVarUint(out, rec.type_id - prevTypeId);
			}

			prevTypeId = rec.type_id;

			// Build flags byte:
			// bits 0-2 = level
			// bit 3 = has training_start
			// bit 4 = has training_end
			let flags = rec.level & 0x07;
			if (hasStart) flags |= 1 << 3;
			if (hasEnd) flags |= 1 << 4;

			out.push(flags);

			// Write optional timestamps only when present.
			if (hasStart) {
				writeVarUint(out, rec.training_start);
			}

			if (hasEnd) {
				writeVarUint(out, rec.training_end);
			}
		}

		return bytesToBase64Url(Uint8Array.from(out));
	}

	/**
	 * Decodes a base64url string produced by encode() back into skill records.
	 *
	 * Behavior:
	 * - Decodes base64url to bytes
	 * - Reads and validates the format version
	 * - Rebuilds type_id values using delta decoding
	 * - Reconstructs optional fields from the flags byte
	 *
	 * Output order:
	 * - Records are returned sorted by type_id because the encoder sorts them
	 *   before writing.
	 *
	 * @param {string} encoded - Base64url string produced by encode().
	 * @returns {Array<{
	 *   type_id:number,
	 *   level:number,
	 *   training_start?:number,
	 *   training_end?:number
	 * }>} Decoded records.
	 * @throws {Error} If the input is malformed or the version is unsupported.
	 */
	function decode(encoded) {
		const bytes = base64UrlToBytes(encoded);
		const state = { offset: 0 };

		// Read and validate version.
		const version = readVarUint(bytes, state);
		if (version !== VERSION) {
			throw new Error(`Unsupported version: ${version}`);
		}

		// Read record count.
		const count = readVarUint(bytes, state);
		const records = [];

		let prevTypeId = 0;

		for (let i = 0; i < count; i++) {
			// Read type_id:
			// - first record is full value
			// - later records are previous + delta
			const typeId = i === 0
				? readVarUint(bytes, state)
				: prevTypeId + readVarUint(bytes, state);

			prevTypeId = typeId;

			if (state.offset >= bytes.length) {
				throw new Error("Unexpected end of data while reading flags");
			}

			const flags = bytes[state.offset++];
			const level = flags & 0x07;
			const hasStart = (flags & (1 << 3)) !== 0;
			const hasEnd = (flags & (1 << 4)) !== 0;

			const rec = {
				type_id: typeId,
				level
			};

			if (hasStart) {
				rec.training_start = readVarUint(bytes, state);
			}

			if (hasEnd) {
				rec.training_end = readVarUint(bytes, state);
			}

			records.push(rec);
		}

		// If unread bytes remain, the payload is malformed or from a different format.
		if (state.offset !== bytes.length) {
			throw new Error("Extra trailing bytes detected");
		}

		return records;
	}

	/**
	 * Exposes the public API for this codec.
	 */
	return {
		encode,
		decode
	};
})();


// Example usage:
/*
const input = [
	{ type_id: 3400, level: 2, training_start: 1714000000 },
	{ type_id: 3301, level: 4, training_end: 1714003600 },
	{ type_id: 3300, level: 3, training_start: 1714000000, training_end: 1714001800 }
];

const encoded = SkillUrlCodecSafe.encode(input);
console.log("encoded:", encoded);

const decoded = SkillUrlCodecSafe.decode(encoded);
console.log("decoded:", decoded);
*/