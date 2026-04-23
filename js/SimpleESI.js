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

		// Replace localStorage with async KeyValues store
		this.store = new KeyValues('simpleesi-db', 'simpleesi-store', 5 * 60 * 1000);

		// user info and cache
		this.whoami = null;
		this.initWhoami();

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

	initWhoami() {
		if (localStorage.getItem('loggedout') === 'true') {
			this.whoami = null;
			return;
		}

		let whoamiinit = localStorage.getItem('whoami');
		if (whoamiinit === null) {
			this.whoami = null;
			return;
		}

		try {
			this.whoami = JSON.parse(whoamiinit);
		} catch (err) {
			this.errorlogger('Failed to parse whoami from localStorage:', err);
			this.whoami = null;
			localStorage.removeItem('whoami');
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

	async authLogout(destructive = true) {
		if (destructive) {
			localStorage.clear();
			await this.lsSet('logged_in_characters', null, true);
			await this.store.destroyDB();
			alert('You have been logged out. All cached data has been cleared.');
		} else {
			localStorage.setItem('loggedout', 'true');
			alert('You have been logged out.');
		}

		window.location = '/';
		return false;
	}

	async authCallback() {
		try {
			const params = Object.fromEntries(new URLSearchParams(window.location.search));
			if (decodeURIComponent(params.state) !== localStorage.getItem('state')) {
				// Something went very wrong, try again
				return this.authBegin();
			}

			const body = {
				grant_type: 'authorization_code',
				code: params.code,
				client_id: this.ssoClientId,
				code_verifier: localStorage.getItem('code_verifier')
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

			localStorage.setItem('whoami', JSON.stringify(this.whoami));
			localStorage.setItem(`whoami-${this.whoami.character_id}`, JSON.stringify(this.whoami));
			await this.lsSet('whoami', this.whoami);
			await this.lsSet('authed_json', json);
			localStorage.removeItem('loggedout');

			window.location = '/';
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
	changeCharacter(character_id) {
		// No change
		if (!this.whoami) {
			throw new Error('Cannot change character: not authenticated');
		}
		
		if (this.whoami.character_id === character_id) return false;

		const raw_whoami = localStorage.getItem(`whoami-${character_id}`);
		if (!raw_whoami) {
			throw new Error(`${character_id} is not an authenticated character!`);
		}

		try {
			const next_whoami = JSON.parse(raw_whoami);
			this.whoami = next_whoami;
			localStorage.setItem('whoami', raw_whoami);
			this.initWhoami();
			return true;
		} catch (err) {
			this.errorlogger('Failed to parse stored character data:', err);
			throw new Error(`Invalid character data for ${character_id}`);
		}
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
		headers.Authorization = await this.getAccessToken(character_id);
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
		if (headers === null) headers = {};
		headers['User-Agent'] = this.whoami
			? `${this.options.appName} (Character: ${this.whoami.name} / ${this.whoami.character_id})`
			: `${this.options.appName} (auth not established or in progress)`;
		headers['X-User-Agent'] = headers['User-Agent']; // Because Chrome wants to be special and override....

		// Add conditional request headers for caching optimization
		const cacheKey = `esi-cache-${url}`;
		const cachedData = await this.lsGet(cacheKey, true);
		if (cachedData && method === 'GET') {
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
			res = await fetch(url, params);
			if (res.status >= 500) this.esiIssueHandler(res);

			// Cache ETag and Last-Modified headers for future conditional requests
			if (method === 'GET' && res.ok) {
				try {
					const etag = getHeader(res, 'etag');
					const lastModified = getHeader(res, 'last-modified');
					if (etag || lastModified) {
						await this.lsSet(cacheKey, { etag, lastModified }, true);
					}
				} catch (err) {
					// Ignore cache storage errors
				}
			}

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
					const etag = getHeader(res, 'etag');
					const lastModified = getHeader(res, 'last-modified');
					if (etag || lastModified) {
						await this.lsSet(cacheKey, { etag, lastModified, data }, true);
					}
				} catch (err) {
					// Ignore if response is not JSON or storage fails
				}
			}

			// Rate limit handling with error protection
			try {
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
						const delay = 6 - Math.floor(remain / 10);
						const baseDelay = parseRateLimit(rateLimitHeader);
						const rateLimitRateMs = (delay * 1000) + baseDelay;
						this.logger(`Rate limit nearly exceeded (${remain} remaining), waiting ${rateLimitRateMs}ms`, method, url);
						await new Promise(resolve => setTimeout(resolve, rateLimitRateMs));
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
		localStorage.setItem('code_verifier', await this.generateCodeVerifier());
		localStorage.setItem('code_challenge', await this.generateCodeChallenge(localStorage.getItem('code_verifier')));
		localStorage.setItem('state', this.createRandomString(32));

		const params = new URLSearchParams({
			response_type: 'code',
			redirect_uri: this.callbackUrl,
			client_id: this.ssoClientId,
			scope: this.scopes,
			code_challenge: localStorage.getItem('code_challenge'),
			code_challenge_method: 'S256',
			state: localStorage.getItem('state')
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
		if (await this.lsGet('access_token', character_id) === 'undefined') await this.lsDel('access_token', character_id);
		let access_token_expires = parseInt(await this.lsGet('access_token_expires', character_id) || '0');
		if (access_token_expires < Date.now() || await this.lsGet('access_token', character_id) === null) {
			let authed_json = await this.lsGet('authed_json');
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

			await this.lsSet('access_token', json.access_token, character_id);
			await this.lsSet('access_token_expires', Date.now() + (1000 * (json.expires_in - 2)), character_id);
		}
		return await this.lsGet('access_token', character_id);
	}

	/**
	 * 
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
