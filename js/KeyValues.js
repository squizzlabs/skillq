import { get, set, del, keys, createStore } from 'https://cdn.jsdelivr.net/npm/idb-keyval@6.2.2/+esm';


class KeyValues {
	/**
	 * @param {string} dbName        IndexedDB database name
	 * @param {string} storeName     Object store name
	 * @param {number|null} cleanupIntervalMs  Interval for TTL cleanup (ms), null to disable
	 */
	constructor(dbName = 'db', storeName = 'keyvalues', cleanupIntervalMs = 5 * 60 * 1000) {
		// If IndexedDB isn't available, fall back to a disabled no-op mode
		if (typeof indexedDB === 'undefined') {
			console.warn('IndexedDB not supported; KeyValues will operate in no-op mode.');
			this.disabled = true;
			this.store = null;
			this._cleanupTimer = null;
			return;
		}

		this.disabled = false;
		this.store = createStore(dbName, storeName);
		this.cleanupIntervalMs = cleanupIntervalMs;
		this._cleanupTimer = null;

		if (this.cleanupIntervalMs != null) {
			this._startCleanupLoop();
		}
	}

	_startCleanupLoop() {
		if (this.disabled) return;

		const tick = async () => {
			try {
				await this.clearExpired();
			} catch (err) {
				console.error('Error during clearing expired entries:', err);
			} finally {
				if (this._cleanupTimer !== null) {
					this._cleanupTimer = setTimeout(tick, this.cleanupIntervalMs);
				}
			}
		};

		// start the loop
		this._cleanupTimer = setTimeout(tick, this.cleanupIntervalMs);
	}

	/**
	 * Stop cleanup loop; call if you're tearing down the app/page.
	 */
	destroy() {
		if (this._cleanupTimer !== null) {
			clearTimeout(this._cleanupTimer);
			this._cleanupTimer = null;
		}
	}

	/**
	 * Get value by key, respecting TTL.
	 * Returns null if not found or expired.
	 */
	async get(key) {
		if (this.disabled) return null;

		const record = await get(key, this.store);
		if (!record) return null;

		const { value, ttl } = record;

		if (ttl != null && ttl < Date.now()) {
			// fire-and-forget delete
			del(key, this.store).catch(console.error);
			return null;
		}

		return value;
	}

	/**
	 * Set a value with optional TTL in seconds.
	 * ttl = null  → no expiration
	 * ttl = 0     → expire immediately
	 */
	async set(key, value, ttl = null) {
		if (this.disabled) return;

		const expiresAt = (ttl == null) ? null : Date.now() + ttl * 1000;
		await set(key, { value, ttl: expiresAt }, this.store);
	}

	/**
	 * Delete a key.
	 */
	async delete(key) {
		if (this.disabled) return;
		await del(key, this.store);
	}

	/**
	 * Clear expired entries; returns number of deleted keys.
	 */
	async clearExpired() {
		if (this.disabled) return 0;

		const now = Date.now();
		const allKeys = await keys(this.store);
		let deletedCount = 0;

		await Promise.all(
			allKeys.map(async (k) => {
				const record = await get(k, this.store);
				if (!record) return;

				const { ttl } = record;
				if (ttl != null && ttl < now) {
					await del(k, this.store);
					deletedCount++;
				}
			})
		);

		if (deletedCount) {
			console.log(`Cleared ${deletedCount} expired entries`);
		}

		return deletedCount;
	}

	/**
	 * Return all keys (including expired ones; use clearExpired() if you
	 * want to purge first).
	 */
	async keys() {
		if (this.disabled) return [];
		return keys(this.store);
	}

	async destroyDB() {
		await indexedDB.deleteDatabase(this.dbName);
	}
}

// Expose KeyValues to global scope for non-module scripts
window.KeyValues = KeyValues;
