const githubhash = "";
let routerInitialized = false;
const ESI_BASE = 'https://esi.evetech.net';
const LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHARACTER_DATA_TTL_MS = 60 * 60 * 1000;
const BACKGROUND_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const typeInfoCache = new Map();
const groupInfoCache = new Map();
const universeNameCache = new Map();
const localTypeInfoCache = new Map();
const localGroupInfoCache = new Map();
let localSdeDataPromise = null;
let skillEnablesIndexPromise = null;
const lookupStore = new DexieStore('skillq-lookups-db', 'skillq-lookups', 5 * 60 * 1000);
const characterDataStore = new DexieStore('skillq-character-data-db', 'skillq-character-data', 5 * 60 * 1000);
let backgroundRefreshInitialized = false;
let cacheAutoRenderInitialized = false;
let routeRerenderScheduled = false;
const LAST_BACKGROUND_REFRESH_KEY = '__meta:last-background-refresh';
const CHARACTER_DATA_UPDATED_EVENT = 'skillq:character-data-updated';
const CHARACTER_DATA_SYNC_CHANNEL_NAME = 'skillq:character-data-sync';
const CHARACTER_DATA_SYNC_TAB_ID = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const characterDataSyncChannel = typeof BroadcastChannel !== 'undefined'
	? new BroadcastChannel(CHARACTER_DATA_SYNC_CHANNEL_NAME)
	: null;
const LAYOUT_MODE_KEY = '__ui:layout-mode';
const THEME_MODE_KEY = '__ui:theme-mode';
const MANAGE_SETTINGS_KEY = '__ui:manage-settings';
const SKILL_ENABLES_INDEX_KEY = '__ui:skill-enables-index';
const SHARE_URL_VERSION = 1;
const SHARE_LINK_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
let layoutMode = 'restricted';
let themeMode = 'dark';

document.addEventListener('DOMContentLoaded', doBtnBinds);
document.addEventListener('DOMContentLoaded', main);

function doBtnBinds() {
	// bind buttons with class btn-bind to a function equivalent to the button's id
	Array.from(document.getElementsByClassName('btn-bind')).forEach((el) => {
		const id = el.id;
		if (id == null || id.trim().length == 0) return console.error('this btn-bind does not have an id', el);
		if (!window[id] || typeof window[id] != 'function') return console.error('button', id, 'does not have a matching function');
		el.addEventListener('click', window[id]); // assign the function with the same name
	});
}

async function main() {
	try {
		if (window.esi?.ready) {
			await window.esi.ready;
		}
		if (!window.esi) {
			throw new Error('ESI initialization failed or not available');
		}

		if (await handleRoute()) {
			await initThemeMode();
			await initLayoutMode();

			initCacheAutoRender();
			initSpaNavigation();
			initBackgroundCharacterRefresh();
			primeCharacterCachesOnStartup();
		}
	} catch (err) {
		console.error('Error in main():', err);
		document.getElementById('about').innerHTML = '<p>Error during initialization. <a href="/login">Click here to login</a>.</p>';
		document.getElementById('about').classList.remove('d-none');
		return;
	}
}

function isSpaPath(pathname) {
	return pathname === '/' || pathname === '/readme' || pathname === '/readme/' || pathname === '/share' || pathname === '/share/' || pathname.startsWith('/share/') || pathname === '/auth' || pathname === '/login' || pathname === '/login-check' || pathname === '/logout' || pathname === '/manage' || pathname === '/manage/' || pathname === '/settings' || pathname === '/settings/' || pathname === '/account' || pathname === '/account/' || pathname.startsWith('/char/') || pathname.startsWith('/item/');
}

function initSpaNavigation() {
	if (routerInitialized) return;
	routerInitialized = true;

	document.addEventListener('click', (event) => {
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

		const link = event.target.closest('a[href]');
		if (!link) return;
		if (link.target && link.target !== '_self') return;
		if (link.hasAttribute('download')) return;

		const href = link.getAttribute('href');
		if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;

		const url = new URL(link.href, window.location.origin);
		if (url.origin !== window.location.origin) return;
		if (!isSpaPath(url.pathname)) return;

		event.preventDefault();
		if (url.pathname === window.location.pathname) return;
		navigateTo(url.pathname + url.search + url.hash);
	});

	window.addEventListener('popstate', () => {
		handleRoute();
	});
}

async function navigateTo(path) {
	history.pushState(null, '', path);
	await handleRoute();
}

async function handleRoute() {
	const path = window.location.pathname;
	const route = parseRoute(path);

	if (path === '/auth') {
		// Let SimpleESI auth callback workflow run on this route.
		return false;
	}

	if (path === '/login-check') {
		if (window?.esi?.whoami !== null) {
			history.replaceState(null, '', '/');
			return false;
		}
		await window.esi.authBegin();
		return false;
	}

	if (path === '/login') {
		await window.esi.authBegin();
		return false;
	}

	if (path === '/logout') {
		const confirmed = window.confirm('Logging out deletes all locally stored SkillQ data. Next time you log in, you will need to re-add all characters. Continue?');
		if (!confirmed) {
			history.replaceState(null, '', '/');
			return false;
		}
		await clearAllLocalSkillQData();
		await window.esi.authLogout(true, false);
		history.replaceState(null, '', '/');
	}

	if (route.name === 'share') {
		await renderSharedCharacterPage();
		return false;
	}

	if (route.name === 'readme') {
		await renderReadmePage();
		return true;
	}

	if (window?.esi?.whoami === null) {
		if (path !== '/readme' && path !== '/readme/') {
			history.replaceState(null, '', '/readme');
		}
		await renderReadmePage();
		return true;
	}

	if (route.name === 'char') {
		await renderCharacterPage(route.charName, route.tab);
		return true;
	}

	if (route.name === 'item') {
		showItemLoading(route.itemId);
		await renderItemPage(route.itemId);
		return true;
	}

	if (route.name === 'manage') {
		await renderManagePage();
		return true;
	}

	if (route.name === 'settings') {
		if (path === '/account' || path === '/account/') {
			history.replaceState(null, '', '/settings');
		}
		await renderAccountPage();
		return true;
	}

	await renderLoggedInHome();
	return true;
}

function parseRoute(pathname) {
	const cleaned = pathname.replace(/\/+$/, '') || '/';
	if (cleaned === '/readme') {
		return { name: 'readme' };
	}
	if (cleaned === '/share' || cleaned.startsWith('/share/')) {
		return { name: 'share' };
	}
	if (cleaned === '/manage') {
		return { name: 'manage' };
	}
	if (cleaned === '/settings' || cleaned === '/account') {
		return { name: 'settings' };
	}
	if (cleaned.startsWith('/item/')) {
		const parts = cleaned.split('/').filter(Boolean);
		return {
			name: 'item',
			itemId: Number(parts[1] || 0)
		};
	}
	if (!cleaned.startsWith('/char/')) {
		return { name: 'home' };
	}

	const parts = cleaned.split('/').filter(Boolean);
	return {
		name: 'char',
		charName: decodeURIComponent(parts[1] || ''),
		tab: parts[2] || 'overview'
	};
}

function renderNavbarInto(root, options) {
	const existingNav = root.querySelector('.sq-nav');
	if (existingNav && canPatchNavbar(existingNav, options)) {
		patchNavbar(existingNav, options);
		return existingNav;
	}

	const nextNav = renderNavbar(options);
	root.replaceChildren(nextNav);
	return nextNav;
}

function canPatchNavbar(nav, { characters = [], isLoggedIn = false } = {}) {
	const hasAllLink = Boolean(nav.querySelector('.sq-nav__all-link'));
	const hasLoginButton = Boolean(nav.querySelector('.sq-btn--primary'));
	const hasDropdownAboutLink = Boolean(nav.querySelector('.sq-dropdown__menu a[href="/readme"]'));
	const hasLoggedOutAboutLink = Boolean(nav.querySelector('.sq-nav__actions > a[href="/readme"]'));
	if (isLoggedIn !== hasAllLink) return false;
	if (!isLoggedIn && !hasLoginButton) return false;
	if (isLoggedIn && !hasDropdownAboutLink) return false;
	if (!isLoggedIn && !hasLoggedOutAboutLink) return false;

	const charLinks = Array.from(nav.querySelectorAll('.sq-nav__char-link'));
	if (charLinks.length !== characters.length) return false;
	for (let index = 0; index < characters.length; index += 1) {
		const char = characters[index];
		const link = charLinks[index];
		if (!link) return false;
		if (String(link.dataset.characterId || '') !== String(char.character_id)) return false;
		if (String(link.title || '') !== String(char.name || '')) return false;
		if (String(link.getAttribute('href') || '') !== `/char/${encodeURIComponent(char.name)}`) return false;
	}

	return true;
}

function patchNavbar(nav, { currentCharId = null, isLoggedIn = false, layoutMode = 'restricted', isHome = false } = {}) {
	const allLink = nav.querySelector('.sq-nav__all-link');
	if (allLink) {
		allLink.classList.toggle('sq-nav__all-link--active', Boolean(isLoggedIn && isHome));
	}

	for (const link of nav.querySelectorAll('.sq-nav__char-link')) {
		const isActive = !isHome && String(link.dataset.characterId || '') === String(currentCharId || '');
		link.classList.toggle('sq-nav__char-link--active', isActive);
	}

	const layoutToggle = nav.querySelector('.sq-layout-toggle');
	if (layoutToggle) {
		layoutToggle.textContent = layoutMode === 'full' ? 'Use Restricted Width' : 'Use Full Width';
	}
}

function showItemLoading(itemId) {
	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.replaceChildren();
	cardsRoot.classList.add('d-none');
	document.getElementById('net-summary').classList.add('d-none');

	const charViewRoot = document.getElementById('char-view-root');
	const page = document.createElement('div');
	page.className = 'sq-char-view';

	const loading = document.createElement('div');
	loading.className = 'sq-loading';
	loading.setAttribute('role', 'status');
	loading.setAttribute('aria-live', 'polite');

	const spinner = document.createElement('span');
	spinner.className = 'sq-loading__spinner';
	spinner.setAttribute('aria-hidden', 'true');
	loading.appendChild(spinner);

	const textWrap = document.createElement('div');
	const title = document.createElement('p');
	title.className = 'sq-loading__title';
	title.textContent = `Loading item ${Number(itemId) || ''}...`;
	textWrap.appendChild(title);

	const detail = document.createElement('p');
	detail.className = 'sq-loading__detail';
	detail.textContent = 'Fetching item details, requirements, and enabled skills.';
	textWrap.appendChild(detail);

	loading.appendChild(textWrap);
	page.appendChild(loading);
	charViewRoot.replaceChildren(page);
	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
}

function renderCharacterShareControls({ character, skills = [], totalSP = 0, lastUpdatedAt = null } = {}) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'sq-char-info__action';
	button.setAttribute('aria-label', 'Copy share link');
	button.title = !Array.isArray(skills) || skills.length === 0
		? 'Share becomes available once overview skills are loaded.'
		: `Create a share link${lastUpdatedAt ? ` from ${formatDateTime(lastUpdatedAt)}` : ''}`;
	button.disabled = !Array.isArray(skills) || skills.length === 0;
	button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5a3 3 0 1 1 2.83 4H17l-6.2 3.35a3.02 3.02 0 0 1 0 1.3L17 17h.83A3 3 0 1 1 15 19a3 3 0 0 1 .2-1.08l-6.2-3.35a3 3 0 1 1 0-5.14l6.2-3.35A3 3 0 0 1 15 5Zm-8 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm10-4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm0 12a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" fill="currentColor"/></svg>';

	button.addEventListener('click', async () => {
		if (button.disabled) return;
		button.disabled = true;
		const previousTitle = button.title;
		button.title = 'Building share link...';
		try {
			const url = await buildCharacterShareUrl(character, skills, totalSP);
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url);
				button.title = 'Share link copied';
			} else {
				window.prompt('Copy share URL', url);
				button.title = 'Share link ready to copy';
			}
		} catch (err) {
			button.title = err?.message || 'Unable to build share link.';
		} finally {
			button.disabled = !Array.isArray(skills) || skills.length === 0;
			if (!button.disabled && button.title === 'Share link copied') {
				setTimeout(() => {
					button.title = previousTitle;
				}, 1800);
			} else if (!button.disabled && button.title === 'Share link ready to copy') {
				setTimeout(() => {
					button.title = previousTitle;
				}, 1800);
			} else if (!button.disabled && button.title !== 'Building share link...') {
				setTimeout(() => {
					button.title = previousTitle;
				}, 2600);
			}
		}
	});

	return button;
}

function buildShareSkillRecords(skills, queueWindowsBySkillId = null) {
	return (skills || [])
		.map((skill) => {
			const record = {
				type_id: Number(skill.typeID || 0),
				level: Math.max(0, Math.min(5, Number(skill.level || 0)))
			};
			const queueWindow = queueWindowsBySkillId?.get(Number(skill.typeID || 0)) || null;
			const trainingStartMs = Number(queueWindow?.startMs || 0);
			const trainingEndMs = Number(queueWindow?.endMs || 0);
			if (trainingStartMs > 0) {
				record.training_start = Math.floor(trainingStartMs / 1000);
			}
			if (trainingEndMs > 0) {
				record.training_end = Math.floor(trainingEndMs / 1000);
			}
			return record;
		})
		.filter((record) => record.type_id > 0);
}

