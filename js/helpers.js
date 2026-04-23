/**
 * helpers.js — shared utility functions used by components and app.js
 */

/**
 * Format a number with commas and optional decimal places.
 * e.g. numberFormat(1234567.89, 2) → "1,234,567.89"
 */
function numberFormat(n, decimals = 0) {
	if (n == null || isNaN(n)) return '0';
	return Number(n).toLocaleString(undefined, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals
	});
}

/**
 * Capitalize the first letter of a string.
 */
function capitalizeFirst(str) {
	if (!str) return '';
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format a duration in seconds as a human-readable string.
 * e.g. 90061 → "1d 1h 1m 1s"
 */
function formatDuration(totalSeconds) {
	if (!totalSeconds || totalSeconds <= 0) return 'Done';
	const d = Math.floor(totalSeconds / 86400);
	const h = Math.floor((totalSeconds % 86400) / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = Math.floor(totalSeconds % 60);
	const parts = [];
	if (d > 0) parts.push(`${d}d`);
	if (h > 0) parts.push(`${h}h`);
	if (m > 0) parts.push(`${m}m`);
	if (s > 0 || parts.length === 0) parts.push(`${s}s`);
	return parts.join(' ');
}

/**
 * Start a live countdown on every element matching `.sq-countdown[data-until]`.
 * data-until = Unix timestamp (ms) when training ends.
 * Call once after mounting components.
 */
function startCountdowns() {
	function tick() {
		const now = Date.now();
		document.querySelectorAll('.sq-countdown[data-until]').forEach(el => {
			const until = Number(el.dataset.until);
			const remaining = Math.max(0, Math.floor((until - now) / 1000));
			el.textContent = remaining > 0 ? formatDuration(remaining) : 'Done';
		});
	}
	tick();
	setInterval(tick, 1000);
}

window.numberFormat = numberFormat;
window.capitalizeFirst = capitalizeFirst;
window.formatDuration = formatDuration;
window.startCountdowns = startCountdowns;
