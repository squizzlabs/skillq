/*
## SimpleESI

### Required Options

- `clientID`  
  The client ID.

- `callbackURL`  
  The full callback URL. e.g. https://yourdomain.com/sso/auth

- `scopes`  
  The scopes.


### Optional Options

- `loginURL`  
  The login URL for your app. Will execute `authBegin` if detected.

- `authURL`  
  The auth/callback URL for your app. Will execute `doAuth`.

- `logoutURL`  
  The logout URL. Will execute `authLogout`.

- `postAuthRedirect`  
	Redirect target after successful auth. Can be a string URL/path or a function `(whoami) => string`.

- `esiInFlightHandler`  
  A custom function that will be called when a ESI call is started and completed, it will be passed the total number of inflight calls count

- `esiIssueHandler`  
  A custom function that will be executed when an issue is found (res.status >= 500), it will be passed res

- `logger`  
  Where to send normal output, defaults to console.log

- `errorlogger`  
  Where to send error output, defaults to console.error

*/

class SimpleESI {
	_bucket_values = {};
	_locks = {};

	getBucketValues() {
		return this._bucket_values;
	}

	constructor(options = {}) {
		if (!options.appName) {
			throw new Error('Option "appName" is required!');
		}

		this.options = options;
		this.ssoClientId = this.getOption('clientID');
		this.callbackUrl = this.getOption('callbackUrl');
		this.scopesArray = this.getOption('scopes');
		this.postAuthRedirect = this.getOption('postAuthRedirect', '/');
		this.esiInFlightHandler = this.getOption('esiInFlightHandler', this.noop);
		this.esiIssueHandler = this.getOption('esiIssueHandler', this.noop);
		this.logger = this.getOption('logger', console.log);
		this.errorlogger = this.getOption('errorlogger', console.error);

		this.scopes = this.scopesArray.join(' ');

		this.ssoAuthUrl = 'https://login.eveonline.com/v2/oauth/authorize/';
		this.ssoTokenUrl = 'https://login.eveonline.com/v2/oauth/token';

		const compatibility_date = '2020-01-01';

		this.mimetypeForm = {
			'Content-Type': 'application/x-www-form-urlencoded'
		};
		this.mimetypeJson = {
			Accept: 'application/json',
			'X-Compatibility-Date': compatibility_date,
			'Content-Type': 'application/json'
		};

		this.inflight = 0;

		// Persistent store backed by Dexie (IndexedDB)
		this.store = new DexieStore('simpleesi-db', 'simpleesi-store', 5 * 60 * 1000);

		// user info and cache
		this.whoami = null;
		this.ready = this.initWhoami();

		// Attach DOM event handlers
		document.addEventListener('DOMContentLoaded', this.domLoaded.bind(this));
	}

	setOption(name, value) {
		this.options[name] = value;
	}

	getOption(name, defaultValue = undefined) {
		if (typeof defaultValue === 'undefined' && typeof this.options[name] === 'undefined') {
			throw new Error(`Required option ${name} is not defined!`);
		}
		return this.options[name] ?? defaultValue;
	}

	async initWhoami() {
		try {
			const loggedOut = await this.store.get('simpleesi-global-loggedout');
			if (loggedOut === 'true') {
				this.whoami = null;
				return;
			}

			const whoamiInit = await this.store.get('simpleesi-global-whoami');
			if (whoamiInit === null || whoamiInit === undefined) {
				this.whoami = null;
				return;
			}

			this.whoami = JSON.parse(whoamiInit);
		} catch (err) {
			this.errorlogger('Failed to initialize whoami from Dexie:', err);
			this.whoami = null;
			await this.store.delete('simpleesi-global-whoami');
		}
	}

	async domLoaded() {
		switch (window.location.pathname) {
			case this.getOption('loginURL', '/login.html'):
				return this.authBegin();
			case this.getOption('authURL', '/auth.html'):
				return this.authCallback();
			case this.getOption('logoutURL', '/logout.html'):
				return await this.authLogout();
		}
	}

	async authLogout(destructive = true, redirectToRoot = true) {
		await this.ready;
		if (destructive) {
			this.whoami = null;
			await this.store.destroyDB();
			this.store = new DexieStore('simpleesi-db', 'simpleesi-store', 5 * 60 * 1000);
			this.ready = Promise.resolve();
		} else {
			await this.store.set('simpleesi-global-loggedout', 'true');
			this.whoami = null;
		}

		if (redirectToRoot) {
			window.location = '/';
		}
		return false;
	}