async function buildCharacterShareUrl(character, skills, totalSP = 0) {
	if (typeof SkillUrlCodecSafe === 'undefined') {
		throw new Error('Share codec is not available.');
	}
	const characterId = String(character?.character_id || '');
	if (!characterId) {
		throw new Error('Character information is missing.');
	}
	const queueResponse = await window.esi
		.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/skillqueue/?datasource=tranquility`, 'GET', null, null, characterId)
		.catch(() => []);
	const queue = (Array.isArray(queueResponse) ? queueResponse : [])
		.slice(0, 25)
		.sort((a, b) => Number(a?.queue_position || 0) - Number(b?.queue_position || 0));

	// Encode each trained skill as a base record (current level, no timing)
	const trainedRecords = (skills || [])
		.filter((s) => Number(s.typeID || 0) > 0)
		.map((s) => ({
			type_id: Number(s.typeID),
			level: Math.max(0, Math.min(5, Number(s.level || 0)))
		}));

	// Encode each queue row as one record with compact timing:
	// first row keeps absolute start; all rows store end delta to previous queue boundary.
	let previousQueueEndUnix = 0;
	const queueRecords = queue
		.filter((row) => Number(row?.skill_id || 0) > 0)
		.map((row, index) => {
			const record = {
				type_id: Number(row.skill_id),
				level: Math.max(0, Math.min(5, Number(row.finished_level || 0)))
			};
			const startUnix = row.start_date ? Math.floor(Date.parse(row.start_date) / 1000) : 0;
			const endUnix = row.finish_date ? Math.floor(Date.parse(row.finish_date) / 1000) : 0;

			if (index === 0 && startUnix > 0) {
				record.training_start = startUnix;
			}

			if (endUnix > 0) {
				if (index === 0) {
					record.training_end = Math.max(0, endUnix - (startUnix > 0 ? startUnix : endUnix));
				} else if (previousQueueEndUnix > 0 && endUnix >= previousQueueEndUnix) {
					record.training_end = Math.max(0, endUnix - previousQueueEndUnix);
				} else {
					// Fallback keeps queue entries decodable if API timings are incomplete.
					record.training_end = endUnix;
				}
			}

			if (!Object.prototype.hasOwnProperty.call(record, 'training_end')) {
				record.training_end = 0;
			}

			if (endUnix > 0) {
				previousQueueEndUnix = endUnix;
			}
			return record;
		});

	const recordArray = [...trainedRecords, ...queueRecords];
	if (recordArray.length === 0) {
		throw new Error('No overview skills are available to share yet.');
	}
	const encodedSkills = await encodeShareSkillsPayload(recordArray);
	const shareContext = await getCharacterShareContext(characterId);
	const encodedTotalSP = encodeCompactInt(totalSP);
	const balanceCents = Math.max(0, Math.round(Number(character?.balance || 0) * 100));
	const encodedBalance = encodeCompactInt(balanceCents);
	const snapshotUnix = Math.floor(Date.now() / 1000);
	const encodedSnapshotUnix = encodeCompactInt(snapshotUnix);
	const signature = await createCharacterShareSignature(
		shareContext,
		encodedSkills,
		encodedTotalSP,
		encodedBalance,
		encodedSnapshotUnix
	);
	return `${window.location.origin}/share/${encodeURIComponent(characterId)}/${encodedSkills}.${signature}.${encodedTotalSP}.${encodedBalance}.${encodedSnapshotUnix}`;
}

async function renderCurrentNavbarForUtilityPage() {
	const navbarRoot = document.getElementById('navbar-root');
	if (window.esi?.whoami) {
		const characters = await window.esi.getLoggedInCharacters();
		const orderedCharacters = await getOrderedCharactersForNavbar(characters);
		renderNavbarInto(navbarRoot, {
			characters: orderedCharacters,
			isLoggedIn: true,
			layoutMode
		});
	} else {
		renderNavbarInto(navbarRoot, { isLoggedIn: false, layoutMode });
	}
	bindLayoutToggle();
}

async function renderReadmePage() {
	await renderCurrentNavbarForUtilityPage();
	await loadReadme();
	document.getElementById('about').classList.remove('d-none');
	document.getElementById('skillq').classList.add('d-none');
}

function findCurrentCorporationHistoryEntry(historyRows, corporationId) {
	return (historyRows || [])
		.filter((row) => Number(row?.corporation_id || 0) === Number(corporationId || 0))
		.sort((left, right) => {
			const leftTime = Date.parse(left?.start_date || left?.record_start_date || 0) || 0;
			const rightTime = Date.parse(right?.start_date || right?.record_start_date || 0) || 0;
			if (rightTime !== leftTime) return rightTime - leftTime;
			return Number(right?.record_id || 0) - Number(left?.record_id || 0);
		})[0] || null;
}

async function getCharacterShareContext(characterId) {
	const [charInfo, history] = await Promise.all([
		window.esi.doJsonRequest(`${ESI_BASE}/characters/${characterId}/?datasource=tranquility`),
		window.esi.doJsonRequest(`${ESI_BASE}/characters/${characterId}/corporationhistory/?datasource=tranquility`)
	]);

	const corporationId = Number(charInfo?.corporation_id || 0);
	const currentCorpHistory = findCurrentCorporationHistoryEntry(history, corporationId);
	const corporationJoinDate = currentCorpHistory?.start_date || currentCorpHistory?.record_start_date || '';
	if (!corporationId || !corporationJoinDate) {
		throw new Error('Current corporation signature data is unavailable for this character.');
	}

	const [corporation, alliance] = await Promise.all([
		corporationId ? getCorporationInfo(corporationId) : null,
		charInfo?.alliance_id ? getAllianceInfo(charInfo.alliance_id) : null
	]);

	return {
		character: {
			character_id: String(characterId),
			name: charInfo?.name || `Character ${characterId}`,
			corporation_id: corporationId,
			alliance_id: Number(charInfo?.alliance_id || 0) || null,
			balance: 0
		},
		corporation: corporation ? { corporation_id: corporationId, name: corporation.name } : null,
		alliance: alliance ? { alliance_id: Number(charInfo?.alliance_id || 0), name: alliance.name } : null,
		corporationJoinDate
	};
}

async function createCharacterShareSignature(shareContext, encodedSkills, encodedTotalSP = '', encodedBalance = '', encodedSnapshotUnix = '') {
	const signatureText = [
		`skillq-share-v${SHARE_URL_VERSION}`,
		String(shareContext.character.character_id || ''),
		String(shareContext.character.corporation_id || ''),
		String(shareContext.corporationJoinDate || ''),
		String(encodedSkills || ''),
		String(encodedTotalSP || ''),
		String(encodedBalance || ''),
		String(encodedSnapshotUnix || '')
	].join('|');
	return (await sha256Base64Url(signatureText)).slice(0, 16);
}

function encodeCompactInt(value) {
	const num = Math.max(0, Math.floor(Number(value || 0)));
	return num.toString(36);
}

function decodeCompactInt(value) {
	if (!value) return 0;
	const num = Number.parseInt(String(value), 36);
	return Number.isFinite(num) && num > 0 ? num : 0;
}

async function sha256Base64Url(text) {
	const bytes = new TextEncoder().encode(String(text || ''));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes) {
	let base64;
	if (typeof Buffer !== 'undefined') {
		base64 = Buffer.from(bytes).toString('base64');
	} else {
		let binary = '';
		for (let index = 0; index < bytes.length; index += 1) {
			binary += String.fromCharCode(bytes[index]);
		}
		base64 = btoa(binary);
	}
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(str) {
	const base64 = String(str || '')
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(String(str || '').length / 4) * 4, '=');

	if (typeof Buffer !== 'undefined') {
		return Uint8Array.from(Buffer.from(base64, 'base64'));
	}

	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function supportsShareCompressionStreams() {
	return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function gzipBytes(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

async function deflateBytes(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

async function gunzipBytes(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

async function inflateBytes(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

async function encodeShareSkillsPayload(records) {
	const rawPayload = SkillUrlCodecSafe.encode(records);
	if (!supportsShareCompressionStreams()) {
		return rawPayload;
	}

	try {
		const rawBytes = base64UrlToBytes(rawPayload);
		const candidates = [rawPayload];

		try {
			const deflated = await deflateBytes(rawBytes);
			candidates.push(`c2d_${bytesToBase64Url(deflated)}`);
		} catch (deflateErr) {
			console.warn('Deflate compression unavailable for share payload.', deflateErr);
		}

		try {
			const gzipped = await gzipBytes(rawBytes);
			candidates.push(`c2g_${bytesToBase64Url(gzipped)}`);
		} catch (gzipErr) {
			console.warn('Gzip compression unavailable for share payload.', gzipErr);
		}

		return candidates.reduce((shortest, candidate) => (candidate.length < shortest.length ? candidate : shortest), rawPayload);
	} catch (err) {
		console.warn('Unable to compress share payload, falling back to legacy format.', err);
		return rawPayload;
	}
}

async function decodeShareSkillsPayload(encodedSkills) {
	const payload = String(encodedSkills || '').trim();
	if (!payload) {
		throw new Error('This shared link is missing required data.');
	}

	if (!payload.startsWith('c1_')) {
		if (!payload.startsWith('c2d_') && !payload.startsWith('c2g_')) {
			return SkillUrlCodecSafe.decode(payload);
		}
	}

	if (!supportsShareCompressionStreams()) {
		throw new Error('This shared link needs CompressionStream support in your browser.');
	}

	try {
		if (payload.startsWith('c1_')) {
			const compressed = base64UrlToBytes(payload.slice(3));
			const decompressed = await gunzipBytes(compressed);
			const rawPayload = new TextDecoder().decode(decompressed);
			return SkillUrlCodecSafe.decode(rawPayload);
		}

		if (payload.startsWith('c2d_')) {
			const compressed = base64UrlToBytes(payload.slice(4));
			const decompressed = await inflateBytes(compressed);
			return SkillUrlCodecSafe.decode(bytesToBase64Url(decompressed));
		}

		if (payload.startsWith('c2g_')) {
			const compressed = base64UrlToBytes(payload.slice(4));
			const decompressed = await gunzipBytes(compressed);
			return SkillUrlCodecSafe.decode(bytesToBase64Url(decompressed));
		}

		return SkillUrlCodecSafe.decode(payload);
	} catch (err) {
		throw new Error('This shared link could not be decompressed.');
	}
}

async function hydrateSharedSkills(records) {
	const typeInfos = new Map(await Promise.all(records.map(async (record) => [record.type_id, await getTypeInfo(record.type_id)])));
	const groupIds = Array.from(new Set(Array.from(typeInfos.values()).map((info) => info?.group_id).filter(Boolean)));
	const groupInfos = new Map(await Promise.all(groupIds.map(async (groupId) => [groupId, await getGroupInfo(groupId)])));

	// Split: records without training times = trained-skill snapshots (one per skill, current level)
	//        records with training times = individual queue-position entries
	const trainedMap = new Map(); // type_id → max trained level
	const queueEntryRecords = [];
	for (const record of records) {
		const hasTime = Object.prototype.hasOwnProperty.call(record, 'training_start') || Object.prototype.hasOwnProperty.call(record, 'training_end');
		if (!hasTime) {
			const existing = trainedMap.get(record.type_id) || 0;
			trainedMap.set(record.type_id, Math.max(existing, Number(record.level || 0)));
		} else {
			queueEntryRecords.push(record);
		}
	}

	const compactQueueTimes = normalizeSharedQueueTimings(queueEntryRecords);

	// Build queue display entries (one per original queue position, sorted by start time)
	const queue = compactQueueTimes
		.map((record) => {
			const typeInfo = typeInfos.get(record.type_id);
			const groupInfo = groupInfos.get(typeInfo?.group_id);
			return {
				typeID: Number(record.type_id || 0),
				typeName: typeInfo?.name || `Skill ${record.type_id}`,
				groupID: Number(typeInfo?.group_id || 0),
				groupName: groupInfo?.name || 'Unknown Group',
				targetLevel: Number(record.level || 0),
				trainingStartMs: Number(record.training_start || 0) > 0 ? Number(record.training_start) * 1000 : 0,
				trainingEndMs: Number(record.training_end || 0) > 0 ? Number(record.training_end) * 1000 : 0
			};
		})
		.sort((a, b) => {
			const aStart = Number(a.trainingStartMs || 0);
			const bStart = Number(b.trainingStartMs || 0);
			if (aStart !== bStart) return aStart - bStart;
			return Number(a.trainingEndMs || 0) - Number(b.trainingEndMs || 0);
		});

	// Build per-skill entries for the grouped skill list
	const maxQueueLevel = new Map();
	for (const entry of queue) {
		maxQueueLevel.set(entry.typeID, Math.max(maxQueueLevel.get(entry.typeID) || 0, entry.targetLevel));
	}
	const allTypeIds = new Set([...trainedMap.keys(), ...queue.map((e) => e.typeID)]);
	const skills = Array.from(allTypeIds)
		.map((typeId) => {
			const typeInfo = typeInfos.get(typeId);
			const groupInfo = groupInfos.get(typeInfo?.group_id);
			const trainedLevel = trainedMap.get(typeId) || 0;
			const maxQueued = maxQueueLevel.get(typeId) || 0;
			return {
				typeID: typeId,
				typeName: typeInfo?.name || `Skill ${typeId}`,
				groupID: Number(typeInfo?.group_id || 0),
				groupName: groupInfo?.name || 'Unknown Group',
				level: trainedLevel,
				training: maxQueued > trainedLevel ? maxQueued : 0,
				queue: maxQueued,
				trainingStartMs: 0,
				trainingEndMs: 0
			};
		})
		.sort((a, b) => (a.groupName || '').localeCompare(b.groupName || '') || (a.typeName || '').localeCompare(b.typeName || ''));

	return { queue, skills };
}

function normalizeSharedQueueTimings(queueEntryRecords) {
	if (!Array.isArray(queueEntryRecords) || queueEntryRecords.length === 0) {
		return [];
	}

	const first = queueEntryRecords[0] || {};
	const firstStart = Number(first.training_start || 0);
	const firstEndRaw = Number(first.training_end || 0);
	const compactFormat = firstStart > 1000000000 && firstEndRaw >= 0 && firstEndRaw < firstStart;

	if (!compactFormat) {
		return queueEntryRecords;
	}

	let previousEnd = 0;
	return queueEntryRecords.map((record, index) => {
		const deltaEnd = Math.max(0, Number(record.training_end || 0));
		if (index === 0) {
			const start = Math.max(0, Number(record.training_start || 0));
			const end = start + deltaEnd;
			previousEnd = end;
			return {
				...record,
				training_start: start,
				training_end: end
			};
		}

		const start = previousEnd;
		const end = start + deltaEnd;
		previousEnd = end;
		return {
			...record,
			training_start: start,
			training_end: end
		};
	});
}

function findSharedTrainingSummary(queue) {
	const now = Date.now();
	const active = (queue || []).find((entry) => {
		const startMs = Number(entry.trainingStartMs || 0);
		const endMs = Number(entry.trainingEndMs || 0);
		return startMs > 0 && endMs > now && startMs <= now;
	});
	if (active) return active;
	return (queue || [])
		.filter((entry) => Number(entry.trainingEndMs || 0) > now)
		.sort((a, b) => Number(a.trainingStartMs || 0) - Number(b.trainingStartMs || 0))[0] || null;
}

function showSharedCharacterLoading(characterId) {
	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.replaceChildren();
	cardsRoot.classList.add('d-none');
	document.getElementById('net-summary').classList.add('d-none');

	const charViewRoot = document.getElementById('char-view-root');
	const page = document.createElement('div');
	page.className = 'sq-char-view';

	const loading = document.createElement('div');
	loading.className = 'sq-loading';
	loading.setAttribute('role', 'status');
	loading.setAttribute('aria-live', 'polite');

	const spinner = document.createElement('span');
	spinner.className = 'sq-loading__spinner';
	spinner.setAttribute('aria-hidden', 'true');
	loading.appendChild(spinner);

	const textWrap = document.createElement('div');
	const title = document.createElement('p');
	title.className = 'sq-loading__title';
	title.textContent = `Loading shared character ${characterId}...`;
	textWrap.appendChild(title);

	const detail = document.createElement('p');
	detail.className = 'sq-loading__detail';
	detail.textContent = 'Verifying the share signature and restoring the overview snapshot.';
	textWrap.appendChild(detail);

	loading.appendChild(textWrap);
	page.appendChild(loading);
	charViewRoot.replaceChildren(page);
	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
}

async function renderSharedCharacterPage() {
	const shareData = parseSharedCharacterRoute();
	const version = shareData.version;
	const characterId = shareData.characterId;
	const encodedSkills = shareData.encodedSkills;
	const providedSignature = shareData.signature;
	const encodedTotalSP = shareData.encodedTotalSP;
	const encodedBalance = shareData.encodedBalance;
	const encodedSnapshotUnix = shareData.encodedSnapshotUnix;
	const sharedTotalSP = decodeCompactInt(encodedTotalSP);
	const hasSharedBalance = encodedBalance !== '';
	const sharedBalance = decodeCompactInt(encodedBalance) / 100;
	const snapshotUnix = decodeCompactInt(encodedSnapshotUnix);

	await renderCurrentNavbarForUtilityPage();
	showSharedCharacterLoading(characterId || '');

	const charViewRoot = document.getElementById('char-view-root');
	const page = document.createElement('div');
	page.className = 'sq-char-view';

	try {
		if (version !== SHARE_URL_VERSION) {
			throw new Error('This shared link uses an unsupported format version.');
		}
		if (!characterId || !encodedSkills || !providedSignature) {
			throw new Error('This shared link is missing required data.');
		}
		if (snapshotUnix <= 0) {
			throw new Error('This shared link is missing a snapshot timestamp and is no longer valid.');
		}
		const nowUnix = Math.floor(Date.now() / 1000);
		if (snapshotUnix > nowUnix + 5 * 60) {
			throw new Error('This shared link has an invalid snapshot timestamp.');
		}
		if (nowUnix - snapshotUnix > SHARE_LINK_MAX_AGE_SECONDS) {
			throw new Error('This shared link has expired (older than 30 days).');
		}
		if (typeof SkillUrlCodecSafe === 'undefined') {
			throw new Error('Share codec is not available.');
		}

		const shareContext = await getCharacterShareContext(characterId);
		const expectedSignature = await createCharacterShareSignature(
			shareContext,
			encodedSkills,
			encodedTotalSP,
			encodedBalance,
			encodedSnapshotUnix
		);
		if (expectedSignature !== providedSignature) {
			throw new Error('Sorry, that share link is invalid.');
		}

		const decodedRecords = await decodeShareSkillsPayload(encodedSkills);
		const sharedData = await hydrateSharedSkills(decodedRecords);
		const trainingSummary = findSharedTrainingSummary(sharedData.queue);
		const sharedCharacter = {
			...shareContext.character,
			balance: hasSharedBalance ? sharedBalance : 0
		};
		const queueEmptyMs = sharedData.queue.length > 0
			? Math.max(0, ...sharedData.queue.map((e) => Number(e.trainingEndMs || 0)))
			: (trainingSummary?.trainingEndMs || 0);

		page.appendChild(renderCharInfo({
			character: sharedCharacter,
			corporation: shareContext.corporation,
			alliance: shareContext.alliance,
			training: trainingSummary ? {
				typeName: trainingSummary.typeName,
				level: trainingSummary.targetLevel || 0,
				trainingEndMs: trainingSummary.trainingEndMs,
				queueEmptyMs
			} : null,
			showBalance: hasSharedBalance
		}));

		const notice = document.createElement('div');
		notice.className = 'sq-alert';
		const snapshotText = snapshotUnix > 0
			? `Snapshot taken at ${formatDateTime(snapshotUnix * 1000)} UTC. `
			: '';
		notice.innerHTML = `
			<ul>
				<li>${snapshotText}</li>
				<li>Only first 25 skills in skill queue are shown.</li>
				<li>This link will automatically invalidate if the character changes corporations.</li>
				<li>Share links expire after 30 days.</li>
				<li>A crafty person <em>could</em> tamper with the URL to share fake character data.</li>
			</ul>
		`;
		page.appendChild(notice);

		page.appendChild(renderSharedCharSkills({ queue: sharedData.queue, skills: sharedData.skills, totalSP: sharedTotalSP }));
	} catch (err) {
		const alert = document.createElement('div');
		alert.className = 'sq-alert';
		alert.textContent = err?.message || 'This shared character could not be loaded.';
		page.appendChild(alert);
	}

	charViewRoot.replaceChildren(page);
	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
	startCountdowns();
}

function parseSharedCharacterRoute() {
	const pathname = window.location.pathname.replace(/\/+$/, '') || '/share';
	const parts = pathname.split('/').filter(Boolean);
	if (parts[0] === 'share' && parts.length >= 3) {
		const joined = parts.slice(2).join('/');
		const segments = joined.split('.');
		if (segments.length >= 5) {
			const encodedSnapshotUnix = segments.pop();
			const encodedBalance = segments.pop();
			const encodedTotalSP = segments.pop();
			const signature = segments.pop();
			const encodedSkills = segments.join('.');
			return {
				version: SHARE_URL_VERSION,
				characterId: decodeURIComponent(parts[1] || ''),
				encodedSkills,
				signature,
				encodedTotalSP,
				encodedBalance: encodedBalance || '',
				encodedSnapshotUnix: encodedSnapshotUnix || ''
			};
		}
		if (segments.length >= 4) {
			const encodedBalance = segments.pop();
			const encodedTotalSP = segments.pop();
			const signature = segments.pop();
			const encodedSkills = segments.join('.');
			return {
				version: SHARE_URL_VERSION,
				characterId: decodeURIComponent(parts[1] || ''),
				encodedSkills,
				signature,
				encodedTotalSP,
				encodedBalance: encodedBalance || '',
				encodedSnapshotUnix: ''
			};
		}
		const lastDot = joined.lastIndexOf('.');
		const secondLastDot = lastDot > 0 ? joined.lastIndexOf('.', lastDot - 1) : -1;
		if (secondLastDot > 0 && lastDot > secondLastDot) {
			return {
				version: SHARE_URL_VERSION,
				characterId: decodeURIComponent(parts[1] || ''),
				encodedSkills: joined.slice(0, secondLastDot),
				signature: joined.slice(secondLastDot + 1, lastDot),
				encodedTotalSP: joined.slice(lastDot + 1),
				encodedBalance: '',
				encodedSnapshotUnix: ''
			};
		}
		if (lastDot > 0) {
			return {
				version: SHARE_URL_VERSION,
				characterId: decodeURIComponent(parts[1] || ''),
				encodedSkills: joined.slice(0, lastDot),
				signature: joined.slice(lastDot + 1),
				encodedTotalSP: '',
				encodedBalance: '',
				encodedSnapshotUnix: ''
			};
		}
	}

	const params = new URLSearchParams(window.location.search);
	return {
		version: Number(params.get('v') || SHARE_URL_VERSION),
		characterId: String(params.get('character') || '').trim(),
		encodedSkills: String(params.get('skills') || '').trim(),
		signature: String(params.get('sig') || '').trim(),
		encodedTotalSP: String(params.get('sp') || '').trim(),
		encodedBalance: String(params.get('isk') || params.get('bal') || '').trim(),
		encodedSnapshotUnix: String(params.get('ts') || params.get('snapshot') || '').trim()
	};
}

async function renderLoggedInHome() {
	const characters = await window.esi.getLoggedInCharacters();
	const currentCharId = String(window.esi.whoami.character_id);
	const manageSettings = await getManageSettings();

	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.classList.remove('d-none');
	cardsRoot.replaceChildren();
	document.getElementById('char-view-root').replaceChildren();

	const summaries = await loadCharacterSummariesFromCache(characters);
	const orderedSummaries = orderCharacterSummaries(summaries, manageSettings);
	const orderedCharacters = orderedSummaries.map((summary) => ({
		character_id: String(summary.character.character_id),
		name: summary.character.name
	}));

	const navbarRoot = document.getElementById('navbar-root');
	renderNavbarInto(navbarRoot, {
		characters: orderedCharacters,
		currentCharId,
		isLoggedIn: true,
		layoutMode,
		isHome: true
	});
	bindLayoutToggle();

	let previousGroup = null;
	for (const summary of orderedSummaries) {
		const characterId = String(summary.character.character_id);
		const groupLabel = String(manageSettings.groupedByCharacterId?.[characterId] || '').trim();
		if (groupLabel !== previousGroup) {
			if (groupLabel.length > 0) {
				cardsRoot.appendChild(renderHomeGroupHeader(groupLabel));
			}
			previousGroup = groupLabel;
		}
		cardsRoot.appendChild(renderCharCard({
			character: summary.character,
			training: summary.training
		}));
	}

	refreshCharacterSummariesInBackground(characters);

	const netSummary = document.getElementById('net-summary');
	if (orderedSummaries.length > 1) {
		const totalIsk = orderedSummaries.reduce((acc, s) => acc + (s.character.balance || 0), 0);
		const totalSp = orderedSummaries.reduce((acc, s) => acc + (s.character.skillPoints || 0), 0);
		netSummary.innerHTML = `Net ISK: ${numberFormat(totalIsk, 2)}<br>Net SP: ${numberFormat(totalSp, 0)}`;
		netSummary.classList.remove('d-none');
	} else {
		netSummary.classList.add('d-none');
	}

	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
	startCountdowns();
}

async function renderCharacterPage(charName, tab = 'overview') {
	const characters = await window.esi.getLoggedInCharacters();
	const matched = characters.find((c) => c.name.toLowerCase() === charName.toLowerCase());
	if (!matched) {
		await renderLoggedInHome();
		return;
	}

	await window.esi.changeCharacter(String(matched.character_id));
	const characterId = String(window.esi.whoami.character_id);
	const activeTab = ['overview', 'wallet', 'train'].includes(tab) ? tab : 'overview';
	const data = await loadCharacterPageDataFromCache(characterId, activeTab);
	const orderedCharacters = await getOrderedCharactersForNavbar(characters);

	const navbarRoot = document.getElementById('navbar-root');
	renderNavbarInto(navbarRoot, {
		characters: orderedCharacters,
		currentCharId: characterId,
		isLoggedIn: true,
		layoutMode
	});
	bindLayoutToggle();

	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.replaceChildren();
	cardsRoot.classList.add('d-none');
	document.getElementById('net-summary').classList.add('d-none');

	const charViewRoot = document.getElementById('char-view-root');
	const infoSignature = buildCharacterInfoSignature(data);
	const messageText = data.message || '';

	let page = charViewRoot.querySelector('.sq-char-view[data-character-id]');
	const canPatchInPlace = page && page.dataset.characterId === characterId;

	const nextMenu = renderCharMenu({ charName: data.character.name, activeTab });
	nextMenu.dataset.role = 'char-menu';
	const nextContent = buildCharacterTabContent(data, activeTab);
	nextContent.dataset.role = 'char-tab-content';

	const nextActions = activeTab === 'overview' ? renderCharacterShareControls({
		character: data.character,
		skills: data.skills || [],
		totalSP: data.totalSP || 0,
		lastUpdatedAt: data.lastUpdatedAt || null
	}) : null;

	if (!canPatchInPlace) {
		page = document.createElement('div');
		page.className = 'sq-char-view';
		page.dataset.characterId = characterId;
		page.dataset.infoSignature = infoSignature;

		const alert = document.createElement('div');
		alert.className = 'sq-alert';
		alert.dataset.role = 'char-message';
		alert.hidden = !messageText;
		alert.textContent = messageText;
		page.appendChild(alert);

		const info = renderCharInfo({
			character: data.character,
			corporation: data.corporation,
			alliance: data.alliance,
			training: data.training,
			showBalance: true,
			actions: nextActions
		});
		info.dataset.role = 'char-info';
		page.appendChild(info);
		page.appendChild(nextMenu);
		page.appendChild(nextContent);
		charViewRoot.replaceChildren(page);
	} else {
		const existingMessage = page.querySelector('[data-role="char-message"]');
		if (existingMessage) {
			existingMessage.hidden = !messageText;
			existingMessage.textContent = messageText;
		}

		if (page.dataset.infoSignature !== infoSignature) {
			const existingInfo = page.querySelector('[data-role="char-info"]');
			const nextInfo = renderCharInfo({
				character: data.character,
				corporation: data.corporation,
				alliance: data.alliance,
				training: data.training,
				showBalance: true,
				actions: nextActions
			});
			nextInfo.dataset.role = 'char-info';
			if (existingInfo) existingInfo.replaceWith(nextInfo);
			page.dataset.infoSignature = infoSignature;
		} else {
			const actionWrap = page.querySelector('.sq-char-info__actions');
			if (actionWrap) actionWrap.remove();
			if (nextActions) {
				const existingInfo = page.querySelector('[data-role="char-info"]');
				if (existingInfo) {
					const nextActionWrap = document.createElement('div');
					nextActionWrap.className = 'sq-char-info__actions';
					nextActionWrap.appendChild(nextActions);
					existingInfo.appendChild(nextActionWrap);
				}
			}
		}

		const existingMenu = page.querySelector('[data-role="char-menu"]');
		if (existingMenu) existingMenu.replaceWith(nextMenu);

		const existingContent = page.querySelector('[data-role="char-tab-content"]');
		if (existingContent) existingContent.replaceWith(nextContent);
	}

	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
	startCountdowns();

	refreshCharacterPageInBackground(characterId, activeTab);
}

function buildCharacterInfoSignature(data) {
	return JSON.stringify({
		character: {
			character_id: String(data?.character?.character_id || ''),
			name: String(data?.character?.name || ''),
			corporation_id: Number(data?.character?.corporation_id || 0),
			alliance_id: Number(data?.character?.alliance_id || 0),
			balance: Number(data?.character?.balance || 0)
		},
		corporationName: String(data?.corporation?.name || ''),
		allianceName: String(data?.alliance?.name || ''),
		training: {
			typeName: String(data?.training?.typeName || ''),
			level: Number(data?.training?.level || 0),
			trainingEndMs: Number(data?.training?.trainingEndMs || 0),
			queueEmptyMs: Number(data?.training?.queueEmptyMs || 0)
		}
	});
}

function buildCharacterTabContent(data, activeTab) {
	const content = document.createElement('div');
	if (activeTab === 'wallet') {
		content.appendChild(renderCharWallet({ transactions: data.wallet || [] }));
		if (data.lastUpdatedAt) {
			const updated = document.createElement('p');
			updated.className = 'sq-muted sq-char-note';
			updated.textContent = `Last updated: ${formatDateTime(data.lastUpdatedAt)}`;
			content.appendChild(updated);
		}
		return content;
	}

	if (activeTab === 'train') {
		content.appendChild(renderCharTrain({ implants: data.implants || [], suggestions: data.suggestions || [] }));
		if (data.lastUpdatedAt) {
			const updated = document.createElement('p');
			updated.className = 'sq-muted sq-char-note';
			updated.textContent = `Last updated: ${formatDateTime(data.lastUpdatedAt)}`;
			content.appendChild(updated);
		}
		return content;
	}

	content.appendChild(renderCharSkills({
		queue: data.queue || [],
		skills: data.skills || [],
		totalSP: data.totalSP || 0,
		unallocatedSP: data.unallocatedSP || 0
	}));
	if (data.lastUpdatedAt) {
		const updated = document.createElement('p');
		updated.className = 'sq-muted sq-char-note';
		updated.textContent = `Last updated: ${formatDateTime(data.lastUpdatedAt)}`;
		content.appendChild(updated);
	}
	const note = document.createElement('p');
	note.className = 'sq-muted sq-char-note';
	note.textContent = 'ESI may return stale data until this specific character has logged into EVE.';
	content.appendChild(note);
	return content;
}

async function renderManagePage() {
	const characters = await window.esi.getLoggedInCharacters();
	const manageSettings = await getManageSettings();
	const summaries = await loadCharacterSummariesFromCache(characters);
	const orderedSummaries = orderCharacterSummaries(summaries, manageSettings);
	const orderedCharacters = orderedSummaries.map((summary) => ({
		character_id: String(summary.character.character_id),
		name: summary.character.name
	}));

	const navbarRoot = document.getElementById('navbar-root');
	renderNavbarInto(navbarRoot, {
		characters: orderedCharacters,
		isLoggedIn: true,
		layoutMode
	});
	bindLayoutToggle();

	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.replaceChildren();
	cardsRoot.classList.add('d-none');
	document.getElementById('net-summary').classList.add('d-none');

	const charViewRoot = document.getElementById('char-view-root');
	const page = document.createElement('div');
	page.className = 'sq-char-view';

	const container = document.createElement('div');
	container.className = 'sq-manage';

	const title = document.createElement('h3');
	title.className = 'sq-section-title';
	title.textContent = 'API Management';
	container.appendChild(title);

	const form = document.createElement('form');
	form.className = 'sq-manage-form';

	const table = document.createElement('table');
	table.className = 'sq-table sq-table--striped sq-table--compact';
	const thead = document.createElement('thead');
	thead.innerHTML = '<tr><th style="width: 8em;">Group</th><th style="width: 5em;">Custom</th><th>Character</th><th>Last Checked</th><th style="width: 5em;">Action</th></tr>';
	table.appendChild(thead);
	const tbody = document.createElement('tbody');

	for (const summary of orderedSummaries) {
		const char = summary.character;
		const charId = String(char.character_id);
		const row = document.createElement('tr');

		const groupCell = document.createElement('td');
		groupCell.dataset.label = 'Group';
		const groupInput = document.createElement('input');
		groupInput.type = 'text';
		groupInput.name = `group-${charId}`;
		groupInput.value = String(manageSettings.groupedByCharacterId?.[charId] || '');
		groupInput.className = 'sq-manage__input';
		groupCell.appendChild(groupInput);
		row.appendChild(groupCell);

		const customCell = document.createElement('td');
		customCell.dataset.label = 'Custom';
		const customInput = document.createElement('input');
		customInput.type = 'number';
		customInput.name = `custom-${charId}`;
		customInput.value = String(Number(manageSettings.customOrderByCharacterId?.[charId] || 0));
		customInput.className = 'sq-manage__input sq-text-right';
		customCell.appendChild(customInput);
		row.appendChild(customCell);

		const charCell = document.createElement('td');
		charCell.dataset.label = 'Character';
		const charLink = document.createElement('a');
		charLink.href = `/char/${encodeURIComponent(char.name)}`;
		charLink.textContent = char.name;
		charCell.appendChild(charLink);
		row.appendChild(charCell);

		const checkedCell = document.createElement('td');
		checkedCell.dataset.label = 'Last Checked';
		checkedCell.textContent = summary.updatedAt ? formatDateTime(summary.updatedAt) : 'Never';
		row.appendChild(checkedCell);

		const actionCell = document.createElement('td');
		actionCell.dataset.label = 'Action';
		actionCell.className = 'sq-text-right';
		const removeBtn = document.createElement('button');
		removeBtn.type = 'button';
		removeBtn.className = 'sq-btn sq-btn--danger sq-btn--sm';
		removeBtn.textContent = 'Remove';
		removeBtn.dataset.characterId = charId;
		removeBtn.dataset.characterName = char.name;
		removeBtn.addEventListener('click', () => {
			removeManagedCharacter(charId, char.name);
		});
		actionCell.appendChild(removeBtn);
		row.appendChild(actionCell);

		tbody.appendChild(row);
	}

	table.appendChild(tbody);
	form.appendChild(table);

	const controls = document.createElement('div');
	controls.className = 'sq-manage__controls';
	controls.innerHTML = '<label>Group Order</label>';
	const groupSelect = document.createElement('select');
	groupSelect.name = 'groupOrderBy';
	groupSelect.className = 'sq-manage__select';
	for (const option of [
		{ value: 'grouped desc', label: 'Group (desc)' },
		{ value: 'grouped asc', label: 'Group (asc)' }
	]) {
		const el = document.createElement('option');
		el.value = option.value;
		el.textContent = option.label;
		if (manageSettings.groupOrderBy === option.value) el.selected = true;
		groupSelect.appendChild(el);
	}
	controls.appendChild(groupSelect);

	const orderLabel = document.createElement('label');
	orderLabel.textContent = 'Order By';
	controls.appendChild(orderLabel);
	const orderSelect = document.createElement('select');
	orderSelect.name = 'orderBy';
	orderSelect.className = 'sq-manage__select';
	for (const option of [
		{ value: 'skillPoints desc', label: 'Skillpoints (desc)' },
		{ value: 'balance desc', label: 'Wallet Balance (desc)' },
		{ value: 'characterName', label: 'Name (asc)' },
		{ value: 'queueFinishes', label: 'Queue Finishes (asc)' },
		{ value: 'customOrder', label: 'Custom Order' }
	]) {
		const el = document.createElement('option');
		el.value = option.value;
		el.textContent = option.label;
		if (manageSettings.orderBy === option.value) el.selected = true;
		orderSelect.appendChild(el);
	}
	controls.appendChild(orderSelect);

	const saveBtn = document.createElement('button');
	saveBtn.type = 'submit';
	saveBtn.className = 'sq-btn sq-btn--primary';
	saveBtn.textContent = 'Save';
	controls.appendChild(saveBtn);

	form.appendChild(controls);
	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		await saveManageSettingsFromForm(form, characters);
		await renderManagePage();
	});

	container.appendChild(form);
	page.appendChild(container);
	charViewRoot.replaceChildren(page);

	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
}

async function renderAccountPage() {
	const characters = await window.esi.getLoggedInCharacters();
	const orderedCharacters = await getOrderedCharactersForNavbar(characters);

	const navbarRoot = document.getElementById('navbar-root');
	renderNavbarInto(navbarRoot, {
		characters: orderedCharacters,
		isLoggedIn: true,
		layoutMode
	});
	bindLayoutToggle();

	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.replaceChildren();
	cardsRoot.classList.add('d-none');
	document.getElementById('net-summary').classList.add('d-none');

	const charViewRoot = document.getElementById('char-view-root');
	const page = document.createElement('div');
	page.className = 'sq-char-view';

	const container = document.createElement('div');
	container.className = 'sq-account';

	const title = document.createElement('h3');
	title.className = 'sq-section-title';
	title.textContent = 'Settings';
	container.appendChild(title);

	const form = document.createElement('form');
	form.className = 'sq-account-form';

	const table = document.createElement('table');
	table.className = 'sq-table';
	const body = document.createElement('tbody');

	const fluidRow = document.createElement('tr');
	fluidRow.innerHTML = '<th>Fluid</th>';
	const fluidCell = document.createElement('td');
	const fluidSelect = document.createElement('select');
	fluidSelect.name = 'fluid';
	fluidSelect.className = 'sq-account__select';
	for (const option of [
		{ value: 'no', label: '3 Chars per Row' },
		{ value: 'yes', label: 'As many as can fit' }
	]) {
		const el = document.createElement('option');
		el.value = option.value;
		el.textContent = option.label;
		const isFull = layoutMode === 'full';
		if ((option.value === 'yes' && isFull) || (option.value === 'no' && !isFull)) {
			el.selected = true;
		}
		fluidSelect.appendChild(el);
	}
	fluidCell.appendChild(fluidSelect);
	fluidRow.appendChild(fluidCell);
	body.appendChild(fluidRow);

	const themeRow = document.createElement('tr');
	themeRow.innerHTML = '<th>Theme</th>';
	const themeCell = document.createElement('td');
	const themeSelect = document.createElement('select');
	themeSelect.name = 'themeMode';
	themeSelect.className = 'sq-account__select';
	for (const option of [
		{ value: 'dark', label: 'Dark (default)' },
		{ value: 'light', label: 'Light' },
		{ value: 'system', label: 'System' }
	]) {
		const el = document.createElement('option');
		el.value = option.value;
		el.textContent = option.label;
		if (themeMode === option.value) {
			el.selected = true;
		}
		themeSelect.appendChild(el);
	}
	themeCell.appendChild(themeSelect);
	themeRow.appendChild(themeCell);
	body.appendChild(themeRow);

	table.appendChild(body);
	form.appendChild(table);

	const actions = document.createElement('div');
	actions.className = 'sq-account__actions';
	const submit = document.createElement('button');
	submit.type = 'submit';
	submit.className = 'sq-btn sq-btn--primary';
	submit.textContent = 'Update';
	actions.appendChild(submit);
	form.appendChild(actions);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const fluid = String(form.elements.fluid?.value || 'no');
		const nextMode = fluid === 'yes' ? 'full' : 'restricted';
		const nextThemeMode = String(form.elements.themeMode?.value || 'dark');
		applyLayoutMode(nextMode);
		applyThemeMode(nextThemeMode);
		await lookupCacheSet(LAYOUT_MODE_KEY, { mode: nextMode });
		await lookupCacheSet(THEME_MODE_KEY, { mode: themeMode });
		await renderAccountPage();
	});

	container.appendChild(form);
	page.appendChild(container);
	charViewRoot.replaceChildren(page);

	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
}

async function renderItemPage(itemId) {
	const parsedItemId = Number(itemId || 0);
	if (!Number.isFinite(parsedItemId) || parsedItemId <= 0) {
		await renderLoggedInHome();
		return;
	}

	const characters = await window.esi.getLoggedInCharacters();
	const orderedCharacters = await getOrderedCharactersForNavbar(characters);

	const navbarRoot = document.getElementById('navbar-root');
	renderNavbarInto(navbarRoot, {
		characters: orderedCharacters,
		isLoggedIn: true,
		layoutMode
	});
	bindLayoutToggle();

	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.replaceChildren();
	cardsRoot.classList.add('d-none');
	document.getElementById('net-summary').classList.add('d-none');

	const charViewRoot = document.getElementById('char-view-root');
	const page = document.createElement('div');
	page.className = 'sq-char-view';
	const container = document.createElement('div');
	container.className = 'sq-item';

	let typeInfo = null;
	let groupInfo = null;
	try {
		typeInfo = await window.esi.doJsonRequest(`${ESI_BASE}/universe/types/${parsedItemId}/?datasource=tranquility&language=en`);
	} catch (_) {
		try {
			typeInfo = await getTypeInfo(parsedItemId);
		} catch (_) {
			typeInfo = null;
		}
	}

	try {
		groupInfo = await getGroupInfo(typeInfo?.group_id);
	} catch (_) {
		groupInfo = null;
	}

	if (!typeInfo || !typeInfo.name) {
		container.appendChild(_createItemTitle(`Item ${parsedItemId}`));
		container.appendChild(_createItemNotice('Item details could not be loaded.'));
		page.appendChild(container);
		charViewRoot.replaceChildren(page);
		document.getElementById('about').classList.add('d-none');
		document.getElementById('skillq').classList.remove('d-none');
		return;
	}

	const header = document.createElement('div');
	header.className = 'sq-item__header';
	const icon = document.createElement('img');
	icon.className = 'sq-item__icon';
	icon.src = `https://images.evetech.net/types/${parsedItemId}/icon?size=64`;
	icon.alt = typeInfo.name;
	header.appendChild(icon);

	const headingWrap = document.createElement('div');
	headingWrap.appendChild(_createItemTitle(typeInfo.name));
	const meta = document.createElement('p');
	meta.className = 'sq-muted';
	meta.textContent = `${groupInfo?.name || 'Unknown Group'} • Type ID ${parsedItemId}`;
	headingWrap.appendChild(meta);
	header.appendChild(headingWrap);
	container.appendChild(header);

	if (typeInfo.description) {
		const desc = document.createElement('p');
		desc.className = 'sq-item__description';
		desc.innerHTML = String(typeInfo.description).replace(/\n/g, '<br>');
		container.appendChild(desc);
	}

	const [requirements, enables] = await Promise.all([
		getItemRequirements(parsedItemId),
		_isSkillGroup(groupInfo) ? getSkillEnables(parsedItemId) : Promise.resolve([])
	]);

	if (requirements.length > 0) {
		container.appendChild(_createItemRequirementsSection(requirements));
	}

	if (enables.length > 0) {
		container.appendChild(_createItemEnablesSection(parsedItemId, typeInfo.name, enables));
	}

	const table = document.createElement('table');
	table.className = 'sq-table sq-table--striped sq-table--compact';
	const thead = document.createElement('thead');
	thead.innerHTML = '<tr><th>Field</th><th>Value</th></tr>';
	const tbody = document.createElement('tbody');
	for (const key of Object.keys(typeInfo).sort()) {
		const tr = document.createElement('tr');
		const keyTd = document.createElement('td');
		keyTd.textContent = key;
		const valueTd = document.createElement('td');
		valueTd.className = 'sq-item__value';
		valueTd.textContent = _formatItemFieldValue(typeInfo[key]);
		tr.appendChild(keyTd);
		tr.appendChild(valueTd);
		tbody.appendChild(tr);
	}
	table.appendChild(thead);
	table.appendChild(tbody);
	container.appendChild(_createPersistentItemSection({
		title: 'All ESI Item Fields',
		storageKey: `item:${parsedItemId}:fields`,
		defaultExpanded: true,
		content: table
	}));

	const pre = document.createElement('pre');
	pre.className = 'sq-item__json';
	pre.textContent = JSON.stringify(typeInfo, null, 2);
	container.appendChild(_createPersistentItemSection({
		title: 'Raw ESI JSON',
		storageKey: `item:${parsedItemId}:raw`,
		defaultExpanded: false,
		content: pre
	}));

	page.appendChild(container);
	charViewRoot.replaceChildren(page);
	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
}

