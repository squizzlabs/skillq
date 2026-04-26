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
 * - timed_count: uint8
 *   - number of records that include training data (start and/or end)
 *   - these records are stored first, preserving relative order
 * - record_count: varuint
 *   - total number of records (timed + untimed)
 *
 * Record ordering:
 * - Records are reordered during encoding:
 *   - first `timed_count` records = records with training data
 *   - remaining records = records without training data
 * - Relative order within each group is preserved
 *
 * 1) type_id stream:
 * - Each record writes:
 *   - type_id_delta: signed varint (zig-zag encoded)
 *     - first record: type_id - 0
 *     - subsequent: type_id - previous type_id
 *
 * 2) level stream:
 * - Each record has:
 *   - level: 3 bits
 *
 * 3) flags stream (timed records only):
 * - 1 bit per timed record:
 *   - bit 0: training_start present
 * - Packed consecutively into bytes (LSB first)
 *
 * 4) timestamp stream (timed records only):
 * - For each timed record (in order):
 *   - if training_start present:
 *       - training_start_delta: varuint
 *         - stored as delta from previous training_start (initial = 0)
 *   - training_end: varuint
 *       - always present for timed records
 *       - represents duration / delta (not absolute time)
 */
const SkillUrlCodecSafe = (() => {
	/**
	 * Binary format version.
	 * Bump this if the encoding layout changes in the future.
	 */
	const VERSION = 3;

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
	 * Zig-zag encodes a signed integer into an unsigned integer.
	 *
	 * @param {number} value - Signed integer.
	 * @returns {number} Unsigned zig-zag encoded integer.
	 */
	function encodeZigZag(value) {
		return value >= 0 ? value * 2 : (-value * 2) - 1;
	}

	/**
	 * Zig-zag decodes an unsigned integer back into a signed integer.
	 *
	 * @param {number} value - Unsigned zig-zag encoded integer.
	 * @returns {number} Signed integer.
	 */
	function decodeZigZag(value) {
		return (value % 2 === 0) ? (value / 2) : -((value + 1) / 2);
	}

	/**
	 * Writes a signed variable-length integer to the output byte array.
	 *
	 * @param {number[]} out - Output byte array.
	 * @param {number} value - Signed integer to write.
	 */
	function writeVarInt(out, value) {
		assertSafeInt(value, "varint");
		writeVarUint(out, encodeZigZag(value));
	}

	/**
	 * Reads a signed variable-length integer from a byte array.
	 *
	 * @param {Uint8Array} bytes - Source bytes.
	 * @param {{offset:number}} state - Mutable read state.
	 * @returns {number} Decoded signed integer.
	 */
	function readVarInt(bytes, state) {
		return decodeZigZag(readVarUint(bytes, state));
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
	 * - Writes the binary format described at the top of this file
	 * - Returns base64url text safe for use in URLs
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

		const timed = [];
		const untimed = [];
		for (const r of normalized) {
			if (r.training_start !== undefined || r.training_end !== undefined) {
				timed.push(r);
			} else {
				untimed.push(r);
			}
		}
		const sorted = timed.concat(untimed);

		const out = [];

		// Write file format version.
		writeVarUint(out, VERSION);

		// Write timed count
		if (timed.length > 255) {
			throw new Error("Too many timed records");
		}
		out.push(timed.length);

		// Write total count
		writeVarUint(out, sorted.length);

		// Write type ids
		let prevTypeId = 0;
		for (const record of sorted) {
			writeVarInt(out, record.type_id - prevTypeId);
			prevTypeId = record.type_id;
		}

		// Write levels with bit packing
		let bitBuffer = 0;
		let bitCount = 0;
		for (const record of sorted) {
			bitBuffer |= (record.level & 0x07) << bitCount;
			bitCount += 3;
			while (bitCount >= 8) {
				out.push(bitBuffer & 0xff);
				bitBuffer >>= 8;
				bitCount -= 8;
			}
		}
		if (bitCount > 0) {
			out.push(bitBuffer);
		}

		// Write flags
		let flagBuf = 0;
		let flagBits = 0;
		for (let i = 0; i < timed.length; i++) {
			const record = timed[i];
			const hasStart = record.training_start !== undefined ? 1 : 0;
			flagBuf |= hasStart << flagBits;
			flagBits += 1;
			while (flagBits >= 8) {
				out.push(flagBuf & 0xff);
				flagBuf >>= 8;
				flagBits -= 8;
			}
		}
		if (flagBits > 0) {
			out.push(flagBuf);
		}

		let prevStart = 0;
		for (let i = 0; i < timed.length; i++) {
			const record = timed[i];
			const hasStart = record.training_start !== undefined;
			if (hasStart) {
				const deltaStart = record.training_start - prevStart;
				writeVarUint(out, deltaStart);
				prevStart = record.training_start;
			}
			writeVarUint(out, record.training_end);
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
		if (version === 1) {
			return decodeV1(bytes, state);
		}
		if (version === 2) {
			return decodeV2(bytes, state);
		}
		if (version === 3) {
			return decodeV3(bytes, state);
		}
		throw new Error(`Unsupported version: ${version}`);
	}

	function decodeV1(bytes, state) {
		const count = readVarUint(bytes, state);
		const records = [];
		let prevTypeId = 0;

		for (let i = 0; i < count; i++) {
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

			const rec = { type_id: typeId, level };
			if (hasStart) rec.training_start = readVarUint(bytes, state);
			if (hasEnd) rec.training_end = readVarUint(bytes, state);
			records.push(rec);
		}

		if (state.offset !== bytes.length) {
			throw new Error("Extra trailing bytes detected");
		}

		return records;
	}

	function decodeV2(bytes, state) {
		// Read record count.
		const count = readVarUint(bytes, state);
		const records = [];

		let prevTypeId = 0;

		for (let i = 0; i < count; i++) {
			// Read type_id as signed delta from previous.
			const typeId = prevTypeId + readVarInt(bytes, state);

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

		if (state.offset !== bytes.length) {
			throw new Error("Extra trailing bytes detected");
		}

		return records;
	}

	function decodeV3(bytes, state) {
		if (state.offset >= bytes.length) {
			throw new Error("Unexpected end while reading timed count");
		}
		const timedCount = bytes[state.offset++];
		const count = readVarUint(bytes, state);
		const records = new Array(count);

		let prevTypeId = 0;
		for (let i = 0; i < count; i++) {
			const typeId = prevTypeId + readVarInt(bytes, state);
			prevTypeId = typeId;
			records[i] = { type_id: typeId };
		}

		let bitBuffer = 0;
		let bitCount = 0;
		for (let i = 0; i < count; i++) {
			while (bitCount < 3) {
				if (state.offset >= bytes.length) {
					throw new Error("Unexpected end while reading levels");
				}
				bitBuffer |= bytes[state.offset++] << bitCount;
				bitCount += 8;
			}
			records[i].level = bitBuffer & 0x07;
			bitBuffer >>= 3;
			bitCount -= 3;
		}

		const hasStartArr = new Array(timedCount);
		let flagBuf = 0;
		let flagBits = 0;
		for (let i = 0; i < timedCount; i++) {
			while (flagBits < 1) {
				if (state.offset >= bytes.length) {
					throw new Error("Unexpected end while reading flags");
				}
				flagBuf |= bytes[state.offset++] << flagBits;
				flagBits += 8;
			}
			hasStartArr[i] = flagBuf & 1;
			flagBuf >>= 1;
			flagBits -= 1;
		}

		let prevStart = 0;
		for (let i = 0; i < timedCount; i++) {
			const hasStart = hasStartArr[i] !== 0;
			if (hasStart) {
				const deltaStart = readVarUint(bytes, state);
				const start = prevStart + deltaStart;
				records[i].training_start = start;
				prevStart = start;
			}
			records[i].training_end = readVarUint(bytes, state);
		}

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
