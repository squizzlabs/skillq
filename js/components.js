/**
 * components.js — client-side render functions replacing the old Jinja2 templates.
 *
 * Each function returns an HTMLElement and is exposed on `window`.
 * No Bootstrap. CSS classes are prefixed `sq-`.
 *
 * Components:
 *   renderNavbar(options)
 *   renderCharCard(options)
 *   renderCharInfo(options)
 *   renderCharMenu(options)
 *   renderCharSkills(options)
 *   renderCharWallet(options)
 *   renderCharClones(options)
 *   renderCharTrain(options)
 */

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function _el(tag, className, text) {
	const el = document.createElement(tag);
	if (className) el.className = className;
	if (text != null) el.textContent = text;
	return el;
}

function _img(src, alt, className, attrs = {}) {
	const img = document.createElement('img');
	img.src = src;
	img.alt = alt || '';
	if (className) img.className = className;
	for (const [key, value] of Object.entries(attrs)) {
		img.setAttribute(key, value);
	}
	return img;
}

const eager_img = {
	loading: 'eager',
	decoding: 'async',
	fetchpriority: 'high',
};

const img_128 = {
	...eager_img,
	height: 128,
	width: 128
};

const img_256 = {
	...eager_img,
	height: 256,
	width: 256
};

function _a(href, text, className) {
	const a = document.createElement('a');
	a.href = href;
	if (text != null) a.textContent = text;
	if (className) a.className = className;
	return a;
}

function _boosterBadge(text = 'Booster') {
	const badge = _el('span', 'sq-badge sq-badge--booster', text);
	badge.title = 'Training speed is above the expected attributes + implant rate.';
	return badge;
}

function _remainingBadge(text = '<1 Week Remaining') {
	const badge = _el('span', 'sq-badge sq-badge--remaining', text);
	badge.title = 'Current training is expected to finish within 7 days.';
	return badge;
}

function _remainingDayBadge(text = '<24 HOURS REMAINING') {
	const badge = _el('span', 'sq-badge sq-badge--remaining-24h', text);
	badge.title = 'Skill queue is expected to finish within 24 hours.';
	return badge;
}

function _noTrainingAlarmBadge(text = 'NO SKILL TRAINING') {
	const badge = _el('span', 'sq-badge sq-badge--alarm', text);
	badge.title = 'No active skill training detected, and recent training ended within the last 14 days.';
	return badge;
}

function _getQueueStatusBadge({ characterId, training, now }) {
	const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
	const twentyFourHoursMs = 24 * 60 * 60 * 1000;
	const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
	const trainingEndMs = Number(training?.trainingEndMs || 0);
	const queueEndMs = Number(training?.queueEmptyMs || 0);
	const inferredIsCurrentlyTraining = Boolean(training?.typeName) && trainingEndMs > now;
	const isCurrentlyTraining = training?.isCurrentlyTraining === true || inferredIsCurrentlyTraining;
	const lastTrainingEndMs = Number(training?.lastTrainingEndMs || (trainingEndMs > 0 && trainingEndMs <= now ? trainingEndMs : 0));

	const showDayEndingBadge = queueEndMs > now && (queueEndMs - now) <= twentyFourHoursMs;
	const showWeekEndingBadge = queueEndMs > now && (queueEndMs - now) <= sevenDaysMs;
	const showNoTrainingBadge = !isCurrentlyTraining && lastTrainingEndMs > 0 && (now - lastTrainingEndMs) <= fourteenDaysMs;

	if (showDayEndingBadge) return _remainingDayBadge();
	if (showWeekEndingBadge) return _remainingBadge();
	if (showNoTrainingBadge) return _noTrainingAlarmBadge();
	return null;
}

function _appendTrainingLabel(container, typeName, level) {
	const nameText = String(typeName || '').trim();
	const levelText = Number(level || 0) > 0 ? toRomanNumeral(level) : '';

	const nameSpan = _el('span', 'sq-training-name', nameText);
	container.appendChild(nameSpan);

	if (levelText) {
		container.appendChild(_el('span', 'sq-training-level', levelText));
	}
}

function _skillPips(level, training = 0, queued = 0) {
	const span = _el('span', 'sq-skill-pips');
	span.setAttribute('aria-label', `Level ${level}`);
	for (let i = 1; i <= 5; i++) {
		const pip = _el('span', 'sq-pip');
		if (i <= level) pip.classList.add('sq-pip--trained');
		else if (training > 0 && i <= training) pip.classList.add('sq-pip--training');
		else if (queued > 0 && i <= queued) pip.classList.add('sq-pip--queued');
		span.appendChild(pip);
	}
	return span;
}

function toRomanNumeral(n) {
	const map = ['', 'I', 'II', 'III', 'IV', 'V'];
	return map[Math.min(5, Math.max(0, Math.floor(n || 0)))] || '';
}