function _createItemTitle(text) {
	const title = document.createElement('h3');
	title.className = 'sq-section-title';
	title.textContent = text;
	return title;
}

function _formatItemFieldValue(value) {
	if (value == null) return '';
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	try {
		return JSON.stringify(value);
	} catch (_) {
		return String(value);
	}
}

function _createItemNotice(message) {
	const alert = document.createElement('div');
	alert.className = 'sq-alert';
	alert.textContent = message;
	return alert;
}

function _createPersistentItemSection({ title, storageKey, content, defaultExpanded = false, onExpand = null } = {}) {
	const section = document.createElement('section');
	section.className = 'sq-item__section';

	const toggle = document.createElement('button');
	toggle.type = 'button';
	toggle.className = 'sq-item__section-toggle';
	toggle.textContent = title;

	const body = document.createElement('div');
	body.className = 'sq-item__section-body';
	body.appendChild(content);

	const expanded = _getStoredUiExpandedState(storageKey, defaultExpanded);
	toggle.setAttribute('aria-expanded', String(expanded));
	body.hidden = !expanded;
	let expandTask = null;

	async function ensureExpandedContent() {
		if (typeof onExpand !== 'function') return;
		if (expandTask) {
			await expandTask;
			return;
		}
		expandTask = Promise.resolve(onExpand(body)).catch((err) => {
			console.warn(`Failed to expand item section ${storageKey}`, err);
			throw err;
		});
		await expandTask;
	}

	toggle.addEventListener('click', () => {
		const open = toggle.getAttribute('aria-expanded') === 'true';
		const next = !open;
		toggle.setAttribute('aria-expanded', String(next));
		body.hidden = !next;
		_setStoredUiExpandedState(storageKey, next);
		if (next) {
			ensureExpandedContent();
		}
	});

	if (expanded) {
		ensureExpandedContent();
	}

	section.appendChild(toggle);
	section.appendChild(body);
	return section;
}

