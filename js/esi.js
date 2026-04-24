window.esi = null;

const APP_NAME = 'SkillQ (skillq.net - Squizz Caphinator)';
const localhost = window.location.hostname === 'localhost';
const ssoLocalClientId = 'a4a7c16cc97440afb765f8fee441ef5a';
const ssoPublicClientId = '2b1049c33ff24b2ba403475e216bb38d';
const ESI_OWNER_STORAGE_KEY = 'skillq:esi-owner';
const ESI_CHANNEL_NAME = 'skillq:esi-owner-channel';
const ESI_OWNER_TTL_MS = 15000;
const ESI_OWNER_HEARTBEAT_MS = 5000;

function installSingleTabEsiCoordinator(esi) {
	if (!esi || typeof BroadcastChannel === 'undefined') return;

	const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const channel = new BroadcastChannel(ESI_CHANNEL_NAME);
	const pendingRequests = new Map();
	const originalDoJsonRequest = esi.doJsonRequest.bind(esi);
	const originalDoJsonAuthRequest = esi.doJsonAuthRequest.bind(esi);

	function now() {
		return Date.now();
	}

	function readOwnerRecord() {
		try {
			const raw = window.localStorage.getItem(ESI_OWNER_STORAGE_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			if (!parsed || !parsed.tabId || !parsed.updatedAt) return null;
			return parsed;
		} catch (_) {
			return null;
		}
	}

	function writeOwnerRecord(nextTabId = tabId) {
		try {
			window.localStorage.setItem(ESI_OWNER_STORAGE_KEY, JSON.stringify({
				tabId: nextTabId,
				updatedAt: now()
			}));
		} catch (_) {
			// Ignore localStorage failures and fall back to local execution.
		}
	}

	function ownerIsFresh(owner) {
		return Boolean(owner?.tabId) && (now() - Number(owner.updatedAt || 0)) < ESI_OWNER_TTL_MS;
	}

	function isOwner() {
		const owner = readOwnerRecord();
		return ownerIsFresh(owner) && owner.tabId === tabId;
	}

	function claimOwnership() {
		const owner = readOwnerRecord();
		if (!ownerIsFresh(owner) || owner.tabId === tabId) {
			writeOwnerRecord(tabId);
			return true;
		}
		return owner.tabId === tabId;
	}

	async function executeLocally(methodName, args) {
		if (methodName === 'doJsonAuthRequest') {
			return await originalDoJsonAuthRequest(...args);
		}
		return await originalDoJsonRequest(...args);
	}

	function serializeError(error) {
		return {
			message: error?.message || 'ESI request failed.',
			name: error?.name || 'Error'
		};
	}

	function createForwardedRequest(methodName, args) {
		return new Promise((resolve, reject) => {
			const requestId = `${tabId}:${now()}:${Math.random().toString(36).slice(2)}`;
			const timeoutId = setTimeout(() => {
				pendingRequests.delete(requestId);
				reject(new Error('Timed out waiting for the active SkillQ tab to respond.'));
			}, ESI_OWNER_TTL_MS + 5000);

			pendingRequests.set(requestId, {
				resolve,
				reject,
				timeoutId
			});

			channel.postMessage({
				type: 'esi-request',
				requestId,
				fromTabId: tabId,
				methodName,
				args
			});
		});
	}

	channel.addEventListener('message', async (event) => {
		const message = event.data || {};

		if (message.type === 'esi-response') {
			const pending = pendingRequests.get(message.requestId);
			if (!pending) return;
			pendingRequests.delete(message.requestId);
			clearTimeout(pending.timeoutId);
			if (message.ok) {
				pending.resolve(message.value);
				return;
			}
			const error = new Error(message.error?.message || 'ESI request failed.');
			error.name = message.error?.name || 'Error';
			pending.reject(error);
			return;
		}

		if (message.type !== 'esi-request' || !isOwner() || message.fromTabId === tabId) {
			return;
		}

		try {
			const value = await executeLocally(message.methodName, message.args || []);
			channel.postMessage({
				type: 'esi-response',
				requestId: message.requestId,
				toTabId: message.fromTabId,
				ok: true,
				value
			});
		} catch (error) {
			channel.postMessage({
				type: 'esi-response',
				requestId: message.requestId,
				toTabId: message.fromTabId,
				ok: false,
				error: serializeError(error)
			});
		}
	});

	setInterval(() => {
		if (isOwner()) {
			writeOwnerRecord(tabId);
			return;
		}
		claimOwnership();
	}, ESI_OWNER_HEARTBEAT_MS);

	window.addEventListener('beforeunload', () => {
		if (!isOwner()) return;
		const owner = readOwnerRecord();
		if (owner?.tabId === tabId) {
			try {
				window.localStorage.removeItem(ESI_OWNER_STORAGE_KEY);
			} catch (_) {
				// Ignore owner cleanup failures.
			}
		}
	});

	window.addEventListener('focus', () => {
		claimOwnership();
	});

	claimOwnership();

	async function runSingleTabRequest(methodName, args) {
		if (isOwner() || claimOwnership()) {
			return await executeLocally(methodName, args);
		}

		try {
			return await createForwardedRequest(methodName, args);
		} catch (_) {
			claimOwnership();
			return await executeLocally(methodName, args);
		}
	}

	esi.doJsonRequest = async (...args) => await runSingleTabRequest('doJsonRequest', args);
	esi.doJsonAuthRequest = async (...args) => await runSingleTabRequest('doJsonAuthRequest', args);
}

if (window.location.hostname === '127.0.0.1') {
	window.location = 'http://localhost:' + window.location.port + window.location.pathname + window.location.search + window.location.hash;
} else {
	(() => {
		try {
			const callbackUrl =
				window.location.protocol +
				'//' +
				window.location.hostname +
				(window.location.port === '' ? '' : ':' + window.location.port) +
				'/auth';
			console.log('Initializing ESI with callback URL:', callbackUrl);

			window.esi = new SimpleESI({
				appName: APP_NAME,
				clientID: localhost ? ssoLocalClientId : ssoPublicClientId,
				loginURL: '/login',
				authURL: '/auth',
				logoutURL: '/logout',
				callbackUrl,
				scopes: [
					"publicData",
					"esi-skills.read_skills.v1",
					"esi-skills.read_skillqueue.v1",
					"esi-wallet.read_character_wallet.v1",
					"esi-clones.read_clones.v1",
					"esi-clones.read_implants.v1"
				]
			});
			installSingleTabEsiCoordinator(window.esi);
			console.log('ESI initialized');
		} catch (e) {
			console.log(e);
		}
	})();
}