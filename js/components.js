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
 *   renderCharTrain(options)
 */

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function _el(tag, className, text) {
	const el = document.createElement(tag);
	if (className) el.className = className;
	if (text != null) el.textContent = text;
	return el;
}

function _img(src, alt, className) {
	const img = document.createElement('img');
	img.src = src;
	img.alt = alt || '';
	if (className) img.className = className;
	return img;
}

function _a(href, text, className) {
	const a = document.createElement('a');
	a.href = href;
	if (text != null) a.textContent = text;
	if (className) a.className = className;
	return a;
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
	brand.appendChild(_img('/img/skillbook.png', 'Skillbook', 'sq-nav__brand-icon'));
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
			const a = _a(`/char/${encodeURIComponent(char.name)}`, null, 'sq-nav__char-link');
			if (!isHome && char.character_id == currentCharId) a.classList.add('sq-nav__char-link--active');
			a.dataset.characterId = String(char.character_id);
			a.title = char.name;
			a.appendChild(_img(
				`https://images.evetech.net/characters/${char.character_id}/portrait?size=32`,
				char.name,
				'sq-nav__char-img'
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

		for (const [label, href] of [['Manage', '/manage'], ['Settings', '/settings'], ['Logout', '/logout']]) {
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

	const card = _el('div', 'sq-char-card');

	// Portrait
	const portraitLink = _a(`/char/${encodeURIComponent(name)}`, null, 'sq-char-card__portrait-link');
	portraitLink.appendChild(_img(
		`https://images.evetech.net/characters/${character_id}/portrait?size=128`,
		name,
		'sq-char-card__portrait'
	));
	card.appendChild(portraitLink);

	// Info
	const info = _el('div', 'sq-char-card__info');

	const nameEl = document.createElement('strong');
	nameEl.appendChild(_a(`/char/${encodeURIComponent(name)}`, name));
	info.appendChild(nameEl);

	info.appendChild(_el('div', 'sq-char-card__stat', `${numberFormat(balance, 2)} ISK`));
	info.appendChild(_el('div', 'sq-char-card__stat', `${numberFormat(skillPoints, 0)} SP`));

	if (training?.typeName) {
		const trainDiv = _el('div', 'sq-char-card__training');
		trainDiv.textContent = training.typeName + (training.level ? ` ${toRomanNumeral(training.level)}` : '');
		info.appendChild(trainDiv);

		if (training.trainingEndMs > Date.now()) {
			const countdown = _el('div', 'sq-countdown sq-char-card__countdown');
			countdown.dataset.until = training.trainingEndMs;
			info.appendChild(countdown);
		}

		if (training.queueEmptyMs && training.queueEmptyMs - Date.now() < 86400000) {
			const warn = _el('div', 'sq-warn', 'Queue finishing soon');
			info.appendChild(warn);
		}
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

	const el = _el('div', 'sq-char-info');

	// Portrait
	el.appendChild(_img(
		`https://images.evetech.net/characters/${character_id}/portrait?size=256`,
		name,
		'sq-char-info__portrait'
	));

	// Corp / alliance logos
	const logos = _el('div', 'sq-char-info__logos');
	if (corporation_id) {
		logos.appendChild(_img(
			`https://images.evetech.net/corporations/${corporation_id}/logo?size=128`,
			corporation?.name || '',
			'sq-char-info__logo'
		));
	}
	if (alliance_id) {
		logos.appendChild(_img(
			`https://images.evetech.net/alliances/${alliance_id}/logo?size=128`,
			alliance?.name || '',
			'sq-char-info__logo'
		));
	}
	el.appendChild(logos);

	// Text details
	const details = _el('div', 'sq-char-info__details');
	details.appendChild(_el('strong', 'sq-char-info__name', name));
	if (corporation?.name) details.appendChild(_el('div', 'sq-char-info__corp', corporation.name));
	if (alliance?.name)    details.appendChild(_el('div', 'sq-char-info__alliance', alliance.name));
	if (showBalance)       details.appendChild(_el('div', 'sq-char-info__balance', `${numberFormat(balance, 2)} ISK`));

	if (training?.typeName) {
		details.appendChild(_el('div', 'sq-char-info__training', training.typeName + (training.level ? ` ${toRomanNumeral(training.level)}` : '')));
		if (training.trainingEndMs > Date.now()) {
			const countdown = _el('span', 'sq-countdown');
			countdown.dataset.until = training.trainingEndMs;
			details.appendChild(countdown);
		}
		if (training.queueEmptyMs && training.queueEmptyMs - Date.now() < 86400000) {
			details.appendChild(_el('div', 'sq-warn', 'Queue finishing soon'));
		}
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
 * activeTab: 'overview' | 'wallet' | 'train'
 */
function renderCharMenu({ charName, activeTab = 'overview' } = {}) {
	const encoded = encodeURIComponent(charName);
	const tabs = [
		{ id: 'overview', label: 'Overview', href: `/char/${encoded}/` },
		{ id: 'wallet',   label: 'Wallet',   href: `/char/${encoded}/wallet/` },
		{ id: 'train',    label: 'Train',    href: `/char/${encoded}/train/` },
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
 * queue:  [{ typeName, typeID, groupName, startTime, endTime, spHour }]
 * skills: [{ typeName, typeID, groupName, groupID, skillPoints, level,
 *            training, queue }]
 *   training/queue: level currently being trained/queued (0 if none)
 * totalSP, unallocatedSP: numbers
 */
function renderCharSkills({ queue = [], skills = [], totalSP = 0, unallocatedSP = 0 } = {}) {
	const el = _el('div', 'sq-skills');

	/* ── Skill Queue ── */
	if (queue.length > 0) {
		const section = _el('section', 'sq-queue');
		const h4 = _el('h4', 'sq-section-title');
		h4.innerHTML = `Skill Queue <small>(${queue.length} in queue)</small>`;
		section.appendChild(h4);

		const table = document.createElement('table');
		table.className = 'sq-table sq-table--striped';
		const thead = document.createElement('thead');
		thead.innerHTML = '<tr><th>Skill</th><th>Group</th><th>Start</th><th>End</th><th>SP/h</th></tr>';
		const tbody = document.createElement('tbody');
		for (const skill of queue) {
			const tr = document.createElement('tr');
			const queueLevel = Number(
				skill.level
				|| skill.targetLevel
				|| skill.finished_level
				|| skill.finishedLevel
				|| skill.target_level
				|| 0
			);

			const skillTd = document.createElement('td');
			skillTd.dataset.label = 'Skill';
			const skillLink = document.createElement('a');
			skillLink.href = `/item/${skill.typeID}/`;
			skillLink.textContent = skill.typeName + (queueLevel ? ` ${toRomanNumeral(queueLevel)}` : '');
			skillTd.appendChild(skillLink);
			tr.appendChild(skillTd);

			const groupTd = document.createElement('td');
			groupTd.dataset.label = 'Group';
			groupTd.textContent = skill.groupName || '';
			tr.appendChild(groupTd);

			const startTd = document.createElement('td');
			startTd.dataset.label = 'Start';
			startTd.textContent = skill.startDate ? formatDateTime(skill.startDate) : (skill.startTime || '');
			tr.appendChild(startTd);

			const endTd = document.createElement('td');
			endTd.dataset.label = 'End';
			endTd.textContent = skill.endDate ? formatDateTime(skill.endDate) : (skill.endTime || '');
			tr.appendChild(endTd);

			const spTd = document.createElement('td');
			spTd.dataset.label = 'SP/h';
			spTd.textContent = numberFormat(skill.spHour, 0);
			tr.appendChild(spTd);

			tbody.appendChild(tr);
		}
		table.appendChild(thead);
		table.appendChild(tbody);
		section.appendChild(table);
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
			const btn = _el('button', 'sq-btn sq-btn--sm', label);
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
				const link = _a(`/item/${skill.typeID}/`, skill.typeName);
				nameTd.appendChild(link);
				const targetLevel = skill.training || skill.queue || 0;
				if (targetLevel > 0 && targetLevel > skill.level) {
					nameTd.appendChild(_el('em', 'sq-skill-sp', ` ${toRomanNumeral(targetLevel)}`));
				}
				if (skill.skillPoints) {
					nameTd.appendChild(_el('em', 'sq-skill-sp', ` ${numberFormat(skill.skillPoints, 0)} SP`));
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

/* ─── Character Train (implants + suggestions) ───────────────────────────────
 *
 * renderCharTrain({ implants, suggestions })
 *
 * implants: [{ attributeName, baseValue, bonus, implantName }]
 * suggestions: [{ typeName, typeID, level, time, primaryAttribute,
 *                 secondaryAttribute, skillPoints, training, queue }]
 */
function renderCharTrain({ implants = [], suggestions = [] } = {}) {
	const el = _el('div', 'sq-train');

	/* ── Implants ── */
	if (implants.length > 0) {
		const section = _el('section', 'sq-implants');
		section.appendChild(_el('h4', 'sq-section-title', 'Implants'));

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
		el.appendChild(section);
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
		const btn = _el('button', 'sq-btn sq-btn--sm', label);
		btn.addEventListener('click', fn);
		controls.appendChild(btn);
	};
	addCtrl('Show All',      () => section.querySelectorAll('.sq-skill-row').forEach(r => r.hidden = false));
	addCtrl('Hide Untrained',() => section.querySelectorAll('.sq-skill-row--untrained').forEach(r => r.hidden = true));
	addCtrl('Hide Trained',  () => section.querySelectorAll('.sq-skill-row--trained').forEach(r => r.hidden = true));
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

function renderSharedCharSkills({ queue = [], skills = [], totalSP = 0 } = {}) {
	const el = _el('div', 'sq-skills');
	const now = Date.now();

	if (queue.length > 0) {
		const trainingSection = _el('section', 'sq-queue');
		const trainingHeader = _el('h4', 'sq-section-title');
		trainingHeader.innerHTML = `Skill Queue <small>(${queue.length} in queue)</small>`;
		trainingSection.appendChild(trainingHeader);

		const trainingTable = document.createElement('table');
		trainingTable.className = 'sq-table sq-table--striped';
		const trainingHead = document.createElement('thead');
		trainingHead.innerHTML = '<tr><th>Skill</th><th>Group</th><th>Start</th><th>End</th></tr>';
		const trainingBody = document.createElement('tbody');

		for (const entry of queue) {
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
		el.appendChild(trainingSection);
	}

	const section = _el('section', 'sq-skill-groups');
	const heading = _el('h4', 'sq-section-title');
	const totalSpSummary = Number(totalSP || 0) > 0 ? `${numberFormat(totalSP, 0)} SP / ` : '';
	heading.innerHTML = `Shared Skills <small>${totalSpSummary}${skills.length} Skills</small>`;
	section.appendChild(heading);

	if (skills.length === 0) {
		section.appendChild(_el('p', 'sq-muted', 'No shared overview skills are available.'));
		el.appendChild(section);
		return el;
	}

	// Build sets for active/queued annotation in the grouped skill list
	const activeTypeIds = new Set(
		queue.filter((e) => Number(e.trainingStartMs || 0) > 0 && Number(e.trainingEndMs || 0) > now && Number(e.trainingStartMs) <= now)
			.map((e) => e.typeID)
	);
	const queuedTypeIds = new Set(queue.map((e) => e.typeID));

	const controls = _el('div', 'sq-skill-controls');
	const addCtrl = (label, fn) => {
		const btn = _el('button', 'sq-btn sq-btn--sm', label);
		btn.addEventListener('click', fn);
		controls.appendChild(btn);
	};
	addCtrl('Expand All', () => section.querySelectorAll('.sq-skill-row').forEach((row) => { row.hidden = false; }));
	addCtrl('Collapse All', () => section.querySelectorAll('.sq-skill-row').forEach((row) => { row.hidden = true; }));
	section.appendChild(controls);

	const grouped = new Map();
	for (const skill of skills) {
		if (!grouped.has(skill.groupID)) grouped.set(skill.groupID, { name: skill.groupName, count: 0, skills: [] });
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

	const note = _el('p', 'sq-muted', 'Shared links include skill levels and active training timing, not wallet data or exact accumulated SP.');
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
window.renderCharTrain  = renderCharTrain;
window.renderSharedCharSkills = renderSharedCharSkills;