function _getStoredUiExpandedState(storageKey, fallback = false) {
	try {
		const value = window.localStorage.getItem(`skillq:${storageKey}`);
		if (value == null) return fallback;
		return value === '1';
	} catch (_) {
		return fallback;
	}
}

function _setStoredUiExpandedState(storageKey, value) {
	try {
		window.localStorage.setItem(`skillq:${storageKey}`, value ? '1' : '0');
	} catch (_) {
		// Ignore local UI state persistence failures.
	}
}

function _getDogmaValue(typeInfo, attributeId) {
	const entry = (typeInfo?.dogma_attributes || []).find((attr) => Number(attr.attribute_id) === Number(attributeId));
	return entry ? Number(entry.value) : null;
}

function _extractRequirementRows(typeInfo) {
	const pairs = [
		{ skillAttrId: 182, levelAttrId: 277 },
		{ skillAttrId: 183, levelAttrId: 278 },
		{ skillAttrId: 184, levelAttrId: 279 }
	];

	return pairs.map(({ skillAttrId, levelAttrId }) => ({
		typeID: Math.round(Number(_getDogmaValue(typeInfo, skillAttrId) || 0)),
		requiredSkillLevel: Math.round(Number(_getDogmaValue(typeInfo, levelAttrId) || 0))
	})).filter((row) => row.typeID > 0);
}