function _queueDateMs(entry, field) {
	const value = entry?.[field];
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function _skillQueueClipboardText(queue) {
	return (Array.isArray(queue) ? queue : []).map((skill) => {
		const level = Number(skill.level || skill.targetLevel || skill.finished_level || skill.finishedLevel || skill.target_level || 1);
		return `${skill.typeName} ${Math.min(5, Math.max(1, level))}`;
	}).join('\n');
}

function _showSkillQueueOptimizationModal(queue, warnings = [], heading = 'Optimized Skill Queue') {
	const backdrop = _el('div', 'sq-modal-backdrop');
	const dialog = _el('div', 'sq-modal');
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	dialog.setAttribute('aria-labelledby', 'sq-queue-modal-title');

	const header = _el('div', 'sq-modal__header');
	const title = _el('h3', 'sq-modal__title', heading);
	title.id = 'sq-queue-modal-title';
	header.appendChild(title);
	const close = _el('button', 'sq-modal__close', '×');
	close.type = 'button';
	close.setAttribute('aria-label', 'Close ' + heading);
	header.appendChild(close);
	dialog.appendChild(header);

	dialog.appendChild(_el('p', 'sq-muted', 'Copy this list, then import it into EVE Online to rebuild your queue in the optimized order. Training times use current attributes and implants, temporary boosters are excluded'));
	const text = document.createElement('textarea');
	text.className = 'sq-modal__textarea';
	text.readOnly = true;
	text.setAttribute('aria-label', heading);
	text.value = _skillQueueClipboardText(queue);
	dialog.appendChild(text);

	const actions = _el('div', 'sq-modal__actions');
	const copy = _el('button', 'sq-btn sq-btn--primary', 'Copy to Clipboard');
	copy.type = 'button';
	copy.addEventListener('click', async () => {
		try {
			if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text.value);
			else {
				text.focus();
				text.select();
				document.execCommand('copy');
			}
			copy.textContent = 'Copied!';
			setTimeout(() => { copy.textContent = 'Copy to Clipboard'; }, 1800);
		} catch (_) {
			text.focus();
			text.select();
			copy.textContent = 'Select text and copy';
		}
	});
	actions.appendChild(copy);
	dialog.appendChild(actions);

	const instructions = _el('div', 'sq-modal__instructions');
	instructions.appendChild(_el('strong', null, 'Import in EVE Online'));
	const list = document.createElement('ol');
	for (const step of [
		'Open the Skills window in-game.',
		'Open the Skill Queue menu (the three-line menu near the queue).',
		'Choose Import from Clipboard, then confirm the skills to add.'
	]) list.appendChild(_el('li', null, step));
	instructions.appendChild(list);
	instructions.appendChild(_el('p', 'sq-muted', 'EVE will validate skill books and prerequisites during import. The active skill may be skipped if it is already training.'));
	for (const warning of warnings) instructions.appendChild(_el('p', 'sq-queue__warning', warning));
	dialog.appendChild(instructions);

	const closeModal = () => {
		 document.removeEventListener('keydown', onKeyDown);
		 backdrop.remove();
	};
	const onKeyDown = (event) => { if (event.key === 'Escape') closeModal(); };
	close.addEventListener('click', closeModal);
	backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(); });
	document.addEventListener('keydown', onKeyDown);
	backdrop.appendChild(dialog);
	document.body.appendChild(backdrop);
	text.focus();
	text.select();
}

