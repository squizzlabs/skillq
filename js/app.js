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
const LAYOUT_MODE_KEY = '__ui:layout-mode';
const THEME_MODE_KEY = '__ui:theme-mode';
const MANAGE_SETTINGS_KEY = '__ui:manage-settings';
const SKILL_ENABLES_INDEX_KEY = '__ui:skill-enables-index';
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
		console.log('app.js main() starting');
		if (window.esi?.ready) {
			await window.esi.ready;
		}
		if (!window.esi) {
			throw new Error('ESI initialization failed or not available');
		}
		await initThemeMode();
		await initLayoutMode();
		initCacheAutoRender();
		initBackgroundCharacterRefresh();
		await primeCharacterCachesOnStartup();
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
	return pathname === '/' || pathname === '/readme' || pathname === '/readme/' || pathname === '/auth' || pathname === '/login' || pathname === '/login-check' || pathname === '/logout' || pathname === '/manage' || pathname === '/manage/' || pathname === '/settings' || pathname === '/settings/' || pathname === '/account' || pathname === '/account/' || pathname.startsWith('/char/') || pathname.startsWith('/item/');
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
		const confirmed = window.confirm('Logging out deletes all locally stored SkillQ data. Next time you log in, you will need to re-add all characters. Continue?');
		if (!confirmed) {
			history.replaceState(null, '', '/');
			if (window.esi.whoami !== null) {
				await renderLoggedInHome();
			}
			return;
		}
		await window.esi.authLogout(true, false);
		history.replaceState(null, '', '/');
	}

	if (window.esi.whoami === null) {
		if (path !== '/readme' && path !== '/readme/') {
			history.replaceState(null, '', '/readme');
		}
		await loadReadme();
		document.getElementById('about').classList.remove('d-none');
		document.getElementById('skillq').classList.add('d-none');
		renderNavbarInto(document.getElementById('navbar-root'), { isLoggedIn: false, layoutMode });
		bindLayoutToggle();
		return;
	}

	if (route.name === 'char') {
		await renderCharacterPage(route.charName, route.tab);
		return;
	}

	if (route.name === 'item') {
		showItemLoading(route.itemId);
		await renderItemPage(route.itemId);
		return;
	}

	if (route.name === 'manage') {
		await renderManagePage();
		return;
	}

	if (route.name === 'settings') {
		if (path === '/account' || path === '/account/') {
			history.replaceState(null, '', '/settings');
		}
		await renderAccountPage();
		return;
	}

	await renderLoggedInHome();
}

function parseRoute(pathname) {
	const cleaned = pathname.replace(/\/+$/, '') || '/';
	if (cleaned === '/readme') {
		return { name: 'readme' };
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
	if (isLoggedIn !== hasAllLink) return false;
	if (!isLoggedIn && !hasLoginButton) return false;

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

	void refreshCharacterSummariesInBackground(characters);

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
		removeBtn.className = 'sq-btn sq-btn--sm';
		removeBtn.textContent = 'Remove';
		removeBtn.dataset.characterId = charId;
		removeBtn.dataset.characterName = char.name;
		removeBtn.addEventListener('click', () => {
			void removeManagedCharacter(charId, char.name);
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
			void ensureExpandedContent();
		}
	});

	if (expanded) {
		void ensureExpandedContent();
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
			typeName: requirement.typeName,
			metaText: `Level ${Math.max(1, Number(requirement.requiredSkillLevel || 0))}`,
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
		void toggleLayoutMode();
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