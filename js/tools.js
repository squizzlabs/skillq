function delegateLongPress(root, selector, callback, pressTime = 500, moveTolerance = 10) {
	const timers = new Map(); // key: pointerId -> {timer, el, x, y}

	const getTarget = (startEl) => startEl.closest(selector);

	const clear = (pointerId) => {
		const s = timers.get(pointerId);
		if (!s) return;
		clearTimeout(s.timer);
		timers.delete(pointerId);
	};

	root.addEventListener('pointerdown', (e) => {
		const el = getTarget(e.target);
		if (!el) return;

		// capture start position to cancel if user moves too far
		const startX = e.clientX, startY = e.clientY;

		const timer = setTimeout(() => {
			// only fire if still tracked
			if (timers.has(e.pointerId)) {
				callback(e, el);
				// optional: keep or clear after firing
				clear(e.pointerId);
			}
		}, pressTime);

		timers.set(e.pointerId, { timer, el, x: startX, y: startY });

		// prevent long-press context menu on touch
		if (e.pointerType === 'touch') {
			el.addEventListener('contextmenu', preventOnce, { once: true, capture: true });
		}
	});

	root.addEventListener('pointerup', (e) => clear(e.pointerId));
	root.addEventListener('pointercancel', (e) => clear(e.pointerId));
	root.addEventListener('pointerleave', (e) => clear(e.pointerId));

	// cancel if the pointer moves too much (scroll/drag)
	root.addEventListener('pointermove', (e) => {
		const s = timers.get(e.pointerId);
		if (!s) return;
		const dx = e.clientX - s.x;
		const dy = e.clientY - s.y;
		if (dx * dx + dy * dy > moveTolerance * moveTolerance) {
			clear(e.pointerId);
		}
	});

	// helper to suppress context menu once
	function preventOnce(ev) { ev.preventDefault(); }
}

/*
// Example usage:
delegateLongPress(
	document,            // root to delegate from (could be a container element)
	'.myClass',          // selector
	(e, el) => {         // callback(event, element)
		console.log('Long press on:', el, 'via', e.type);
	},
	500                  // pressTime ms (optional)
);*/