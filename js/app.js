let routerInitialized = false;
const ESI_BASE = 'https://esi.evetech.net';
const LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHARACTER_DATA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CHARACTER_DATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BACKGROUND_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const BACKGROUND_REFRESH_JOB_INTERVAL_MS = 3 * 1000;
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
const removingCharactersForAuthError = new Set();
const LAST_BACKGROUND_REFRESH_KEY = '__meta:last-background-refresh';
const CHARACTER_DATA_UPDATED_EVENT = 'skillq:character-data-updated';
const CHARACTER_DATA_SYNC_CHANNEL_NAME = 'skillq:character-data-sync';
const CHARACTER_DATA_SYNC_TAB_ID = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const TRAIN_CACHE_KEY_PREFIX = 'train-v5';
const CHARACTER_NOTE_KEY_PREFIX = 'notes';
const CHARACTER_NOTE_MAX_LENGTH = 10000;
const CHARACTER_NOTE_AUTOSAVE_DELAY_MS = 2000;
const characterDataSyncChannel = typeof BroadcastChannel !== 'undefined'
	? new BroadcastChannel(CHARACTER_DATA_SYNC_CHANNEL_NAME)
	: null;
const LAYOUT_MODE_KEY = '__ui:layout-mode';
const THEME_MODE_KEY = '__ui:theme-mode';
const MANAGE_SETTINGS_KEY = '__ui:manage-settings';
const SKILL_ENABLES_INDEX_KEY = '__ui:skill-enables-index';
const PERSISTENT_LOOKUP_KEYS = new Set([
	LAYOUT_MODE_KEY,
	THEME_MODE_KEY,
	MANAGE_SETTINGS_KEY
]);
const BACKUP_KIND = 'skillq-backup';
const BACKUP_VERSION = 1;
const BACKUP_ZIP_ENTRY_NAME = 'skillq-backup.enc.json';
const BACKUP_FILENAME_PREFIX = 'skillq-backup';
const SIMPLEESI_GLOBAL_WHOAMI_PREFIX = 'simpleesi-global-whoami-';
const SIMPLEESI_CHAR_KEY_PREFIX = 'simpleesi-';
const SIMPLEESI_AUTHED_SUFFIX = '-authed_json';
const SHARE_URL_VERSION = 1;
const SHARE_LINK_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SHARE_EMPTY_SKILLS_TOKEN = 'none';
const SHARE_SECTION_KEYS = {
	overviewSkills: 'overviewSkills',
	skillQueue: 'skillQueue',
	totalSkillPoints: 'totalSkillPoints',
	walletBalance: 'walletBalance',
	jumpClones: 'jumpClones',
	notes: 'notes'
};
let githubhash = "6129896";
const staticCacheHash = window.location.hostname === 'localhost' ? Date.now() : '6129896';
let layoutMode = 'restricted';
let themeMode = 'dark';

function withStaticCacheHash(path) {
	const cacheValue = githubhash || staticCacheHash;
	const separator = path.includes('?') ? '&' : '?';
	return `${path}${separator}v=${encodeURIComponent(cacheValue)}`;
}

function getTrainCacheKey(characterId) {
	return `${TRAIN_CACHE_KEY_PREFIX}:${characterId}`;
}

function getSkillInjectorYield(totalSkillPoints) {
	const total = Math.max(0, Number(totalSkillPoints || 0));
	if (total < 5_000_000) return 500_000;
	if (total < 50_000_000) return 400_000;
	if (total < 80_000_000) return 300_000;
	return 150_000;
}

function estimateSkillInjectors(requiredSkillPoints, totalSkillPoints) {
	const requiredValue = Number(requiredSkillPoints || 0);
	const totalValue = Number(totalSkillPoints || 0);
	const required = Number.isFinite(requiredValue) ? Math.max(0, Math.ceil(requiredValue)) : 0;
	let projectedTotal = Number.isFinite(totalValue) ? Math.max(0, Math.floor(totalValue)) : 0;
	let injectedSkillPoints = 0;
	let injectorCount = 0;

	while (injectedSkillPoints < required) {
		const yieldAmount = getSkillInjectorYield(projectedTotal);
		injectedSkillPoints += yieldAmount;
		projectedTotal += yieldAmount;
		injectorCount += 1;
	}

	return { injectorCount, injectedSkillPoints };
}

function buildQueueInjectorEstimate(skillsResponse, queueRows, now = Date.now()) {
	const skills = Array.isArray(skillsResponse?.skills) ? skillsResponse.skills : [];
	const queue = Array.isArray(queueRows) ? queueRows : [];
	const skillSpById = new Map(skills.map((row) => [
		Number(row?.skill_id || 0),
		Number(row?.skillpoints_in_skill || 0)
	]));
	const inferredCurrentSpById = new Map(skillSpById);
	let queueSkillPoints = 0;

	for (const row of queue) {
		const startSp = Number(row?.training_start_sp ?? row?.level_start_sp ?? 0);
		const endSp = Number(row?.level_end_sp ?? 0);
		if (!(endSp > startSp)) continue;

		const startMs = row?.start_date ? (Date.parse(row.start_date) || 0) : 0;
		const endMs = row?.finish_date ? (Date.parse(row.finish_date) || 0) : 0;
		const skillId = Number(row?.skill_id || 0);
		if (endMs > 0 && endMs <= now) {
			inferredCurrentSpById.set(skillId, Math.max(Number(inferredCurrentSpById.get(skillId) || 0), endSp));
			continue;
		}

		let currentSp = startSp;
		if (startMs > 0 && endMs > now && startMs <= now) {
			const reportedSp = Number(inferredCurrentSpById.get(skillId) || startSp);
			const elapsedFraction = Math.min(1, Math.max(0, (now - startMs) / (endMs - startMs)));
			const timeEstimatedSp = startSp + ((endSp - startSp) * elapsedFraction);
			currentSp = Math.min(endSp, Math.max(startSp, reportedSp, timeEstimatedSp));
			inferredCurrentSpById.set(skillId, currentSp);
		}

		queueSkillPoints += Math.max(0, endSp - currentSp);
	}

	queueSkillPoints = Math.ceil(queueSkillPoints);
	const allocatedSkillPoints = Math.max(0, Number(skillsResponse?.total_sp || 0));
	const unallocatedSkillPoints = Math.max(0, Number(skillsResponse?.unallocated_sp || 0));
	const requiredSkillPoints = Math.max(0, queueSkillPoints - unallocatedSkillPoints);
	const inferredUnreportedSkillPoints = Array.from(inferredCurrentSpById).reduce((total, [skillId, inferredSp]) => (
		total + Math.max(0, Number(inferredSp || 0) - Number(skillSpById.get(skillId) || 0))
	), 0);
	const overallSkillPoints = allocatedSkillPoints + unallocatedSkillPoints + inferredUnreportedSkillPoints;
	const injection = estimateSkillInjectors(requiredSkillPoints, overallSkillPoints);

	return {
		queueSkillPoints,
		unallocatedSkillPoints,
		requiredSkillPoints,
		injectorCount: injection.injectorCount,
		injectedSkillPoints: injection.injectedSkillPoints
	};
}

function getCharacterNoteKey(characterId) {
	return `${CHARACTER_NOTE_KEY_PREFIX}:${String(characterId || '')}`;
}

function normalizeCharacterNoteText(value) {
	return String(value == null ? '' : value).slice(0, CHARACTER_NOTE_MAX_LENGTH);
}

async function getCharacterNoteRecord(characterId) {
	const record = await cacheGetCharacterData(getCharacterNoteKey(characterId));
	return {
		text: normalizeCharacterNoteText(record?.text || ''),
		updatedAt: Number(record?.updatedAt || 0) || null
	};
}

async function saveCharacterNote(characterId, value, updatedAt = Date.now()) {
	const key = getCharacterNoteKey(characterId);
	const text = normalizeCharacterNoteText(value);
	if (!text.trim()) {
		const existing = await characterDataStore.get(key);
		if (existing) {
			await characterDataStore.delete(key);
			announceCharacterDataUpdated(key);
		}
		return { text: '', updatedAt: null };
	}

	const timestamp = Number(updatedAt || 0);
	const record = {
		text,
		updatedAt: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()
	};
	const existing = await characterDataStore.get(key);
	if (String(existing?.text || '') !== record.text || Number(existing?.updatedAt || 0) !== record.updatedAt) {
		await characterDataStore.set(key, record, null);
		announceCharacterDataUpdated(key);
	}
	return record;
}

async function fetchLatestCharacterJson(url, method = 'GET', headers = null, body = null) {
	return await window.esi.doJsonRequest(url, method, headers, body, { bypassCache: true });
}

async function fetchLatestCharacterAuthJson(url, characterId, method = 'GET', headers = null, body = null) {
	return await window.esi.doJsonAuthRequest(url, method, headers, body, characterId, { bypassCache: true });
}

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
			if (window.esi?.whoami) {
				initBackgroundRefresh();
			}
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
			return handleRoute();
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
			return handleRoute();
		}
		await clearAllLocalSkillQData();
		await window.esi.authLogout(true, false);
		history.replaceState(null, '', '/');
	}

	if (route.name === 'share') {
		await initLayoutMode();
		await renderSharedCharacterPage();
		return false;
	}

	if (route.name === 'legacy-share') {
		await renderLegacyShareDeprecationPage(route.charName);
		return true;
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

	if (route.name === 'home' && (path !== '/' || window.location.search || window.location.hash)) {
		history.replaceState(null, '', '/');
	}

	await renderLoggedInHome();
	return true;
}

function parseRoute(pathname) {
	const cleaned = pathname.replace(/\/+$/, '') || '/';
	const parts = cleaned.split('/').filter(Boolean);
	if (cleaned === '/readme') {
		return { name: 'readme' };
	}
	if (cleaned === '/share' || cleaned.startsWith('/share/')) {
		return { name: 'share' };
	}
	if (parts[0] === 'char' && parts[2] === 'share' && parts.length >= 4) {
		return {
			name: 'legacy-share',
			charName: decodeCharacterNameFromPath(parts[1] || '')
		};
	}
	if (cleaned === '/manage') {
		return { name: 'manage' };
	}
	if (cleaned === '/settings' || cleaned === '/account') {
		return { name: 'settings' };
	}
	if (cleaned.startsWith('/item/')) {
		return {
			name: 'item',
			itemId: Number(parts[1] || 0)
		};
	}
	if (!cleaned.startsWith('/char/')) {
		return { name: 'home' };
	}

	return {
		name: 'char',
		charName: decodeCharacterNameFromPath(parts[1] || ''),
		tab: parts[2] || 'overview'
	};
}

function encodeCharacterNameForPath(name) {
	return encodeURIComponent(String(name || '')).replace(/%20/g, '+');
}

function decodeCharacterNameFromPath(value) {
	return decodeURIComponent(String(value || '').replace(/\+/g, '%20'));
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
		if (String(link.getAttribute('href') || '') !== `/char/${encodeCharacterNameForPath(char.name)}`) return false;
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

function getDefaultShareSections() {
	return {
		[SHARE_SECTION_KEYS.overviewSkills]: true,
		[SHARE_SECTION_KEYS.skillQueue]: true,
		[SHARE_SECTION_KEYS.totalSkillPoints]: true,
		[SHARE_SECTION_KEYS.walletBalance]: true,
		[SHARE_SECTION_KEYS.jumpClones]: true,
		[SHARE_SECTION_KEYS.notes]: false
	};
}

function normalizeShareSections(sections) {
	const defaults = getDefaultShareSections();
	if (!sections || typeof sections !== 'object') return defaults;
	return {
		[SHARE_SECTION_KEYS.overviewSkills]: sections[SHARE_SECTION_KEYS.overviewSkills] !== false,
		[SHARE_SECTION_KEYS.skillQueue]: sections[SHARE_SECTION_KEYS.skillQueue] !== false,
		[SHARE_SECTION_KEYS.totalSkillPoints]: sections[SHARE_SECTION_KEYS.totalSkillPoints] !== false,
		[SHARE_SECTION_KEYS.walletBalance]: sections[SHARE_SECTION_KEYS.walletBalance] !== false,
		[SHARE_SECTION_KEYS.jumpClones]: sections[SHARE_SECTION_KEYS.jumpClones] !== false,
		[SHARE_SECTION_KEYS.notes]: sections[SHARE_SECTION_KEYS.notes] === true
	};
}

function getShareSectionChecklistState({ skills = [], queue = [], totalSP = 0, balance = 0, clones = [], note = '' } = {}) {
	const jumpClones = (Array.isArray(clones) ? clones : []).filter((clone) => !clone?.isActive);
	const noteText = normalizeCharacterNoteText(note);
	return [
		{
			key: SHARE_SECTION_KEYS.overviewSkills,
			label: 'Overview skills',
			help: Array.isArray(skills) && skills.length > 0
				? `${skills.length} skills ready`
				: 'No overview skills loaded yet',
			available: Array.isArray(skills) && skills.length > 0
		},
		{
			key: SHARE_SECTION_KEYS.skillQueue,
			label: 'Skill queue',
			help: Array.isArray(queue) && queue.length > 0
				? `${Math.min(25, queue.length)} queue rows ready`
				: 'No queue rows loaded yet',
			available: Array.isArray(queue) && queue.length > 0
		},
		{
			key: SHARE_SECTION_KEYS.totalSkillPoints,
			label: 'Total skill points',
			help: `${numberFormat(Number(totalSP || 0), 0)} SP`,
			available: true
		},
		{
			key: SHARE_SECTION_KEYS.walletBalance,
			label: 'Wallet balance',
			help: `${numberFormat(Number(balance || 0), 2)} ISK`,
			available: true
		},
		{
			key: SHARE_SECTION_KEYS.jumpClones,
			label: 'Jump clones',
			help: jumpClones.length > 0
				? `${jumpClones.length} ${jumpClones.length === 1 ? 'clone' : 'clones'}, including implants (if any)`
				: 'No jump clone data loaded yet',
			available: jumpClones.length > 0
		},
		{
			key: SHARE_SECTION_KEYS.notes,
			label: 'Notes',
			help: noteText.trim()
				? `${noteText.length} ${noteText.length === 1 ? 'character' : 'characters'} ready — private by default`
				: 'No notes saved for this character',
			available: Boolean(noteText.trim())
		}
	];
}

function showShareSectionChecklistDialog(checklistState, defaults = getDefaultShareSections()) {
	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'sq-share-dialog-backdrop';

		const dialog = document.createElement('div');
		dialog.className = 'sq-share-dialog';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-labelledby', 'sq-share-dialog-title');

		const title = document.createElement('h3');
		title.id = 'sq-share-dialog-title';
		title.className = 'sq-share-dialog__title';
		title.textContent = 'Choose sections to include';
		dialog.appendChild(title);

		const subtitle = document.createElement('p');
		subtitle.className = 'sq-share-dialog__subtitle';
		subtitle.textContent = 'Only checked sections will be added to this share link.';
		dialog.appendChild(subtitle);

		const list = document.createElement('div');
		list.className = 'sq-share-checklist';

		const checkboxByKey = new Map();
		for (const item of checklistState) {
			const row = document.createElement('label');
			row.className = 'sq-share-checklist__item';

			const input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = item.available && defaults[item.key] !== false;
			input.disabled = !item.available;
			if (!item.available) row.classList.add('sq-share-checklist__item--disabled');
			row.appendChild(input);

			const text = document.createElement('span');
			text.className = 'sq-share-checklist__text';

			const name = document.createElement('span');
			name.className = 'sq-share-checklist__label';
			name.textContent = item.label;
			text.appendChild(name);

			const help = document.createElement('small');
			help.className = 'sq-share-checklist__help';
			help.textContent = item.help;
			text.appendChild(help);

			row.appendChild(text);
			list.appendChild(row);
			checkboxByKey.set(item.key, input);
		}

		dialog.appendChild(list);

		const createHint = document.createElement('p');
		createHint.className = 'sq-share-dialog__hint sq-muted';
		createHint.textContent = 'Select at least one section to enable share creation.';
		dialog.appendChild(createHint);

		const actions = document.createElement('div');
		actions.className = 'sq-share-dialog__actions';

		const cancelBtn = document.createElement('button');
		cancelBtn.type = 'button';
		cancelBtn.className = 'sq-btn sq-btn--ghost';
		cancelBtn.textContent = 'Cancel';

		const createBtn = document.createElement('button');
		createBtn.type = 'button';
		createBtn.className = 'sq-btn sq-btn--primary';
		createBtn.textContent = 'Create Share Link';

		actions.appendChild(cancelBtn);
		actions.appendChild(createBtn);
		dialog.appendChild(actions);

		overlay.appendChild(dialog);
		document.body.appendChild(overlay);

		const cleanup = (value) => {
			document.removeEventListener('keydown', onKeyDown);
			overlay.remove();
			resolve(value);
		};

		const collectSelectedSections = () => normalizeShareSections({
			[SHARE_SECTION_KEYS.overviewSkills]: checkboxByKey.get(SHARE_SECTION_KEYS.overviewSkills)?.checked,
			[SHARE_SECTION_KEYS.skillQueue]: checkboxByKey.get(SHARE_SECTION_KEYS.skillQueue)?.checked,
			[SHARE_SECTION_KEYS.totalSkillPoints]: checkboxByKey.get(SHARE_SECTION_KEYS.totalSkillPoints)?.checked,
			[SHARE_SECTION_KEYS.walletBalance]: checkboxByKey.get(SHARE_SECTION_KEYS.walletBalance)?.checked,
			[SHARE_SECTION_KEYS.jumpClones]: checkboxByKey.get(SHARE_SECTION_KEYS.jumpClones)?.checked,
			[SHARE_SECTION_KEYS.notes]: checkboxByKey.get(SHARE_SECTION_KEYS.notes)?.checked
		});

		const hasAnySelectedSection = () => Array.from(checkboxByKey.values()).some((input) => input.checked);
		const syncCreateButtonState = () => {
			createBtn.disabled = !hasAnySelectedSection();
			if (createBtn.disabled) {
				createBtn.title = 'Select at least one section to create a share link.';
				createHint.classList.add('sq-share-dialog__hint--visible');
			} else {
				createBtn.title = '';
				createHint.classList.remove('sq-share-dialog__hint--visible');
			}
		};

		for (const input of checkboxByKey.values()) {
			input.addEventListener('change', syncCreateButtonState);
		}
		syncCreateButtonState();

		const onKeyDown = (event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				cleanup(null);
			}
		};

		cancelBtn.addEventListener('click', () => cleanup(null));
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) cleanup(null);
		});
		createBtn.addEventListener('click', () => {
			if (createBtn.disabled) return;
			cleanup(collectSelectedSections());
		});

		document.addEventListener('keydown', onKeyDown);

		requestAnimationFrame(() => {
			const firstEnabled = Array.from(checkboxByKey.values()).find((input) => !input.disabled);
			(firstEnabled || createBtn).focus();
		});
	});
}