	async authCallback() {
		try {
			await this.ready;
			const params = Object.fromEntries(new URLSearchParams(window.location.search));
			const expectedState = await this.store.get('simpleesi-global-state');
			if (decodeURIComponent(params.state) !== expectedState) {
				// Something went very wrong, try again
				return this.authBegin();
			}

			const body = {
				grant_type: 'authorization_code',
				code: params.code,
				client_id: this.ssoClientId,
				code_verifier: await this.store.get('simpleesi-global-code_verifier')
			};

			let res = await this.doRequest(this.ssoTokenUrl, 'POST', this.mimetypeForm, body);
			
			if (!res || !res.ok) {
				this.errorlogger('OAuth token exchange failed:', res?.status);
				return this.authBegin();
			}
			
			let json = await res.json();

			if (!json.access_token) {
				this.errorlogger('No access token in OAuth response');
				return this.authBegin();
			}

			this.whoami = this.parseJwtPayload(json.access_token);
			this.whoami.character_id = this.whoami.sub.replace('CHARACTER:EVE:', '');

			await this.store.set('simpleesi-global-whoami', JSON.stringify(this.whoami));
			await this.store.set(`simpleesi-global-whoami-${this.whoami.character_id}`, JSON.stringify(this.whoami));
			await this.lsSet('whoami', this.whoami);
			await this.lsSet('authed_json', json, this.whoami.character_id);
			if (json.expires_in) {
				await this.lsSet('access_token', json.access_token, this.whoami.character_id, 1000 * (json.expires_in - 2));
			}
			await this.store.delete('simpleesi-global-loggedout');
			await this.store.delete('simpleesi-global-state');
			await this.store.delete('simpleesi-global-code_verifier');
			await this.store.delete('simpleesi-global-code_challenge');

			const redirectTarget = typeof this.postAuthRedirect === 'function'
				? this.postAuthRedirect(this.whoami)
				: this.postAuthRedirect;
			window.location = redirectTarget || '/';
		} catch (err) {
			this.errorlogger('Authentication callback error:', err);
			return this.authBegin();
		}
	}

	/**
	 * The character that auth calls are made for by default
	 * @param {Number} character_id 
	 * @returns 
	 */
	async changeCharacter(character_id) {
		await this.ready;
		// No change
		if (!this.whoami) {
			throw new Error('Cannot change character: not authenticated');
		}
		
		if (this.whoami.character_id === character_id) return false;

		const raw_whoami = await this.store.get(`simpleesi-global-whoami-${character_id}`);
		if (!raw_whoami) {
			throw new Error(`${character_id} is not an authenticated character!`);
		}

		try {
			const next_whoami = JSON.parse(raw_whoami);
			this.whoami = next_whoami;
			await this.store.set('simpleesi-global-whoami', raw_whoami);
			return true;
		} catch (err) {
			this.errorlogger('Failed to parse stored character data:', err);
			throw new Error(`Invalid character data for ${character_id}`);
		}
	}

	async getLoggedInCharacters() {
		await this.ready;
		const prefix = 'simpleesi-global-whoami-';
		const rows = await this.store.table.where('key').startsWith(prefix).toArray();
		const characters = [];

		for (const row of rows) {
			try {
				const who = JSON.parse(row.value);
				if (!who || !who.character_id) continue;
				characters.push({
					character_id: String(who.character_id),
					name: who.name || `Character ${who.character_id}`
				});
			} catch (_) {
				// Ignore malformed entries.
			}
		}

		if (this.whoami?.character_id) {
			const currentId = String(this.whoami.character_id);
			if (!characters.find((c) => c.character_id === currentId)) {
				characters.push({
					character_id: currentId,
					name: this.whoami.name || `Character ${currentId}`
				});
			}
		}

		characters.sort((a, b) => a.name.localeCompare(b.name));
		return characters;
	}

	async removeCharacter(characterId) {
		await this.ready;
		const targetId = String(characterId);

		await this.store.delete(`simpleesi-global-whoami-${targetId}`);
		await this.store.table.where('key').startsWith(`simpleesi-${targetId}-`).delete();

		const isCurrent = this.whoami && String(this.whoami.character_id) === targetId;
		if (!isCurrent) {
			return;
		}

		const remainingRows = await this.store.table.where('key').startsWith('simpleesi-global-whoami-').toArray();
		if (remainingRows.length === 0) {
			this.whoami = null;
			await this.store.delete('simpleesi-global-whoami');
			await this.store.set('simpleesi-global-loggedout', 'true');
			return;
		}

		let nextWhoami = null;
		for (const row of remainingRows) {
			try {
				nextWhoami = JSON.parse(row.value);
				if (nextWhoami?.character_id) break;
			} catch (_) {
				// Ignore malformed rows and keep scanning.
			}
		}

		if (!nextWhoami?.character_id) {
			this.whoami = null;
			await this.store.delete('simpleesi-global-whoami');
			await this.store.set('simpleesi-global-loggedout', 'true');
			return;
		}

		this.whoami = nextWhoami;
		await this.store.set('simpleesi-global-whoami', JSON.stringify(nextWhoami));
		await this.store.delete('simpleesi-global-loggedout');
	}