async function getItemRequirements(typeId, visited = new Set(), depth = 0) {
	const typeInfo = await getTypeInfo(typeId);
	const directRequirements = _extractRequirementRows(typeInfo);
	const rows = [];

	for (const requirement of directRequirements) {
		if (visited.has(requirement.typeID)) continue;
		visited.add(requirement.typeID);

		const skillInfo = await getTypeInfo(requirement.typeID);
		rows.push({
			typeID: requirement.typeID,
			typeName: skillInfo?.name || `Skill ${requirement.typeID}`,
			requiredSkillLevel: requirement.requiredSkillLevel,
			depth
		});

		const nested = await getItemRequirements(requirement.typeID, visited, depth + 1);
		rows.push(...nested);
	}

	return rows;
}

async function getSkillEnables(typeId) {
	const index = await getSkillEnablesIndex();
	return Array.isArray(index?.[String(typeId)]) ? index[String(typeId)] : [];
}

async function getSkillEnablesIndex() {
	if (skillEnablesIndexPromise) {
		return skillEnablesIndexPromise;
	}

	skillEnablesIndexPromise = (async () => {
		const cached = await lookupCacheGet(SKILL_ENABLES_INDEX_KEY);
		if (cached && typeof cached === 'object') {
			return cached;
		}

		await ensureLocalSdeDataLoaded();
		const skillIds = Array.from(localTypeInfoCache.keys())
			.map((id) => Number(id))
			.filter((id) => Number.isFinite(id) && id > 0)
			.sort((a, b) => a - b);

		const index = {};
		let cursor = 0;
		const workerCount = Math.min(12, Math.max(4, Math.ceil(skillIds.length / 80)));

		async function worker() {
			for (;;) {
				const currentIndex = cursor;
				cursor += 1;
				if (currentIndex >= skillIds.length) return;

				const skillId = skillIds[currentIndex];
				try {
					const typeInfo = await getTypeInfo(skillId);
					for (const requirement of _extractRequirementRows(typeInfo)) {
						const key = String(requirement.typeID);
						if (!Array.isArray(index[key])) {
							index[key] = [];
						}
						index[key].push({
							typeID: skillId,
							typeName: typeInfo?.name || `Skill ${skillId}`,
							neededLevel: requirement.requiredSkillLevel
						});
					}
				} catch (_) {
					// Skip skills that fail to resolve.
				}
			}
		}

		await Promise.all(Array.from({ length: workerCount }, () => worker()));

		for (const key of Object.keys(index)) {
			index[key].sort((a, b) => Number(a.neededLevel || 0) - Number(b.neededLevel || 0)
				|| String(a.typeName || '').localeCompare(String(b.typeName || '')));
		}

		await lookupCacheSet(SKILL_ENABLES_INDEX_KEY, index);
		return index;
	})();

	return skillEnablesIndexPromise;
}

function _createItemRequirementsSection(requirements) {
	const section = document.createElement('section');
	section.className = 'sq-item__section sq-item__block';

	const title = document.createElement('h4');
	title.className = 'sq-item__section-heading';
	title.textContent = 'Required Skills';
	section.appendChild(title);

	const body = document.createElement('div');
	body.className = 'sq-item__section-body sq-item__section-body--static';

	const list = document.createElement('div');
	list.className = 'sq-item__skill-list';

	for (const requirement of requirements) {
		list.appendChild(_createItemSkillRow({
			typeID: requirement.typeID,
			typeName: requirement.typeName + ' ' + toRomanNumeral(requirement.requiredSkillLevel),
			//metaText: `-`,
			depth: requirement.depth || 0
		}));
	}

	body.appendChild(list);
	section.appendChild(body);
	return section;
}

function _createItemEnablesSection(itemTypeId, itemName, enables) {
	const section = document.createElement('section');
	section.className = 'sq-item__section sq-item__block';

	const title = document.createElement('h4');
	title.className = 'sq-item__section-heading';
	title.textContent = 'This Skill Enables';
	section.appendChild(title);

	const body = document.createElement('div');
	body.className = 'sq-item__section-body sq-item__section-body--static';

	const groupsContent = document.createElement('div');
	groupsContent.className = 'sq-item__block';

	const groups = new Map();
	for (const enabled of enables) {
		const level = Math.max(1, Number(enabled.neededLevel || 0));
		if (!groups.has(level)) {
			groups.set(level, []);
		}
		groups.get(level).push(enabled);
	}

	for (const level of Array.from(groups.keys()).sort((a, b) => a - b)) {
		const group = document.createElement('div');
		group.className = 'sq-item__enables-group';

		const toggle = document.createElement('button');
		toggle.type = 'button';
		toggle.className = 'sq-item__enables-toggle';
		toggle.textContent = `${itemName} ${level}`;
		toggle.setAttribute('aria-expanded', 'false');
		group.appendChild(toggle);

		const body = document.createElement('div');
		body.className = 'sq-item__enables-body';
		body.hidden = true;

		for (const enabled of groups.get(level)) {
			body.appendChild(_createItemSkillRow({
				typeID: enabled.typeID,
				typeName: enabled.typeName,
				metaText: `Requires ${itemName} ${level}`,
				depth: 0
			}));
		}

		toggle.addEventListener('click', () => {
			const open = toggle.getAttribute('aria-expanded') === 'true';
			toggle.setAttribute('aria-expanded', String(!open));
			body.hidden = open;
		});

		group.appendChild(body);
		groupsContent.appendChild(group);
	}

	body.appendChild(groupsContent);
	section.appendChild(body);
	return section;
}

function _createItemSkillRow({ typeID, typeName, metaText = '', depth = 0 } = {}) {
	const row = document.createElement('div');
	row.className = 'sq-item__skill-row';
	row.style.paddingLeft = `${Math.max(0, Number(depth || 0)) * 1.2}rem`;

	const iconLink = document.createElement('a');
	iconLink.href = `/item/${typeID}`;
	iconLink.className = 'sq-item__skill-icon-link';
	const icon = document.createElement('img');
	icon.className = 'sq-item__skill-icon';
	icon.src = `https://images.evetech.net/types/${typeID}/icon?size=32`;
	icon.alt = typeName;
	iconLink.appendChild(icon);
	row.appendChild(iconLink);

	const text = document.createElement('div');
	text.className = 'sq-item__skill-text';
	const link = document.createElement('a');
	link.href = `/item/${typeID}`;
	link.textContent = typeName;
	text.appendChild(link);

	if (metaText) {
		const meta = document.createElement('div');
		meta.className = 'sq-item__skill-meta';
		meta.textContent = metaText;
		text.appendChild(meta);
	}

	row.appendChild(text);
	return row;
}

function _isSkillGroup(groupInfo) {
	return Number(groupInfo?.category_id || 0) === 16;
}

function _hasDogmaAttributes(typeInfo) {
	return Array.isArray(typeInfo?.dogma_attributes) && typeInfo.dogma_attributes.length > 0;
}

async function removeManagedCharacter(characterId, characterName) {
	const confirmed = window.confirm(`Remove ${characterName} from local SkillQ data on this browser?`);
	if (!confirmed) return;

	await window.esi.removeCharacter(characterId);
	await clearCharacterLocalData(characterId);
	await removeCharacterFromManageSettings(characterId);

	if (!window.esi.whoami) {
		history.replaceState(null, '', '/');
		await handleRoute();
		return;
	}

	await renderManagePage();
}

async function clearCharacterLocalData(characterId) {
	const charId = String(characterId);
	const keys = [
		`summary:${charId}`,
		`common:${charId}`,
		`wallet:${charId}`,
		`train:${charId}`,
		`overview:${charId}`
	];
	for (const key of keys) {
		await characterDataStore.delete(key);
	}
}