function renderCharacterShareControls({ character, skills = [], queue = [], totalSP = 0, lastUpdatedAt = null } = {}) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'sq-char-info__action';
	button.setAttribute('aria-label', 'Copy share link');
	button.title = `Create a share link${lastUpdatedAt ? ` from ${formatDateTime(lastUpdatedAt)}` : ''}`;
	button.disabled = false;
	button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5a3 3 0 1 1 2.83 4H17l-6.2 3.35a3.02 3.02 0 0 1 0 1.3L17 17h.83A3 3 0 1 1 15 19a3 3 0 0 1 .2-1.08l-6.2-3.35a3 3 0 1 1 0-5.14l6.2-3.35A3 3 0 0 1 15 5Zm-8 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm10-4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm0 12a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" fill="currentColor"/></svg>';

	button.addEventListener('click', async () => {
		if (button.disabled) return;
		const characterId = String(character?.character_id || '');
		const [trainCached, noteRecord, overviewCached] = characterId
			? await Promise.all([
				cacheGetCharacterData(getTrainCacheKey(characterId)),
				getCharacterNoteRecord(characterId),
				cacheGetCharacterData(`overview:${characterId}`)
			])
			: [null, { text: '' }, null];
		const shareSkills = Array.isArray(skills) && skills.length > 0
			? skills
			: (overviewCached?.skills || []);
		const shareQueue = Array.isArray(queue) && queue.length > 0
			? queue
			: (overviewCached?.queue || []);
		const shareTotalSP = Array.isArray(skills) && skills.length > 0
			? totalSP
			: Number(overviewCached?.totalSP || 0);
		const checklistState = getShareSectionChecklistState({
			skills: shareSkills,
			queue: shareQueue,
			totalSP: shareTotalSP,
			balance: Number(character?.balance || 0),
			clones: trainCached?.clones || [],
			note: noteRecord.text
		});
		const selectedSections = await showShareSectionChecklistDialog(checklistState, getDefaultShareSections());
		if (!selectedSections) return;

		button.disabled = true;
		const previousTitle = button.title;
		button.title = 'Building share link...';
		try {
			const url = await buildCharacterShareUrl(character, shareSkills, shareQueue, shareTotalSP, selectedSections);
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url);
				button.title = 'Share link copied';
				showToast('Share link copied to clipboard.', button);
			} else {
				window.prompt('Copy share URL', url);
				button.title = 'Share link ready to copy';
				showToast('Share link ready to copy.', button);
			}
		} catch (err) {
			button.title = err?.message || 'Unable to build share link.';
		} finally {
			button.disabled = false;
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

let toastHideTimer = null;
function showToast(message, anchorEl = null) {
	const text = String(message || '').trim();
	if (!text) return;

	let toast = document.getElementById('sq-toast');
	if (!toast) {
		toast = document.createElement('div');
		toast.id = 'sq-toast';
		toast.className = 'sq-toast';
		toast.setAttribute('role', 'status');
		toast.setAttribute('aria-live', 'polite');
		document.body.appendChild(toast);
	}

	toast.textContent = text;

	if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
		const rect = anchorEl.getBoundingClientRect();
		toast.style.bottom = 'auto';
		toast.style.top = `${Math.max(8, Math.round(rect.bottom + 8))}px`;
		toast.style.left = `${Math.round(rect.left + (rect.width / 2))}px`;
	} else {
		toast.style.top = 'auto';
		toast.style.bottom = '1rem';
		toast.style.left = '50%';
	}

	toast.classList.add('sq-toast--show');

	if (toastHideTimer) clearTimeout(toastHideTimer);
	toastHideTimer = setTimeout(() => {
		toast.classList.remove('sq-toast--show');
	}, 1800);
}