	async doJsonAuthRequest(url, method = 'GET', headers = null, body = null, character_id = this.whoami?.character_id) {
		let res = await this.doAuthRequest(url, method, headers, body, character_id);
		if (!res || !res.ok) {
			throw new Error(`Request failed with status ${res?.status}`);
		}
		return await res.json();
	}

	async doAuthRequest(url, method = 'GET', headers = null, body = null, character_id = this.whoami?.character_id) {
		if (headers === null) headers = {};
		const accessToken = await this.getAccessToken(character_id);
		headers.Authorization = accessToken.startsWith('Bearer ') ? accessToken : `Bearer ${accessToken}`;
		headers.Accept = 'application/json';
		return await this.doRequest(url, method, headers, body);
	}

	async doJsonRequest(url, method = 'GET', headers = null, body = null) {
		let res = await this.doRequest(url, method, headers, body);
		if (!res || !res.ok) {
			throw new Error(`Request failed with status ${res?.status}`);
		}
		return await res.json();
	}

	async doRequest(url, method = 'GET', headers = null, body = null) {
		const lockKey = `request_lock_${method}_${url}`;
		try {
			while (this._locks[lockKey]) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			this._locks[lockKey] = true;

			if (headers === null) headers = {};
			headers['User-Agent'] = this.whoami
				? `${this.options.appName} (Character: ${this.whoami.name} / ${this.whoami.character_id})`
				: `${this.options.appName} (auth not established or in progress)`;
			headers['X-User-Agent'] = headers['User-Agent']; // Because Chrome wants to be special and override....

			// Add conditional request headers for caching optimization
			const cacheKey = `esi-cache-${url}`;
			const cachedData = method == 'GET' ? await this.lsGet(cacheKey, true) : null;

			if (cachedData) {
				// Are we within the Expires window? If so, return that data
				let useCache = cachedData.expires && new Date(cachedData.expires).getTime() > Date.now();

				// If the time is between 10:59a UTC and 1110a UTC, ESI can be very unreliable. 
				// During that time, only use cached data
				const now = new Date();
				const minute = now.getUTCHours() * 100 + now.getUTCMinutes();
				useCache |= (minute >= 1059 && minute <= 1110);

				if (useCache) {
					return new Response(JSON.stringify(cachedData.data), {
						status: 200,
						statusText: 'OK (Cached)',
						headers: { 'Content-Type': 'application/json' }
					});
				}

				if (cachedData.etag) {
					headers['If-None-Match'] = cachedData.etag;
				}
				if (cachedData.lastModified) {
					headers['If-Modified-Since'] = cachedData.lastModified;
				}
			}

			let params = {
				method: method,
				headers: headers
			};
			if (body !== null) {
				if (typeof body === 'object') params.body = new URLSearchParams(body).toString();
				else params.body = body;
			}

			let res;
			try {
				this.inflight++;
				this.esiInFlightHandler(this.inflight);
				console.log('Fetching:', method, url);
				res = await fetch(url, params);
				if (res.status >= 500) this.esiIssueHandler(res);

				// Handle 304 Not Modified - return cached data
				if (res.status === 304 && cachedData && cachedData.data) {
					// Create a synthetic response from cached data
					res = new Response(JSON.stringify(cachedData.data), {
						status: 200,
						statusText: 'OK (Cached)',
						headers: res.headers
					});
				} else if (method === 'GET' && res.ok) {
					// Store response data for future 304 responses
					try {
						const clonedRes = res.clone();
						const data = await clonedRes.json();
						const expires = getHeader(res, 'expires');
						const etag = getHeader(res, 'etag');
						const lastModified = getHeader(res, 'last-modified');
						if (etag || lastModified) {
							await this.lsSet(cacheKey, { etag, lastModified, expires, data }, true);
						}
					} catch (err) {
						// Ignore if response is not JSON or storage fails
					}
				}
				if (!res.ok) {
					console.error(res);
					console.error(await res.text());
				}

				// Rate limit handling with error protection
				try {
					const retry_after = getHeader(res, 'retry-after');
					if (retry_after) {
						const delay = (Number(retry_after) || 60) * 1000;
						this.logger(`Received Retry-After header, waiting ${delay}ms before next request`, method, url);
						await new Promise(resolve => setTimeout(resolve, delay));
					} else {
						const bucket = getHeader(res, 'x-ratelimit-group');
						const remain = Number(getHeader(res, 'x-ratelimit-remaining') || 999999);

						if (bucket) {
							if (this._bucket_values[this.whoami.character_id] === undefined) {
								this._bucket_values[this.whoami.character_id] = {};
							}
							this._bucket_values[this.whoami.character_id][bucket] = { remain: remain, epoch: new Date().getTime() };
						}
						if (remain <= 50) {
							const rateLimitHeader = getHeader(res, 'x-ratelimit-limit');
							if (rateLimitHeader) {
								// Exponential backoff: more aggressive as we approach limit
								const delay = remain == 0 ? 60 : 6 - Math.floor(remain / 10);
								const baseDelay = parseRateLimit(rateLimitHeader);
								const rateLimitRateMs = (delay * 1000) + baseDelay;
								this.logger(`Rate limit nearly exceeded (${remain} remaining), waiting ${rateLimitRateMs}ms`, method, url);
								await new Promise(resolve => setTimeout(resolve, rateLimitRateMs));
							}
						}
					}
				} catch (err) {
					this.errorlogger('Rate limit parsing error:', err);
				}

				return res;
			} catch (e) {
				this.errorlogger(e);
				// Pass undefined explicitly if res was never set
				this.esiIssueHandler(e, res || null);
				// Re-throw to let caller handle the error
				throw e;
			} finally {
				this.inflight--;
				this.esiInFlightHandler(this.inflight);
			}
		} finally {
			this._locks[lockKey] = false;
		}
	}