function orderCharacterSummaries(summaries, settings) {
	const manageSettings = normalizeManageSettings(settings);
	const grouped = manageSettings.groupedByCharacterId || {};
	const custom = manageSettings.customOrderByCharacterId || {};

	const sorted = [...summaries].sort((a, b) => {
		const aId = String(a.character.character_id);
		const bId = String(b.character.character_id);
		const aGroup = String(grouped[aId] || '').toLowerCase();
		const bGroup = String(grouped[bId] || '').toLowerCase();
		if (aGroup !== bGroup) {
			const dir = manageSettings.groupOrderBy === 'grouped asc' ? 1 : -1;
			return aGroup.localeCompare(bGroup) * dir;
		}

		const compareValue = compareByOrder(a, b, manageSettings.orderBy, custom);
		if (compareValue !== 0) return compareValue;
		return String(a.character.name || '').localeCompare(String(b.character.name || ''));
	});

	return sorted;
}

function renderHomeGroupHeader(groupLabel) {
	const wrapper = document.createElement('div');
	wrapper.className = 'sq-char-group';

	const heading = document.createElement('h4');
	heading.className = 'sq-char-group__title';
	heading.textContent = groupLabel;
	wrapper.appendChild(heading);

	const rule = document.createElement('hr');
	rule.className = 'sq-char-group__rule';
	wrapper.appendChild(rule);

	return wrapper;
}

function compareByOrder(a, b, orderBy, customMap) {
	if (orderBy === 'characterName') {
		return String(a.character.name || '').localeCompare(String(b.character.name || ''));
	}
	if (orderBy === 'balance desc') {
		return Number(b.character.balance || 0) - Number(a.character.balance || 0);
	}
	if (orderBy === 'queueFinishes') {
		const aQueue = Number(a.training?.queueEmptyMs || Number.MAX_SAFE_INTEGER);
		const bQueue = Number(b.training?.queueEmptyMs || Number.MAX_SAFE_INTEGER);
		return aQueue - bQueue;
	}
	if (orderBy === 'customOrder') {
		const aCustom = Number(customMap?.[String(a.character.character_id)] || 0);
		const bCustom = Number(customMap?.[String(b.character.character_id)] || 0);
		return aCustom - bCustom;
	}
	return Number(b.character.skillPoints || 0) - Number(a.character.skillPoints || 0);
}

async function getManageSettings() {
	const saved = await lookupCacheGet(MANAGE_SETTINGS_KEY);
	return normalizeManageSettings(saved);
}

function normalizeManageSettings(settings) {
	const allowedOrder = new Set(['characterName', 'balance desc', 'skillPoints desc', 'queueFinishes', 'customOrder']);
	const allowedGroupOrder = new Set(['grouped desc', 'grouped asc']);
	const orderBy = allowedOrder.has(settings?.orderBy) ? settings.orderBy : 'skillPoints desc';
	const groupOrderBy = allowedGroupOrder.has(settings?.groupOrderBy) ? settings.groupOrderBy : 'grouped desc';
	return {
		orderBy,
		groupOrderBy,
		customOrderByCharacterId: (settings?.customOrderByCharacterId && typeof settings.customOrderByCharacterId === 'object') ? settings.customOrderByCharacterId : {},
		groupedByCharacterId: (settings?.groupedByCharacterId && typeof settings.groupedByCharacterId === 'object') ? settings.groupedByCharacterId : {}
	};
}

async function saveManageSettingsFromForm(form, characters) {
	const settings = await getManageSettings();
	const orderBy = String(form.elements.orderBy?.value || settings.orderBy);
	const groupOrderBy = String(form.elements.groupOrderBy?.value || settings.groupOrderBy);

	const next = {
		orderBy,
		groupOrderBy,
		customOrderByCharacterId: { ...settings.customOrderByCharacterId },
		groupedByCharacterId: { ...settings.groupedByCharacterId }
	};

	for (const char of characters) {
		const charId = String(char.character_id);
		const customRaw = String(form.elements[`custom-${charId}`]?.value || '').trim();
		next.customOrderByCharacterId[charId] = Number(customRaw || 0);
		next.groupedByCharacterId[charId] = String(form.elements[`group-${charId}`]?.value || '').trim();
	}

	await lookupCacheSet(MANAGE_SETTINGS_KEY, normalizeManageSettings(next));
}

async function removeCharacterFromManageSettings(characterId) {
	const charId = String(characterId);
	const settings = await getManageSettings();
	delete settings.customOrderByCharacterId[charId];
	delete settings.groupedByCharacterId[charId];
	await lookupCacheSet(MANAGE_SETTINGS_KEY, normalizeManageSettings(settings));
}

async function getOrderedCharactersForNavbar(characters) {
	const list = Array.isArray(characters) ? characters : [];
	if (list.length <= 1) {
		return list;
	}

	const manageSettings = await getManageSettings();
	const summaries = await loadCharacterSummariesFromCache(list);
	const ordered = orderCharacterSummaries(summaries, manageSettings);
	return ordered.map((summary) => ({
		character_id: String(summary.character.character_id),
		name: summary.character.name
	}));
}

async function loadCharacterSummariesFromCache(characters) {
	const summaries = [];
	for (const char of characters) {
		const characterId = String(char.character_id);
		const cached = await cacheGetCharacterData(`summary:${characterId}`);
		const summary = cached || {
			character: {
				character_id: characterId,
				name: char.name,
				balance: 0,
				skillPoints: 0
			},
			training: null,
			updatedAt: 0
		};

		summary.character.name = summary.character.name || char.name;

		summaries.push(summary);
	}

	return summaries;
}

async function loadCharacterPageDataFromCache(characterId, tab) {
	const commonFallback = {
		character: {
			character_id: characterId,
			name: window.esi.whoami?.name || `Character ${characterId}`,
			corporation_id: null,
			alliance_id: null,
			balance: 0
		},
		corporation: null,
		alliance: null,
		training: null,
		message: 'Refreshing data in background...',
		updatedAt: 0
	};

	const data = (await cacheGetCharacterData(`common:${characterId}`)) || commonFallback;
	if (!data.message) {
		data.message = null;
	}
	let latestUpdatedAt = Number(data.updatedAt || 0);

	if (tab === 'wallet') {
		if (Number(data?.training?.trainingEndMs || 0) > 0 && Number(data.training.trainingEndMs) <= Date.now()) {
			const overviewCached = await cacheGetCharacterData(`overview:${characterId}`);
			applyOverviewTrainingToCommonData(data, overviewCached?.queue || []);
		}
		const walletCached = await cacheGetCharacterData(`wallet:${characterId}`);
		data.wallet = walletCached?.rows || [];
		latestUpdatedAt = Math.max(latestUpdatedAt, Number(walletCached?.updatedAt || 0));
		data.lastUpdatedAt = latestUpdatedAt || null;
		return data;
	}

	if (tab === 'train') {
		if (Number(data?.training?.trainingEndMs || 0) > 0 && Number(data.training.trainingEndMs) <= Date.now()) {
			const overviewCached = await cacheGetCharacterData(`overview:${characterId}`);
			applyOverviewTrainingToCommonData(data, overviewCached?.queue || []);
		}
		const trainData = (await cacheGetCharacterData(`train:${characterId}`)) || { implants: [], suggestions: [], updatedAt: 0 };
		data.implants = trainData.implants;
		data.suggestions = trainData.suggestions;
		latestUpdatedAt = Math.max(latestUpdatedAt, Number(trainData.updatedAt || 0));
		data.lastUpdatedAt = latestUpdatedAt || null;
		return data;
	}

	const skillsData = (await cacheGetCharacterData(`overview:${characterId}`)) || {
		queue: [],
		skills: [],
		totalSP: 0,
		unallocatedSP: 0,
		updatedAt: 0
	};
	if (data.training?.typeName && !Number(data.training?.level || 0)) {
		const queuedLevel = Number(skillsData?.queue?.[0]?.level || 0);
		if (queuedLevel > 0) {
			data.training.level = queuedLevel;
		}
	}
	applyOverviewTrainingToCommonData(data, skillsData.queue || []);
	data.queue = skillsData.queue;
	data.skills = skillsData.skills;
	data.totalSP = skillsData.totalSP;
	data.unallocatedSP = skillsData.unallocatedSP;
	latestUpdatedAt = Math.max(latestUpdatedAt, Number(skillsData.updatedAt || 0));
	data.lastUpdatedAt = latestUpdatedAt || null;
	return data;
}

async function refreshCharacterSummariesInBackground(characters) {
	for (const char of characters) {
		refreshCharacterSummaryInBackground(String(char.character_id), char.name);
	}
}

