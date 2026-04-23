class DexieStore {
	constructor(dbName = 'db', storeName = 'skillq', cleanupIntervalMs = 5 * 60 * 1000) {
		if (typeof Dexie === 'undefined') {
			throw new Error('Dexie is required before DexieStore can be used.');
		}

		this.dbName = dbName;
		this.storeName = storeName;
		this.cleanupIntervalMs = cleanupIntervalMs;
		this.cleanupTimer = null;

		this.db = new Dexie(dbName);
		this.db.version(1).stores({
			[storeName]: 'key, expiresAt'
		});
		this.table = this.db.table(storeName);

		if (this.cleanupIntervalMs != null) {
			this.startCleanupLoop();
		}
	}

	startCleanupLoop() {
		const tick = async () => {
			try {
				await this.clearExpired();
			} catch (err) {
				console.error('DexieStore cleanup failed:', err);
			} finally {
				if (this.cleanupTimer !== null) {
					this.cleanupTimer = window.setTimeout(tick, this.cleanupIntervalMs);
				}
			}
		};

		this.cleanupTimer = window.setTimeout(tick, this.cleanupIntervalMs);
	}

	stopCleanupLoop() {
		if (this.cleanupTimer !== null) {
			window.clearTimeout(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	async get(key) {
		const record = await this.table.get(key);
		if (!record) {
			return null;
		}

		if (record.expiresAt != null && record.expiresAt < Date.now()) {
			await this.table.delete(key);
			return null;
		}

		return record.value;
	}

	async set(key, value, ttl = null) {
		const expiresAt = ttl == null ? null : Date.now() + ttl;
		await this.table.put({ key, value, expiresAt });
	}

	async delete(key) {
		await this.table.delete(key);
	}

	async clearExpired() {
		return await this.table.where('expiresAt').below(Date.now()).delete();
	}

	async destroyDB() {
		this.stopCleanupLoop();
		this.db.close();
		await Dexie.delete(this.dbName);
	}
}

window.DexieStore = DexieStore;