	async noop() { }

	async generateCodeVerifier() {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return btoa(String.fromCharCode(...array))
			.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	async generateCodeChallenge(verifier) {
		const data = new TextEncoder().encode(verifier);
		const digest = await crypto.subtle.digest('SHA-256', data);
		const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
		return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	async authBegin() {
		await this.ready;
		const codeVerifier = await this.generateCodeVerifier();
		const codeChallenge = await this.generateCodeChallenge(codeVerifier);
		const state = this.createRandomString(32);
		await this.store.set('simpleesi-global-code_verifier', codeVerifier);
		await this.store.set('simpleesi-global-code_challenge', codeChallenge);
		await this.store.set('simpleesi-global-state', state);

		const params = new URLSearchParams({
			response_type: 'code',
			redirect_uri: this.callbackUrl,
			client_id: this.ssoClientId,
			scope: this.scopes,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			state: state
		}).toString();
		window.location = `${this.ssoAuthUrl}?${params}`;
	}

	createRandomString(length) {
		if (length === null || length === undefined || length < 0) {
			throw new Error(`Invalid length value ${length}`);
		}
		let result = [];
		const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const charactersLength = characters.length;
		for (let i = 0; i < length; i++) {
			result.push(characters.charAt(Math.floor(Math.random() * charactersLength)));
		}
		return result.join('');
	}

	parseJwtPayload(accessToken) {
		if (!accessToken || typeof accessToken !== 'string') {
			throw new Error('Invalid access token');
		}
		
		const parts = accessToken.split('.');
		if (parts.length !== 3) {
			throw new Error('Invalid JWT format');
		}
		
		try {
			const base64Url = parts[1];
			const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
			const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
			const json = atob(padded);
			return JSON.parse(json);
		} catch (err) {
			throw new Error(`Failed to parse JWT payload: ${err.message}`);
		}
	}

	async getAccessToken(character_id = this.whoami.character_id) {
		const lockKey = `access_token_lock_${character_id}`;
		try {
			while (this._locks[lockKey]) {
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
			this._locks[lockKey] = true;

			if (await this.lsGet('access_token', character_id) === 'undefined') await this.lsDel('access_token', character_id);
			let current_access_token = await this.lsGet('access_token', character_id);
			if (current_access_token === null) {
				let authed_json = await this.lsGet('authed_json', character_id);
				if (authed_json === null) return this.authLogout();
				const body = {
					grant_type: 'refresh_token',
					refresh_token: authed_json.refresh_token,
					client_id: this.ssoClientId
				};
				this.logger('Fetching new access token!');
				let res = await this.doRequest(this.ssoTokenUrl, 'POST', this.mimetypeForm, body);
			
				if (!res || !res.ok) {
					this.errorlogger('Token refresh failed:', res?.status);
					return this.authLogout();
				}
			
				let json = await res.json();

				if (!json.access_token || !json.expires_in) {
					this.errorlogger('Invalid token refresh response');
					return this.authLogout();
				}

				current_access_token = json.access_token;
				const nextAuthedJson = {
					...authed_json,
					...json,
					refresh_token: json.refresh_token || authed_json.refresh_token
				};
				await this.lsSet('authed_json', nextAuthedJson, character_id);
				await this.lsSet('access_token', json.access_token, character_id, 1000 * (json.expires_in - 2));
			}
			return current_access_token;
		} finally {
			this._locks[lockKey] = false;
		}
	}

	/**
	 * @param {String} key 
	 * @param {*} global 
	 * @returns 
	 */
	async lsGet(key, global = false) {
		const sesiKey = this.createKey(key, global);
		const val = await this.store.get(sesiKey);
		if (!val) return null;
		try {
			return JSON.parse(val);
		} catch (err) {
			await this.store.delete(sesiKey);
			return null;
		}
	}

	async lsSet(key, value, global = false, ttl = null) {
		const sesiKey = this.createKey(key, global);
		return await this.store.set(sesiKey, JSON.stringify(value), ttl);
	}

	async lsDel(key, global = false) {
		const sesiKey = this.createKey(key, global);
		return await this.store.delete(sesiKey);
	}

	createKey(key, global) {
		if (global === false) {
			if (!this.whoami || !this.whoami.character_id) {
				throw new Error('Not authenticated!');
			}
			global = this.whoami.character_id;
		}
		// If global is true, use 'global' as identifier, if global is a Number/String, use that as character_id
		const who = (global === true) ? 'global' : global;
		return `simpleesi-${who}-${key}`;
	}
}

/**
 * Rate limit cache
 * @type {Object.<string, number>}
 */
const rateLimitCache = {};

/**
 * Converts a rate limit string (e.g., "600/15m") to milliseconds per call
 * @param {string} rateLimit - Rate limit string in format "calls/time" where time can be s, m, h, d
 * @returns {number} Milliseconds to wait between calls
 * @example
 * parseRateLimit("600/15m") // returns 1500 (wait 1.5s between calls)
 * parseRateLimit("10000/30m") // returns 180 (wait 180ms between calls)
 */
function parseRateLimit(rateLimit) {
	if (rateLimitCache[rateLimit]) {
		return rateLimitCache[rateLimit];
	}

	const match = rateLimit.match(/^(\d+)\/(\d+)([smhd])$/);
	if (!match) {
		throw new Error(`Invalid rate limit format: ${rateLimit}`);
	}

	const [, calls, time, unit] = match;
	const numCalls = Math.max(1, parseInt(calls, 10));
	const timeValue = Math.max(1, parseInt(time, 10));

	// Convert time to milliseconds
	const unitMultipliers = {
		's': 1000,           // seconds
		'm': 60 * 1000,      // minutes
		'h': 60 * 60 * 1000, // hours
		'd': 24 * 60 * 60 * 1000 // days
	};

	const totalMs = timeValue * unitMultipliers[unit];
	// Use Math.ceil to ensure we wait slightly longer rather than shorter (safer for rate limits)
	const msPerCall = Math.max(1, Math.ceil(totalMs / numCalls));

	rateLimitCache[rateLimit] = msPerCall;
	return msPerCall;
}

function getHeader(res, header) {
	// If we've already parsed/normalized/cache headers, reuse them
	if (!res._esiHeaderCache) {
		const normalized = {};

		// Build normalized header map
		for (const [k, v] of res.headers) {
			const key = k.toLowerCase().trim();
			const value = String(v ?? "").trim();

			if (!normalized[key]) normalized[key] = [];
			normalized[key].push(value);
		}

		// Define helper getter inside the cached object
		res._esiHeaderCache = {
			normalized,

			getBest(partial) {
				// Normalize the search term
				const search = partial.toLowerCase().trim();
				
				// Try exact match first
				if (normalized[search] && normalized[search].length) {
					const values = normalized[search]
						.map(v => v.trim())
						.filter(v => v !== "" && v !== "null" && v !== "undefined");
					if (values.length) return values[0];
				}
				
				// Fall back to substring match
				const key = Object.keys(normalized)
					.find(k => k.includes(search));

				if (!key) return null;

				const values = normalized[key]
					.map(v => v.trim())
					.filter(v => v !== "" && v !== "null" && v !== "undefined");

				return values.length ? values[0] : null;
			}
		};
	}

	// Use the cached helper to get a header
	return res._esiHeaderCache.getBest(header);
}
