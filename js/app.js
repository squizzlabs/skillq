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
const lookupStore = new DexieStore('skillq-lookups-db', 'skillq-lookups', 5 * 60 * 1000);
const characterDataStore = new DexieStore('skillq-character-data-db', 'skillq-character-data', 5 * 60 * 1000);
let backgroundRefreshInitialized = false;
let cacheAutoRenderInitialized = false;
let routeRerenderScheduled = false;
const LAST_BACKGROUND_REFRESH_KEY = '__meta:last-background-refresh';
const CHARACTER_DATA_UPDATED_EVENT = 'skillq:character-data-updated';

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
		console.log('app.js main() starting');
		if (window.esi?.ready) {
			await window.esi.ready;
		}
		if (!window.esi) {
			throw new Error('ESI initialization failed or not available');
		}
		initCacheAutoRender();
		initBackgroundCharacterRefresh();
		initSpaNavigation();
		await handleRoute();
	} catch (err) {
		console.error('Error in main():', err);
		document.getElementById('about').innerHTML = '<p>Error during initialization. <a href="/login">Click here to login</a>.</p>';
		document.getElementById('about').classList.remove('d-none');
		return;
	}
}

function isSpaPath(pathname) {
	return pathname === '/' || pathname === '/auth' || pathname === '/login' || pathname === '/login-check' || pathname === '/logout' || pathname.startsWith('/char/');
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
		void navigateTo(url.pathname + url.search + url.hash);
	});

	window.addEventListener('popstate', () => {
		void handleRoute();
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
		return;
	}

	if (path === '/login' || path === '/login-check') {
		await window.esi.authBegin();
		return;
	}

	if (path === '/logout') {
		await window.esi.authLogout(true, false);
		history.replaceState(null, '', '/');
	}

	if (window.esi.whoami === null) {
		await loadReadme();
		document.getElementById('about').classList.remove('d-none');
		document.getElementById('skillq').classList.add('d-none');
		document.getElementById('navbar-root').replaceChildren(renderNavbar({ isLoggedIn: false }));
		return;
	}

	if (route.name === 'char') {
		await renderCharacterPage(route.charName, route.tab);
		return;
	}

	await renderLoggedInHome();
}