async function buildCharacterShareUrl(character, skills, queue = [], totalSP = 0, selectedSections = null) {
	if (typeof SkillUrlCodecSafe === 'undefined') {
		throw new Error('Share codec is not available.');
	}
	const characterId = String(character?.character_id || '');
	if (!characterId) {
		throw new Error('Character information is missing.');
	}
	const sections = normalizeShareSections(selectedSections);
	const overviewCached = await cacheGetCharacterData(`overview:${characterId}`);
	const selectedQueueSource = Array.isArray(queue) && queue.length > 0
		? queue
		: (Array.isArray(overviewCached?.queue) ? overviewCached.queue : []);
	const queueRows = selectedQueueSource.slice(0, 25);
	const normalizedSkills = Array.isArray(skills) ? skills : [];

	// Encode each trained skill as a base record (current level, no timing)
	const trainedRecords = normalizedSkills
		.filter((s) => Number(s.typeID || 0) > 0)
		.map((s) => ({
			type_id: Number(s.typeID),
			level: Math.max(0, Math.min(5, Number(s.level || 0)))
		}));

	// Encode each queue row as one record with compact timing:
	// first row keeps absolute start; all rows store end delta to previous queue boundary.
	let previousQueueEndUnix = 0;
	const queueRecords = queueRows
		.filter((row) => Number(row?.typeID || 0) > 0)
		.map((row, index) => {
			const record = {
				type_id: Number(row.typeID),
				level: Math.max(0, Math.min(5, Number(row.level || 0)))
			};
			const startUnix = row.startDate ? Math.floor(Date.parse(row.startDate) / 1000) : 0;
			const endUnix = row.endDate ? Math.floor(Date.parse(row.endDate) / 1000) : 0;

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

	const selectedRecords = [
		...(sections[SHARE_SECTION_KEYS.overviewSkills] ? trainedRecords : []),
		...(sections[SHARE_SECTION_KEYS.skillQueue] ? queueRecords : [])
	];
	const encodedSkills = selectedRecords.length > 0
		? await encodeShareSkillsPayload(selectedRecords)
		: SHARE_EMPTY_SKILLS_TOKEN;
	const shareContext = await getCharacterShareContext(characterId, { cacheOnly: true });
	const encodedTotalSP = sections[SHARE_SECTION_KEYS.totalSkillPoints]
		? encodeCompactInt(totalSP)
		: '';
	const balanceCents = Math.max(0, Math.round(Number(character?.balance || 0) * 100));
	const encodedBalance = sections[SHARE_SECTION_KEYS.walletBalance]
		? encodeCompactInt(balanceCents)
		: '';
	const snapshotUnix = Math.floor(Date.now() / 1000);
	const encodedSnapshotUnix = encodeCompactInt(snapshotUnix);
	let encodedJumpClones = '';
	if (sections[SHARE_SECTION_KEYS.jumpClones]) {
		const trainCached = await cacheGetCharacterData(getTrainCacheKey(characterId));
		const jumpClones = (Array.isArray(trainCached?.clones) ? trainCached.clones : [])
			.filter((clone) => !clone?.isActive);
		if (jumpClones.length === 0) {
			throw new Error('Jump clone data is not available for this share.');
		}
		encodedJumpClones = await encodeShareJumpClonesPayload(jumpClones);
	}
	let encodedNotes = '';
	if (sections[SHARE_SECTION_KEYS.notes]) {
		const noteRecord = await getCharacterNoteRecord(characterId);
		if (!noteRecord.text.trim()) {
			throw new Error('Notes are not available for this share.');
		}
		encodedNotes = await encodeShareNotesPayload(noteRecord.text);
	}
	const signature = await createCharacterShareSignature(
		shareContext,
		encodedSkills,
		encodedTotalSP,
		encodedBalance,
		encodedSnapshotUnix,
		encodedJumpClones,
		encodedNotes
	);
	const baseUrl = `${window.location.origin}/share/${encodeURIComponent(characterId)}#${encodedSkills}.${signature}.${encodedTotalSP}.${encodedBalance}.${encodedSnapshotUnix}`;
	if (encodedNotes) {
		return `${baseUrl}.${encodedJumpClones}.${encodedNotes}`;
	}
	return encodedJumpClones ? `${baseUrl}.${encodedJumpClones}` : baseUrl;
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

async function renderLegacyShareDeprecationPage(charName = '') {
	await renderCurrentNavbarForUtilityPage();

	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.replaceChildren();
	cardsRoot.classList.add('d-none');
	document.getElementById('net-summary').classList.add('d-none');

	const charViewRoot = document.getElementById('char-view-root');
	const page = document.createElement('div');
	page.className = 'sq-char-view';

	const alert = document.createElement('div');
	alert.className = 'sq-alert';
	const readableName = String(charName || '').trim();
	alert.innerHTML = `
		<strong>That share link format is no longer supported.</strong>
		<p>SkillQ has been updated, and old links like <code>/char/&lt;name&gt;/share/&lt;id&gt;</code> are no longer valid.</p>
		<p>Please request a new share link for that character.</p>
	`;

	page.appendChild(alert);
	charViewRoot.replaceChildren(page);

	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
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

async function getCharacterShareContext(characterId, options = {}) {
	const cacheOnly = options?.cacheOnly === true;
	const cachedCommon = await cacheGetCharacterData(`common:${characterId}`);
	if (cachedCommon?.character?.corporation_id && cachedCommon?.corporationJoinDate) {
		return {
			character: {
				character_id: String(characterId),
				name: cachedCommon.character?.name || `Character ${characterId}`,
				corporation_id: Number(cachedCommon.character?.corporation_id || 0),
				alliance_id: Number(cachedCommon.character?.alliance_id || 0) || null,
				balance: Number(cachedCommon.character?.balance || 0)
			},
			corporation: cachedCommon.corporation || null,
			alliance: cachedCommon.alliance || null,
			corporationJoinDate: String(cachedCommon.corporationJoinDate || '')
		};
	}
	if (cacheOnly) {
		throw new Error('Share data is still loading in the background.');
	}

	const [charInfo, history] = await Promise.all([
		window.esi.doJsonRequest(`${ESI_BASE}/characters/${characterId}`),
		window.esi.doJsonRequest(`${ESI_BASE}/characters/${characterId}/corporationhistory`)
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

async function createCharacterShareSignature(shareContext, encodedSkills, encodedTotalSP = '', encodedBalance = '', encodedSnapshotUnix = '', encodedJumpClones = '', encodedNotes = '') {
	const signatureParts = [
		`skillq-share-v${SHARE_URL_VERSION}`,
		String(shareContext.character.character_id || ''),
		String(shareContext.character.corporation_id || ''),
		String(shareContext.corporationJoinDate || ''),
		String(encodedSkills || ''),
		String(encodedTotalSP || ''),
		String(encodedBalance || ''),
		String(encodedSnapshotUnix || '')
	];
	if (encodedJumpClones) {
		signatureParts.push(String(encodedJumpClones));
	}
	if (encodedNotes) {
		if (!encodedJumpClones) signatureParts.push('');
		signatureParts.push(String(encodedNotes));
	}
	const signatureText = signatureParts.join('|');
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
	if (payload === '' || payload === SHARE_EMPTY_SKILLS_TOKEN) {
		return [];
	}
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

async function encodeShareJumpClonesPayload(clones) {
	const rows = (Array.isArray(clones) ? clones : [])
		.filter((clone) => !clone?.isActive)
		.slice(0, 25)
		.map((clone) => ({
			n: String(clone?.name || 'Jump Clone').slice(0, 100),
			l: String(clone?.locationLabel || 'Unknown location').slice(0, 200),
			i: (Array.isArray(clone?.implants) ? clone.implants : [])
				.map((implant) => Number(implant?.typeID || 0))
				.filter((typeId) => Number.isSafeInteger(typeId) && typeId > 0)
				.slice(0, 20)
		}));
	const rawBytes = new TextEncoder().encode(JSON.stringify({ v: 1, c: rows }));
	const rawPayload = `j1_${bytesToBase64Url(rawBytes)}`;
	if (!supportsShareCompressionStreams()) return rawPayload;

	const candidates = [rawPayload];
	try {
		const deflated = await deflateBytes(rawBytes);
		candidates.push(`j1d_${bytesToBase64Url(deflated)}`);
	} catch (err) {
		console.warn('Deflate compression unavailable for jump clone share payload.', err);
	}
	try {
		const gzipped = await gzipBytes(rawBytes);
		candidates.push(`j1g_${bytesToBase64Url(gzipped)}`);
	} catch (err) {
		console.warn('Gzip compression unavailable for jump clone share payload.', err);
	}

	return candidates.reduce((shortest, candidate) => (candidate.length < shortest.length ? candidate : shortest), rawPayload);
}

async function encodeShareNotesPayload(note) {
	const text = normalizeCharacterNoteText(note);
	if (!text.trim()) return '';

	const rawBytes = new TextEncoder().encode(text);
	const rawPayload = `n1_${bytesToBase64Url(rawBytes)}`;
	if (!supportsShareCompressionStreams()) return rawPayload;

	const candidates = [rawPayload];
	try {
		const deflated = await deflateBytes(rawBytes);
		candidates.push(`n1d_${bytesToBase64Url(deflated)}`);
	} catch (err) {
		console.warn('Deflate compression unavailable for notes share payload.', err);
	}
	try {
		const gzipped = await gzipBytes(rawBytes);
		candidates.push(`n1g_${bytesToBase64Url(gzipped)}`);
	} catch (err) {
		console.warn('Gzip compression unavailable for notes share payload.', err);
	}

	return candidates.reduce((shortest, candidate) => (candidate.length < shortest.length ? candidate : shortest), rawPayload);
}

async function decodeShareNotesPayload(encodedNotes) {
	const payload = String(encodedNotes || '').trim();
	if (!payload) return '';

	try {
		let bytes;
		if (payload.startsWith('n1_')) {
			bytes = base64UrlToBytes(payload.slice(3));
		} else if (payload.startsWith('n1d_')) {
			if (!supportsShareCompressionStreams()) {
				throw new Error('CompressionStream support is unavailable.');
			}
			bytes = await inflateBytes(base64UrlToBytes(payload.slice(4)));
		} else if (payload.startsWith('n1g_')) {
			if (!supportsShareCompressionStreams()) {
				throw new Error('CompressionStream support is unavailable.');
			}
			bytes = await gunzipBytes(base64UrlToBytes(payload.slice(4)));
		} else {
			throw new Error('Unsupported notes payload.');
		}

		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		if (text.length > CHARACTER_NOTE_MAX_LENGTH) {
			throw new Error('Notes payload is too large.');
		}
		return text;
	} catch (err) {
		throw new Error('This shared link contains invalid notes data.');
	}
}

async function decodeShareJumpClonesPayload(encodedJumpClones) {
	const payload = String(encodedJumpClones || '').trim();
	if (!payload) return [];

	try {
		let bytes;
		if (payload.startsWith('j1_')) {
			bytes = base64UrlToBytes(payload.slice(3));
		} else if (payload.startsWith('j1d_')) {
			if (!supportsShareCompressionStreams()) {
				throw new Error('CompressionStream support is unavailable.');
			}
			bytes = await inflateBytes(base64UrlToBytes(payload.slice(4)));
		} else if (payload.startsWith('j1g_')) {
			if (!supportsShareCompressionStreams()) {
				throw new Error('CompressionStream support is unavailable.');
			}
			bytes = await gunzipBytes(base64UrlToBytes(payload.slice(4)));
		} else {
			throw new Error('Unsupported jump clone payload.');
		}

		const decoded = JSON.parse(new TextDecoder().decode(bytes));
		if (Number(decoded?.v) !== 1 || !Array.isArray(decoded?.c)) {
			throw new Error('Invalid jump clone payload.');
		}
		return decoded.c.slice(0, 25).map((clone, index) => ({
			name: String(clone?.n || '').slice(0, 100) || `Jump Clone ${index + 1}`,
			locationLabel: String(clone?.l || '').slice(0, 200) || 'Unknown location',
			implantTypeIds: (Array.isArray(clone?.i) ? clone.i : [])
				.map((typeId) => Number(typeId || 0))
				.filter((typeId) => Number.isSafeInteger(typeId) && typeId > 0)
				.slice(0, 20)
		}));
	} catch (err) {
		throw new Error('This shared link contains invalid jump clone data.');
	}
}

async function hydrateSharedJumpClones(rows) {
	const typeIds = Array.from(new Set((Array.isArray(rows) ? rows : [])
		.flatMap((clone) => clone?.implantTypeIds || [])
		.map((typeId) => Number(typeId || 0))
		.filter((typeId) => typeId > 0)));
	const implantInfoByTypeId = new Map(await Promise.all(typeIds.map(async (typeId) => [
		typeId,
		await getTypeInfo(typeId)
	])));

	return (Array.isArray(rows) ? rows : []).map((clone, index) => ({
		cloneId: null,
		name: String(clone?.name || '').trim() || `Jump Clone ${index + 1}`,
		kind: 'Jump Clone',
		isActive: false,
		locationLabel: clone?.locationLabel || 'Unknown location',
		implants: buildCloneImplantRows(clone?.implantTypeIds, implantInfoByTypeId)
	}));
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
	const nowMs = Date.now();
	const maxCompletedQueueLevel = new Map();
	const maxPendingQueueLevel = new Map();
	for (const entry of queue) {
		const endMs = Number(entry.trainingEndMs || 0);
		const targetLevel = Number(entry.targetLevel || 0);
		if (targetLevel <= 0) continue;

		if (endMs > 0 && endMs <= nowMs) {
			maxCompletedQueueLevel.set(entry.typeID, Math.max(maxCompletedQueueLevel.get(entry.typeID) || 0, targetLevel));
		} else {
			maxPendingQueueLevel.set(entry.typeID, Math.max(maxPendingQueueLevel.get(entry.typeID) || 0, targetLevel));
		}
	}
	const allTypeIds = new Set([
		...trainedMap.keys(),
		...maxCompletedQueueLevel.keys(),
		...maxPendingQueueLevel.keys()
	]);
	const skills = Array.from(allTypeIds)
		.map((typeId) => {
			const typeInfo = typeInfos.get(typeId);
			const groupInfo = groupInfos.get(typeInfo?.group_id);
			const snapshotTrainedLevel = trainedMap.get(typeId) || 0;
			const completedFromQueue = maxCompletedQueueLevel.get(typeId) || 0;
			const trainedLevel = Math.max(snapshotTrainedLevel, completedFromQueue);
			const maxQueued = maxPendingQueueLevel.get(typeId) || 0;
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
	const encodedJumpClones = shareData.encodedJumpClones || '';
	const encodedNotes = shareData.encodedNotes || '';
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
		if (!characterId || !providedSignature) {
			throw new Error('This shared link is missing required data.');
		}
		if (snapshotUnix <= 0) {
			throw new Error('This shared link is missing a snapshot timestamp and is no longer valid.');
		}
		const nowUnix = Math.floor(Date.now() / 1000);
		if (snapshotUnix > nowUnix) {
			throw new Error('This shared link snapshot timestamp is in the future and is invalid.');
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
			encodedSnapshotUnix,
			encodedJumpClones,
			encodedNotes
		);
		if (expectedSignature !== providedSignature) {
			throw new Error('Sorry, that share link is invalid.');
		}

		const decodedRecords = await decodeShareSkillsPayload(encodedSkills);
		const decodedJumpClones = await decodeShareJumpClonesPayload(encodedJumpClones);
		const sharedNotes = await decodeShareNotesPayload(encodedNotes);
		const [sharedData, sharedJumpClones] = await Promise.all([
			hydrateSharedSkills(decodedRecords),
			hydrateSharedJumpClones(decodedJumpClones)
		]);
		const trainingSummary = findSharedTrainingSummary(sharedData.queue);
		const now = Date.now();
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
				trainingStartMs: Number(trainingSummary.trainingStartMs || 0),
				trainingEndMs: trainingSummary.trainingEndMs,
				isCurrentlyTraining: Number(trainingSummary.trainingStartMs || 0) > 0
					&& Number(trainingSummary.trainingEndMs || 0) > now
					&& Number(trainingSummary.trainingStartMs || 0) <= now,
				queueEmptyMs
			} : null,
			showBalance: hasSharedBalance
		}));

		const notice = document.createElement('div');
		notice.className = 'sq-alert';
		const snapshotText = snapshotUnix > 0
			? `Snapshot taken at ${formatDateTime(snapshotUnix * 1000)} UTC. `
			: '';
		const noticeList = document.createElement('ul');
		const addNotice = (text, className = null) => {
			const item = document.createElement('li');
			if (className) item.appendChild(_el('em', className, text));
			else item.textContent = text;
			noticeList.appendChild(item);
		};
		addNotice(snapshotText);
		addNotice('Only first 25 skills in skill queue are shown.');
		addNotice('Skills considered completed are not shown in Skill Queue.');
		if (encodedJumpClones) addNotice('Jump clones and their implants were included by the owner.');
		if (encodedNotes) addNotice('Character notes were included by the owner.');
		addNotice('Share links invalidate if the character changes corporations.');
		addNotice('Share links expire after 30 days.');
		const lastNotice = document.createElement('li');
		lastNotice.appendChild(document.createTextNode('A crafty person '));
		lastNotice.appendChild(_el('em', null, 'could'));
		lastNotice.appendChild(document.createTextNode(' tamper with the URL to share fake character data.'));
		noticeList.appendChild(lastNotice);
		notice.appendChild(noticeList);
		page.appendChild(notice);
		if (encodedNotes) {
			page.appendChild(renderSharedCharacterNotes(sharedNotes));
		}

		page.appendChild(renderSharedCharSkills({
			queue: sharedData.queue,
			skills: sharedData.skills,
			totalSP: sharedTotalSP,
			hasSharedTotalSP: encodedTotalSP !== ''
		}));
		if (encodedJumpClones) {
			page.appendChild(renderCharClones({ clones: sharedJumpClones }));
		}
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

	// Current format: /share/<characterId>#<payload>
	if (parts[0] === 'share' && parts.length === 2 && window.location.hash) {
		const joined = window.location.hash.slice(1);
		const segments = joined.split('.');
		let encodedJumpClones = '';
		let encodedNotes = '';
		if (segments.length >= 7) {
			encodedNotes = segments.pop() || '';
			encodedJumpClones = segments.pop() || '';
		} else if (segments.length >= 6) {
			encodedJumpClones = segments.pop() || '';
		}
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
				encodedSnapshotUnix: encodedSnapshotUnix || '',
				encodedJumpClones,
				encodedNotes
			};
		}
	}

	// Legacy format: /share/<characterId>/<payload> (path-based)
	if (parts[0] === 'share' && parts.length >= 3) {
		const joined = parts.slice(2).join('/');
		const segments = joined.split('.');
		let encodedJumpClones = '';
		let encodedNotes = '';
		if (segments.length >= 7) {
			encodedNotes = segments.pop() || '';
			encodedJumpClones = segments.pop() || '';
		} else if (segments.length >= 6) {
			encodedJumpClones = segments.pop() || '';
		}
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
				encodedSnapshotUnix: encodedSnapshotUnix || '',
				encodedJumpClones,
				encodedNotes
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
				encodedSnapshotUnix: '',
				encodedJumpClones: '',
				encodedNotes: ''
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
				encodedSnapshotUnix: '',
				encodedJumpClones: '',
				encodedNotes: ''
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
				encodedSnapshotUnix: '',
				encodedJumpClones: '',
				encodedNotes: ''
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
		encodedSnapshotUnix: String(params.get('ts') || params.get('snapshot') || '').trim(),
		encodedJumpClones: String(params.get('clones') || '').trim(),
		encodedNotes: String(params.get('notes') || '').trim()
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
	const distinctGroupCount = new Set(
		orderedSummaries.map((summary) => {
			const characterId = String(summary.character.character_id);
			const groupLabel = String(manageSettings.groupedByCharacterId?.[characterId] || '').trim();
			return groupLabel.length > 0 ? `group:${groupLabel}` : '__ungrouped__';
		})
	).size;
	const showGroupRule = distinctGroupCount > 1;
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

	let previousGroupKey = null;
	for (const summary of orderedSummaries) {
		const characterId = String(summary.character.character_id);
		const groupLabel = String(manageSettings.groupedByCharacterId?.[characterId] || '').trim();
		const groupKey = groupLabel.length > 0 ? `group:${groupLabel}` : '__ungrouped__';
		if (groupKey !== previousGroupKey) {
			cardsRoot.appendChild(renderHomeGroupHeader(groupLabel, { showRule: showGroupRule }));
			previousGroupKey = groupKey;
		}
		cardsRoot.appendChild(renderCharCard({
			character: summary.character,
			training: summary.training
		}));
	}

	const netSummary = document.getElementById('net-summary');
	if (orderedSummaries.length > 1) {
		const totalIsk = orderedSummaries.reduce((acc, s) => acc + (s.character.balance || 0), 0);
		const totalSp = orderedSummaries.reduce((acc, s) => acc + (s.character.skillPoints || 0), 0);
		netSummary.replaceChildren(
			document.createTextNode(`Net ISK: ${numberFormat(totalIsk, 2)}`),
			document.createElement('br'),
			document.createTextNode(`Net SP: ${numberFormat(totalSp, 0)}`)
		);
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
	const activeTab = ['overview', 'wallet', 'train', 'plan', 'clones', 'notes'].includes(tab) ? tab : 'overview';
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

	const nextActions = renderCharacterShareControls({
		character: data.character,
		skills: data.skills || [],
		queue: data.queue || [],
		totalSP: data.totalSP || 0,
		lastUpdatedAt: data.lastUpdatedAt || null
	});

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
	page.classList.toggle('sq-char-view--research', activeTab === 'plan');

	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
	startCountdowns();
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
			trainingStartMs: Number(data?.training?.trainingStartMs || 0),
			trainingEndMs: Number(data?.training?.trainingEndMs || 0),
			queueEmptyMs: Number(data?.training?.queueEmptyMs || 0),
			isCurrentlyTraining: Boolean(data?.training?.isCurrentlyTraining),
			lastTrainingEndMs: Number(data?.training?.lastTrainingEndMs || 0),
			hasTrainingBooster: Boolean(data?.training?.hasTrainingBooster),
			hasCharacterBooster: Boolean(data?.training?.hasCharacterBooster)
		}
	});
}

function renderCharacterNotesEditor({ characterId, note = '', updatedAt = null } = {}) {
	const section = document.createElement('section');
	section.className = 'sq-notes';

	const heading = document.createElement('h4');
	heading.className = 'sq-section-title';
	heading.textContent = 'Character Notes';
	section.appendChild(heading);

	const help = document.createElement('p');
	help.className = 'sq-muted';
	help.textContent = 'Changes save automatically after you stop typing. Notes are included in encrypted backups and are never shared unless you check Notes when creating a link.';
	section.appendChild(help);

	const editor = document.createElement('div');
	editor.className = 'sq-notes__form';

	const textarea = document.createElement('textarea');
	textarea.className = 'sq-notes__textarea';
	textarea.name = 'characterNote';
	textarea.rows = 12;
	textarea.maxLength = CHARACTER_NOTE_MAX_LENGTH;
	textarea.placeholder = 'Add reminders, plans, fittings, or anything else you want to remember about this character.';
	textarea.value = normalizeCharacterNoteText(note);
	textarea.dataset.initialValue = textarea.value;
	textarea.setAttribute('aria-label', 'Character notes');
	editor.appendChild(textarea);

	const footer = document.createElement('div');
	footer.className = 'sq-notes__footer';

	const meta = document.createElement('div');
	meta.className = 'sq-notes__meta';
	const count = document.createElement('span');
	count.className = 'sq-muted';
	const status = document.createElement('span');
	status.className = 'sq-muted';
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	meta.appendChild(count);
	meta.appendChild(status);
	footer.appendChild(meta);
	editor.appendChild(footer);
	section.appendChild(editor);

	let saveTimer = null;
	let saveInProgress = false;
	let saveState = 'idle';

	const syncState = () => {
		const isDirty = textarea.value !== textarea.dataset.initialValue;
		count.textContent = `${textarea.value.length.toLocaleString()} / ${CHARACTER_NOTE_MAX_LENGTH.toLocaleString()}`;
		if (saveState === 'saving') {
			status.textContent = 'Saving...';
		} else if (saveState === 'error') {
			status.textContent = 'Unable to save. Keep typing or leave the field to retry.';
		} else if (isDirty) {
			status.textContent = 'Autosave pending...';
		} else {
			status.textContent = updatedAt ? `Saved: ${formatDateTime(updatedAt)} UTC` : 'Nothing saved yet';
		}
	};

	const scheduleSave = () => {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = null;
			persistNote();
		}, CHARACTER_NOTE_AUTOSAVE_DELAY_MS);
	};

	const persistNote = async () => {
		if (saveInProgress) {
			scheduleSave();
			return;
		}
		if (textarea.value === textarea.dataset.initialValue) return;

		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		const valueBeingSaved = textarea.value;
		saveInProgress = true;
		saveState = 'saving';
		syncState();
		try {
			const saved = await saveCharacterNote(characterId, valueBeingSaved);
			if (textarea.value === valueBeingSaved) {
				textarea.value = saved.text;
			}
			textarea.dataset.initialValue = saved.text;
			updatedAt = saved.updatedAt;
			saveState = 'idle';
		} catch (err) {
			console.warn('Unable to autosave character notes.', err);
			saveState = 'error';
		} finally {
			saveInProgress = false;
			syncState();
			if (textarea.value !== textarea.dataset.initialValue && saveState !== 'error') {
				scheduleSave();
			}
		}
	};

	textarea.addEventListener('input', () => {
		saveState = 'idle';
		scheduleSave();
		syncState();
	});
	textarea.addEventListener('blur', () => {
		if (textarea.value !== textarea.dataset.initialValue) persistNote();
	});

	syncState();
	return section;
}

function renderSharedCharacterNotes(note) {
	const section = document.createElement('section');
	section.className = 'sq-notes sq-notes--shared';

	const heading = document.createElement('h4');
	heading.className = 'sq-section-title';
	heading.textContent = 'Shared Notes';
	section.appendChild(heading);

	const body = document.createElement('div');
	body.className = 'sq-notes__shared-text';
	body.textContent = normalizeCharacterNoteText(note);
	section.appendChild(body);
	return section;
}

function buildCharacterTabContent(data, activeTab) {
	const content = document.createElement('div');
	if (activeTab === 'plan') return renderCharPlan(data.character.character_id);
	if (activeTab === 'notes') {
		content.appendChild(renderCharacterNotesEditor({
			characterId: data.character?.character_id,
			note: data.note || '',
			updatedAt: data.noteUpdatedAt || null
		}));
		return content;
	}

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
		content.appendChild(renderCharTrain({
			characterId: data.character?.character_id,
			implants: data.implants || [],
			suggestions: data.suggestions || [],
			optimize: data.optimize || null,
			injectorEstimate: data.injectorEstimate || null
		}));
		if (data.lastUpdatedAt) {
			const updated = document.createElement('p');
			updated.className = 'sq-muted sq-char-note';
			updated.textContent = `Last updated: ${formatDateTime(data.lastUpdatedAt)}`;
			content.appendChild(updated);
		}
		return content;
	}

	if (activeTab === 'clones') {
		content.appendChild(renderCharClones({ clones: data.clones || [] }));
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
		groupInput.dataset.initialValue = groupInput.value;
		groupInput.className = 'sq-manage__input';
		groupCell.appendChild(groupInput);
		row.appendChild(groupCell);

		const customCell = document.createElement('td');
		customCell.dataset.label = 'Custom';
		const customInput = document.createElement('input');
		customInput.type = 'number';
		customInput.name = `custom-${charId}`;
		customInput.value = String(Number(manageSettings.customOrderByCharacterId?.[charId] || 0));
		customInput.dataset.initialValue = customInput.value;
		customInput.className = 'sq-manage__input sq-text-right';
		customCell.appendChild(customInput);
		row.appendChild(customCell);

		const charCell = document.createElement('td');
		charCell.dataset.label = 'Character';
		const charLink = document.createElement('a');
		charLink.href = `/char/${encodeCharacterNameForPath(char.name)}`;
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
	groupSelect.dataset.initialValue = groupSelect.value;
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
	orderSelect.dataset.initialValue = orderSelect.value;
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
	fluidSelect.dataset.initialValue = fluidSelect.value;
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
	themeSelect.dataset.initialValue = themeSelect.value;
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

	const backupPanel = document.createElement('div');
	backupPanel.className = 'sq-account__actions';

	const exportBtn = document.createElement('button');
	exportBtn.type = 'button';
	exportBtn.className = 'sq-btn sq-btn--info';
	exportBtn.textContent = 'Export Encrypted Backup';
	backupPanel.appendChild(exportBtn);

	const importBtn = document.createElement('button');
	importBtn.type = 'button';
	importBtn.className = 'sq-btn sq-btn--ghost';
	importBtn.textContent = 'Import Encrypted Backup';
	backupPanel.appendChild(importBtn);

	const importInput = document.createElement('input');
	importInput.type = 'file';
	importInput.accept = '.zip,application/zip';
	importInput.className = 'd-none';
	backupPanel.appendChild(importInput);

	const backupNote = document.createElement('p');
	backupNote.className = 'sq-muted';
	backupNote.textContent = 'Exports include characters, refresh tokens, per-character notes, and local SkillQ settings in an encrypted zip file.';
	backupPanel.appendChild(backupNote);

	form.appendChild(backupPanel);

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

	exportBtn.addEventListener('click', async () => {
		exportBtn.disabled = true;
		try {
			await exportEncryptedSkillqBackup();
			window.alert('Encrypted backup exported.');
		} catch (err) {
			window.alert(`Backup export failed: ${err?.message || err}`);
		} finally {
			exportBtn.disabled = false;
		}
	});

	importBtn.addEventListener('click', () => {
		importInput.value = '';
		importInput.click();
	});

	importInput.addEventListener('change', async () => {
		const selected = importInput.files?.[0] || null;
		if (!selected) return;
		importBtn.disabled = true;
		try {
			await importEncryptedSkillqBackup(selected);
			window.alert('Encrypted backup imported.');
			await renderAccountPage();
		} catch (err) {
			window.alert(`Backup import failed: ${err?.message || err}`);
		} finally {
			importBtn.disabled = false;
			importInput.value = '';
		}
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
		typeInfo = await getTypeInfo(parsedItemId);
	} catch (_) {
		typeInfo = null;
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
		const descriptionLines = String(typeInfo.description).split('\n');
		descriptionLines.forEach((line, index) => {
			if (index > 0) desc.appendChild(document.createElement('br'));
			desc.appendChild(document.createTextNode(line));
		});
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
		container.appendChild(_createItemEnablesSection(typeInfo.name, enables));
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
		storageKey: 'item:fields',
		defaultExpanded: true,
		content: table
	}));

	const pre = document.createElement('pre');
	pre.className = 'sq-item__json';
	pre.textContent = JSON.stringify(typeInfo, null, 2);
	container.appendChild(_createPersistentItemSection({
		title: 'Raw ESI JSON',
		storageKey: 'item:raw',
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
		{ skillAttrId: 184, levelAttrId: 279 },
		{ skillAttrId: 1285, levelAttrId: 1286 },
		{ skillAttrId: 1289, levelAttrId: 1287 },
		{ skillAttrId: 1290, levelAttrId: 1288 }
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

/**
 * Produce a fastest-first preview of the current queue without changing EVE.
 * A prerequisite that is also in the queue is always scheduled before the
 * queued skill that needs it. Skills already trained to the required level do
 * not create a dependency.
 */
async function optimizeSkillQueueOrder(queue = [], skills = []) {
	const rows = Array.isArray(queue) ? queue.map((entry, index) => ({ entry, index })) : [];
	if (rows.length < 2) return { queue: rows.map((row) => row.entry), warnings: [] };

	const currentLevels = new Map((Array.isArray(skills) ? skills : []).map((skill) => [
		Number(skill?.typeID || skill?.skill_id || 0), Number(skill?.level || skill?.trained_skill_level || 0)
	]));
	const skillByTypeId = new Map((Array.isArray(skills) ? skills : []).map((skill) => [Number(skill?.typeID || skill?.skill_id || 0), skill]));
	const infoByTypeId = new Map();
	const requirementByTypeId = new Map();
	await Promise.all(rows.map(async ({ entry }) => {
		const typeId = Number(entry?.typeID || 0);
		if (!typeId || infoByTypeId.has(typeId)) return;
		infoByTypeId.set(typeId, await getTypeInfo(typeId));
		try {
			requirementByTypeId.set(typeId, await getItemRequirements(typeId));
		} catch (_) {
			requirementByTypeId.set(typeId, []);
		}
	}));

	const targetLevel = (entry) => Number(entry?.level || entry?.targetLevel || entry?.finished_level || entry?.finishedLevel || entry?.target_level || 0);
	const remainingSp = (entry) => {
		const explicit = Number(entry?.spNeeded || 0);
		if (explicit > 0) return explicit;
		const skill = skillByTypeId.get(Number(entry?.typeID || 0));
		const target = targetLevel(entry);
		const rank = Number(skill?.skillRank || 0);
		if (skill && target > 0 && rank > 0) {
			return Math.max(0, getSkillPointsForLevel(target, rank) - Number(skill.skillPoints || 0));
		}
		return 0;
	};
	const durationSeconds = (entry) => {
		const spNeeded = remainingSp(entry);
		// expectedSpHour is based on the character's current effective attributes (including
		// implants) and intentionally excludes temporary booster speed.
		const spHour = Number(entry?.expectedSpHour || entry?.spHour || 0);
		if (spNeeded > 0 && spHour > 0) return spNeeded / spHour * 3600;
		return Number.MAX_SAFE_INTEGER;
	};
	const active = rows.filter(({ entry }) => {
		const startMs = _queueDateMs(entry, 'startDate');
		const endMs = _queueDateMs(entry, 'endDate');
		return startMs > 0 && endMs > Date.now() && startMs <= Date.now();
	});
	const activeSet = new Set(active.map(({ index }) => index));
	const pending = rows.filter(({ index }) => !activeSet.has(index));
	const byType = new Map();
	for (const row of rows) {
		const typeId = Number(row.entry?.typeID || 0);
		if (!byType.has(typeId)) byType.set(typeId, []);
		byType.get(typeId).push(row);
	}

	const dependencies = new Map(pending.map(({ index }) => [index, new Set()]));
	const warnings = [];
	for (const dependent of pending) {
		const dependentId = Number(dependent.entry?.typeID || 0);
		const requirements = requirementByTypeId.get(dependentId) || [];
		for (const requirement of requirements) {
			const requiredId = Number(requirement?.typeID || 0);
			const requiredLevel = Number(requirement?.requiredSkillLevel || 0);
			if (!requiredId || !requiredLevel || requiredId === dependentId) continue;
			if (Number(currentLevels.get(requiredId) || 0) >= requiredLevel) continue;
			const candidates = (byType.get(requiredId) || [])
				.filter((row) => targetLevel(row.entry) >= requiredLevel)
				.sort((left, right) => targetLevel(left.entry) - targetLevel(right.entry) || left.index - right.index);
			if (activeSet.has(dependent.index)) {
				if (candidates.some((row) => !activeSet.has(row.index))) {
					const requiredInfo = await getTypeInfo(requiredId);
					warnings.push(`Current training ${dependent.entry?.typeName || `Skill ${dependentId}`} depends on ${requiredInfo?.name || `Skill ${requiredId}`} ${toRomanNumeral(requiredLevel)} later in the queue; EVE must be corrected manually.`);
				}
				continue;
			}
			if (candidates.some((row) => activeSet.has(row.index))) continue;
			if (candidates.length === 0) {
				const requiredInfo = await getTypeInfo(requiredId);
				warnings.push(`${dependent.entry?.typeName || `Skill ${dependentId}`} needs ${requiredInfo?.name || `Skill ${requiredId}`} ${toRomanNumeral(requiredLevel)}, which is not in the current queue.`);
				continue;
			}
			const prerequisite = candidates[0];
			dependencies.get(dependent.index).add(prerequisite.index);
		}
	}

	const orderedPending = [];
	if (pending.some(({ entry }) => durationSeconds(entry) === Number.MAX_SAFE_INTEGER)) {
		warnings.push('Some queue entries have no measured SP/hour rate, so they were placed after rate-known skills.');
	}
	const remaining = new Set(pending.map(({ index }) => index));
	while (remaining.size > 0) {
		const ready = pending.filter(({ index }) => remaining.has(index) && Array.from(dependencies.get(index)).every((dependency) => !remaining.has(dependency)));
		if (ready.length === 0) {
			warnings.push('A prerequisite cycle or incomplete requirement data was detected; the remaining skills kept their current order.');
			orderedPending.push(...pending.filter(({ index }) => remaining.has(index)));
			break;
		}
		ready.sort((left, right) => durationSeconds(left.entry) - durationSeconds(right.entry) || left.index - right.index);
		const next = ready[0];
		orderedPending.push(next);
		remaining.delete(next.index);
	}

	return {
		queue: active.concat(orderedPending).map((row) => row.entry),
		warnings: Array.from(new Set(warnings))
	};
}

window.optimizeSkillQueueOrder = optimizeSkillQueueOrder;

async function buildQuickestSkillsToV(skills, attributes, goals = null) {
	const levels = new Map(skills.map(skill => [Number(skill.skill_id), Number(skill.trained_skill_level || 0)]));
	const points = new Map(skills.map(skill => [Number(skill.skill_id), Number(skill.skillpoints_in_skill || 0)]));
	const targets = goals ? new Map(goals.map(row => [row.typeID, row.requiredSkillLevel])) : new Map(skills.filter(skill => Number(skill.trained_skill_level || 0) < 5).map(skill => [Number(skill.skill_id), 5]));
	const infos = new Map();
	const queue = [];
	// Each candidate includes its complete prerequisite path from the planned state.
	const plan = async (id, level, planned, visiting, rows) => {
		if ((planned.get(id) ?? levels.get(id) ?? 0) >= level) return;
		if (visiting.has(id)) throw new Error('Cyclic skill requirements.');
		visiting.add(id);
		if (!infos.has(id)) infos.set(id, await getTypeInfo(id));
		const info = infos.get(id);
		const rank = _getDogmaValue(info, 275);
		const rate = calculateSkillSpPerHour(attributes, attributeIdToName(_getDogmaValue(info, 180)), attributeIdToName(_getDogmaValue(info, 181)));
		if (!(rank > 0) || !(rate > 0)) throw new Error('Missing training data for ' + (info?.name || id));
		for (const requirement of _extractRequirementRows(info)) {
			await plan(requirement.typeID, requirement.requiredSkillLevel, planned, visiting, rows);
		}
		const currentLevel = planned.get(id) ?? levels.get(id) ?? 0;
		for (let next = currentLevel + 1; next <= level; next++) {
			const start = Math.max(points.get(id) || 0, getSkillPointsForLevel(next - 1, rank));
			const spNeeded = Math.max(0, getSkillPointsForLevel(next, rank) - start);
			rows.push({ typeID: id, typeName: info.name, level: next, spNeeded, expectedSpHour: rate });
		}
		planned.set(id, level);
		visiting.delete(id);
	};
	while (targets.size) {
		let best;
		for (const [id, targetLevel] of targets) {
			if (levels.get(id) >= targetLevel) { targets.delete(id); continue; }
			const rows = [];
			await plan(id, targetLevel, new Map(), new Set(), rows);
			const seconds = rows.reduce((total, row) => total + row.spNeeded / row.expectedSpHour * 3600, 0);
			if (!best || seconds < best.seconds || (seconds === best.seconds && infos.get(id).name.localeCompare(infos.get(best.id).name) < 0)) best = { id, rows, seconds };
		}
		if (!best) break;
		queue.push(...best.rows);
		for (const row of best.rows) levels.set(row.typeID, row.level);
		targets.delete(best.id);
	}
	return queue;
}

async function getCharacterTrainingContext(characterId) {
	const [skills, attributes, implants] = await Promise.all([
		fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/skills`, characterId),
		fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/attributes`, characterId),
		fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/implants`, characterId)
	]);
	const implantInfos = [];
	for (const id of implants) {
		const info = await getTypeInfo(id);
		if (!_hasDogmaAttributes(info)) throw new Error('Missing implant data.');
		implantInfos.push(info);
	}
	const bonuses = buildAttributeImplantMap(implantInfos);
	// A current remap totals 99 points. Remove the uniform accelerator bonus,
	// retaining the current distribution and active implants even with an empty queue.
	const excess = TRAINING_ATTRIBUTE_NAMES.reduce((sum, name) => sum + Number(attributes[name]) - Number(bonuses[name]?.bonus || 0), 0) - 99;
	const offset = excess / 5;
	const baseline = subtractGlobalAttributeOffset(attributes, offset);
	if (!Number.isInteger(offset) || offset < 0 || TRAINING_ATTRIBUTE_NAMES.some(name => {
		const base = baseline[name] - Number(bonuses[name]?.bonus || 0);
		return !Number.isInteger(base) || base < 17 || base > 27;
	})) throw new Error('Unable to determine attributes without temporary boosters.');
	return { skills: skills.skills, attributes: baseline };
}

window.quickestSkillsToV = async function(characterId) {
	const context = await getCharacterTrainingContext(characterId);
	return buildQuickestSkillsToV(context.skills, context.attributes);
};



function renderCharPlan(characterId) {
	const section = _el('section', 'sq-plan');
	section.appendChild(_el('h4', 'sq-section-title', 'Plan'));
	const workspace = _el('div', 'sq-plan__workspace');
	const research = _el('div', 'sq-plan__research');
	const searchWrap = _el('div', 'sq-research__search-wrap');
	const search = _el('input', 'sq-research__search');
	search.type = 'search';
	search.placeholder = 'Search ships and items';
	search.setAttribute('aria-label', 'Search ships and items');
	searchWrap.appendChild(search);
	const results = _el('div', 'sq-research__results');
	results.hidden = true;
	searchWrap.appendChild(results);
	research.appendChild(searchWrap);
	const selected = _el('div', 'sq-plan__selected');
	research.appendChild(selected);
	const planPanel = _el('section', 'sq-plan__queue');
	const planHeader = _el('div', 'sq-plan__queue-header');
	planHeader.appendChild(_el('h4', 'sq-section-title', 'Plan Queue'));
	const planActions = _el('div', 'sq-plan__queue-actions');
	const clearButton = _el('button', 'sq-btn sq-btn--secondary sq-btn--sm', 'Clear');
	clearButton.type = 'button';
	clearButton.disabled = true;
	planActions.appendChild(clearButton);
	const exportButton = _el('button', 'sq-btn sq-btn--primary sq-btn--sm', 'Export');
	exportButton.type = 'button';
	exportButton.disabled = true;
	planActions.appendChild(exportButton);
	planHeader.appendChild(planActions);
	planPanel.appendChild(planHeader);
	const planBody = _el('div', 'sq-plan__queue-body');
	planPanel.appendChild(planBody);
	workspace.appendChild(research);
	workspace.appendChild(planPanel);
	section.appendChild(workspace);

	const LAST_ITEM_KEY = 'skillq:plan:last-item';
	const LAST_LEVEL_KEY = 'skillq:plan:last-level';
	const readSetting = (key) => { try { return window.localStorage.getItem(key); } catch (_) { return null; } };
	const writeSetting = (key, value) => { try { window.localStorage.setItem(key, String(value)); } catch (_) {} };
	let selection = 0;
	let items = [];
	let masteries = {};
	const requirementAvailability = new Map();
	let context = null;
	let currentItem = null;
	let currentPlan = [];
	let planGoals = new Map();
	let planSources = new Map();
	let highlightedSearchResult = -1;
	const PLAN_STATE_KEY = `skillq:plan:queue:${characterId}`;
	const savePlanState = () => {
		try {
			window.localStorage.setItem(PLAN_STATE_KEY, JSON.stringify({
				goals: Array.from(planGoals.entries()),
				sources: Array.from(planSources.entries()).map(([typeID, values]) => [typeID, Array.from(values)])
			}));
		} catch (_) {}
	};
	const restorePlanState = () => {
		try {
			const saved = JSON.parse(window.localStorage.getItem(PLAN_STATE_KEY) || 'null');
			for (const [typeID, level] of (saved?.goals || [])) planGoals.set(Number(typeID), Number(level));
			for (const [typeID, values] of (saved?.sources || [])) {
				planSources.set(Number(typeID), new Set(values.map((value) => String(value).replace(/\s+—\s+/g, ': '))));
			}
		} catch (_) {}
	};
	restorePlanState();

	const currentLevel = (character, typeID) => Number(character.skills.find((skill) => Number(skill.skill_id) === Number(typeID))?.trained_skill_level || 0);
	const addGoals = (roots, itemName, targetLevel) => {
		let added = 0;
		for (const root of roots) {
			const typeID = Number(root.typeID);
			const level = Number(root.requiredSkillLevel || 0);
			if (!typeID || !level) continue;
			if (!planGoals.has(typeID)) added += 1;
			planGoals.set(typeID, Math.max(Number(planGoals.get(typeID) || 0), level));
			if (!planSources.has(typeID)) planSources.set(typeID, new Set());
			planSources.get(typeID).add(`${itemName}${targetLevel ? `: Mastery ${toRomanNumeral(targetLevel)}` : ': Required'}`);
		}
		savePlanState();
		return added;
	};

	const rebuildPlanQueue = async () => {
		if (!context) context = getCharacterTrainingContext(characterId);
		const character = await context;
		const goals = Array.from(planGoals, ([typeID, requiredSkillLevel]) => ({ typeID, requiredSkillLevel }));
		if (!goals.length) {
			currentPlan = [];
			clearButton.disabled = true;
			exportButton.disabled = true;
			planBody.replaceChildren(_el('p', 'sq-muted', 'Add a ship or item to build the plan queue.'));
			return;
		}
		planBody.textContent = 'Optimizing plan queue…';
		const generated = await buildQuickestSkillsToV(character.skills, character.attributes, goals);
		const incomplete = generated.filter((row) => Number(row.level || 0) > currentLevel(character, row.typeID));
		const optimized = await optimizeSkillQueueOrder(incomplete, character.skills);
		currentPlan = optimized.queue;
		clearButton.disabled = false;
		exportButton.disabled = currentPlan.length === 0;
		planBody.replaceChildren();
		if (!currentPlan.length) {
			planBody.appendChild(_el('p', 'sq-muted', 'All planned skills are already complete.'));
			return;
		}
		const table = document.createElement('table');
		table.className = 'sq-table sq-table--striped';
		const head = document.createElement('thead');
		head.innerHTML = '<tr><th>Skill</th></tr>';
		table.appendChild(head);
		const tbody = document.createElement('tbody');
		for (const row of currentPlan) {
			const tr = document.createElement('tr');
			tr.appendChild((() => { const td = document.createElement('td'); td.appendChild(_a(`/item/${row.typeID}/`, `${row.typeName} ${toRomanNumeral(row.level)}`)); return td; })());
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		planBody.appendChild(table);
	};
	clearButton.addEventListener('click', async () => {
		planGoals.clear();
		planSources.clear();
		savePlanState();
		await rebuildPlanQueue();
	});

	const showItem = async (item, requestedLevel = null) => {
		const request = ++selection;
		currentItem = item;
		writeSetting(LAST_ITEM_KEY, item.id);
		results.hidden = true;
		search.value = item.name;
		try {
			const info = await getTypeInfo(item.id);
			const group = await getGroupInfo(info?.group_id);
			const itemMasteries = masteries[String(item.id)] || null;
			const hasMasteries = Boolean(itemMasteries && Object.keys(itemMasteries).length);
			const baseRoots = group?.category_id === 16 ? [{ typeID: item.id, requiredSkillLevel: 1 }] : _extractRequirementRows(info);
			const options = hasMasteries ? [[0, 'Required'], [1, 'I'], [2, 'II'], [3, 'III'], [4, 'IV'], [5, 'V']] : [[0, 'Required']];
			let targetLevel = options.some(([value]) => value === Number(requestedLevel)) ? Number(requestedLevel) : (hasMasteries ? 1 : 0);
			if (!context) context = getCharacterTrainingContext(characterId);
			const character = await context;
			if (request !== selection) return;
			selected.replaceChildren();
			const title = _el('div', 'sq-plan__selected-title', item.name);
			selected.appendChild(title);
			const controls = _el('div', 'sq-plan__controls');
			const buttons = _el('div', 'sq-research__targets');
			const addButton = _el('button', 'sq-btn sq-btn--primary sq-btn--sm', 'Plan →');
			addButton.type = 'button';
			const refreshButtons = () => Array.from(buttons.children).forEach((button, index) => {
				button.classList.toggle('sq-btn--primary', options[index][0] === targetLevel);
				button.classList.toggle('sq-btn--info', options[index][0] !== targetLevel);
			});
			const requirementBody = _el('div', 'sq-plan__requirements');
			const showRequirements = async () => {
				requirementBody.textContent = 'Loading skills…';
				const roots = hasMasteries && targetLevel > 0 ? (itemMasteries[String(targetLevel)] || []) : baseRoots;
				if (!roots.length) {
					requirementBody.textContent = 'No skill requirements found.';
					return;
				}
				const required = new Map();
				const pending = roots.map((row) => ({ ...row, requiredSkillLevel: Math.max(Number(row.requiredSkillLevel || 0), targetLevel) }));
				while (pending.length) {
					const row = pending.pop();
					if (!row?.typeID || (required.get(row.typeID)?.requiredSkillLevel || 0) >= row.requiredSkillLevel) continue;
					const skillInfo = await getTypeInfo(row.typeID);
					required.set(row.typeID, { ...row, typeName: skillInfo?.name || `Skill ${row.typeID}` });
					pending.push(..._extractRequirementRows(skillInfo));
				}
				const table = document.createElement('table');
				table.className = 'sq-table sq-table--striped';
				const head = document.createElement('thead');
				head.innerHTML = '<tr><th>Skill</th><th>Trained</th><th>Required</th></tr>';
				table.appendChild(head);
				const tbody = document.createElement('tbody');
				for (const row of [...required.values()].sort((left, right) => left.typeName.localeCompare(right.typeName))) {
					const tr = document.createElement('tr');
					const name = document.createElement('td');
					name.appendChild(_a(`/item/${row.typeID}/`, row.typeName));
					tr.appendChild(name);
					tr.appendChild(_el('td', null, toRomanNumeral(currentLevel(character, row.typeID)) || '0'));
					tr.appendChild(_el('td', null, toRomanNumeral(row.requiredSkillLevel)));
					tbody.appendChild(tr);
				}
				table.appendChild(tbody);
				requirementBody.replaceChildren(table);
			};
			for (const [value, label] of options) {
				const button = _el('button', 'sq-btn sq-btn--info sq-btn--sm', label);
				button.type = 'button';
				button.addEventListener('click', () => { targetLevel = value; writeSetting(LAST_LEVEL_KEY, value); refreshButtons(); showRequirements(); });
				buttons.appendChild(button);
			}
			refreshButtons();
			controls.appendChild(buttons);
			controls.appendChild(addButton);
			selected.appendChild(controls);
			const note = _el('p', 'sq-muted', hasMasteries ? 'Choose a mastery level, then add it to the Plan Queue.' : 'This item has prerequisites but no mastery levels.');
			selected.appendChild(note);
			selected.appendChild(requirementBody);
			addButton.addEventListener('click', async () => {
				const roots = hasMasteries && targetLevel > 0 ? (itemMasteries[String(targetLevel)] || []) : baseRoots;
				const incompleteRoots = roots.filter((row) => Number(row.requiredSkillLevel || 0) > currentLevel(character, row.typeID));
				if (!incompleteRoots.length) {
					showToast('No skills to add', addButton);
					await rebuildPlanQueue();
					return;
				}
				const added = addGoals(incompleteRoots, item.name, targetLevel);
				showToast(added ? `${added} skill${added === 1 ? '' : 's'} added` : 'No skills to add', addButton);
				writeSetting(LAST_LEVEL_KEY, targetLevel);
				await rebuildPlanQueue();
			});
			await showRequirements();
		} catch (error) { if (request === selection) selected.textContent = error.message; }
	};

	let searchRequest = 0;
	const renderResults = async () => {
		const request = ++searchRequest;
		results.replaceChildren();
		results.hidden = true;
		highlightedSearchResult = -1;
		if (!search.value.trim()) return;
		results.appendChild(_el('p', 'sq-muted', 'Searching…'));
		results.hidden = false;
		await ensureLocalSdeDataLoaded();
		if (request !== searchRequest) return;
		const words = search.value.trim().toLowerCase().split(/\s+/);
		const candidates = items.filter((item) => words.every((word) => item.name.toLowerCase().includes(word)));
		const matches = [];
		for (const item of candidates) {
			if (matches.length >= 50) break;
			let hasRequirements = requirementAvailability.get(Number(item.id));
			if (hasRequirements === undefined) {
				const itemMasteries = masteries[String(item.id)];
				const masteryRequirements = itemMasteries && Object.values(itemMasteries).some((rows) => Array.isArray(rows) && rows.length);
				const info = masteryRequirements ? null : (localTypeInfoCache.get(String(item.id)) || await getTypeInfo(item.id));
				hasRequirements = Boolean(masteryRequirements || _extractRequirementRows(info).length);
				requirementAvailability.set(Number(item.id), hasRequirements);
			}
			if (hasRequirements) matches.push(item);
			if (request !== searchRequest) return;
		}
		if (request !== searchRequest) return;
		results.replaceChildren();
		for (const item of matches.slice(0, 50)) {
			const choose = _el('button', 'sq-research__result', item.name);
			choose.type = 'button';
			choose.addEventListener('mouseenter', () => {
				highlightedSearchResult = Array.from(results.children).indexOf(choose);
				updateSearchHighlight();
			});
			choose.addEventListener('click', () => showItem(item));
			results.appendChild(choose);
		}
		if (!matches.length) results.appendChild(_el('p', 'sq-muted', 'No matching items with skill requirements.'));
		results.hidden = false;
	};
	const updateSearchHighlight = () => {
		const choices = Array.from(results.querySelectorAll('.sq-research__result'));
		choices.forEach((choice, index) => choice.classList.toggle('sq-research__result--active', index === highlightedSearchResult));
		if (highlightedSearchResult >= 0 && choices[highlightedSearchResult]) choices[highlightedSearchResult].scrollIntoView({ block: 'nearest' });
	};
	search.addEventListener('input', renderResults);
	search.addEventListener('keydown', (event) => {
		const choices = Array.from(results.querySelectorAll('.sq-research__result'));
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			if (!choices.length) return;
			event.preventDefault();
			const direction = event.key === 'ArrowDown' ? 1 : -1;
			highlightedSearchResult = (highlightedSearchResult + direction + choices.length) % choices.length;
			updateSearchHighlight();
		} else if (event.key === 'Enter' && highlightedSearchResult >= 0 && choices[highlightedSearchResult]) {
			event.preventDefault();
			choices[highlightedSearchResult].click();
		} else if (event.key === 'Escape') {
			results.hidden = true;
			highlightedSearchResult = -1;
		}
	});
	exportButton.addEventListener('click', async () => {
		const optimized = await optimizeSkillQueueOrder(currentPlan, (await context).skills);
		_showSkillQueueOptimizationModal(optimized.queue, optimized.warnings, 'Plan');
	});
	Promise.all([fetchLocalJson('/data/items.json'), fetchLocalJson('/data/masteries.json')]).then(async ([itemData, masteryData]) => {
		items = Array.isArray(itemData) ? itemData : [];
		masteries = masteryData && typeof masteryData === 'object' ? masteryData : {};
		search.disabled = false;
		await rebuildPlanQueue();
		const lastItem = items.find((item) => String(item.id) === readSetting(LAST_ITEM_KEY));
		if (lastItem) await showItem(lastItem, readSetting(LAST_LEVEL_KEY));
	}).catch((error) => { selected.textContent = error.message; });
	search.disabled = true;
	planBody.appendChild(_el('p', 'sq-muted', 'Add a ship or item to build the plan queue.'));
	return section;
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

function _createItemEnablesSection(itemName, enables) {
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
				metaText: `Requires ${itemName} ` + toRomanNumeral(level),
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

	await removeCharacterAndLocalData(characterId);

	if (!window.esi.whoami) {
		history.replaceState(null, '', '/');
		await handleRoute();
		return;
	}

	await renderManagePage();
}

async function removeCharacterAndLocalData(characterId) {
	await window.esi.removeCharacter(characterId);
	await clearCharacterLocalData(characterId);
	await removeCharacterFromManageSettings(characterId);
}

function isCharacterRefreshTokenError(err) {
	if (!err || err.name !== 'SimpleESITokenRefreshError') {
		return false;
	}
	const code = String(err.code || '').toLowerCase();
	return code === 'invalid_grant';
}

async function handleCharacterRefreshTokenError(err, characterId) {
	if (!isCharacterRefreshTokenError(err)) {
		return false;
	}

	const charId = String(characterId || err?.characterId || '');
	if (!charId) {
		return false;
	}
	if (removingCharactersForAuthError.has(charId)) {
		return true;
	}

	removingCharactersForAuthError.add(charId);
	try {
		console.warn(`Removing character ${charId} due to refresh token failure`, err);
		await removeCharacterAndLocalData(charId);

		if (!window.esi?.whoami) {
			history.replaceState(null, '', '/');
			await handleRoute();
			return true;
		}

		scheduleRouteRerender();
		return true;
	} finally {
		removingCharactersForAuthError.delete(charId);
	}
}

async function fallbackUnlessCharacterRefreshTokenError(promise, fallbackValue, characterId) {
	try {
		return await promise;
	} catch (err) {
		if (await handleCharacterRefreshTokenError(err, characterId)) {
			throw err;
		}
		return (typeof fallbackValue === 'function') ? fallbackValue() : fallbackValue;
	}
}

async function clearCharacterLocalData(characterId) {
	const charId = String(characterId);
	const keys = [
		`summary:${charId}`,
		`common:${charId}`,
		`wallet:${charId}`,
		`train:${charId}`,
		getTrainCacheKey(charId),
		`overview:${charId}`,
		getCharacterNoteKey(charId)
	];
	for (const key of keys) {
		await characterDataStore.delete(key);
	}

	if (window.esi?.store?.table) {
		await Promise.all([
			window.esi.store.table.where('key').startsWith(`simpleesi-global-whoami-${charId}`).delete(),
			window.esi.store.table.where('key').startsWith(`simpleesi-${charId}-`).delete(),
			window.esi.store.table.where('key').startsWith(`simpleesi-global-esi-cache-${ESI_BASE}/characters/${charId}`).delete()
		]);
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

function renderHomeGroupHeader(groupLabel, { showRule = true } = {}) {
	const wrapper = document.createElement('div');
	wrapper.className = 'sq-char-group';

	const heading = document.createElement('h4');
	heading.className = 'sq-char-group__title';
	heading.textContent = groupLabel;
	wrapper.appendChild(heading);

	if (showRule) {
		const rule = document.createElement('hr');
		rule.className = 'sq-char-group__rule';
		wrapper.appendChild(rule);
	}

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
	const normalized = normalizeManageSettings(saved);
	if (saved != null) {
		await lookupCacheSet(MANAGE_SETTINGS_KEY, normalized, null);
	}
	return normalized;
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

function dateStampForFileName(value = Date.now()) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}
	const yyyy = String(date.getUTCFullYear());
	const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(date.getUTCDate()).padStart(2, '0');
	const hh = String(date.getUTCHours()).padStart(2, '0');
	const mi = String(date.getUTCMinutes()).padStart(2, '0');
	const ss = String(date.getUTCSeconds()).padStart(2, '0');
	return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function bytesToBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToBytes(value) {
	const binary = atob(String(value || ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function deriveBackupAesKey(password, saltBytes) {
	const encoder = new TextEncoder();
	const baseKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(password),
		'PBKDF2',
		false,
		['deriveKey']
	);

	return await crypto.subtle.deriveKey({
		name: 'PBKDF2',
		salt: saltBytes,
		iterations: 250000,
		hash: 'SHA-256'
	}, baseKey, {
		name: 'AES-GCM',
		length: 256
	}, false, ['encrypt', 'decrypt']);
}

async function encryptBackupPayload(payload, password) {
	if (!password || String(password).trim().length < 8) {
		throw new Error('Backup password must be at least 8 characters.');
	}

	const encoder = new TextEncoder();
	const plaintext = encoder.encode(JSON.stringify(payload));
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveBackupAesKey(password, salt);
	const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

	return {
		kind: BACKUP_KIND,
		version: BACKUP_VERSION,
		kdf: 'PBKDF2-SHA256',
		iterations: 250000,
		cipher: 'AES-GCM-256',
		salt: bytesToBase64(salt),
		iv: bytesToBase64(iv),
		ciphertext: bytesToBase64(new Uint8Array(encrypted))
	};
}

async function decryptBackupPayload(envelope, password) {
	if (!envelope || envelope.kind !== BACKUP_KIND || Number(envelope.version) !== BACKUP_VERSION) {
		throw new Error('Invalid backup format.');
	}
	if (!password) {
		throw new Error('Backup password is required.');
	}

	const salt = base64ToBytes(envelope.salt);
	const iv = base64ToBytes(envelope.iv);
	const ciphertext = base64ToBytes(envelope.ciphertext);
	const key = await deriveBackupAesKey(password, salt);
	const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
	const decoder = new TextDecoder();

	return JSON.parse(decoder.decode(decrypted));
}

function collectSkillqLocalStorageEntries() {
	const entries = {};
	try {
		for (let index = 0; index < window.localStorage.length; index += 1) {
			const key = window.localStorage.key(index);
			if (!key || !key.startsWith('skillq:')) continue;
			entries[key] = window.localStorage.getItem(key);
		}
	} catch (_) {
		// Ignore localStorage read failures.
	}
	return entries;
}

async function collectSkillqBackupPayload() {
	const rows = await window.esi.store.table.toArray();
	const globalWhoamiRaw = await window.esi.store.get('simpleesi-global-whoami');
	const loggedInCharacters = await window.esi.getLoggedInCharacters();
	const charactersById = new Map();

	for (const char of loggedInCharacters) {
		const charId = String(char?.character_id || '');
		if (!charId) continue;

		let whoami = null;
		const whoamiRaw = await window.esi.store.get(`${SIMPLEESI_GLOBAL_WHOAMI_PREFIX}${charId}`);
		if (whoamiRaw) {
			try {
				whoami = JSON.parse(whoamiRaw);
			} catch (_) {
				whoami = null;
			}
		}

		if (!whoami && String(window.esi?.whoami?.character_id || '') === charId) {
			whoami = window.esi.whoami;
		}

		let authed = null;
		try {
			authed = await window.esi.lsGet('authed_json', charId);
		} catch (_) {
			authed = null;
		}

		// Back-compat: older installs may only have the current character auth at global scope.
		if (!authed && String(window.esi?.whoami?.character_id || '') === charId) {
			try {
				authed = await window.esi.lsGet('authed_json', true);
			} catch (_) {
				authed = null;
			}
		}

		const refreshToken = String(authed?.refresh_token || '');
		if (!refreshToken) continue;

		charactersById.set(charId, {
			character_id: charId,
			whoami: whoami || {
				character_id: charId,
				name: String(char?.name || `Character ${charId}`)
			},
			refresh_token: refreshToken
		});
	}

	// Last fallback: scan raw rows to recover any character tokens not surfaced by getLoggedInCharacters.
	for (const row of rows) {
		const key = String(row?.key || '');
		if (!key || !key.startsWith(SIMPLEESI_CHAR_KEY_PREFIX) || !key.endsWith(SIMPLEESI_AUTHED_SUFFIX)) continue;
		const charId = key.slice(SIMPLEESI_CHAR_KEY_PREFIX.length, key.length - SIMPLEESI_AUTHED_SUFFIX.length);
		if (!charId || charId === 'global' || charactersById.has(charId)) continue;

		let authed = null;
		try {
			authed = JSON.parse(row.value);
		} catch (_) {
			authed = null;
		}
		const refreshToken = String(authed?.refresh_token || '');
		if (!refreshToken) continue;

		let whoami = null;
		const whoamiRaw = await window.esi.store.get(`${SIMPLEESI_GLOBAL_WHOAMI_PREFIX}${charId}`);
		if (whoamiRaw) {
			try {
				whoami = JSON.parse(whoamiRaw);
			} catch (_) {
				whoami = null;
			}
		}

		charactersById.set(charId, {
			character_id: charId,
			whoami: whoami || {
				character_id: charId,
				name: `Character ${charId}`
			},
			refresh_token: refreshToken
		});
	}

	const characters = Array.from(charactersById.values())
		.sort((left, right) => String(left.whoami?.name || '').localeCompare(String(right.whoami?.name || '')));
	for (const entry of characters) {
		entry.note = await getCharacterNoteRecord(entry.character_id);
	}

	let activeCharacterId = null;
	if (globalWhoamiRaw) {
		try {
			activeCharacterId = String(JSON.parse(globalWhoamiRaw)?.character_id || '');
		} catch (_) {
			activeCharacterId = null;
		}
	}
	if (!activeCharacterId) {
		activeCharacterId = String(window.esi?.whoami?.character_id || '');
	}

	const [layoutModeSetting, themeModeSetting, manageSetting, skillEnablesIndexSetting] = await Promise.all([
		lookupCacheGet(LAYOUT_MODE_KEY),
		lookupCacheGet(THEME_MODE_KEY),
		lookupCacheGet(MANAGE_SETTINGS_KEY),
		lookupCacheGet(SKILL_ENABLES_INDEX_KEY)
	]);

	return {
		kind: BACKUP_KIND,
		version: BACKUP_VERSION,
		exportedAt: new Date().toISOString(),
		characters,
		activeCharacterId,
		settings: {
			layoutMode: layoutModeSetting?.mode || layoutMode,
			themeMode: themeModeSetting?.mode || themeMode,
			manage: normalizeManageSettings(manageSetting),
			skillEnablesIndex: skillEnablesIndexSetting || null,
			localStorageSkillq: collectSkillqLocalStorageEntries()
		}
	};
}

async function writeImportedBackupPayload(payload) {
	if (!payload || payload.kind !== BACKUP_KIND || Number(payload.version) !== BACKUP_VERSION) {
		throw new Error('Backup data is not recognized.');
	}

	const characters = Array.isArray(payload.characters) ? payload.characters : [];
	if (characters.length === 0) {
		throw new Error('Backup has no characters to import.');
	}

	for (const entry of characters) {
		const characterId = String(entry?.character_id || '');
		const whoami = entry?.whoami;
		const refreshToken = String(entry?.refresh_token || '');
		if (!characterId || !whoami || !refreshToken) continue;

		await window.esi.store.set(`simpleesi-global-whoami-${characterId}`, JSON.stringify(whoami));
		await window.esi.store.set(`simpleesi-${characterId}-authed_json`, JSON.stringify({
			refresh_token: refreshToken,
			token_type: 'Bearer'
		}));
		await window.esi.store.delete(`simpleesi-${characterId}-access_token`);
		if (entry.note && Object.prototype.hasOwnProperty.call(entry.note, 'text')) {
			await saveCharacterNote(characterId, entry.note.text, entry.note.updatedAt);
		}
	}

	const preferredCharacterId = String(payload.activeCharacterId || characters[0]?.character_id || '');
	const preferred = characters.find((entry) => String(entry?.character_id || '') === preferredCharacterId) || characters[0];
	if (preferred?.whoami) {
		await window.esi.store.set('simpleesi-global-whoami', JSON.stringify(preferred.whoami));
		window.esi.whoami = preferred.whoami;
	}
	await window.esi.store.delete('simpleesi-global-loggedout');

	const settings = payload.settings || {};
	await lookupCacheSet(LAYOUT_MODE_KEY, { mode: String(settings.layoutMode || 'restricted') });
	await lookupCacheSet(THEME_MODE_KEY, { mode: String(settings.themeMode || 'dark') });
	await lookupCacheSet(MANAGE_SETTINGS_KEY, normalizeManageSettings(settings.manage));
	if (settings.skillEnablesIndex != null) {
		await lookupCacheSet(SKILL_ENABLES_INDEX_KEY, settings.skillEnablesIndex);
	}

	try {
		const localEntries = settings.localStorageSkillq && typeof settings.localStorageSkillq === 'object'
			? settings.localStorageSkillq
			: {};
		for (const [key, value] of Object.entries(localEntries)) {
			if (key.startsWith('skillq:')) {
				window.localStorage.setItem(key, value == null ? '' : String(value));
			}
		}
	} catch (_) {
		// Ignore localStorage write failures.
	}
}

async function exportEncryptedSkillqBackup() {
	if (!window.fflate || typeof window.fflate.zipSync !== 'function') {
		throw new Error('Zip support is unavailable.');
	}
	if (!window.crypto?.subtle) {
		throw new Error('Web Crypto support is unavailable in this browser context.');
	}

	const payload = await collectSkillqBackupPayload();
	if (!Array.isArray(payload.characters) || payload.characters.length === 0) {
		throw new Error('No characters with refresh tokens found to export.');
	}

	const password = window.prompt('Enter a password for this backup (minimum 8 characters):', '');
	if (password == null) return;
	const confirmPassword = window.prompt('Confirm backup password:', '');
	if (confirmPassword == null) return;
	if (password !== confirmPassword) {
		throw new Error('Passwords did not match.');
	}

	const encryptedEnvelope = await encryptBackupPayload(payload, password);
	const entryBytes = new TextEncoder().encode(JSON.stringify(encryptedEnvelope));
	const zipBytes = window.fflate.zipSync({
		[BACKUP_ZIP_ENTRY_NAME]: entryBytes
	});

	const blob = new Blob([zipBytes], { type: 'application/zip' });
	const fileName = `${BACKUP_FILENAME_PREFIX}-${dateStampForFileName()}.zip`;
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

async function importEncryptedSkillqBackup(file) {
	if (!window.fflate || typeof window.fflate.unzipSync !== 'function') {
		throw new Error('Zip support is unavailable.');
	}
	if (!window.crypto?.subtle) {
		throw new Error('Web Crypto support is unavailable in this browser context.');
	}
	if (!file) {
		throw new Error('No backup file selected.');
	}

	const confirmed = window.confirm('Importing will merge characters/settings from backup into this browser. Continue?');
	if (!confirmed) return;

	const password = window.prompt('Enter the backup password:', '');
	if (password == null) return;

	const buffer = await file.arrayBuffer();
	const archive = window.fflate.unzipSync(new Uint8Array(buffer));
	const encryptedEntry = archive[BACKUP_ZIP_ENTRY_NAME];
	if (!encryptedEntry) {
		throw new Error(`Backup is missing ${BACKUP_ZIP_ENTRY_NAME}.`);
	}

	let envelope;
	try {
		envelope = JSON.parse(new TextDecoder().decode(encryptedEntry));
	} catch (_) {
		throw new Error('Backup payload is not valid JSON.');
	}

	let payload;
	try {
		payload = await decryptBackupPayload(envelope, password);
	} catch (_) {
		throw new Error('Failed to decrypt backup. Check password and file.');
	}

	await writeImportedBackupPayload(payload);
	applyLayoutMode(String(payload?.settings?.layoutMode || layoutMode));
	applyThemeMode(String(payload?.settings?.themeMode || themeMode));
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
	if (tab === 'notes') {
		const noteRecord = await getCharacterNoteRecord(characterId);
		data.note = noteRecord.text;
		data.noteUpdatedAt = noteRecord.updatedAt;
		return data;
	}

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

	if (tab === 'train' || tab === 'clones') {
		if (Number(data?.training?.trainingEndMs || 0) > 0 && Number(data.training.trainingEndMs) <= Date.now()) {
			const overviewCached = await cacheGetCharacterData(`overview:${characterId}`);
			applyOverviewTrainingToCommonData(data, overviewCached?.queue || []);
		}
		const trainData = (await cacheGetCharacterData(getTrainCacheKey(characterId))) || { clones: [], implants: [], suggestions: [], optimize: null, injectorEstimate: null, updatedAt: 0 };
		if (tab === 'clones') {
			data.clones = trainData.clones || [];
		} else {
			data.implants = trainData.implants;
			data.suggestions = trainData.suggestions;
			data.optimize = trainData.optimize || null;
			data.injectorEstimate = trainData.injectorEstimate || null;
		}
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

function initBackgroundRefresh() {
	if (backgroundRefreshInitialized) return;
	backgroundRefreshInitialized = true;

	console.log('Initializing background character summary refresh');
	refreshCharacterSummariesInBackground();
}	

async function refreshCharacterSummariesInBackground() {
	try {
		const shouldPreloadPageData = await shouldRunScheduledRefresh();
		const characters = await window.esi.getLoggedInCharacters();
		await Promise.all(characters.map(async (char) => {
			const characterId = String(char.character_id);
			await refreshCharacterSummaryInBackground(characterId, char.name);
			if (shouldPreloadPageData || await isCharacterPageDataMissing(characterId)) {
				await refreshCharacterPageInBackground(characterId);
			}
		}));
		if (shouldPreloadPageData) {
			await cacheSetCharacterData(LAST_BACKGROUND_REFRESH_KEY, { updatedAt: Date.now() });
		}
	} finally {
		setTimeout(refreshCharacterSummariesInBackground, BACKGROUND_REFRESH_JOB_INTERVAL_MS);
	}
}

async function isCharacterPageDataMissing(characterId) {
	const [common, wallet, train, overview] = await Promise.all([
		cacheGetCharacterData(`common:${characterId}`),
		cacheGetCharacterData(`wallet:${characterId}`),
		cacheGetCharacterData(getTrainCacheKey(characterId)),
		cacheGetCharacterData(`overview:${characterId}`)
	]);
	const missingTrainOptimize = Boolean(train)
		&& Array.isArray(train?.suggestions)
		&& train.suggestions.length > 0
		&& !Object.prototype.hasOwnProperty.call(train || {}, 'optimize');
	const missingTrainClones = Boolean(train)
		&& !Object.prototype.hasOwnProperty.call(train || {}, 'clones');
	return !common || !wallet || !train || !overview || missingTrainOptimize || missingTrainClones;
}

async function refreshCharacterSummaryInBackground(characterId, characterName) {
	const summaryKey = `summary:${characterId}`;
	const cachedSummary = await cacheGetCharacterData(summaryKey);
	const cachedSummaryTrainingEndMs = Number(cachedSummary?.training?.trainingEndMs || 0);
	const cachedLastTrainingEndMs = Math.max(
		Number(cachedSummary?.training?.lastTrainingEndMs || 0),
		cachedSummaryTrainingEndMs > 0 && cachedSummaryTrainingEndMs <= Date.now() ? cachedSummaryTrainingEndMs : 0
	);
	const missingTrainingLevel = Boolean(cachedSummary?.training?.typeName)
		&& !Number(cachedSummary?.training?.level || 0);
	const missingCharacterBoosterFlag = Boolean(cachedSummary?.training?.typeName)
		&& !Object.prototype.hasOwnProperty.call(cachedSummary?.training || {}, 'hasCharacterBooster');
	const finishedTraining = hasTrainingCompleted(cachedSummary?.training);
	if (!(await shouldRefreshCharacterData(summaryKey)) && !missingTrainingLevel && !missingCharacterBoosterFlag && !finishedTraining) {
		return;
	}

	console.log('Refreshing background summary for', characterName);
	try {
		const [balance, skills, queue, attr, implants, char] = await Promise.all([
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/wallet`, characterId),
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/skills`, characterId),
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/skillqueue`, characterId),
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/attributes`, characterId),
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/implants`, characterId),
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}`, characterId)
		]);
		const implantInfos = await Promise.all((implants || []).map((typeId) => getTypeInfo(typeId)));
		const implantByAttribute = buildAttributeImplantMap(implantInfos);
		const corporationId = char?.corporation_id ? String(char.corporation_id) : null;
		const allianceId = char?.alliance_id ? String(char.alliance_id) : null;
		if (corporationId) {
			const corporation = await getCorporationInfo(corporationId);
			char.corporation_name = corporation?.name || null;
		}
		if (allianceId) {
			const alliance = await getAllianceInfo(allianceId);
			char.alliance_name = alliance?.name || null;
		}

		let training = null;
		if (Array.isArray(queue) && queue.length > 0) {
			const now = Date.now();
			const activeQueueRow = queue.find((row) => {
				const startMs = row?.start_date ? Date.parse(row.start_date) : 0;
				const endMs = row?.finish_date ? Date.parse(row.finish_date) : 0;
				return startMs > 0 && endMs > now && startMs <= now;
			});
			const active = activeQueueRow || pickCurrentOrNextQueueRow(queue);
			const typeInfos = new Map(await Promise.all(
				queue.map(async (row) => [Number(row?.skill_id || 0), await getTypeInfo(row?.skill_id)])
			));
			const inferredAttributeOffset = inferGlobalAttributeOffset(queue, typeInfos, attr);
			const baselineAttributes = subtractGlobalAttributeOffset(attr, inferredAttributeOffset);
			const hasCharacterBooster = inferredAttributeOffset > 0 || await inferQueueHasBooster(queue, baselineAttributes, typeInfos);
			const queueEmptyMs = Math.max(0, ...queue.map((row) => (row?.finish_date ? (Date.parse(row.finish_date) || 0) : 0)));
			const latestQueueTrainingEndMs = Math.max(0, ...queue.map((row) => {
				const endMs = row?.finish_date ? (Date.parse(row.finish_date) || 0) : 0;
				return endMs > 0 && endMs <= now ? endMs : 0;
			}));
			const lastTrainingEndMs = Math.max(cachedLastTrainingEndMs, latestQueueTrainingEndMs);
			if (active) {
				const typeInfo = await getTypeInfo(active?.skill_id);
				const trainingRate = getQueueRowTrainingRateContext(active, typeInfo, baselineAttributes);
				const trainingStartMs = active?.start_date ? (Date.parse(active.start_date) || 0) : 0;
				const trainingEndMs = active?.finish_date ? (Date.parse(active.finish_date) || 0) : 0;
				const isCurrentlyTraining = trainingStartMs > 0 && trainingEndMs > now && trainingStartMs <= now;
				training = {
					typeName: typeInfo?.name || null,
					level: Number(active?.finished_level || 0),
					trainingStartMs,
					trainingEndMs,
					queueEmptyMs,
					isCurrentlyTraining,
					lastTrainingEndMs,
					hasTrainingBooster: trainingRate.hasTrainingBooster || (isCurrentlyTraining && hasCharacterBooster),
					hasCharacterBooster
				};
			} else if (lastTrainingEndMs > 0) {
				training = {
					typeName: null,
					level: 0,
					trainingStartMs: 0,
					trainingEndMs: 0,
					queueEmptyMs,
					isCurrentlyTraining: false,
					lastTrainingEndMs,
					hasTrainingBooster: false,
					hasCharacterBooster
				};
			}
		} else if (cachedLastTrainingEndMs > 0) {
			training = {
				typeName: null,
				level: 0,
				trainingStartMs: 0,
				trainingEndMs: 0,
				queueEmptyMs: 0,
				isCurrentlyTraining: false,
				lastTrainingEndMs: cachedLastTrainingEndMs,
				hasTrainingBooster: false,
				hasCharacterBooster: false
			};
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
		if (await handleCharacterRefreshTokenError(err, characterId)) {
			return;
		}
		console.warn(`Background summary refresh failed for ${characterId}`, err);
	}
}

async function refreshCharacterPageInBackground(characterId, tab) {
	const commonKey = `common:${characterId}`;
	const cachedCommon = await cacheGetCharacterData(commonKey);
	const cachedCommonTrainingEndMs = Number(cachedCommon?.training?.trainingEndMs || 0);
	const cachedCommonLastTrainingEndMs = Math.max(
		Number(cachedCommon?.training?.lastTrainingEndMs || 0),
		cachedCommonTrainingEndMs > 0 && cachedCommonTrainingEndMs <= Date.now() ? cachedCommonTrainingEndMs : 0
	);
	const cachedOverview = await cacheGetCharacterData(`overview:${characterId}`);
	const cachedTrain = await cacheGetCharacterData(getTrainCacheKey(characterId));
	const missingTrainingLevel = Boolean(cachedCommon?.training?.typeName)
		&& !Number(cachedCommon?.training?.level || 0);
	const missingTrainingBoosterFlag = Boolean(cachedCommon?.training?.typeName)
		&& !Object.prototype.hasOwnProperty.call(cachedCommon?.training || {}, 'hasTrainingBooster');
	const missingCharacterBoosterFlag = Boolean(cachedCommon?.training?.typeName)
		&& !Object.prototype.hasOwnProperty.call(cachedCommon?.training || {}, 'hasCharacterBooster');
	const overviewMissingBoosterFlagShape = Array.isArray(cachedOverview?.queue)
		&& cachedOverview.queue.some((row) => !Object.prototype.hasOwnProperty.call(row || {}, 'hasTrainingBooster'));
	const overviewNeedsBoosterRecalc = Boolean(cachedCommon?.training?.hasCharacterBooster)
		&& Array.isArray(cachedOverview?.queue)
		&& cachedOverview.queue.length > 0
		&& !cachedOverview.queue.some((row) => Boolean(row?.hasTrainingBooster));
	const missingOverviewBoosterFlags = overviewMissingBoosterFlagShape || overviewNeedsBoosterRecalc;
	const missingTrainOptimize = Array.isArray(cachedTrain?.suggestions)
		&& cachedTrain.suggestions.length > 0
		&& !Object.prototype.hasOwnProperty.call(cachedTrain || {}, 'optimize');
	const missingTrainClones = Boolean(cachedTrain)
		&& !Object.prototype.hasOwnProperty.call(cachedTrain || {}, 'clones');
	const finishedTraining = hasTrainingCompleted(cachedCommon?.training);
	const shouldRefreshCommon = await shouldRefreshCharacterData(commonKey);
	const shouldRefreshWallet = await shouldRefreshCharacterData(`wallet:${characterId}`);
	const shouldRefreshTrain = await shouldRefreshCharacterData(getTrainCacheKey(characterId));
	const shouldRefreshOverview = await shouldRefreshCharacterData(`overview:${characterId}`);
	if (!shouldRefreshCommon && !missingTrainingLevel && !missingTrainingBoosterFlag && !missingCharacterBoosterFlag && !missingOverviewBoosterFlags && !missingTrainOptimize && !missingTrainClones && !finishedTraining) {
		if (tab === 'wallet' && !shouldRefreshWallet) return;
		if (tab === 'train' && !shouldRefreshTrain) return;
		if (tab === 'clones' && !shouldRefreshTrain) return;
		if (tab === 'overview' && !shouldRefreshOverview) return;
		if (tab == null && !shouldRefreshWallet && !shouldRefreshTrain && !shouldRefreshOverview) return;
	}

	try {
		if (missingTrainingLevel || missingTrainingBoosterFlag || missingCharacterBoosterFlag || missingOverviewBoosterFlags || finishedTraining || shouldRefreshCommon) {
			const common = await fetchCharacterCommonData(characterId, cachedCommonLastTrainingEndMs);
			common.message = null;
			common.updatedAt = Date.now();
			await cacheSetCharacterData(commonKey, common) || await cacheTouchCharacterData(commonKey);
		}

		if (tab === 'wallet') {
			if (!shouldRefreshWallet) return;
			const wallet = await fetchWalletRows(characterId);
			await cacheSetCharacterData(`wallet:${characterId}`, { rows: wallet, updatedAt: Date.now() })
				|| await cacheTouchCharacterData(`wallet:${characterId}`);
			return;
		}

		if (tab === 'train') {
			if (!shouldRefreshTrain && !missingTrainOptimize && !missingTrainClones) return;
			const train = await fetchTrainingSuggestions(characterId);
			train.updatedAt = Date.now();
			await cacheSetCharacterData(getTrainCacheKey(characterId), train)
				|| await cacheTouchCharacterData(getTrainCacheKey(characterId));
			return;
		}

		if (tab === 'clones') {
			if (!shouldRefreshTrain && !missingTrainClones) return;
			const train = await fetchTrainingSuggestions(characterId);
			train.updatedAt = Date.now();
			await cacheSetCharacterData(getTrainCacheKey(characterId), train)
				|| await cacheTouchCharacterData(getTrainCacheKey(characterId));
			return;
		}

		if (tab === 'overview') {
			if (!shouldRefreshOverview && !missingOverviewBoosterFlags) return;
			const overview = await fetchSkillsOverview(characterId);
			overview.updatedAt = Date.now();
			await cacheSetCharacterData(`overview:${characterId}`, overview)
				|| await cacheTouchCharacterData(`overview:${characterId}`);
			return;
		}

		if (shouldRefreshWallet) {
			const wallet = await fetchWalletRows(characterId);
			await cacheSetCharacterData(`wallet:${characterId}`, { rows: wallet, updatedAt: Date.now() })
				|| await cacheTouchCharacterData(`wallet:${characterId}`);
		}

		if (shouldRefreshTrain || missingTrainOptimize || missingTrainClones) {
			const train = await fetchTrainingSuggestions(characterId);
			train.updatedAt = Date.now();
			await cacheSetCharacterData(getTrainCacheKey(characterId), train)
				|| await cacheTouchCharacterData(getTrainCacheKey(characterId));
		}

		if (!shouldRefreshOverview && !missingOverviewBoosterFlags) return;
		const overview = await fetchSkillsOverview(characterId);
		overview.updatedAt = Date.now();
		await cacheSetCharacterData(`overview:${characterId}`, overview)
			|| await cacheTouchCharacterData(`overview:${characterId}`);
	} catch (err) {
		if (await handleCharacterRefreshTokenError(err, characterId)) {
			return;
		}
		console.warn(`Background page refresh failed for ${characterId}`, err);
	}
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

	window.addEventListener(CHARACTER_DATA_UPDATED_EVENT, (event) => {
		const key = String(event?.detail?.key || '');
		if (!shouldRerenderCurrentRouteForKey(key)) {
			return;
		}
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

function shouldRerenderCurrentRouteForKey(key) {
	if (!key || key === LAST_BACKGROUND_REFRESH_KEY) return false;

	const route = parseRoute(window.location.pathname);
	if (route.name === 'home' || route.name === 'manage') {
		return key.startsWith('summary:');
	}

	if (route.name === 'char') {
		const renderedCharacterId = document.querySelector('#char-view-root .sq-char-view[data-character-id]')?.dataset?.characterId
			|| String(window.esi?.whoami?.character_id || '');
		if (!renderedCharacterId) return true;
		return key.startsWith(`summary:${renderedCharacterId}`)
			|| key.startsWith(`common:${renderedCharacterId}`)
			|| key.startsWith(`overview:${renderedCharacterId}`)
			|| key.startsWith(`wallet:${renderedCharacterId}`)
			|| key.startsWith(`${TRAIN_CACHE_KEY_PREFIX}:${renderedCharacterId}`)
			|| key === getCharacterNoteKey(renderedCharacterId);
	}

	if (route.name === 'settings' || route.name === 'readme' || route.name === 'share' || route.name === 'item') {
		return false;
	}

	return true;
}

function scheduleRouteRerender() {
	if (routeRerenderScheduled) return;
	routeRerenderScheduled = true;
	setTimeout(() => {
		routeRerenderScheduled = false;
		if (!window.esi?.whoami) return;
		if (window.location.pathname === '/auth') return;
		if ((window.location.pathname === '/manage' || window.location.pathname === '/manage/') && hasUnsavedManageChanges()) {
			return;
		}
		if ((window.location.pathname === '/settings' || window.location.pathname === '/settings/' || window.location.pathname === '/account' || window.location.pathname === '/account/') && hasUnsavedAccountChanges()) {
			return;
		}
		const currentRoute = parseRoute(window.location.pathname);
		if (currentRoute.name === 'char' && currentRoute.tab === 'notes' && hasUnsavedCharacterNoteChanges()) {
			return;
		}
		handleRoute();
	}, 120);
}

function hasUnsavedManageChanges() {
	const form = document.querySelector('.sq-manage-form');
	if (!form) return false;
	const fields = form.querySelectorAll('input[name^="group-"], input[name^="custom-"], select[name="groupOrderBy"], select[name="orderBy"]');
	for (const field of fields) {
		const initialValue = field.dataset.initialValue;
		if (typeof initialValue === 'undefined') continue;
		if (String(field.value ?? '') !== initialValue) return true;
	}
	return false;
}

function hasUnsavedAccountChanges() {
	const form = document.querySelector('.sq-account-form');
	if (!form) return false;
	const fields = form.querySelectorAll('select[name="fluid"], select[name="themeMode"]');
	for (const field of fields) {
		const initialValue = field.dataset.initialValue;
		if (typeof initialValue === 'undefined') continue;
		if (String(field.value ?? '') !== initialValue) return true;
	}
	return false;
}

function hasUnsavedCharacterNoteChanges() {
	const textarea = document.querySelector('.sq-notes__textarea');
	if (!textarea) return false;
	return String(textarea.value || '') !== String(textarea.dataset.initialValue || '');
}

async function shouldRunScheduledRefresh() {
	const meta = await cacheGetCharacterData(LAST_BACKGROUND_REFRESH_KEY);
	const last = Number(meta?.updatedAt || 0);
	return !last || (Date.now() - last) >= BACKGROUND_REFRESH_INTERVAL_MS;
}

async function shouldRefreshCharacterData(key) {
	const cached = await cacheGetCharacterData(key);
	const last = Number(cached?.updatedAt || 0);
	return !last || (Date.now() - last) >= CHARACTER_DATA_REFRESH_INTERVAL_MS;
}

async function fetchCharacterCommonData(characterId, fallbackLastTrainingEndMs = 0) {
	try {
		const [charInfo, balance, queue, history, attributes, implants] = await Promise.all([
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}`, characterId),
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/wallet`, characterId),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/skillqueue`, characterId),
				[],
				characterId
			),
			fetchLatestCharacterJson(`${ESI_BASE}/characters/${characterId}/corporationhistory`).catch(() => []),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/attributes`, characterId),
				null,
				characterId
			),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/implants`, characterId),
				[],
				characterId
			)
		]);

		const implantInfos = await Promise.all((implants || []).map((typeId) => getTypeInfo(typeId)));
		buildAttributeImplantMap(implantInfos);

		const [corporation, alliance] = await Promise.all([
			charInfo?.corporation_id ? getCorporationInfo(charInfo.corporation_id) : null,
			charInfo?.alliance_id ? getAllianceInfo(charInfo.alliance_id) : null
		]);

		let training = null;
		const currentCorpHistory = findCurrentCorporationHistoryEntry(history, charInfo?.corporation_id);
		const corporationJoinDate = currentCorpHistory?.start_date || currentCorpHistory?.record_start_date || '';
		if (Array.isArray(queue) && queue.length > 0) {
			const now = Date.now();
			const activeQueueRow = queue.find((row) => {
				const startMs = row?.start_date ? Date.parse(row.start_date) : 0;
				const endMs = row?.finish_date ? Date.parse(row.finish_date) : 0;
				return startMs > 0 && endMs > now && startMs <= now;
			});
			const active = activeQueueRow || pickCurrentOrNextQueueRow(queue);
			const typeInfos = new Map(await Promise.all(
				queue.map(async (row) => [Number(row?.skill_id || 0), await getTypeInfo(row?.skill_id)])
			));
			const inferredAttributeOffset = inferGlobalAttributeOffset(queue, typeInfos, attributes);
			const baselineAttributes = subtractGlobalAttributeOffset(attributes, inferredAttributeOffset);
			const hasCharacterBooster = inferredAttributeOffset > 0 || await inferQueueHasBooster(queue, baselineAttributes, typeInfos);
			const queueEmptyMs = Math.max(0, ...queue.map((row) => (row?.finish_date ? (Date.parse(row.finish_date) || 0) : 0)));
			const latestQueueTrainingEndMs = Math.max(0, ...queue.map((row) => {
				const endMs = row?.finish_date ? (Date.parse(row.finish_date) || 0) : 0;
				return endMs > 0 && endMs <= now ? endMs : 0;
			}));
			const lastTrainingEndMs = Math.max(Number(fallbackLastTrainingEndMs || 0), latestQueueTrainingEndMs);
			if (active) {
				const typeInfo = await getTypeInfo(active.skill_id);
				const trainingRate = getQueueRowTrainingRateContext(active, typeInfo, baselineAttributes);
				const activeStartMs = active?.start_date ? (Date.parse(active.start_date) || 0) : 0;
				const activeEndMs = active?.finish_date ? (Date.parse(active.finish_date) || 0) : 0;
				const isCurrentlyTraining = activeStartMs > 0 && activeEndMs > now && activeStartMs <= now;
				training = {
					typeName: typeInfo?.name || `Skill ${active.skill_id}`,
					level: Number(active.finished_level || 0),
					trainingStartMs: activeStartMs,
					trainingEndMs: activeEndMs,
					queueEmptyMs,
					isCurrentlyTraining,
					lastTrainingEndMs,
					hasTrainingBooster: trainingRate.hasTrainingBooster || (isCurrentlyTraining && hasCharacterBooster),
					hasCharacterBooster
				};
			} else if (lastTrainingEndMs > 0) {
				training = {
					typeName: null,
					level: 0,
					trainingStartMs: 0,
					trainingEndMs: 0,
					queueEmptyMs,
					isCurrentlyTraining: false,
					lastTrainingEndMs,
					hasTrainingBooster: false,
					hasCharacterBooster
				};
			}
		} else if (Number(fallbackLastTrainingEndMs || 0) > 0) {
			training = {
				typeName: null,
				level: 0,
				trainingStartMs: 0,
				trainingEndMs: 0,
				queueEmptyMs: 0,
				isCurrentlyTraining: false,
				lastTrainingEndMs: Number(fallbackLastTrainingEndMs || 0),
				hasTrainingBooster: false,
				hasCharacterBooster: false
			};
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
			corporationJoinDate,
			training,
			message: null
		};
	} catch (err) {
		if (await handleCharacterRefreshTokenError(err, characterId)) {
			throw err;
		}
		// If fetch fails, return cached data so users see stale data instead of nothing
		console.warn(`Failed to fetch fresh character common data for ${characterId}, using cache:`, err);
		const cached = await cacheGetCharacterData(`common:${characterId}`);
		if (cached) {
			return cached;
		}
		throw err; // Re-throw if no cache available
	}
}