async function refreshCharacterSummaryInBackground(characterId, characterName) {
	const summaryKey = `summary:${characterId}`;
	const cachedSummary = await cacheGetCharacterData(summaryKey);
	const missingTrainingLevel = Boolean(cachedSummary?.training?.typeName)
		&& !Number(cachedSummary?.training?.level || 0);
	const finishedTraining = hasTrainingCompleted(cachedSummary?.training);
	if (!(await shouldRefreshCharacterData(summaryKey)) && !missingTrainingLevel && !finishedTraining) {
		return;
	}

	try {
		const [balance, skills, queue] = await Promise.all([
			window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/wallet/?datasource=tranquility`, 'GET', null, null, characterId),
			window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/skills/?datasource=tranquility`, 'GET', null, null, characterId),
			window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/skillqueue/?datasource=tranquility`, 'GET', null, null, characterId)
		]);

		let training = null;
		if (Array.isArray(queue) && queue.length > 0) {
			const active = pickCurrentOrNextQueueRow(queue);
			if (active) {
				const queueEmptyMs = Math.max(0, ...queue.map((row) => (row?.finish_date ? (Date.parse(row.finish_date) || 0) : 0)));
				const typeInfo = await getTypeInfo(active?.skill_id);
				training = {
					typeName: typeInfo?.name || null,
					level: Number(active?.finished_level || 0),
					trainingEndMs: active?.finish_date ? Date.parse(active.finish_date) : 0,
					queueEmptyMs
				};
			}
		}

		await cacheSetCharacterData(`summary:${characterId}`, {
			character: {
				character_id: characterId,
				name: characterName,
				balance: Number(balance || 0),
				skillPoints: Number(skills?.total_sp || 0)
			},
			training,
			updatedAt: Date.now()
		}) || await cacheTouchCharacterData(`summary:${characterId}`);
	} catch (err) {
		console.warn(`Background summary refresh failed for ${characterId}`, err);
	}
}

async function refreshCharacterPageInBackground(characterId, tab) {
	const commonKey = `common:${characterId}`;
	const cachedCommon = await cacheGetCharacterData(commonKey);
	const missingTrainingLevel = Boolean(cachedCommon?.training?.typeName)
		&& !Number(cachedCommon?.training?.level || 0);
	const finishedTraining = hasTrainingCompleted(cachedCommon?.training);
	if (!(await shouldRefreshCharacterData(commonKey)) && !missingTrainingLevel && !finishedTraining) {
		if (tab === 'wallet' && !(await shouldRefreshCharacterData(`wallet:${characterId}`))) return;
		if (tab === 'train' && !(await shouldRefreshCharacterData(`train:${characterId}`))) return;
		if (tab === 'overview' && !(await shouldRefreshCharacterData(`overview:${characterId}`))) return;
	}

	try {
		if (missingTrainingLevel || finishedTraining || (await shouldRefreshCharacterData(commonKey))) {
			const common = await fetchCharacterCommonData(characterId);
			common.message = null;
			common.updatedAt = Date.now();
			await cacheSetCharacterData(commonKey, common) || await cacheTouchCharacterData(commonKey);
		}

		if (tab === 'wallet') {
			if (!(await shouldRefreshCharacterData(`wallet:${characterId}`))) return;
			const wallet = await fetchWalletRows(characterId);
			await cacheSetCharacterData(`wallet:${characterId}`, { rows: wallet, updatedAt: Date.now() })
				|| await cacheTouchCharacterData(`wallet:${characterId}`);
			return;
		}

		if (tab === 'train') {
			if (!(await shouldRefreshCharacterData(`train:${characterId}`))) return;
			const train = await fetchTrainingSuggestions(characterId);
			train.updatedAt = Date.now();
			await cacheSetCharacterData(`train:${characterId}`, train)
				|| await cacheTouchCharacterData(`train:${characterId}`);
			return;
		}

		if (!(await shouldRefreshCharacterData(`overview:${characterId}`))) return;
		const overview = await fetchSkillsOverview(characterId);
		overview.updatedAt = Date.now();
		await cacheSetCharacterData(`overview:${characterId}`, overview)
			|| await cacheTouchCharacterData(`overview:${characterId}`);
	} catch (err) {
		console.warn(`Background page refresh failed for ${characterId}`, err);
	}
}

function initBackgroundCharacterRefresh() {
	if (backgroundRefreshInitialized) return;
	backgroundRefreshInitialized = true;

	triggerScheduledBackgroundRefresh();
	setInterval(() => {
		triggerScheduledBackgroundRefresh();
	}, BACKGROUND_REFRESH_INTERVAL_MS);
}

async function initLayoutMode() {
	const saved = await lookupCacheGet(LAYOUT_MODE_KEY);
	const mode = saved?.mode === 'full' ? 'full' : 'restricted';
	applyLayoutMode(mode);
}

async function initThemeMode() {
	const saved = await lookupCacheGet(THEME_MODE_KEY);
	const mode = (saved?.mode === 'light' || saved?.mode === 'system') ? saved.mode : 'dark';
	applyThemeMode(mode);
}

function applyThemeMode(mode) {
	themeMode = (mode === 'light' || mode === 'system') ? mode : 'dark';
	document.body.classList.toggle('sq-theme-dark', themeMode === 'dark');
	document.body.classList.toggle('sq-theme-light', themeMode === 'light');
	document.body.classList.toggle('sq-theme-system', themeMode === 'system');
}

function applyLayoutMode(mode) {
	layoutMode = mode === 'full' ? 'full' : 'restricted';
	document.body.classList.toggle('sq-layout-full', layoutMode === 'full');
	document.body.classList.toggle('sq-layout-restricted', layoutMode !== 'full');
}

function bindLayoutToggle() {
	const toggle = document.querySelector('.sq-layout-toggle');
	if (!toggle) return;
	if (toggle.dataset.bound === 'true') return;
	toggle.dataset.bound = 'true';
	toggle.addEventListener('click', (event) => {
		event.preventDefault();
		toggleLayoutMode();
	});
}

async function toggleLayoutMode() {
	const next = layoutMode === 'full' ? 'restricted' : 'full';
	applyLayoutMode(next);
	await lookupCacheSet(LAYOUT_MODE_KEY, { mode: next });
	await handleRoute();
}

function initCacheAutoRender() {
	if (cacheAutoRenderInitialized) return;
	cacheAutoRenderInitialized = true;

	window.addEventListener(CHARACTER_DATA_UPDATED_EVENT, () => {
		scheduleRouteRerender();
	});

	if (characterDataSyncChannel) {
		characterDataSyncChannel.addEventListener('message', (event) => {
			const message = event.data || {};
			if (message.type !== CHARACTER_DATA_UPDATED_EVENT) return;
			if (message.fromTabId === CHARACTER_DATA_SYNC_TAB_ID) return;
			window.dispatchEvent(new CustomEvent(CHARACTER_DATA_UPDATED_EVENT, {
				detail: {
					key: message.key,
					remote: true
				}
			}));
		});
	}
}

function scheduleRouteRerender() {
	if (routeRerenderScheduled) return;
	routeRerenderScheduled = true;
	setTimeout(() => {
		routeRerenderScheduled = false;
		if (!window.esi?.whoami) return;
		if (window.location.pathname === '/auth') return;
		handleRoute();
	}, 120);
}

async function triggerScheduledBackgroundRefresh() {
	if (!(await shouldRunScheduledRefresh())) {
		return;
	}
	await refreshAllCharactersInBackground();
	await cacheSetCharacterData(LAST_BACKGROUND_REFRESH_KEY, { updatedAt: Date.now() }, null);
}

async function refreshAllCharactersInBackground() {
	try {
		if (!window.esi?.whoami) return;
		console.log('Running scheduled background character data refresh');

		const characters = await window.esi.getLoggedInCharacters();
		const tasks = [];
		for (const char of characters) {
			const characterId = String(char.character_id);
			tasks.push(refreshCharacterSummaryInBackground(characterId, char.name));
			tasks.push(refreshCharacterPageInBackground(characterId, 'overview'));
			tasks.push(refreshCharacterPageInBackground(characterId, 'wallet'));
			tasks.push(refreshCharacterPageInBackground(characterId, 'train'));
		}
		await Promise.allSettled(tasks);
	} catch (err) {
		console.warn('Background character refresh scheduler failed', err);
	}
}

async function primeCharacterCachesOnStartup() {
	if (!window.esi?.whoami) return;

	try {
		const characters = await window.esi.getLoggedInCharacters();
		const tasks = [];
		for (const char of characters) {
			const characterId = String(char.character_id);
			const [summaryCached, commonCached] = await Promise.all([
				cacheGetCharacterData(`summary:${characterId}`),
				cacheGetCharacterData(`common:${characterId}`)
			]);

			if (!summaryCached) {
				tasks.push(refreshCharacterSummaryInBackground(characterId, char.name));
			}
			if (!commonCached) {
				tasks.push(refreshCharacterPageInBackground(characterId, 'overview'));
			}
		}

		if (tasks.length > 0) {
			await Promise.allSettled(tasks);
		}
	} catch (err) {
		console.warn('Initial character cache priming failed', err);
	}
}

async function shouldRunScheduledRefresh() {
	const meta = await cacheGetCharacterData(LAST_BACKGROUND_REFRESH_KEY);
	const last = Number(meta?.updatedAt || 0);
	return !last || (Date.now() - last) >= BACKGROUND_REFRESH_INTERVAL_MS;
}

async function shouldRefreshCharacterData(key) {
	const cached = await cacheGetCharacterData(key);
	const last = Number(cached?.updatedAt || 0);
	return !last || (Date.now() - last) >= CHARACTER_DATA_TTL_MS;
}

async function fetchCharacterCommonData(characterId) {
	const [charInfo, balance, queue] = await Promise.all([
		window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/?datasource=tranquility`, 'GET', null, null, characterId),
		window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/wallet/?datasource=tranquility`, 'GET', null, null, characterId),
		window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/skillqueue/?datasource=tranquility`, 'GET', null, null, characterId).catch(() => [])
	]);

	const [corporation, alliance] = await Promise.all([
		charInfo?.corporation_id ? getCorporationInfo(charInfo.corporation_id) : null,
		charInfo?.alliance_id ? getAllianceInfo(charInfo.alliance_id) : null
	]);

	let training = null;
	if (Array.isArray(queue) && queue.length > 0) {
		const active = pickCurrentOrNextQueueRow(queue);
		if (active) {
			const queueEmptyMs = Math.max(0, ...queue.map((row) => (row?.finish_date ? (Date.parse(row.finish_date) || 0) : 0)));
			const typeInfo = await getTypeInfo(active.skill_id);
			training = {
				typeName: typeInfo?.name || `Skill ${active.skill_id}`,
				level: Number(active.finished_level || 0),
				trainingEndMs: active.finish_date ? Date.parse(active.finish_date) : 0,
				queueEmptyMs
			};
		}
	}

	return {
		character: {
			character_id: characterId,
			name: charInfo?.name || window.esi.whoami.name,
			corporation_id: charInfo?.corporation_id || null,
			alliance_id: charInfo?.alliance_id || null,
			balance: Number(balance || 0)
		},
		corporation: corporation ? { corporation_id: charInfo.corporation_id, name: corporation.name } : null,
		alliance: alliance ? { alliance_id: charInfo.alliance_id, name: alliance.name } : null,
		training,
		message: null
	};
}

async function fetchSkillsOverview(characterId) {
	const [skillsResponse, queueResponse] = await Promise.all([
		window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/skills/?datasource=tranquility`, 'GET', null, null, characterId),
		window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/skillqueue/?datasource=tranquility`, 'GET', null, null, characterId).catch(() => [])
	]);

	const skills = skillsResponse?.skills || [];
	const queue = Array.isArray(queueResponse) ? queueResponse : [];
	const skillIds = Array.from(new Set([...skills.map((s) => s.skill_id), ...queue.map((q) => q.skill_id)].filter(Boolean)));
	const typeInfos = new Map(await Promise.all(skillIds.map(async (skillId) => [skillId, await getTypeInfo(skillId)])));
	const groupIds = Array.from(new Set(Array.from(typeInfos.values()).map((info) => info?.group_id).filter(Boolean)));
	const groupInfos = new Map(await Promise.all(groupIds.map(async (groupId) => [groupId, await getGroupInfo(groupId)])));

	const queueRows = queue.map((row) => {
		const typeInfo = typeInfos.get(row.skill_id);
		const groupInfo = groupInfos.get(typeInfo?.group_id);
		return {
			typeName: typeInfo?.name || `Skill ${row.skill_id}`,
			typeID: row.skill_id,
			groupName: groupInfo?.name || '',
			level: Number(row.finished_level || 0),
			startDate: row.start_date || null,
			endDate: row.finish_date || null,
			spHour: calculateSpPerHour(row)
		};
	});

	const maxQueuedLevels = new Map();
	const activeQueueRow = pickCurrentOrNextQueueRow(queue);
	const activeTrainingSkillId = Number(activeQueueRow?.skill_id || 0);
	const activeTrainingStartMs = activeQueueRow?.start_date ? Date.parse(activeQueueRow.start_date) : 0;
	const activeTrainingEndMs = activeQueueRow?.finish_date ? Date.parse(activeQueueRow.finish_date) : 0;
	for (const row of queue) {
		const existing = maxQueuedLevels.get(row.skill_id) || 0;
		maxQueuedLevels.set(row.skill_id, Math.max(existing, Number(row.finished_level || 0)));
	}

	const skillRows = skills.map((row) => {
		const typeInfo = typeInfos.get(row.skill_id);
		const groupInfo = groupInfos.get(typeInfo?.group_id);
		const activeQueue = queue.find((q) => q.skill_id === row.skill_id);
		const isCurrentlyTraining = Number(row.skill_id || 0) === activeTrainingSkillId && activeTrainingEndMs > Date.now();
		return {
			typeName: typeInfo?.name || `Skill ${row.skill_id}`,
			typeID: row.skill_id,
			groupName: groupInfo?.name || '',
			groupID: typeInfo?.group_id || 0,
			skillPoints: Number(row.skillpoints_in_skill || 0),
			level: Number(row.trained_skill_level ?? row.active_skill_level ?? 0),
			training: activeQueue ? Number(activeQueue.finished_level || 0) : 0,
			queue: maxQueuedLevels.get(row.skill_id) || 0,
			isCurrentlyTraining,
			trainingStartMs: isCurrentlyTraining ? (activeTrainingStartMs || 0) : 0,
			trainingEndMs: isCurrentlyTraining ? (activeTrainingEndMs || 0) : 0
		};
	}).sort((a, b) => (a.groupName || '').localeCompare(b.groupName || '') || a.typeName.localeCompare(b.typeName));

	return {
		queue: queueRows,
		skills: skillRows,
		totalSP: Number(skillsResponse?.total_sp || 0),
		unallocatedSP: Number(skillsResponse?.unallocated_sp || 0)
	};
}

function pickCurrentOrNextQueueRow(queueRows) {
	const now = Date.now();
	const rows = Array.isArray(queueRows) ? queueRows : [];
	const active = rows.find((row) => {
		const startMs = row?.start_date ? Date.parse(row.start_date) : 0;
		const endMs = row?.finish_date ? Date.parse(row.finish_date) : 0;
		return startMs > 0 && endMs > now && startMs <= now;
	});
	if (active) return active;
	return rows
		.filter((row) => {
			const endMs = row?.finish_date ? Date.parse(row.finish_date) : 0;
			return endMs > now;
		})
		.sort((left, right) => {
			const leftStart = left?.start_date ? (Date.parse(left.start_date) || 0) : 0;
			const rightStart = right?.start_date ? (Date.parse(right.start_date) || 0) : 0;
			if (leftStart !== rightStart) return leftStart - rightStart;
			const leftEnd = left?.finish_date ? (Date.parse(left.finish_date) || 0) : 0;
			const rightEnd = right?.finish_date ? (Date.parse(right.finish_date) || 0) : 0;
			return leftEnd - rightEnd;
		})[0] || null;
}

function pickCurrentOrNextOverviewQueueEntry(queueRows) {
	const now = Date.now();
	const rows = Array.isArray(queueRows) ? queueRows : [];
	const active = rows.find((row) => {
		const startMs = row?.startDate ? Date.parse(row.startDate) : 0;
		const endMs = row?.endDate ? Date.parse(row.endDate) : 0;
		return startMs > 0 && endMs > now && startMs <= now;
	});
	if (active) return active;
	return rows
		.filter((row) => {
			const endMs = row?.endDate ? Date.parse(row.endDate) : 0;
			return endMs > now;
		})
		.sort((left, right) => {
			const leftStart = left?.startDate ? (Date.parse(left.startDate) || 0) : 0;
			const rightStart = right?.startDate ? (Date.parse(right.startDate) || 0) : 0;
			if (leftStart !== rightStart) return leftStart - rightStart;
			const leftEnd = left?.endDate ? (Date.parse(left.endDate) || 0) : 0;
			const rightEnd = right?.endDate ? (Date.parse(right.endDate) || 0) : 0;
			return leftEnd - rightEnd;
		})[0] || null;
}

function hasTrainingCompleted(training) {
	const endMs = Number(training?.trainingEndMs || 0);
	return endMs > 0 && endMs <= Date.now();
}

function applyOverviewTrainingToCommonData(data, queueRows) {
	const nextEntry = pickCurrentOrNextOverviewQueueEntry(queueRows || []);
	if (!nextEntry) return;
	const queueEmptyMs = Math.max(0, ...(queueRows || []).map((row) => (row?.endDate ? (Date.parse(row.endDate) || 0) : 0)));
	data.training = {
		typeName: nextEntry.typeName || '',
		level: Number(nextEntry.level || 0),
		trainingEndMs: nextEntry.endDate ? Date.parse(nextEntry.endDate) : 0,
		queueEmptyMs
	};
}