function _renderSkillQueueSection(queue, skills, { optimized = false, warnings = [] } = {}) {
	const section = _el('section', 'sq-queue');
	const queueHeader = _el('div', 'sq-queue__header');
	const h4 = _el('h4', 'sq-section-title');
	h4.innerHTML = `Skill Queue <small>(${queue.length} in queue. All times UTC)</small>`;
	queueHeader.appendChild(h4);

	const controls = _el('div', 'sq-queue__controls');
	const optimizeButton = _el('button', 'sq-btn sq-btn--primary sq-btn--sm', 'Optimze');
	optimizeButton.type = 'button';
	optimizeButton.title = 'Order queued skills by shortest training time while keeping prerequisites ahead of dependents.';
	optimizeButton.addEventListener('click', async () => {
		optimizeButton.disabled = true;
		optimizeButton.textContent = 'Optimizing...';
		try {
			const result = await window.optimizeSkillQueueOrder(queue, skills);
			section.replaceWith(_renderSkillQueueSection(result.queue, skills, {
				optimized: true,
				warnings: result.warnings
			}));
			_showSkillQueueOptimizationModal(result.queue, result.warnings);
		} catch (error) {
			console.warn('Unable to optimize skill queue.', error);
			optimizeButton.disabled = false;
			optimizeButton.textContent = 'Optimze';
		}
	});
	controls.appendChild(optimizeButton);
	queueHeader.appendChild(controls);
	section.appendChild(queueHeader);
	for (const warning of warnings) section.appendChild(_el('p', 'sq-muted sq-queue__warning', warning));

	const table = document.createElement('table');
	table.className = 'sq-table sq-table--striped';
	const thead = document.createElement('thead');
	thead.innerHTML = '<tr><th>Skill <small class="sq-queue-sp-needed">SP remaining to complete skill</small></th><th>Group</th><th>Start</th><th>End</th><th>SP/h</th></tr>';
	const tbody = document.createElement('tbody');
	const now = Date.now();
	const computeQueueSpNeeded = (skill) => {
		const explicit = Number(skill?.spNeeded);
		if (Number.isFinite(explicit) && explicit > 0) return Math.ceil(explicit);
		const startMs = _queueDateMs(skill, 'startDate');
		const endMs = _queueDateMs(skill, 'endDate');
		const spHour = Number(skill?.spHour || 0);
		if (!startMs || !endMs || endMs <= startMs || spHour <= 0) return 0;
		return Math.max(0, Math.ceil(spHour * ((endMs - Math.max(now, startMs)) / 3600000)));
	};
	for (const skill of queue) {
		const tr = document.createElement('tr');
		const queueLevel = Number(skill.level || skill.targetLevel || skill.finished_level || skill.finishedLevel || skill.target_level || 0);
		const skillTd = document.createElement('td');
		skillTd.dataset.label = 'Skill';
		skillTd.appendChild(_a(`/item/${skill.typeID}/`, skill.typeName + (queueLevel ? ` ${toRomanNumeral(queueLevel)}` : '')));
		if (skill.hasTrainingBooster) skillTd.appendChild(_el('span', null, ' '));
		if (skill.hasTrainingBooster) skillTd.appendChild(_boosterBadge());
		const spNeeded = computeQueueSpNeeded(skill);
		if (spNeeded > 0) skillTd.appendChild(_el('small', 'sq-queue-sp-needed', ` ${numberFormat(spNeeded, 0)}`));
		tr.appendChild(skillTd);
		for (const [label, value] of [['Group', skill.groupName || ''], ['Start', skill.startDate ? formatDateTime(skill.startDate) : (skill.startTime || '')], ['End', skill.endDate ? formatDateTime(skill.endDate) : (skill.endTime || '')], ['SP/h', numberFormat(skill.spHour, 0)]]) {
			const td = document.createElement('td');
			td.dataset.label = label;
			td.textContent = value;
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.appendChild(thead);
	table.appendChild(tbody);
	section.appendChild(table);
	return section;
}

function encodeCharacterNameForPath(name) {
	return encodeURIComponent(String(name || '')).replace(/%20/g, '+');
}

/* ─── Navbar ─────────────────────────────────────────────────────────────────
 *
 * renderNavbar({ characters, currentCharId, isLoggedIn })
 *
 * characters: [{ character_id, name }]
 */
function renderNavbar({ characters = [], currentCharId = null, isLoggedIn = false, layoutMode = 'restricted', isHome = false } = {}) {
	const nav = _el('nav', 'sq-nav');

	// Brand
	const brand = _a('/', null, 'sq-nav__brand');
	brand.appendChild(_img('/img/skillbook.png', 'Skillbook', 'sq-nav__brand-icon', {id: 'sq-brand-icon'}));
	brand.appendChild(_el('span', 'sq-nav__brand-text', 'SkillQ'));
	nav.appendChild(brand);

	if (isLoggedIn) {
		const allLink = _a('/', 'All', 'sq-nav__all-link');
		if (isHome) allLink.classList.add('sq-nav__all-link--active');
		nav.appendChild(allLink);
	}

	// Character portrait strip
	if (characters.length > 0) {
		const strip = _el('div', 'sq-nav__chars');
		for (const char of characters) {
			const a = _a(`/char/${encodeCharacterNameForPath(char.name)}`, null, 'sq-nav__char-link');
			if (!isHome && char.character_id == currentCharId) a.classList.add('sq-nav__char-link--active');
			a.dataset.characterId = String(char.character_id);
			a.title = char.name;
			a.appendChild(_img(
				`https://images.evetech.net/characters/${char.character_id}/portrait?size=32`,
				char.name,
				'sq-nav__char-img',
				{id: `sq-char-${char.character_id}-img`}
			));
			strip.appendChild(a);
		}
		nav.appendChild(strip);
	}

	// Right-side actions
	const actions = _el('div', 'sq-nav__actions');
	if (isLoggedIn) {
		actions.appendChild(_a('/login', 'Add Character', 'sq-btn sq-btn--primary'));

		// Dropdown menu (Manage / Settings / Logout)
		const dropdown = _el('div', 'sq-dropdown');
		const toggle = _el('button', 'sq-dropdown__toggle sq-btn sq-btn--ghost');
		toggle.innerHTML = '&#9776;';
		toggle.setAttribute('aria-expanded', 'false');
		const menu = _el('ul', 'sq-dropdown__menu');
		const mobileAddItem = document.createElement('li');
		mobileAddItem.appendChild(_a('/login', 'Add Character', 'sq-dropdown__item sq-dropdown__item--mobile-only'));
		menu.appendChild(mobileAddItem);

		const layoutItem = document.createElement('li');
		const layoutToggle = _a('#', layoutMode === 'full' ? 'Use Restricted Width' : 'Use Full Width', 'sq-dropdown__item');
		layoutToggle.classList.add('sq-layout-toggle');
		layoutItem.appendChild(layoutToggle);
		menu.appendChild(layoutItem);

		for (const [label, href] of [['Manage', '/manage'], ['Settings', '/settings'], ['About', '/readme'], ['Logout', '/logout']]) {
			const li = document.createElement('li');
			li.appendChild(_a(href, label, 'sq-dropdown__item'));
			menu.appendChild(li);
		}
		toggle.addEventListener('click', e => {
			e.stopPropagation();
			const open = toggle.getAttribute('aria-expanded') === 'true';
			toggle.setAttribute('aria-expanded', String(!open));
			menu.classList.toggle('sq-dropdown__menu--open', !open);
		});
		document.addEventListener('click', () => {
			toggle.setAttribute('aria-expanded', 'false');
			menu.classList.remove('sq-dropdown__menu--open');
		});
		dropdown.appendChild(toggle);
		dropdown.appendChild(menu);
		actions.appendChild(dropdown);
	} else {
		actions.appendChild(_a('/login', 'Login', 'sq-btn sq-btn--primary'));
	}

	nav.appendChild(actions);
	return nav;
}

/* ─── Character Card (index/home page) ───────────────────────────────────────
 *
 * renderCharCard({ character, training })
 *
 * character: { character_id, name, corporation_id, balance, skillPoints }
 * training:  { typeName, trainingEndMs, queueEmptyMs } | null
 *   trainingEndMs  = Date.now()-relative ms when current skill finishes
 *   queueEmptyMs   = Date.now()-relative ms when queue empties
 */
function renderCharCard({ character, training = null } = {}) {
	const { character_id, name, balance = 0, skillPoints = 0 } = character;
	const now = Date.now();
	const statusBadge = _getQueueStatusBadge({ characterId: character_id, training, now });

	const card = _el('div', 'sq-char-card');

	// Portrait
	const portraitLink = _a(`/char/${encodeCharacterNameForPath(name)}`, null, 'sq-char-card__portrait-link');
	portraitLink.appendChild(_img(
		`https://images.evetech.net/characters/${character_id}/portrait?size=128`,
		name,
		'sq-char-card__portrait',
	));
	card.appendChild(portraitLink);

	// Info
	const info = _el('div', 'sq-char-card__info');

	const nameEl = document.createElement('strong');
	nameEl.appendChild(_a(`/char/${encodeCharacterNameForPath(name)}`, name));
	info.appendChild(nameEl);

	info.appendChild(_el('div', 'sq-char-card__stat', `${numberFormat(balance, 2)} ISK`));
	info.appendChild(_el('div', 'sq-char-card__stat', `${numberFormat(skillPoints, 0)} SP`));

	if (training?.typeName) {
		const trainDiv = _el('div', 'sq-char-card__training');
		_appendTrainingLabel(trainDiv, training.typeName, training.level);
		info.appendChild(trainDiv);

		if (training.trainingEndMs > Date.now()) {
			const countdown = _el('div', 'sq-countdown sq-char-card__countdown');
			countdown.dataset.until = training.trainingEndMs;
			info.appendChild(countdown);
		}

		if (training.hasTrainingBooster || training.hasCharacterBooster) {
			const boosterWrap = _el('div', 'sq-char-card__booster');
			boosterWrap.appendChild(_boosterBadge('Booster'));
			info.appendChild(boosterWrap);
		}

	}

	if (statusBadge) {
		const statusWrap = _el('div', 'sq-char-card__booster');
		statusWrap.appendChild(statusBadge);
		info.appendChild(statusWrap);
	}

	card.appendChild(info);
	return card;
}

/* ─── Character Info header ──────────────────────────────────────────────────
 *
 * renderCharInfo({ character, corporation, alliance, training, showBalance, actions })
 *
 * character:    { character_id, name, corporation_id, alliance_id, balance }
 * corporation:  { corporation_id, name } | null
 * alliance:     { alliance_id, name }    | null
 * training:     { typeName, trainingEndMs, queueEmptyMs } | null
 * showBalance:  boolean (default true; false for shared views)
 * actions:      HTMLElement | null
 */
function renderCharInfo({ character, corporation = null, alliance = null, training = null, showBalance = true, actions = null } = {}) {
	const { character_id, name, corporation_id, alliance_id, balance = 0 } = character;
	const now = Date.now();
	const statusBadge = _getQueueStatusBadge({ characterId: character_id, training, now });

	const el = _el('div', 'sq-char-info');

	// Portrait
	el.appendChild(_img(
		`https://images.evetech.net/characters/${character_id}/portrait?size=256`,
		name,
		'sq-char-info__portrait',
		img_256
	));

	const size = { height: 128, width: 128 };
	// Corp / alliance logos
	const logos = _el('div', 'sq-char-info__logos');
	if (corporation_id) {
		logos.appendChild(_img(
			`https://images.evetech.net/corporations/${corporation_id}/logo?size=128`,
			corporation?.name || '',
			'sq-char-info__logo',
			img_128
		));
	}
	if (alliance_id) {
		logos.appendChild(_img(
			`https://images.evetech.net/alliances/${alliance_id}/logo?size=128`,
			alliance?.name || '',
			'sq-char-info__logo',
			img_128
		));
	}
	el.appendChild(logos);

	// Text details
	const details = _el('div', 'sq-char-info__details');
	details.appendChild(_el('strong', 'sq-char-info__name', name));
	if (corporation?.name) details.appendChild(_el('div', 'sq-char-info__corp', corporation.name));
	if (alliance?.name)    details.appendChild(_el('div', 'sq-char-info__alliance', alliance.name));
	if (showBalance) {
		details.appendChild(_el('div', 'sq-char-info__balance', `${numberFormat(balance, 2)} ISK`));
	} else {
		details.appendChild(_el('div', 'sq-char-info__balance sq-muted', 'Wallet balance not included in this shared snapshot.'));
	}

	if (training?.typeName) {
		const trainingEl = _el('div', 'sq-char-info__training');
		_appendTrainingLabel(trainingEl, training.typeName, training.level);
		details.appendChild(trainingEl);
		if (training.trainingEndMs > Date.now()) {
			const countdown = _el('span', 'sq-countdown');
			countdown.dataset.until = training.trainingEndMs;
			details.appendChild(countdown);
		}
		if (training.hasTrainingBooster || training.hasCharacterBooster) {
			const boosterWrap = _el('div', 'sq-char-info__booster');
			boosterWrap.appendChild(_boosterBadge('Booster'));
			details.appendChild(boosterWrap);
		}
	}

	if (statusBadge) {
		const statusWrap = _el('div', 'sq-char-info__booster');
		statusWrap.appendChild(statusBadge);
		details.appendChild(statusWrap);
	}

	el.appendChild(details);

	if (actions instanceof HTMLElement) {
		const actionWrap = _el('div', 'sq-char-info__actions');
		actionWrap.appendChild(actions);
		el.appendChild(actionWrap);
	}

	return el;
}

/* ─── Character Tab Menu ─────────────────────────────────────────────────────
 *
 * renderCharMenu({ charName, activeTab })
 *
 * charName:  plain character name (will be URI-encoded)
 * activeTab: 'overview' | 'wallet' | 'train' | 'clones' | 'notes'
 */
function renderCharMenu({ charName, activeTab = 'overview' } = {}) {
	const encoded = encodeCharacterNameForPath(charName);
	const tabs = [
		{ id: 'overview', label: 'Overview', href: `/char/${encoded}/` },
		{ id: 'wallet',   label: 'Wallet',   href: `/char/${encoded}/wallet/` },
		{ id: 'train',    label: 'Train',    href: `/char/${encoded}/train/` },
		{ id: 'clones',   label: 'Clones',   href: `/char/${encoded}/clones/` },
		{ id: 'notes',    label: 'Notes',    href: `/char/${encoded}/notes/` },
	];

	const nav = _el('nav', 'sq-char-menu');
	const ul = _el('ul', 'sq-char-menu__tabs');

	for (const tab of tabs) {
		const li = _el('li', 'sq-char-menu__tab');
		if (tab.id === activeTab) li.classList.add('sq-char-menu__tab--active');
		li.appendChild(_a(tab.href, tab.label));
		ul.appendChild(li);
	}

	nav.appendChild(ul);
	return nav;
}

/* ─── Character Skills (queue + all skills) ──────────────────────────────────
 *
 * renderCharSkills({ queue, skills, totalSP, unallocatedSP })
 *
 * queue:  [{ typeName, typeID, groupName, startTime, endTime, spHour, spNeeded }]
 * skills: [{ typeName, typeID, groupName, groupID, skillPoints, level,
 *            training, queue }]
 *   training/queue: level currently being trained/queued (0 if none)
 * totalSP, unallocatedSP: numbers
 */
function renderCharSkills({ queue = [], skills = [], totalSP = 0, unallocatedSP = 0 } = {}) {
	const el = _el('div', 'sq-skills');
	const now = Date.now();
	const visibleQueue = (queue || []).filter((entry) => {
		const endMs = _queueDateMs(entry, 'endDate');
		return endMs <= 0 || endMs > now;
	});

	/* ── Skill Queue ── */
	if (visibleQueue.length > 0) {
		const section = _renderSkillQueueSection(visibleQueue, skills);
		el.appendChild(section);
	}

	/* ── All Skills by Group ── */
	if (skills.length > 0) {
		const section = _el('section', 'sq-skill-groups');

		const h4 = _el('h4', 'sq-section-title');
		h4.innerHTML = `Skills <small>${numberFormat(totalSP, 0)} SP / ${skills.length} Skills${
			unallocatedSP > 0 ? ` &nbsp;<em class="sq-warn">(${numberFormat(unallocatedSP, 0)} Unallocated SP)</em>` : ''
		}</small>`;
		section.appendChild(h4);

		// Expand/Collapse controls
		const controls = _el('div', 'sq-skill-controls');
		const addCtrl = (label, fn) => {
			const btn = _el('button', 'sq-btn sq-btn--info sq-btn--sm', label);
			btn.addEventListener('click', fn);
			controls.appendChild(btn);
		};
		addCtrl('Expand All',  () => section.querySelectorAll('.sq-skill-row').forEach(r => r.hidden = false));
		addCtrl('Collapse All',() => section.querySelectorAll('.sq-skill-row').forEach(r => r.hidden = true));
		addCtrl("Exclude V's", () => {
			section.querySelectorAll('.sq-skill-row').forEach(r => r.hidden = false);
			section.querySelectorAll('.sq-skill-row--v').forEach(r => r.hidden = true);
		});

		section.appendChild(controls);

		// Group skills by groupID
		const grouped = new Map();
		for (const skill of skills) {
			if (!grouped.has(skill.groupID)) grouped.set(skill.groupID, { name: skill.groupName, sp: 0, count: 0, skills: [] });
			const g = grouped.get(skill.groupID);
			g.sp += skill.skillPoints || 0;
			g.count++;
			g.skills.push(skill);
		}

		for (const [gid, group] of grouped) {
			const groupEl = _el('div', 'sq-skill-group');

			const header = _el('button', 'sq-skill-group__header');
			header.setAttribute('aria-expanded', 'false');
			header.innerHTML = `<span>${group.name}</span><em>${numberFormat(group.sp, 0)} SP / ${group.count} Skills</em>`;
			header.addEventListener('click', () => {
				const open = header.getAttribute('aria-expanded') === 'true';
				header.setAttribute('aria-expanded', String(!open));
				groupEl.querySelectorAll('.sq-skill-row').forEach(r => r.hidden = open);
			});
			groupEl.appendChild(header);

			const table = document.createElement('table');
			table.className = 'sq-table sq-table--compact';
			const tbody = document.createElement('tbody');

			for (const skill of group.skills) {
				const tr = document.createElement('tr');
				tr.className = 'sq-skill-row' + (skill.level === 5 ? ' sq-skill-row--v' : '');
				tr.hidden = true;

				const nameTd = document.createElement('td');
				const link = _a(`/item/${skill.typeID}/`, `${skill.typeName} ${toRomanNumeral(skill.level)}`);
				nameTd.appendChild(link);
				// Show skill points: level V shows total only, others show current/total and remaining
				const currentSp = skill.skillPoints || 0;
				const totalSp = skill.skillPointsTotal || 0;
				const remainingSp = skill.skillPointsRemaining || 0;
				if (totalSp > 0) {
					if (skill.level === 5) {
						nameTd.appendChild(_el('em', 'sq-skill-sp', ` ${numberFormat(totalSp, 0)} SP`));
					} else {
						nameTd.appendChild(_el('em', 'sq-skill-sp', ` ${numberFormat(currentSp, 0)}/${numberFormat(totalSp, 0)} SP`));
						if (remainingSp > 0) {
							nameTd.appendChild(_el('em', 'sq-skill-sp-remaining', ` (${numberFormat(remainingSp, 0)} remaining)`));
						}
					}
				}

				const pipTd = _el('td', 'sq-skill-pip-cell');
				pipTd.appendChild(_skillPips(skill.level, skill.training || 0, skill.queue || 0));

				tr.appendChild(nameTd);
				tr.appendChild(pipTd);
				tbody.appendChild(tr);
			}

			table.appendChild(tbody);
			groupEl.appendChild(table);
			section.appendChild(groupEl);
		}

		el.appendChild(section);
	}

	return el;
}

/* ─── Character Wallet ───────────────────────────────────────────────────────
 *
 * renderCharWallet({ transactions })
 *
 * transactions: [{ dttm, refTypeName, ownerName1, ownerName2, amount, balance, reason }]
 */
function renderCharWallet({ transactions = [] } = {}) {
	const el = _el('div', 'sq-wallet');

	if (transactions.length === 0) {
		el.appendChild(_el('p', 'sq-muted', 'No wallet transactions on record for this character.'));
		el.appendChild(_el('p', 'sq-muted', 'SkillQ only keeps 30 days of wallet transactions.'));
		return el;
	}

	const table = document.createElement('table');
	table.className = 'sq-table sq-table--striped';
	const thead = document.createElement('thead');
	thead.innerHTML = `<tr>
		<th>Time</th><th>Type</th><th>From</th><th>To</th>
		<th class="sq-text-right">Amount</th><th class="sq-text-right">Balance</th><th>Reason</th>
	</tr>`;
	const tbody = document.createElement('tbody');

	for (const row of transactions) {
		const tr = document.createElement('tr');
		tr.className = row.amount >= 0 ? 'sq-row--positive' : 'sq-row--negative';

		const timeTd = document.createElement('td');
		timeTd.dataset.label = 'Time';
		timeTd.textContent = row.dttm || '';
		tr.appendChild(timeTd);

		const typeTd = document.createElement('td');
		typeTd.dataset.label = 'Type';
		typeTd.textContent = row.refTypeName || '';
		tr.appendChild(typeTd);

		const fromTd = document.createElement('td');
		fromTd.dataset.label = 'From';
		fromTd.textContent = row.ownerName1 || '';
		tr.appendChild(fromTd);

		const toTd = document.createElement('td');
		toTd.dataset.label = 'To';
		toTd.textContent = row.ownerName2 || '';
		tr.appendChild(toTd);

		const amountTd = document.createElement('td');
		amountTd.dataset.label = 'Amount';
		amountTd.className = 'sq-text-right';
		amountTd.textContent = numberFormat(row.amount, 2);
		tr.appendChild(amountTd);

		const balanceTd = document.createElement('td');
		balanceTd.dataset.label = 'Balance';
		balanceTd.className = 'sq-text-right';
		balanceTd.textContent = numberFormat(row.balance, 2);
		tr.appendChild(balanceTd);

		const reasonTd = document.createElement('td');
		reasonTd.dataset.label = 'Reason';
		reasonTd.textContent = row.reason || '';
		tr.appendChild(reasonTd);

		tbody.appendChild(tr);
	}

	table.appendChild(thead);
	table.appendChild(tbody);
	el.appendChild(table);
	el.appendChild(_el('p', 'sq-muted', 'SkillQ only keeps 30 days of wallet transactions.'));
	return el;
}

/* ─── Character Clones ───────────────────────────────────────────────────────
 *
 * renderCharClones({ clones })
 *
 * clones: [{ cloneId, name, kind, isActive, locationLabel,
 *            implants: [{ typeID, typeName, slot }] }]
 */
function renderCharClones({ clones = [] } = {}) {
	const el = _el('div', 'sq-clones-page');

	const clonesSection = _el('section', 'sq-clones');
	const clonesTitle = _el('h4', 'sq-section-title', 'Clones & Implants');
	clonesTitle.appendChild(_el('small', null, `(${clones.length} ${clones.length === 1 ? 'clone' : 'clones'})`));
	clonesSection.appendChild(clonesTitle);

	if (clones.length === 0) {
		clonesSection.appendChild(_el('p', 'sq-muted', 'No clone data available.'));
	} else {
		const cloneGrid = _el('div', 'sq-clone-grid');
		for (const clone of clones) {
			const card = _el('article', `sq-clone-card${clone.isActive ? ' sq-clone-card--active' : ''}`);
			const header = _el('div', 'sq-clone-card__header');
			const titleWrap = _el('div', 'sq-clone-card__title-wrap');
			titleWrap.appendChild(_el('h5', 'sq-clone-card__title', clone.name || clone.kind || 'Clone'));
			titleWrap.appendChild(_el('span', 'sq-clone-card__kind', clone.kind || 'Clone'));
			header.appendChild(titleWrap);
			header.appendChild(_el('div', 'sq-clone-card__location', clone.locationLabel || 'Unknown location'));
			card.appendChild(header);

			const installed = Array.isArray(clone.implants) ? clone.implants : [];
			if (installed.length === 0) {
				card.appendChild(_el('p', 'sq-muted sq-clone-card__empty', 'No implants installed.'));
			} else {
				const list = _el('ul', 'sq-clone-implant-list');
				for (const implant of installed) {
					const item = _el('li', 'sq-clone-implant');
					const link = _a(`/item/${implant.typeID}/`, null, 'sq-clone-implant__link');
					link.appendChild(_img(
						`https://images.evetech.net/types/${implant.typeID}/icon?size=32`,
						implant.typeName,
						'sq-clone-implant__icon',
						{ loading: 'lazy', decoding: 'async', width: 32, height: 32 }
					));
					link.appendChild(_el('span', 'sq-clone-implant__name', implant.typeName || `Implant ${implant.typeID}`));
					item.appendChild(link);
					if (Number(implant.slot || 0) > 0) {
						item.appendChild(_el('span', 'sq-clone-implant__slot', `Slot ${implant.slot}`));
					}
					list.appendChild(item);
				}
				card.appendChild(list);
			}
			cloneGrid.appendChild(card);
		}
		clonesSection.appendChild(cloneGrid);
	}
	clonesSection.appendChild(_el('p', 'sq-muted sq-clones-note', 'Player-owned structures are shown by structure ID.'));
	el.appendChild(clonesSection);
	return el;
}

/* ─── Character Train (attributes + suggestions) ─────────────────────────────
 *
 * renderCharTrain({ implants, suggestions, optimize })
 *
 * implants: [{ attributeName, baseValue, bonus, implantName }]
 * suggestions: [{ typeName, typeID, level, time, primaryAttribute,
 *                 secondaryAttribute, skillPoints, training, queue }]
 * optimize: { rows, sampleSize, currentSeconds, optimizedSeconds, savedSeconds, savedPercent }
 */
function renderCharTrain({ characterId, implants = [], suggestions = [], optimize = null } = {}) {
	const el = _el('div', 'sq-train');

	const topPanels = _el('div', 'sq-train-top-panels');

	/* ── Implants ── */
	if (implants.length > 0) {
		const section = _el('section', 'sq-implants');
		section.appendChild(_el('h4', 'sq-section-title', 'Training Attributes'));

		const table = document.createElement('table');
		table.className = 'sq-table sq-table--compact';
		const tbody = document.createElement('tbody');
		for (const attr of implants) {
			const tr = document.createElement('tr');
			tr.innerHTML = `
				<td>${capitalizeFirst(attr.attributeName)}</td>
				<td>${attr.baseValue} <em>(+${attr.bonus})</em></td>
				<td>${attr.implantName}</td>
			`;
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		section.appendChild(table);
		topPanels.appendChild(section);
	}

	/* ── Optimize ── */
	const optimizeSection = _el('section', 'sq-optimize');
	optimizeSection.appendChild(_el('h4', 'sq-section-title', 'Optimize'));
	if (Array.isArray(optimize?.rows) && optimize.rows.length > 0) {
		const table = document.createElement('table');
		table.className = 'sq-table sq-table--compact';
		const thead = document.createElement('thead');
		thead.innerHTML = '<tr><th>Attribute</th><th>Current</th><th>Optimized</th><th>Delta</th></tr>';
		const tbody = document.createElement('tbody');

		for (const row of optimize.rows) {
			const tr = document.createElement('tr');
			const deltaPrefix = Number(row.deltaPoints || 0) > 0 ? '+' : '';
			tr.innerHTML = `
				<td>${capitalizeFirst(row.attributeName)}</td>
				<td>${Number(row.currentPoints || 0)} pts <em>(${Number(row.currentValue || 0)})</em></td>
				<td>${Number(row.optimizedPoints || 0)} pts <em>(${Number(row.optimizedValue || 0)})</em></td>
				<td>${deltaPrefix}${Number(row.deltaPoints || 0)}</td>
			`;
			tbody.appendChild(tr);
		}

		table.appendChild(thead);
		table.appendChild(tbody);
		optimizeSection.appendChild(table);

		const savedSeconds = Number(optimize?.savedSeconds || 0);
		const savedPercent = Number(optimize?.savedPercent || 0);
		const sampleSize = Number(optimize?.sampleSize || 0);
		if (savedSeconds > 0) {
			optimizeSection.appendChild(_el(
				'p',
				'sq-muted sq-optimize-summary',
				`Estimated savings: ${formatDuration(Math.round(savedSeconds))} (${savedPercent.toFixed(1)}%) across ${sampleSize} queued skills.`
			));
		} else {
			optimizeSection.appendChild(_el(
				'p',
				'sq-muted sq-optimize-summary',
				`Current remap is already near-optimal for ${sampleSize} queued skills.`
			));
		}
		optimizeSection.appendChild(_el(
			'p',
			'sq-muted sq-optimize-summary',
			'Assumes Omega training rates and uses Neural remap limits (17-27 per attribute, 14 remap points). Remap cooldown and availability are not modeled.'
		));
		optimizeSection.appendChild(_el(
			'p',
			'sq-muted sq-optimize-summary',
			'Recommended: use remap optimization only when planning at least one year of focused training.'
		));
	} else {
		optimizeSection.appendChild(_el('p', 'sq-muted sq-optimize-summary', 'No queued skills available for optimization.'));
	}
	topPanels.appendChild(optimizeSection);

	if (topPanels.childElementCount > 0) {
		el.appendChild(topPanels);
	}

	/* ── Skill Suggestions ── */
	const section = _el('section', 'sq-skill-suggestions');
	section.appendChild(_el('h4', 'sq-section-title', 'Quickest Skills to Train to V'));

	if (suggestions.length === 0) {
		section.appendChild(_el('p', 'sq-muted', 'No skill training suggestions available.'));
		el.appendChild(section);
		return el;
	}

	// Filter controls
	const controls = _el('div', 'sq-skill-controls');
	const addCtrl = (label, fn) => {
		const btn = _el('button', 'sq-btn sq-btn--info sq-btn--sm', label);
		btn.addEventListener('click', fn);
		controls.appendChild(btn);
	};
	addCtrl('Show All',      () => section.querySelectorAll('.sq-skill-row').forEach(r => r.hidden = false));
	addCtrl('Hide Untrained',() => section.querySelectorAll('.sq-skill-row--untrained').forEach(r => r.hidden = true));
	addCtrl('Hide Trained',  () => section.querySelectorAll('.sq-skill-row--trained').forEach(r => r.hidden = true));
	if (characterId) {
		const quickest = _el('button', 'sq-btn sq-btn--primary sq-btn--sm', 'Export');
		quickest.style.marginLeft = 'auto';
		quickest.type = 'button';
		quickest.addEventListener('click', async () => {
			quickest.disabled = true;
			try {
				const rows = await window.quickestSkillsToV(characterId);
				_showSkillQueueOptimizationModal(rows, [], 'Quickest to V');
			} catch (error) {
				window.alert(error.message);
			} finally {
				quickest.disabled = false;
			}
		});
		controls.appendChild(quickest);
	}
	section.appendChild(controls);

	const table = document.createElement('table');
	table.className = 'sq-table sq-table--striped';
	const thead = document.createElement('thead');
	thead.innerHTML = '<tr><th>Skill</th><th>Level</th><th>Time</th><th>Primary</th><th>Secondary</th></tr>';
	const tbody = document.createElement('tbody');

	for (const row of suggestions) {
		const tr = document.createElement('tr');
		tr.className = `sq-skill-row ${row.level > 0 ? 'sq-skill-row--trained' : 'sq-skill-row--untrained'}`;

		const nameTd = document.createElement('td');
		nameTd.appendChild(_a(`/item/${row.typeID}/`, row.typeName));
		if (row.skillPoints) nameTd.appendChild(_el('em', 'sq-skill-sp', ` ${numberFormat(row.skillPoints, 0)} SP`));

		const pipTd = _el('td', 'sq-skill-pip-cell');
		pipTd.appendChild(_skillPips(row.level, row.training || 0, row.queue || 0));

		tr.appendChild(nameTd);
		tr.appendChild(pipTd);
		tr.appendChild(_el('td', null, row.time || ''));
		tr.appendChild(_el('td', null, capitalizeFirst(row.primaryAttribute || '')));
		tr.appendChild(_el('td', null, capitalizeFirst(row.secondaryAttribute || '')));
		tbody.appendChild(tr);
	}

	table.appendChild(thead);
	table.appendChild(tbody);
	section.appendChild(table);
	section.appendChild(_el('p', 'sq-muted', 'Required skill dependencies are not calculated into the time.'));
	el.appendChild(section);
	return el;
}

function renderSharedCharSkills({ queue = [], skills = [], totalSP = 0, hasSharedTotalSP = true } = {}) {
	const el = _el('div', 'sq-skills');
	const now = Date.now();
	const visibleQueue = (queue || []).filter((entry) => Number(entry.trainingEndMs || 0) <= 0 || Number(entry.trainingEndMs || 0) > now);

	const trainingSection = _el('section', 'sq-queue');
	const trainingHeader = _el('h4', 'sq-section-title');
	trainingHeader.innerHTML = `Skill Queue <small>(${visibleQueue.length} in queue. All times UTC)</small>`;
	trainingSection.appendChild(trainingHeader);

	if (visibleQueue.length === 0) {
		trainingSection.appendChild(_el('p', 'sq-muted', 'No queue rows were included in this shared snapshot.'));
	} else {
		const trainingTable = document.createElement('table');
		trainingTable.className = 'sq-table sq-table--striped';
		const trainingHead = document.createElement('thead');
		trainingHead.innerHTML = '<tr><th>Skill</th><th>Group</th><th>Start</th><th>End</th></tr>';
		const trainingBody = document.createElement('tbody');

		for (const entry of visibleQueue) {
			const tr = document.createElement('tr');
			const startMs = Number(entry.trainingStartMs || 0);
			const endMs = Number(entry.trainingEndMs || 0);

			const skillTd = document.createElement('td');
			skillTd.dataset.label = 'Skill';
			const levelStr = toRomanNumeral(
				Number(entry.targetLevel || entry.level || entry.finished_level || entry.finishedLevel || entry.target_level || 0)
			);
			skillTd.appendChild(_a(`/item/${entry.typeID}/`, entry.typeName + (levelStr ? ` ${levelStr}` : '')));
			tr.appendChild(skillTd);

			const groupTd = document.createElement('td');
			groupTd.dataset.label = 'Group';
			groupTd.textContent = entry.groupName || '';
			tr.appendChild(groupTd);

			const startTd = document.createElement('td');
			startTd.dataset.label = 'Start';
			startTd.textContent = startMs > 0 ? formatDateTime(startMs) : '';
			tr.appendChild(startTd);

			const endTd = document.createElement('td');
			endTd.dataset.label = 'End';
			endTd.textContent = endMs > 0 ? formatDateTime(endMs) : '';
			tr.appendChild(endTd);

			trainingBody.appendChild(tr);
		}

		trainingTable.appendChild(trainingHead);
		trainingTable.appendChild(trainingBody);
		trainingSection.appendChild(trainingTable);
	}
	el.appendChild(trainingSection);

	const section = _el('section', 'sq-skill-groups');
	const heading = _el('h4', 'sq-section-title');
	const totalSpSummary = hasSharedTotalSP ? `${numberFormat(totalSP, 0)} SP / ` : 'Total SP not included / ';
	heading.innerHTML = `Shared Skills <small>${totalSpSummary}${skills.length} Skills</small>`;
	section.appendChild(heading);

	if (skills.length === 0) {
		section.appendChild(_el('p', 'sq-muted', 'No overview skill rows were included in this shared snapshot.'));
		el.appendChild(section);
		return el;
	}

	// Build sets for active/queued annotation in the grouped skill list
	const activeTypeIds = new Set(
		visibleQueue.filter((e) => Number(e.trainingStartMs || 0) > 0 && Number(e.trainingEndMs || 0) > now && Number(e.trainingStartMs) <= now)
			.map((e) => e.typeID)
	);
	const queuedTypeIds = new Set(visibleQueue.map((e) => e.typeID));

	const controls = _el('div', 'sq-skill-controls');
	const addCtrl = (label, fn) => {
		const btn = _el('button', 'sq-btn sq-btn--info sq-btn--sm', label);
		btn.addEventListener('click', fn);
		controls.appendChild(btn);
	};
	addCtrl('Expand All', () => section.querySelectorAll('.sq-skill-row').forEach((row) => { row.hidden = false; }));
	addCtrl('Collapse All', () => section.querySelectorAll('.sq-skill-row').forEach((row) => { row.hidden = true; }));
	section.appendChild(controls);

	const grouped = new Map();
	for (const skill of skills) {
		if (!grouped.has(skill.groupID)) grouped.set(skill.groupID, { name: skill.groupName || 'Unknown Group', count: 0, skills: [] });
		const group = grouped.get(skill.groupID);
		group.count += 1;
		group.skills.push(skill);
	}

	for (const [, group] of grouped) {
		const groupEl = _el('div', 'sq-skill-group');
		const header = _el('button', 'sq-skill-group__header');
		header.setAttribute('aria-expanded', 'false');
		header.innerHTML = `<span>${group.name}</span><em>${group.count} Skills</em>`;
		header.addEventListener('click', () => {
			const open = header.getAttribute('aria-expanded') === 'true';
			header.setAttribute('aria-expanded', String(!open));
			groupEl.querySelectorAll('.sq-skill-row').forEach((row) => { row.hidden = open; });
		});
		groupEl.appendChild(header);

		const table = document.createElement('table');
		table.className = 'sq-table sq-table--compact';
		const tbody = document.createElement('tbody');

		for (const skill of group.skills) {
			const tr = document.createElement('tr');
			tr.className = 'sq-skill-row' + (skill.level === 5 ? ' sq-skill-row--v' : '');
			tr.hidden = true;

			const isActive = activeTypeIds.has(skill.typeID);
			const isQueued = queuedTypeIds.has(skill.typeID);

			const nameTd = document.createElement('td');
			nameTd.appendChild(_a(`/item/${skill.typeID}/`, skill.typeName));
			if (isActive) {
				nameTd.appendChild(_el('em', 'sq-skill-sp', ' active'));
			} else if (isQueued) {
				nameTd.appendChild(_el('em', 'sq-skill-sp', ' queued'));
			}

			const pipTd = _el('td', 'sq-skill-pip-cell');
			pipTd.appendChild(_skillPips(skill.level, skill.training || 0, skill.queue || 0));

			tr.appendChild(nameTd);
			tr.appendChild(pipTd);
			tbody.appendChild(tr);
		}

		table.appendChild(tbody);
		groupEl.appendChild(table);
		section.appendChild(groupEl);
	}

	const note = _el('p', 'sq-muted', 'Shared links include skill levels and active training timing, not wallet transactions or exact accumulated SP.');
	section.appendChild(note);
	el.appendChild(section);
	return el;
}

/* ─── Exports ────────────────────────────────────────────────────────────────── */
window.renderNavbar    = renderNavbar;
window.renderCharCard  = renderCharCard;
window.renderCharInfo  = renderCharInfo;
window.renderCharMenu  = renderCharMenu;
window.renderCharSkills = renderCharSkills;
window.renderCharWallet = renderCharWallet;
window.renderCharClones = renderCharClones;
window.renderCharTrain  = renderCharTrain;
window.renderSharedCharSkills = renderSharedCharSkills;