async function fetchSkillsOverview(characterId) {
	try {
		const [skillsResponse, queueResponse, attributes, implants] = await Promise.all([
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/skills`, characterId),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/skillqueue`, characterId),
				[],
				characterId
			),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/attributes`, characterId),
				null,
				characterId
			),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/implants`, characterId),
				[],
				characterId
			)
		]);

		const skills = skillsResponse?.skills || [];
		const queue = Array.isArray(queueResponse) ? queueResponse : [];
		const skillSpById = new Map(skills.map((row) => [Number(row.skill_id || 0), Number(row.skillpoints_in_skill || 0)]));
		const now = Date.now();
		const skillIds = Array.from(new Set([...skills.map((s) => s.skill_id), ...queue.map((q) => q.skill_id)].filter(Boolean)));
		const typeInfos = new Map(await Promise.all(skillIds.map(async (skillId) => [skillId, await getTypeInfo(skillId)])));
		const groupIds = Array.from(new Set(Array.from(typeInfos.values()).map((info) => info?.group_id).filter(Boolean)));
		const groupInfos = new Map(await Promise.all(groupIds.map(async (groupId) => [groupId, await getGroupInfo(groupId)])));
		const implantInfos = await Promise.all((implants || []).map((typeId) => getTypeInfo(typeId)));
		buildAttributeImplantMap(implantInfos);
		const inferredAttributeOffset = inferGlobalAttributeOffset(queue, typeInfos, attributes);
		const baselineAttributes = subtractGlobalAttributeOffset(attributes, inferredAttributeOffset);
		const hasCharacterBooster = inferredAttributeOffset > 0 || await inferQueueHasBooster(queue, baselineAttributes, typeInfos);

		const queueRows = queue.map((row) => {
			const typeInfo = typeInfos.get(row.skill_id);
			const groupInfo = groupInfos.get(typeInfo?.group_id);
			const trainingRate = getQueueRowTrainingRateContext(row, typeInfo, baselineAttributes);
			const startSp = Number(row.training_start_sp ?? row.level_start_sp ?? 0);
			const endSp = Number(row.level_end_sp ?? 0);
			const startMs = row.start_date ? Date.parse(row.start_date) : 0;
			const endMs = row.finish_date ? Date.parse(row.finish_date) : 0;
			const isActive = startMs > 0 && endMs > now && startMs <= now;
			const currentSp = isActive ? Number(skillSpById.get(Number(row.skill_id || 0)) || startSp) : startSp;
			const derivedSpNeeded = (() => {
				const spHour = calculateSpPerHour(row);
				const effectiveStartMs = Math.max(now, startMs || 0);
				if (!startMs || !endMs || endMs <= effectiveStartMs || spHour <= 0) return 0;
				return Math.max(0, Math.ceil(spHour * ((endMs - effectiveStartMs) / 3600000)));
			})();
			const spNeeded = endSp > 0 ? Math.max(0, endSp - currentSp) : derivedSpNeeded;
			return {
				typeName: typeInfo?.name || `Skill ${row.skill_id}`,
				typeID: row.skill_id,
				groupName: groupInfo?.name || '',
				level: Number(row.finished_level || 0),
				primaryAttribute: trainingRate.primaryAttribute,
				secondaryAttribute: trainingRate.secondaryAttribute,
				startDate: row.start_date || null,
				endDate: row.finish_date || null,
				spHour: trainingRate.actualSpHour,
				expectedSpHour: trainingRate.expectedSpHour,
				hasTrainingBooster: trainingRate.hasTrainingBooster || (isActive && hasCharacterBooster),
				hasCharacterBooster: isActive && hasCharacterBooster,
				spNeeded
			};
		});

		const pairMinSpHour = new Map();
		for (const row of queueRows) {
			const primary = String(row?.primaryAttribute || '');
			const secondary = String(row?.secondaryAttribute || '');
			if (!primary || !secondary) continue;
			const key = `${primary}|${secondary}`;
			const spHour = Number(row?.spHour || 0);
			if (spHour <= 0) continue;
			const currentMin = Number(pairMinSpHour.get(key) || 0);
			if (currentMin <= 0 || spHour < currentMin) {
				pairMinSpHour.set(key, spHour);
			}
		}

		for (const row of queueRows) {
			const primary = String(row?.primaryAttribute || '');
			const secondary = String(row?.secondaryAttribute || '');
			if (!primary || !secondary) continue;
			const key = `${primary}|${secondary}`;
			const minSpHour = Number(pairMinSpHour.get(key) || 0);
			const spHour = Number(row?.spHour || 0);
			const inferredPairBooster = minSpHour > 0 && (spHour - minSpHour) > 45;
			row.hasTrainingBooster = Boolean(row.hasTrainingBooster || inferredPairBooster);
		}

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
			const skillPointsCurrent = Number(row.skillpoints_in_skill || 0);
			const dogma = new Map((typeInfo?.dogma_attributes || []).map((attr) => [attr.attribute_id, attr.value]));
			const skillRank = Number(dogma.get(275) || 1);
			const skillPointsTotal = getSkillPointsForLevel(5, skillRank);
			return {
				typeName: typeInfo?.name || `Skill ${row.skill_id}`,
				typeID: row.skill_id,
				groupName: groupInfo?.name || '',
				groupID: typeInfo?.group_id || 0,
				skillPoints: skillPointsCurrent,
				skillPointsTotal: skillPointsTotal,
				skillPointsRemaining: Math.max(0, skillPointsTotal - skillPointsCurrent),
				skillRank: skillRank,
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
	} catch (err) {
		if (await handleCharacterRefreshTokenError(err, characterId)) {
			throw err;
		}
		// If fetch fails, return cached data so users see stale data instead of nothing
		console.warn(`Failed to fetch fresh skills overview for ${characterId}, using cache:`, err);
		const cached = await cacheGetCharacterData(`overview:${characterId}`);
		if (cached) {
			return cached;
		}
		throw err; // Re-throw if no cache available
	}
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
	const rows = queueRows || [];
	const now = Date.now();
	const nextEntry = pickCurrentOrNextOverviewQueueEntry(rows);
	const queueEmptyMs = Math.max(0, ...rows.map((row) => (row?.endDate ? (Date.parse(row.endDate) || 0) : 0)));
	const hasCharacterBooster = rows.some((row) => Boolean(row?.hasCharacterBooster || row?.hasTrainingBooster));
	const latestQueueTrainingEndMs = Math.max(0, ...rows.map((row) => {
		const endMs = row?.endDate ? (Date.parse(row.endDate) || 0) : 0;
		return endMs > 0 && endMs <= now ? endMs : 0;
	}));
	const lastTrainingEndMs = Math.max(Number(data?.training?.lastTrainingEndMs || 0), latestQueueTrainingEndMs);

	if (!nextEntry) {
		if (lastTrainingEndMs <= 0) return;
		data.training = {
			typeName: null,
			level: 0,
			trainingStartMs: 0,
			trainingEndMs: 0,
			queueEmptyMs,
			isCurrentlyTraining: false,
			lastTrainingEndMs,
			hasTrainingBooster: false,
			hasCharacterBooster
		};
		return;
	}

	const trainingStartMs = nextEntry.startDate ? Date.parse(nextEntry.startDate) : Number(nextEntry.trainingStartMs || 0);
	const trainingEndMs = nextEntry.endDate ? Date.parse(nextEntry.endDate) : Number(nextEntry.trainingEndMs || 0);
	data.training = {
		typeName: nextEntry.typeName || '',
		level: Number(nextEntry.level || 0),
		trainingStartMs,
		trainingEndMs,
		queueEmptyMs,
		isCurrentlyTraining: trainingStartMs > 0 && trainingEndMs > now && trainingStartMs <= now,
		lastTrainingEndMs,
		hasTrainingBooster: Boolean(nextEntry.hasTrainingBooster),
		hasCharacterBooster
	};
}