async function fetchWalletRows(characterId) {
	const rows = await window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/wallet/journal/?datasource=tranquility&page=1`, 'GET', null, null, characterId).catch(() => []);
	const ids = Array.from(new Set(rows.flatMap((row) => [row.first_party_id, row.second_party_id]).filter((id) => Number(id) > 0)));
	const names = await resolveUniverseNames(ids);

	return rows.map((row) => ({
		dttm: formatDateTime(row.date),
		refTypeName: humanizeSlug(row.ref_type),
		ownerName1: names.get(row.first_party_id) || String(row.first_party_id || ''),
		ownerName2: names.get(row.second_party_id) || String(row.second_party_id || ''),
		amount: Number(row.amount || 0),
		balance: Number(row.balance || 0),
		reason: row.description || ''
	}));
}

async function fetchTrainingSuggestions(characterId) {
	const [attributes, implants, skillsResponse] = await Promise.all([
		window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/attributes/?datasource=tranquility`, 'GET', null, null, characterId).catch(() => null),
		window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/implants/?datasource=tranquility`, 'GET', null, null, characterId).catch(() => []),
		window.esi.doJsonAuthRequest(`${ESI_BASE}/characters/${characterId}/skills/?datasource=tranquility`, 'GET', null, null, characterId).catch(() => ({ skills: [] }))
	]);

	const implantInfos = await Promise.all((implants || []).slice(0, 5).map((typeId) => getTypeInfo(typeId)));
	const attributeRows = ['charisma', 'intelligence', 'memory', 'perception', 'willpower'].map((attributeName, index) => ({
		attributeName,
		baseValue: Number(attributes?.[attributeName] || 0),
		bonus: 0,
		implantName: implantInfos[index]?.name || ''
	})).filter((row) => row.baseValue > 0 || row.implantName);

	const suggestions = await buildTrainingSuggestions(skillsResponse?.skills || [], attributes);
	return { implants: attributeRows, suggestions };
}

async function buildTrainingSuggestions(skills, attributes) {
	const candidates = skills.filter((skill) => Number(skill.trained_skill_level ?? 0) < 5).slice(0, 25);
	const typeInfos = new Map(await Promise.all(candidates.map(async (row) => [row.skill_id, await getTypeInfo(row.skill_id)])));
	const suggestions = [];

	for (const row of candidates) {
		const typeInfo = typeInfos.get(row.skill_id);
		const dogma = new Map((typeInfo?.dogma_attributes || []).map((attr) => [attr.attribute_id, attr.value]));
		const primaryAttribute = attributeIdToName(dogma.get(180));
		const secondaryAttribute = attributeIdToName(dogma.get(181));
		const rank = Number(dogma.get(275) || 1);
		const currentLevel = Number(row.trained_skill_level || 0);
		const currentSp = Number(row.skillpoints_in_skill || 0);
		const targetSp = getSkillPointsForLevel(5, rank);
		const remainingSp = Math.max(0, targetSp - currentSp);
		const spPerHour = calculateSkillSpPerHour(attributes, primaryAttribute, secondaryAttribute);
		suggestions.push({
			typeName: typeInfo?.name || `Skill ${row.skill_id}`,
			typeID: row.skill_id,
			level: currentLevel,
			time: spPerHour > 0 ? formatDuration(Math.ceil(remainingSp / spPerHour * 3600)) : 'Unknown',
			primaryAttribute,
			secondaryAttribute,
			skillPoints: currentSp,
			training: 0,
			queue: 0,
			remainingSeconds: spPerHour > 0 ? Math.ceil(remainingSp / spPerHour * 3600) : Number.MAX_SAFE_INTEGER
		});
	}

	return suggestions.sort((a, b) => a.remainingSeconds - b.remainingSeconds).slice(0, 20);
}

async function getTypeInfo(typeId) {
	if (!typeId) return null;
	if (typeInfoCache.has(typeId)) return typeInfoCache.get(typeId);
	let localInfo = null;
	const cached = await lookupCacheGet(`type-info:${typeId}`);
	await ensureLocalSdeDataLoaded();
	if (cached && (_hasDogmaAttributes(cached) || !localTypeInfoCache.has(String(typeId)))) {
		typeInfoCache.set(typeId, cached);
		return cached;
	}
	if (localTypeInfoCache.has(String(typeId))) {
		localInfo = localTypeInfoCache.get(String(typeId));
		if (_hasDogmaAttributes(localInfo)) {
			typeInfoCache.set(typeId, localInfo);
			await lookupCacheSet(`type-info:${typeId}`, localInfo);
			return localInfo;
		}
	}
	try {
		const remoteInfo = await window.esi.doJsonRequest(`${ESI_BASE}/universe/types/${typeId}/?datasource=tranquility&language=en`);
		const info = {
			...(localInfo || {}),
			...(cached || {}),
			...(remoteInfo || {}),
			dogma_attributes: Array.isArray(remoteInfo?.dogma_attributes) ? remoteInfo.dogma_attributes : (localInfo?.dogma_attributes || cached?.dogma_attributes || [])
		};
		typeInfoCache.set(typeId, info);
		await lookupCacheSet(`type-info:${typeId}`, info);
		return info;
	} catch (_) {
		if (cached) {
			typeInfoCache.set(typeId, cached);
			return cached;
		}
		if (localInfo) {
			typeInfoCache.set(typeId, localInfo);
			await lookupCacheSet(`type-info:${typeId}`, localInfo);
			return localInfo;
		}
		const fallback = { name: `Skill ${typeId}`, group_id: null, dogma_attributes: [] };
		typeInfoCache.set(typeId, fallback);
		await lookupCacheSet(`type-info:${typeId}`, fallback);
		return fallback;
	}
}

async function getGroupInfo(groupId) {
	if (!groupId) return null;
	if (groupInfoCache.has(groupId)) return groupInfoCache.get(groupId);
	const cached = await lookupCacheGet(`group-info:${groupId}`);
	if (cached) {
		groupInfoCache.set(groupId, cached);
		return cached;
	}
	await ensureLocalSdeDataLoaded();
	if (localGroupInfoCache.has(String(groupId))) {
		const info = localGroupInfoCache.get(String(groupId));
		groupInfoCache.set(groupId, info);
		await lookupCacheSet(`group-info:${groupId}`, info);
		return info;
	}
	try {
		const info = await window.esi.doJsonRequest(`${ESI_BASE}/universe/groups/${groupId}/?datasource=tranquility&language=en`);
		groupInfoCache.set(groupId, info);
		await lookupCacheSet(`group-info:${groupId}`, info);
		return info;
	} catch (_) {
		const fallback = { name: '' };
		groupInfoCache.set(groupId, fallback);
		await lookupCacheSet(`group-info:${groupId}`, fallback);
		return fallback;
	}
}

async function ensureLocalSdeDataLoaded() {
	if (localSdeDataPromise) {
		return localSdeDataPromise;
	}

	localSdeDataPromise = (async () => {
		const [types, groups] = await Promise.all([
			fetchLocalJson('/data/types.json'),
			fetchLocalJson('/data/groups.json')
		]);

		for (const [id, info] of Object.entries(types)) {
			localTypeInfoCache.set(String(id), info);
		}

		for (const [id, info] of Object.entries(groups)) {
			localGroupInfoCache.set(String(id), info);
		}
	})();

	return localSdeDataPromise;
}

async function fetchLocalJson(path) {
	try {
		const response = await fetch(path);
		if (!response.ok) return {};
		return await response.json();
	} catch (_) {
		return {};
	}
}

async function resolveUniverseNames(ids) {
	const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
	const unresolved = [];
	for (const id of uniqueIds) {
		if (universeNameCache.has(id)) continue;
		const cachedName = await lookupCacheGet(`universe-name:${id}`);
		if (cachedName) {
			universeNameCache.set(id, cachedName);
		} else {
			unresolved.push(id);
		}
	}
	if (unresolved.length > 0) {
		try {
			const results = await window.esi.doJsonRequest(`${ESI_BASE}/universe/names/?datasource=tranquility`, 'POST', window.esi.mimetypeJson, JSON.stringify(unresolved));
			for (const row of results || []) {
				universeNameCache.set(row.id, row.name);
				await lookupCacheSet(`universe-name:${row.id}`, row.name);
			}
		} catch (_) {
			// Keep cache misses unresolved.
		}
	}

	return new Map(uniqueIds.map((id) => [id, universeNameCache.get(id) || null]));
}

async function getCorporationInfo(corporationId) {
	if (!corporationId) return null;
	const cacheKey = `corporation-info:${corporationId}`;
	const cached = await lookupCacheGet(cacheKey);
	if (cached) return cached;
	try {
		const info = await window.esi.doJsonRequest(`${ESI_BASE}/corporations/${corporationId}/?datasource=tranquility`);
		await lookupCacheSet(cacheKey, info);
		return info;
	} catch (_) {
		return null;
	}
}

async function getAllianceInfo(allianceId) {
	if (!allianceId) return null;
	const cacheKey = `alliance-info:${allianceId}`;
	const cached = await lookupCacheGet(cacheKey);
	if (cached) return cached;
	try {
		const info = await window.esi.doJsonRequest(`${ESI_BASE}/alliances/${allianceId}/?datasource=tranquility`);
		await lookupCacheSet(cacheKey, info);
		return info;
	} catch (_) {
		return null;
	}
}

async function lookupCacheGet(key) {
	try {
		return await lookupStore.get(key);
	} catch (_) {
		return null;
	}
}

async function lookupCacheSet(key, value) {
	try {
		await lookupStore.set(key, value, LOOKUP_TTL_MS);
	} catch (_) {
		// Ignore cache write failures.
	}
}

async function cacheGetCharacterData(key) {
	try {
		return await characterDataStore.get(key);
	} catch (_) {
		return null;
	}
}

function normalizeCharacterCacheValueForCompare(key, value) {
	if (value == null) return value;
	if (key === LAST_BACKGROUND_REFRESH_KEY) return value;
	if (typeof value !== 'object' || Array.isArray(value)) return value;
	const clone = { ...value };
	delete clone.updatedAt;
	return clone;
}

function toStableComparableValue(value) {
	if (Array.isArray(value)) {
		return value.map((item) => toStableComparableValue(item));
	}
	if (value && typeof value === 'object') {
		const sorted = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = toStableComparableValue(value[key]);
		}
		return sorted;
	}
	return value;
}

function areCharacterCacheValuesEqual(key, left, right) {
	const normalizedLeft = normalizeCharacterCacheValueForCompare(key, left);
	const normalizedRight = normalizeCharacterCacheValueForCompare(key, right);
	return JSON.stringify(toStableComparableValue(normalizedLeft))
		=== JSON.stringify(toStableComparableValue(normalizedRight));
}

async function cacheSetCharacterData(key, value) {
	try {
		const existing = await characterDataStore.get(key);
		if (areCharacterCacheValuesEqual(key, existing, value)) {
			return false;
		}
		const ttl = key === LAST_BACKGROUND_REFRESH_KEY ? null : CHARACTER_DATA_TTL_MS;
		await characterDataStore.set(key, value, ttl);
		if (key !== LAST_BACKGROUND_REFRESH_KEY) {
			window.dispatchEvent(new CustomEvent(CHARACTER_DATA_UPDATED_EVENT, { detail: { key } }));
			characterDataSyncChannel?.postMessage({
				type: CHARACTER_DATA_UPDATED_EVENT,
				key,
				fromTabId: CHARACTER_DATA_SYNC_TAB_ID
			});
		}
		return true;
	} catch (_) {
		// Ignore cache write failures.
		return false;
	}
}

async function cacheTouchCharacterData(key) {
	try {
		const existing = await characterDataStore.get(key);
		if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
			return false;
		}
		const ttl = key === LAST_BACKGROUND_REFRESH_KEY ? null : CHARACTER_DATA_TTL_MS;
		await characterDataStore.set(key, {
			...existing,
			updatedAt: Date.now()
		}, ttl);
		return true;
	} catch (_) {
		return false;
	}
}

async function clearAllLocalSkillQData() {
	try {
		await Promise.all([
			lookupStore.clearAll(),
			characterDataStore.clearAll()
		]);
	} catch (_) {
		// Ignore local cache clear failures and still continue logout.
	}

	try {
		for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
			const key = window.localStorage.key(index);
			if (key && key.startsWith('skillq:')) {
				window.localStorage.removeItem(key);
			}
		}
	} catch (_) {
		// Ignore localStorage clear failures.
	}
}

function formatDateTime(value) {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const Y = date.getUTCFullYear();
	const M = String(date.getUTCMonth() + 1).padStart(2, '0');
	const D = String(date.getUTCDate()).padStart(2, '0');
	const h = String(date.getUTCHours()).padStart(2, '0');
	const m = String(date.getUTCMinutes()).padStart(2, '0');
	return `${Y}-${M}-${D} ${h}:${m}`;
}

function calculateSpPerHour(queueRow) {
	const startSp = Number(queueRow.training_start_sp ?? queueRow.level_start_sp ?? 0);
	const endSp = Number(queueRow.level_end_sp ?? queueRow.finished_level ?? 0);
	const start = queueRow.start_date ? Date.parse(queueRow.start_date) : 0;
	const finish = queueRow.finish_date ? Date.parse(queueRow.finish_date) : 0;
	if (!start || !finish || finish <= start || endSp <= startSp) return 0;
	return ((endSp - startSp) / ((finish - start) / 3600000));
}

function humanizeSlug(value) {
	if (!value) return '';
	return String(value)
		.split('_')
		.map((part) => capitalizeFirst(part))
		.join(' ');
}

function attributeIdToName(attributeId) {
	const map = {
		164: 'charisma',
		165: 'intelligence',
		166: 'memory',
		167: 'perception',
		168: 'willpower'
	};
	return map[Number(attributeId)] || '';
}

function calculateSkillSpPerHour(attributes, primaryAttribute, secondaryAttribute) {
	const primary = Number(attributes?.[primaryAttribute] || 0);
	const secondary = Number(attributes?.[secondaryAttribute] || 0);
	if (primary <= 0) return 0;
	return (primary + (secondary / 2)) * 60;
}

function getSkillPointsForLevel(level, rank) {
	const multipliers = {
		1: 250,
		2: 1415,
		3: 8000,
		4: 45255,
		5: 256000
	};
	return Math.ceil((multipliers[level] || 0) * Math.max(1, Number(rank || 1)));
}

async function loadReadme() {
	try {
		const response = await fetch('/README.md');
		if (!response.ok) throw new Error(`Failed to fetch README: ${response.status}`);
		const markdown = await response.text();
		
		// Wait for marked.js to load
		if (typeof marked === 'undefined') {
			console.warn('marked.js not loaded yet, retrying...');
			await new Promise(resolve => setTimeout(resolve, 100));
			return loadReadme();
		}
		
		// Convert markdown to HTML and inject
		const html = marked.parse(markdown);
		const about = document.getElementById('about');
		about.innerHTML = html;
		// Rewrite skillq.net URLs to local paths
		about.querySelectorAll('a[href^="https://skillq.net/"]').forEach(a => {
			a.href = a.getAttribute('href').replace('https://skillq.net', '');
		});
		about.querySelectorAll('img[src^="https://skillq.net/"]').forEach(img => {
			img.src = img.getAttribute('src').replace('https://skillq.net', '');
		});
	} catch (err) {
		console.error('Failed to load README:', err);
		document.getElementById('about').innerHTML = '<p>Error loading README. <a href="/login">Click here to login</a>.</p>';
	}
}