function parseRoute(pathname) {
	const cleaned = pathname.replace(/\/+$/, '') || '/';
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

async function renderLoggedInHome() {
	const characters = await window.esi.getLoggedInCharacters();
	const currentCharId = String(window.esi.whoami.character_id);

	const navbarRoot = document.getElementById('navbar-root');
	navbarRoot.replaceChildren(renderNavbar({
		characters,
		currentCharId,
		isLoggedIn: true
	}));

	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.classList.remove('d-none');
	cardsRoot.replaceChildren();
	document.getElementById('char-view-root').replaceChildren();

	const summaries = await loadCharacterSummariesFromCache(characters);
	for (const summary of summaries) {
		cardsRoot.appendChild(renderCharCard({
			character: summary.character,
			training: summary.training
		}));
	}

	void refreshCharacterSummariesInBackground(characters);

	const netSummary = document.getElementById('net-summary');
	if (summaries.length > 1) {
		const totalIsk = summaries.reduce((acc, s) => acc + (s.character.balance || 0), 0);
		const totalSp = summaries.reduce((acc, s) => acc + (s.character.skillPoints || 0), 0);
		netSummary.textContent = `Net ISK: ${numberFormat(totalIsk, 2)} | Net SP: ${numberFormat(totalSp, 0)}`;
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

	const navbarRoot = document.getElementById('navbar-root');
	navbarRoot.replaceChildren(renderNavbar({
		characters,
		currentCharId: characterId,
		isLoggedIn: true
	}));

	const cardsRoot = document.getElementById('char-cards-root');
	cardsRoot.replaceChildren();
	cardsRoot.classList.add('d-none');
	document.getElementById('net-summary').classList.add('d-none');

	const charViewRoot = document.getElementById('char-view-root');
	const page = document.createElement('div');
	page.className = 'sq-char-view';

	if (data.message) {
		const alert = document.createElement('div');
		alert.className = 'sq-alert';
		alert.textContent = data.message;
		page.appendChild(alert);
	}

	page.appendChild(renderCharInfo({
		character: data.character,
		corporation: data.corporation,
		alliance: data.alliance,
		training: data.training,
		showBalance: true
	}));
	page.appendChild(renderCharMenu({ charName: data.character.name, activeTab }));

	if (activeTab === 'wallet') {
		page.appendChild(renderCharWallet({ transactions: data.wallet || [] }));
		if (data.lastUpdatedAt) {
			const updated = document.createElement('p');
			updated.className = 'sq-muted sq-char-note';
			updated.textContent = `Last updated: ${formatDateTime(data.lastUpdatedAt)}`;
			page.appendChild(updated);
		}
	} else if (activeTab === 'train') {
		page.appendChild(renderCharTrain({ implants: data.implants || [], suggestions: data.suggestions || [] }));
		if (data.lastUpdatedAt) {
			const updated = document.createElement('p');
			updated.className = 'sq-muted sq-char-note';
			updated.textContent = `Last updated: ${formatDateTime(data.lastUpdatedAt)}`;
			page.appendChild(updated);
		}
	} else {
		page.appendChild(renderCharSkills({
			queue: data.queue || [],
			skills: data.skills || [],
			totalSP: data.totalSP || 0,
			unallocatedSP: data.unallocatedSP || 0
		}));
		if (data.lastUpdatedAt) {
			const updated = document.createElement('p');
			updated.className = 'sq-muted sq-char-note';
			updated.textContent = `Last updated: ${formatDateTime(data.lastUpdatedAt)}`;
			page.appendChild(updated);
		}
		const note = document.createElement('p');
		note.className = 'sq-muted sq-char-note';
		note.textContent = 'ESI may return stale data until this specific character has logged into EVE recently.';
		page.appendChild(note);
	}

	charViewRoot.replaceChildren(page);
	document.getElementById('about').classList.add('d-none');
	document.getElementById('skillq').classList.remove('d-none');
	startCountdowns();

	void refreshCharacterPageInBackground(characterId, activeTab);
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
		const walletCached = await cacheGetCharacterData(`wallet:${characterId}`);
		data.wallet = walletCached?.rows || [];
		latestUpdatedAt = Math.max(latestUpdatedAt, Number(walletCached?.updatedAt || 0));
		data.lastUpdatedAt = latestUpdatedAt || null;
		return data;
	}

	if (tab === 'train') {
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
		void refreshCharacterSummaryInBackground(String(char.character_id), char.name);
	}
}

async function refreshCharacterSummaryInBackground(characterId, characterName) {
	if (!(await shouldRefreshCharacterData(`summary:${characterId}`))) {
		return;
	}

	try {
		const [balance, skills, queue] = await Promise.all([
			window.esi.doJsonAuthRequest(`${ESI_BASE}/latest/characters/${characterId}/wallet/?datasource=tranquility`, 'GET', null, null, characterId),
			window.esi.doJsonAuthRequest(`${ESI_BASE}/latest/characters/${characterId}/skills/?datasource=tranquility`, 'GET', null, null, characterId),
			window.esi.doJsonAuthRequest(`${ESI_BASE}/latest/characters/${characterId}/skillqueue/?datasource=tranquility`, 'GET', null, null, characterId)
		]);

		let training = null;
		if (Array.isArray(queue) && queue.length > 0) {
			const active = queue[0];
			const queueLast = queue[queue.length - 1];
			const typeInfo = await getTypeInfo(active?.skill_id);
			training = {
				typeName: typeInfo?.name || null,
				trainingEndMs: active?.finish_date ? Date.parse(active.finish_date) : 0,
				queueEmptyMs: queueLast?.finish_date ? Date.parse(queueLast.finish_date) : 0
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
		});
	} catch (err) {
		console.warn(`Background summary refresh failed for ${characterId}`, err);
	}
}

async function refreshCharacterPageInBackground(characterId, tab) {
	if (!(await shouldRefreshCharacterData(`common:${characterId}`))) {
		if (tab === 'wallet' && !(await shouldRefreshCharacterData(`wallet:${characterId}`))) return;
		if (tab === 'train' && !(await shouldRefreshCharacterData(`train:${characterId}`))) return;
		if (tab === 'overview' && !(await shouldRefreshCharacterData(`overview:${characterId}`))) return;
	}

	try {
		if (await shouldRefreshCharacterData(`common:${characterId}`)) {
			const common = await fetchCharacterCommonData(characterId);
			common.message = null;
			common.updatedAt = Date.now();
			await cacheSetCharacterData(`common:${characterId}`, common);
		}

		if (tab === 'wallet') {
			if (!(await shouldRefreshCharacterData(`wallet:${characterId}`))) return;
			const wallet = await fetchWalletRows(characterId);
			await cacheSetCharacterData(`wallet:${characterId}`, { rows: wallet, updatedAt: Date.now() });
			return;
		}

		if (tab === 'train') {
			if (!(await shouldRefreshCharacterData(`train:${characterId}`))) return;
			const train = await fetchTrainingSuggestions(characterId);
			train.updatedAt = Date.now();
			await cacheSetCharacterData(`train:${characterId}`, train);
			return;
		}

		if (!(await shouldRefreshCharacterData(`overview:${characterId}`))) return;
		const overview = await fetchSkillsOverview(characterId);
		overview.updatedAt = Date.now();
		await cacheSetCharacterData(`overview:${characterId}`, overview);
	} catch (err) {
		console.warn(`Background page refresh failed for ${characterId}`, err);
	}
}

function initBackgroundCharacterRefresh() {
	if (backgroundRefreshInitialized) return;
	backgroundRefreshInitialized = true;

	void triggerScheduledBackgroundRefresh();
	setInterval(() => {
		void triggerScheduledBackgroundRefresh();
	}, BACKGROUND_REFRESH_INTERVAL_MS);
}

function initCacheAutoRender() {
	if (cacheAutoRenderInitialized) return;
	cacheAutoRenderInitialized = true;

	window.addEventListener(CHARACTER_DATA_UPDATED_EVENT, () => {
		scheduleRouteRerender();
	});
}

function scheduleRouteRerender() {
	if (routeRerenderScheduled) return;
	routeRerenderScheduled = true;
	setTimeout(() => {
		routeRerenderScheduled = false;
		if (!window.esi?.whoami) return;
		if (window.location.pathname === '/auth') return;
		void handleRoute();
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
		const characters = await window.esi.getLoggedInCharacters();
		for (const char of characters) {
			const characterId = String(char.character_id);
			void refreshCharacterSummaryInBackground(characterId, char.name);
			void refreshCharacterPageInBackground(characterId, 'overview');
			void refreshCharacterPageInBackground(characterId, 'wallet');
			void refreshCharacterPageInBackground(characterId, 'train');
		}
	} catch (err) {
		console.warn('Background character refresh scheduler failed', err);
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
		const active = queue[0];
		const queueLast = queue[queue.length - 1];
		const typeInfo = await getTypeInfo(active.skill_id);
		training = {
			typeName: typeInfo?.name || `Skill ${active.skill_id}`,
			trainingEndMs: active.finish_date ? Date.parse(active.finish_date) : 0,
			queueEmptyMs: queueLast.finish_date ? Date.parse(queueLast.finish_date) : 0
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
			startTime: formatDateTime(row.start_date),
			endTime: formatDateTime(row.finish_date),
			spHour: calculateSpPerHour(row)
		};
	});

	const maxQueuedLevels = new Map();
	for (const row of queue) {
		const existing = maxQueuedLevels.get(row.skill_id) || 0;
		maxQueuedLevels.set(row.skill_id, Math.max(existing, Number(row.finished_level || 0)));
	}

	const skillRows = skills.map((row) => {
		const typeInfo = typeInfos.get(row.skill_id);
		const groupInfo = groupInfos.get(typeInfo?.group_id);
		const activeQueue = queue.find((q) => q.skill_id === row.skill_id);
		return {
			typeName: typeInfo?.name || `Skill ${row.skill_id}`,
			typeID: row.skill_id,
			groupName: groupInfo?.name || '',
			groupID: typeInfo?.group_id || 0,
			skillPoints: Number(row.skillpoints_in_skill || 0),
			level: Number(row.trained_skill_level ?? row.active_skill_level ?? 0),
			training: activeQueue ? Number(activeQueue.finished_level || 0) : 0,
			queue: maxQueuedLevels.get(row.skill_id) || 0
		};
	}).sort((a, b) => (a.groupName || '').localeCompare(b.groupName || '') || a.typeName.localeCompare(b.typeName));

	return {
		queue: queueRows,
		skills: skillRows,
		totalSP: Number(skillsResponse?.total_sp || 0),
		unallocatedSP: Number(skillsResponse?.unallocated_sp || 0)
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
	const cached = await lookupCacheGet(`type-info:${typeId}`);
	if (cached) {
		typeInfoCache.set(typeId, cached);
		return cached;
	}
	await ensureLocalSdeDataLoaded();
	if (localTypeInfoCache.has(String(typeId))) {
		const info = localTypeInfoCache.get(String(typeId));
		typeInfoCache.set(typeId, info);
		await lookupCacheSet(`type-info:${typeId}`, info);
		return info;
	}
	try {
		const info = await window.esi.doJsonRequest(`${ESI_BASE}/universe/types/${typeId}/?datasource=tranquility&language=en`);
		typeInfoCache.set(typeId, info);
		await lookupCacheSet(`type-info:${typeId}`, info);
		return info;
	} catch (_) {
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

async function cacheSetCharacterData(key, value) {
	try {
		const ttl = key === LAST_BACKGROUND_REFRESH_KEY ? null : CHARACTER_DATA_TTL_MS;
		await characterDataStore.set(key, value, ttl);
		window.dispatchEvent(new CustomEvent(CHARACTER_DATA_UPDATED_EVENT, { detail: { key } }));
	} catch (_) {
		// Ignore cache write failures.
	}
}

function formatDateTime(value) {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
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