async function fetchWalletRows(characterId) {
	try {
		const rows = await fallbackUnlessCharacterRefreshTokenError(
			fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/wallet/journal?page=1`, characterId),
			[],
			characterId
		);
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
	} catch (err) {
		if (await handleCharacterRefreshTokenError(err, characterId)) {
			throw err;
		}
		// If fetch fails, return cached data so users see stale data instead of nothing
		console.warn(`Failed to fetch fresh wallet rows for ${characterId}, using cache:`, err);
		const cached = await cacheGetCharacterData(`wallet:${characterId}`);
		if (cached) {
			return cached.rows || [];
		}
		throw err; // Re-throw if no cache available
	}
}

async function fetchTrainingSuggestions(characterId) {
	try {
		const [attributes, activeImplantTypeIds, clonesResponse, skillsResponse, queueResponse] = await Promise.all([
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/attributes`, characterId),
				null,
				characterId
			),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/implants`, characterId),
				[],
				characterId
			),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/clones`, characterId),
				({ jump_clones: [] }),
				characterId
			),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/skills`, characterId),
				({ skills: [] }),
				characterId
			),
			fallbackUnlessCharacterRefreshTokenError(
				fetchLatestCharacterAuthJson(`${ESI_BASE}/characters/${characterId}/skillqueue`, characterId),
				[],
				characterId
			)
		]);

		const jumpClones = Array.isArray(clonesResponse?.jump_clones) ? clonesResponse.jump_clones : [];
		const allImplantTypeIds = Array.from(new Set([
			...(Array.isArray(activeImplantTypeIds) ? activeImplantTypeIds : []),
			...jumpClones.flatMap((clone) => Array.isArray(clone?.implants) ? clone.implants : [])
		].map((typeId) => Number(typeId || 0)).filter((typeId) => typeId > 0)));
		const implantInfoByTypeId = new Map(await Promise.all(allImplantTypeIds.map(async (typeId) => [
			typeId,
			await getTypeInfo(typeId)
		])));
		const activeImplantInfos = (Array.isArray(activeImplantTypeIds) ? activeImplantTypeIds : [])
			.map((typeId) => implantInfoByTypeId.get(Number(typeId || 0)))
			.filter(Boolean);
		const implantByAttribute = buildAttributeImplantMap(activeImplantInfos);
		const attributeRows = ['charisma', 'intelligence', 'memory', 'perception', 'willpower'].map((attributeName) => ({
			attributeName,
			baseValue: Number(attributes?.[attributeName] || 0),
			bonus: Number(implantByAttribute[attributeName]?.bonus || 0),
			implantName: implantByAttribute[attributeName]?.implantName || ''
		})).filter((row) => row.baseValue > 0 || row.implantName);

		const { suggestions, optimize } = await buildTrainingSuggestions(
			skillsResponse?.skills || [],
			attributes,
			implantByAttribute,
			Array.isArray(queueResponse) ? queueResponse : []
		);
		const injectorEstimate = buildQueueInjectorEstimate(skillsResponse, queueResponse);
		const clones = await buildCloneRows(clonesResponse, activeImplantTypeIds, implantInfoByTypeId);
		return { clones, implants: attributeRows, suggestions, optimize, injectorEstimate };
	} catch (err) {
		if (await handleCharacterRefreshTokenError(err, characterId)) {
			throw err;
		}
		// If fetch fails, return cached data so users see stale data instead of nothing
		console.warn(`Failed to fetch fresh training suggestions for ${characterId}, using cache:`, err);
		const cached = await cacheGetCharacterData(getTrainCacheKey(characterId));
		if (cached) {
			return cached;
		}
		throw err; // Re-throw if no cache available
	}
}

function buildCloneImplantRows(typeIds, implantInfoByTypeId = new Map()) {
	return (Array.isArray(typeIds) ? typeIds : [])
		.map((typeId) => {
			const numericTypeId = Number(typeId || 0);
			if (numericTypeId <= 0) return null;
			const typeInfo = implantInfoByTypeId.get(numericTypeId);
			return {
				typeID: numericTypeId,
				typeName: typeInfo?.name || `Implant ${numericTypeId}`,
				slot: Math.max(0, Math.round(Number(_getDogmaValue(typeInfo, 331) || 0)))
			};
		})
		.filter(Boolean)
		.sort((left, right) => {
			const leftSlot = Number(left.slot || Number.MAX_SAFE_INTEGER);
			const rightSlot = Number(right.slot || Number.MAX_SAFE_INTEGER);
			return leftSlot - rightSlot || String(left.typeName).localeCompare(String(right.typeName));
		});
}

async function buildCloneRows(clonesResponse, activeImplantTypeIds = [], implantInfoByTypeId = new Map()) {
	const rows = [{
		cloneId: null,
		name: 'Active Clone',
		kind: 'Active',
		isActive: true,
		locationLabel: 'Current body',
		implants: buildCloneImplantRows(activeImplantTypeIds, implantInfoByTypeId)
	}];

	const jumpClones = Array.isArray(clonesResponse?.jump_clones) ? clonesResponse.jump_clones : [];
	const jumpCloneRows = await Promise.all(jumpClones.map(async (clone, index) => ({
		cloneId: Number(clone?.jump_clone_id || 0) || null,
		name: String(clone?.name || '').trim() || `Jump Clone ${index + 1}`,
		kind: 'Jump Clone',
		isActive: false,
		locationLabel: await getCloneLocationLabel(clone?.location_id, clone?.location_type),
		implants: buildCloneImplantRows(clone?.implants, implantInfoByTypeId)
	})));

	return rows.concat(jumpCloneRows);
}

function buildAttributeImplantMap(implantInfos = []) {
	const bonusAttributeIdToName = {
		175: 'charisma',
		176: 'intelligence',
		177: 'memory',
		178: 'perception',
		179: 'willpower'
	};

	const bestByAttribute = {
		charisma: { bonus: 0, implantName: '' },
		intelligence: { bonus: 0, implantName: '' },
		memory: { bonus: 0, implantName: '' },
		perception: { bonus: 0, implantName: '' },
		willpower: { bonus: 0, implantName: '' }
	};

	for (const implantInfo of implantInfos) {
		for (const [attributeId, attributeName] of Object.entries(bonusAttributeIdToName)) {
			const bonus = Number(_getDogmaValue(implantInfo, Number(attributeId)) || 0);
			if (bonus <= 0) continue;
			if (bonus < Number(bestByAttribute[attributeName].bonus || 0)) continue;
			bestByAttribute[attributeName] = {
				bonus,
				implantName: implantInfo?.name || ''
			};
		}
	}

	return bestByAttribute;
}

async function buildTrainingSuggestions(skills, attributes, implantByAttribute = null, queueRows = []) {
	const candidates = skills.filter((skill) => Number(skill.trained_skill_level ?? 0) < 5).slice(0, 25);
	const typeInfos = new Map(await Promise.all(candidates.map(async (row) => [row.skill_id, await getTypeInfo(row.skill_id)])));

	const queuedSkillIds = Array.from(new Set((Array.isArray(queueRows) ? queueRows : [])
		.map((row) => Number(row?.skill_id || 0))
		.filter((id) => id > 0)));
	const missingQueuedTypeIds = queuedSkillIds.filter((id) => !typeInfos.has(id));
	if (missingQueuedTypeIds.length > 0) {
		const extraTypeInfos = await Promise.all(missingQueuedTypeIds.map(async (id) => [id, await getTypeInfo(id)]));
		for (const [id, info] of extraTypeInfos) {
			typeInfos.set(id, info);
		}
	}

	// Suggestions should use the character's current implant-enhanced attributes,
	// but not temporary accelerators. ESI exposes effective attributes (including
	// implants), so remove only the global bonus inferred from the queue.
	const suggestionAttributes = subtractGlobalAttributeOffset(
		attributes,
		inferGlobalAttributeOffset(queueRows, typeInfos, attributes)
	);
	const suggestions = [];

	for (const row of candidates) {
		const typeInfo = typeInfos.get(row.skill_id);
		const dogma = new Map((typeInfo?.dogma_attributes || []).map((attr) => [attr.attribute_id, attr.value]));
		const primaryAttribute = attributeIdToName(dogma.get(180));
		const secondaryAttribute = attributeIdToName(dogma.get(181));
		if (!primaryAttribute || !secondaryAttribute) continue;
		const rank = Number(dogma.get(275) || 1);
		const currentLevel = Number(row.trained_skill_level || 0);
		const currentSp = Number(row.skillpoints_in_skill || 0);
		const targetSp = getSkillPointsForLevel(5, rank);
		const remainingSp = Math.max(0, targetSp - currentSp);
		if (remainingSp <= 0) continue;
		const spPerHour = calculateSkillSpPerHour(suggestionAttributes, primaryAttribute, secondaryAttribute);
		const remainingSeconds = spPerHour > 0 ? Math.ceil((remainingSp / spPerHour) * 3600) : Number.MAX_SAFE_INTEGER;
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
			remainingSeconds
		});
	}

	const skillSpById = new Map((Array.isArray(skills) ? skills : []).map((row) => [
		Number(row?.skill_id || 0),
		Number(row?.skillpoints_in_skill || 0)
	]));
	const now = Date.now();
	const optimizationCandidates = [];
	for (const queueRow of (Array.isArray(queueRows) ? queueRows : [])) {
		const skillId = Number(queueRow?.skill_id || 0);
		if (skillId <= 0) continue;
		const typeInfo = typeInfos.get(skillId);
		if (!typeInfo) continue;
		const dogma = new Map((typeInfo?.dogma_attributes || []).map((attr) => [attr.attribute_id, attr.value]));
		const primaryAttribute = attributeIdToName(dogma.get(180));
		const secondaryAttribute = attributeIdToName(dogma.get(181));
		if (!primaryAttribute || !secondaryAttribute) continue;

		const startSp = Number(queueRow?.training_start_sp ?? queueRow?.level_start_sp ?? 0);
		const endSp = Number(queueRow?.level_end_sp ?? 0);
		if (endSp <= startSp) continue;

		const startMs = queueRow?.start_date ? (Date.parse(queueRow.start_date) || 0) : 0;
		const endMs = queueRow?.finish_date ? (Date.parse(queueRow.finish_date) || 0) : 0;
		if (endMs > 0 && endMs <= now) continue;
		const isActive = startMs > 0 && endMs > now && startMs <= now;
		const currentSp = isActive ? Number(skillSpById.get(skillId) || startSp) : startSp;
		const remainingSp = Math.max(0, endSp - currentSp);
		if (remainingSp <= 0) continue;

		optimizationCandidates.push({
			primaryAttribute,
			secondaryAttribute,
			remainingSp
		});
	}

	const topSuggestions = suggestions.sort((a, b) => a.remainingSeconds - b.remainingSeconds).slice(0, 20);
	const optimize = optimizeAttributeRemap(optimizationCandidates, suggestionAttributes, implantByAttribute || {});
	return { suggestions: topSuggestions, optimize };
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
		const remoteInfo = await window.esi.doJsonRequest(`${ESI_BASE}/universe/types/${typeId}?language=en`);
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
		const info = await window.esi.doJsonRequest(`${ESI_BASE}/universe/groups/${groupId}?language=en`);
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
		const response = await fetch(withStaticCacheHash(path));
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
			const results = await window.esi.doJsonRequest(`${ESI_BASE}/universe/names`, 'POST', window.esi.mimetypeJson, JSON.stringify(unresolved));
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
		const info = await window.esi.doJsonRequest(`${ESI_BASE}/corporations/${corporationId}`);
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
		const info = await window.esi.doJsonRequest(`${ESI_BASE}/alliances/${allianceId}`);
		await lookupCacheSet(cacheKey, info);
		return info;
	} catch (_) {
		return null;
	}
}

async function getCloneLocationLabel(locationId, locationType) {
	const numericLocationId = Number(locationId || 0);
	const normalizedType = String(locationType || '').toLowerCase();
	if (numericLocationId <= 0) return 'Unknown location';

	if (normalizedType !== 'station') {
		return `${capitalizeFirst(normalizedType || 'location')} ${numericLocationId}`;
	}

	const cacheKey = `station-info:${numericLocationId}`;
	const cached = await lookupCacheGet(cacheKey);
	if (cached?.name) return cached.name;

	try {
		const info = await window.esi.doJsonRequest(`${ESI_BASE}/universe/stations/${numericLocationId}`);
		if (info) await lookupCacheSet(cacheKey, info);
		return info?.name || `Station ${numericLocationId}`;
	} catch (_) {
		return `Station ${numericLocationId}`;
	}
}

async function lookupCacheGet(key) {
	try {
		return await lookupStore.get(key);
	} catch (_) {
		return null;
	}
}

async function lookupCacheSet(key, value, ttl = undefined) {
	try {
		const effectiveTtl = ttl === undefined
			? (PERSISTENT_LOOKUP_KEYS.has(key) ? null : LOOKUP_TTL_MS)
			: ttl;
		await lookupStore.set(key, value, effectiveTtl);
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
		const ttl = key === LAST_BACKGROUND_REFRESH_KEY || key.startsWith(`${CHARACTER_NOTE_KEY_PREFIX}:`)
			? null
			: CHARACTER_DATA_RETENTION_MS;
		await characterDataStore.set(key, value, ttl);
		if (key !== LAST_BACKGROUND_REFRESH_KEY) {
			announceCharacterDataUpdated(key);
		}
		return true;
	} catch (_) {
		// Ignore cache write failures.
		return false;
	}
}

function announceCharacterDataUpdated(key) {
	window.dispatchEvent(new CustomEvent(CHARACTER_DATA_UPDATED_EVENT, { detail: { key } }));
	characterDataSyncChannel?.postMessage({
		type: CHARACTER_DATA_UPDATED_EVENT,
		key,
		fromTabId: CHARACTER_DATA_SYNC_TAB_ID
	});
}

async function cacheTouchCharacterData(key) {
	try {
		const existing = await characterDataStore.get(key);
		if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
			return false;
		}
		const ttl = key === LAST_BACKGROUND_REFRESH_KEY || key.startsWith(`${CHARACTER_NOTE_KEY_PREFIX}:`)
			? null
			: CHARACTER_DATA_RETENTION_MS;
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

function getSkillTrainingAttributes(typeInfo) {
	const dogma = new Map((typeInfo?.dogma_attributes || []).map((attr) => [attr.attribute_id, attr.value]));
	return {
		primaryAttribute: attributeIdToName(dogma.get(180)),
		secondaryAttribute: attributeIdToName(dogma.get(181))
	};
}

function calculateSkillSpPerHour(attributes, primaryAttribute, secondaryAttribute) {
	const primary = Number(attributes?.[primaryAttribute] || 0);
	const secondary = Number(attributes?.[secondaryAttribute] || 0);
	if (primary <= 0) return 0;
	return (primary + (secondary / 2)) * 60;
}

const TRAINING_ATTRIBUTE_NAMES = ['charisma', 'intelligence', 'memory', 'perception', 'willpower'];
let cachedValidRemaps = null;

function optimizeAttributeRemap(candidates, attributes, implantByAttribute = {}) {
	const knownAttributeTotal = TRAINING_ATTRIBUTE_NAMES.reduce((sum, name) => sum + Math.max(0, Number(attributes?.[name] || 0)), 0);
	if (knownAttributeTotal <= 0) return null;

	const filteredCandidates = (Array.isArray(candidates) ? candidates : []).filter((row) => {
		if (!row) return false;
		if (!TRAINING_ATTRIBUTE_NAMES.includes(row.primaryAttribute) || !TRAINING_ATTRIBUTE_NAMES.includes(row.secondaryAttribute)) return false;
		return Number(row.remainingSp || 0) > 0;
	});
	if (!filteredCandidates.length) return null;

	const implantBonus = {};
	for (const name of TRAINING_ATTRIBUTE_NAMES) {
		implantBonus[name] = Math.max(0, Number(implantByAttribute?.[name]?.bonus || 0));
	}

	const remapConfigs = enumerateValidRemaps();
	const currentRemap = projectAttributesToRemap(attributes, implantBonus, remapConfigs);
	const currentEffective = addImplantBonusToRemap(currentRemap, implantBonus);

	let bestRemap = remapConfigs[0] || currentRemap;
	let bestSeconds = Number.POSITIVE_INFINITY;
	for (const remap of remapConfigs) {
		const effective = addImplantBonusToRemap(remap, implantBonus);
		const seconds = estimateTrainingSecondsForCandidates(filteredCandidates, effective);
		if (seconds < bestSeconds) {
			bestSeconds = seconds;
			bestRemap = remap;
		}
	}

	const currentSeconds = estimateTrainingSecondsForCandidates(filteredCandidates, currentEffective);
	const savedSeconds = Number.isFinite(currentSeconds) && Number.isFinite(bestSeconds)
		? Math.max(0, currentSeconds - bestSeconds)
		: 0;
	const savedPercent = currentSeconds > 0 ? (savedSeconds / currentSeconds) * 100 : 0;

	const rows = TRAINING_ATTRIBUTE_NAMES.map((attributeName) => {
		const currentPoints = Math.max(0, Number(currentRemap[attributeName] || 17) - 17);
		const optimizedPoints = Math.max(0, Number(bestRemap[attributeName] || 17) - 17);
		return {
			attributeName,
			currentPoints,
			optimizedPoints,
			deltaPoints: optimizedPoints - currentPoints,
			currentValue: Number(currentEffective[attributeName] || 0),
			optimizedValue: Number((bestRemap[attributeName] || 0) + implantBonus[attributeName])
		};
	});

	return {
		rows,
		sampleSize: filteredCandidates.length,
		currentSeconds: Number.isFinite(currentSeconds) ? currentSeconds : 0,
		optimizedSeconds: Number.isFinite(bestSeconds) ? bestSeconds : 0,
		savedSeconds,
		savedPercent
	};
}

function enumerateValidRemaps() {
	if (cachedValidRemaps) return cachedValidRemaps;
	const remaps = [];
	for (let charismaPoints = 0; charismaPoints <= 10; charismaPoints += 1) {
		for (let intelligencePoints = 0; intelligencePoints <= 10; intelligencePoints += 1) {
			for (let memoryPoints = 0; memoryPoints <= 10; memoryPoints += 1) {
				for (let perceptionPoints = 0; perceptionPoints <= 10; perceptionPoints += 1) {
					const spent = charismaPoints + intelligencePoints + memoryPoints + perceptionPoints;
					if (spent > 14) continue;
					const willpowerPoints = 14 - spent;
					if (willpowerPoints > 10) continue;
					remaps.push({
						charisma: 17 + charismaPoints,
						intelligence: 17 + intelligencePoints,
						memory: 17 + memoryPoints,
						perception: 17 + perceptionPoints,
						willpower: 17 + willpowerPoints
					});
				}
			}
		}
	}
	cachedValidRemaps = remaps;
	return remaps;
}

function projectAttributesToRemap(attributes, implantBonus, remapConfigs) {
	const raw = {};
	for (const name of TRAINING_ATTRIBUTE_NAMES) {
		raw[name] = Math.max(0, Number(attributes?.[name] || 0));
	}

	const rawTotal = TRAINING_ATTRIBUTE_NAMES.reduce((sum, name) => sum + raw[name], 0);
	const bonusTotal = TRAINING_ATTRIBUTE_NAMES.reduce((sum, name) => sum + Math.max(0, Number(implantBonus?.[name] || 0)), 0);
	const rawMinusBonusTotal = rawTotal - bonusTotal;
	const rawDistance = Math.abs(rawTotal - 99);
	const minusDistance = Math.abs(rawMinusBonusTotal - 99);
	const includesImplants = bonusTotal > 0 && minusDistance <= rawDistance;

	const targetRemap = {};
	for (const name of TRAINING_ATTRIBUTE_NAMES) {
		const source = raw[name] - (includesImplants ? Math.max(0, Number(implantBonus?.[name] || 0)) : 0);
		targetRemap[name] = Math.max(17, Math.min(27, source || 17));
	}

	let best = remapConfigs[0] || {
		charisma: 17,
		intelligence: 17,
		memory: 17,
		perception: 17,
		willpower: 17
	};
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const remap of remapConfigs) {
		let distance = 0;
		for (const name of TRAINING_ATTRIBUTE_NAMES) {
			const delta = Number(remap[name] || 17) - Number(targetRemap[name] || 17);
			distance += delta * delta;
		}
		if (distance < bestDistance) {
			bestDistance = distance;
			best = remap;
		}
	}

	return best;
}

function addImplantBonusToRemap(remap, implantBonus) {
	const effective = {};
	for (const name of TRAINING_ATTRIBUTE_NAMES) {
		effective[name] = Number(remap?.[name] || 0) + Math.max(0, Number(implantBonus?.[name] || 0));
	}
	return effective;
}

function estimateTrainingSecondsForCandidates(candidates, effectiveAttributes) {
	let totalSeconds = 0;
	for (const row of candidates) {
		const spPerHour = calculateSkillSpPerHour(effectiveAttributes, row.primaryAttribute, row.secondaryAttribute);
		if (spPerHour <= 0) continue;
		totalSeconds += (Number(row.remainingSp || 0) / spPerHour) * 3600;
	}
	if (!Number.isFinite(totalSeconds)) return Number.POSITIVE_INFINITY;
	return Math.max(0, totalSeconds);
}

function getQueueRowTrainingRateContext(queueRow, typeInfo, attributes) {
	const { primaryAttribute, secondaryAttribute } = getSkillTrainingAttributes(typeInfo);
	const expectedSpHour = calculateSkillSpPerHour(attributes, primaryAttribute, secondaryAttribute);
	const actualSpHour = calculateSpPerHour(queueRow);
	const spHourDelta = actualSpHour - expectedSpHour;
	// Treat only meaningful rate gains as a booster: tiny +1/s style drift should not trigger.
	const boosterToleranceSpSecond = 3;
	const deltaThresholdSpHour = boosterToleranceSpSecond * 3600;
	const hasRateDeltaBooster = expectedSpHour > 0 && spHourDelta > deltaThresholdSpHour;
	// If expected rate cannot be derived (missing dogma), prefer showing a badge over suppressing it.
	const hasUnknownBaselineButFastTraining = expectedSpHour <= 0 && actualSpHour > 0;
	const hasTrainingBooster = hasRateDeltaBooster || hasUnknownBaselineButFastTraining;
	return {
		primaryAttribute,
		secondaryAttribute,
		expectedSpHour,
		actualSpHour,
		hasTrainingBooster
	};
}

async function inferQueueHasBooster(queueRows, attributes, preloadedTypeInfos = null) {
	const rows = Array.isArray(queueRows) ? queueRows : [];
	for (const row of rows) {
		const typeInfo = preloadedTypeInfos?.get?.(Number(row?.skill_id || 0)) || await getTypeInfo(row?.skill_id);
		const ctx = getQueueRowTrainingRateContext(row, typeInfo, attributes);
		if (ctx.hasTrainingBooster) return true;
	}
	return false;
}

function subtractGlobalAttributeOffset(attributes, offset) {
	const safeOffset = Math.max(0, Number(offset || 0));
	const names = ['charisma', 'intelligence', 'memory', 'perception', 'willpower'];
	const next = { ...(attributes || {}) };
	for (const name of names) {
		next[name] = Math.max(0, Number(attributes?.[name] || 0) - safeOffset);
	}
	return next;
}

function inferGlobalAttributeOffset(queueRows, typeInfos, attributes) {
	const rows = Array.isArray(queueRows) ? queueRows : [];
	if (!rows.length) return 0;

	const attrNames = ['charisma', 'intelligence', 'memory', 'perception', 'willpower'];
	const minAttr = Math.min(...attrNames.map((name) => Number(attributes?.[name] || 0)).filter((value) => value > 0));
	const maxOffset = Math.max(0, Math.min(15, Math.floor(minAttr)));

	const scoreForOffset = (offset) => {
		const baseline = subtractGlobalAttributeOffset(attributes, offset);
		const deltas = [];
		for (const row of rows) {
			const typeInfo = typeInfos?.get?.(Number(row?.skill_id || 0));
			if (!typeInfo) continue;
			const ctx = getQueueRowTrainingRateContext(row, typeInfo, baseline);
			if (!(ctx.expectedSpHour > 0) || !(ctx.actualSpHour > 0)) continue;
			deltas.push(Math.abs(ctx.actualSpHour - ctx.expectedSpHour));
		}
		if (!deltas.length) return Number.POSITIVE_INFINITY;
		deltas.sort((a, b) => a - b);
		return deltas[Math.floor(deltas.length / 2)];
	};

	const scoreAtZero = scoreForOffset(0);
	let bestOffset = 0;
	let bestScore = scoreAtZero;
	for (let offset = 1; offset <= maxOffset; offset += 1) {
		const score = scoreForOffset(offset);
		if (score < bestScore) {
			bestScore = score;
			bestOffset = offset;
		}
	}

	if (!Number.isFinite(scoreAtZero) || !Number.isFinite(bestScore)) return 0;
	return (bestOffset > 0 && (scoreAtZero - bestScore) > 40) ? bestOffset : 0;
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
		const response = await fetch(withStaticCacheHash('/README.md?v=' + staticCacheHash));
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
